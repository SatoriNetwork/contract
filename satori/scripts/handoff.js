// D4 — hand the deployed protocol from the deployer EOA to its real owners.
//
//   npx hardhat run scripts/handoff.js --network baseSepolia          (shows the plan)
//   HANDOFF_EXECUTE=1 npx hardhat run scripts/handoff.js --network baseSepolia
//
// TWO SHAPES
// On Base the token's root is the association's Safe from its constructor (M02):
// deploy.js borrowed wiring and appoint from it, and this script prints the one
// Safe transaction that hands every slot to its final holder (or sends it with
// SIGNER_KEYS on a testnet), and moves the deployer's own roles. A rehearsal
// deployed with the deployer as root runs the full sequence below instead.
//
// WHY THIS EXISTS AS A SEPARATE STEP
// The deployer needs these while deploy.js runs, for three reasons:
//
//   1. `token.setController`, `token.setHook`, `token.setAirdrop` and the hub's
//      Merkle and vote-lock setters are gated on the token's wiring slot, and
//      `engine.setHub` on its appoint slot; the script signs them as the deployer.
//   2. The adapter registrations run while every capability flag is off, so they
//      pass only via the admin bypass in `capabilityAllowed` — the deployer must
//      be `rewards.admin()`.
//   3. Adapter registration burns SATORI. At genesis only the root and the dev
//      recipient hold any SATORI at all.
//
// With a Safe root the deployer only borrows wiring, appoint and 0.001 SATORI;
// root, fee, upgrade, freeze and the genesis treasury never leave the Safe. The
// open window is the borrowed wiring slot, which can redirect the sole minter,
// until the Safe batch this prints runs. With the deployer as root (a
// rehearsal), the deployer holds everything, treasury included, until the
// sequence below completes. Either way, close it fast.
//
// THE DEPLOYER-ROOT ORDER IS CHOSEN, NOT INCIDENTAL
// The two halves of the danger close at different speeds, so the one that can be
// closed unilaterally goes first:
//
//   1. MOVE THE SATORI. One transfer, no coordination, no second party. It takes
//      the prize off the hot key immediately. Nothing later depends on the
//      deployer holding tokens.
//   2. MOVE THE FOUR NON-ROOT AUTHORITY SLOTS. Single-step, immediate, no second
//      party — `setUpgradeAuthority` and friends are `onlyRoot`, and the deployer is
//      still root at this point.
//
//      THIS NARROWS THE MINTER HOLE. IT DOES NOT CLOSE IT. `setController` is
//      gated on `wiringAuthority`, so after this the deployer cannot redirect
//      the minter in one call — but it is STILL ROOT, so it can send
//      `setWiringAuthority(self)` and then do exactly that. Two transactions
//      instead of one, and the first is a loud, separate event on chain.
//      Verified on a live run, not assumed.
//
//      What that is worth: a stray call or a fat finger can no longer redirect
//      the minter, and a watcher gets a warning shot. What it is NOT worth:
//      nothing here protects against a deployer key that is compromised while
//      it still holds root. Step 5 remains the step that actually closes it.
//   3. MOVE THE ADMIN. Single-step and immediate, with no accept leg.
//      `setAdmin` rejects the zero address, so it cannot renounce.
//   4. NOMINATE THE ROOT. `setRootAuthority` only nominates — the deployer stays
//      root until the Safe accepts. Starting it early is what lets the humans
//      begin collecting signatures.
//   5. THE SAFE ACCEPTS. `acceptRootAuthority` must be sent BY the incoming root,
//      so this script cannot do it and deliberately does not try — it prints the
//      call for the Safe to execute.
//
// ORDER IS LOAD-BEARING, and differently than before. The four setters are
// `onlyRoot`, so they have to happen BEFORE the Safe accepts root — after that
// the deployer cannot move them and the Safe would have to send four more
// transactions itself. Doing them first also means every dangerous power is off
// the hot key within one block, rather than hours later when signatures land.
//
// Root stays two-step by design: a mistyped or keyless address can never take
// the one slot that assigns all the others, because it would have to call
// `acceptRootAuthority` to get it.
//
// IDEMPOTENT. It reads the chain, works out what is left, and does only that. A
// handoff spans a human coordination gap — signatures take hours — so re-running
// it to check progress has to be free and safe.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { runChecks, readPolicy } = require("./live-reads-lib");
const { SAFE, encodeMultiSend, txBuilderBatch, ROOT_PUBLISHER, NEW_ADMIN, requireDeployer, presetOr, NEW_GOVERNOR, BURN_ROOT_BALANCE } = require("./deploy-lib");
const { execViaSafe } = require("./safe-exec");

function requireAddr(name, v) {
  const s = (v ?? "").trim();
  if (!s) throw new Error(`${name} is required.`);
  let a;
  try { a = ethers.getAddress(s); }
  catch { throw new Error(`${name} is not a valid address: ${s}`); }
  if (a === ethers.ZeroAddress) throw new Error(`${name} must not be the zero address`);
  return a;
}

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const execute = !!(process.env.HANDOFF_EXECUTE || "").trim();
  const [deployer] = await ethers.getSigners();
  await requireDeployer(ethers.provider, deployer);
  if (!deployer) throw new Error("No signer — set PRIVATE_KEY in .env");

  const book = process.env.ADDRESS_BOOK ||
    path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(book)) {
    throw new Error(`no address book at ${book} — run deploy.js first, or set ADDRESS_BOOK`);
  }
  const bookJson = JSON.parse(fs.readFileSync(book, "utf8"));
  if (bookJson.complete === false) {
    throw new Error(`${book} is from a deploy.js run that has not finished — finish the deploy first (run it again).`);
  }
  const A = bookJson.addresses;

  const newGovernor = requireAddr("NEW_GOVERNOR", presetOr("NEW_GOVERNOR", NEW_GOVERNOR[chainId]));
  const newAdmin = requireAddr("NEW_ADMIN", presetOr("NEW_ADMIN", NEW_ADMIN[chainId]) || newGovernor);
  // Where the genesis supply goes. Defaults to the incoming governor, which is
  // the Safe — the treasury and the governor are the same body unless told
  // otherwise, and a separate value here is a deliberate choice, not a typo.
  const treasury = requireAddr("TREASURY", process.env.TREASURY || newGovernor);
  // The merkle channel is always deployed now, and when ROOT_PUBLISHER was unset
  // at deploy time it starts on the DEPLOYER — a hot, throwaway key. Nothing
  // moved it before this, so it would have stayed there permanently while every
  // other role was handed over. Defaults to NEW_ADMIN: publishing roots is an
  // operational job, so it belongs with the admin rather than the governor, and
  // it can be rotated to a warm operator key afterwards from the Off-chain tab.
  const newRootPublisher = requireAddr("NEW_ROOT_PUBLISHER",
    presetOr("NEW_ROOT_PUBLISHER", ROOT_PUBLISHER[chainId]) || newAdmin);

  // The four non-root slots. Each defaults to NEW_GOVERNOR, so the simple case —
  // everything to one Safe — needs no new configuration at all, and splitting
  // them across Safes is opt-in per slot whenever those Safes exist.
  const SLOTS = [
    ["upgrade", "NEW_UPGRADE_AUTHORITY", "upgradeAuthority", "setUpgradeAuthority"],
    ["wiring",  "NEW_WIRING_AUTHORITY",  "wiringAuthority",  "setWiringAuthority"],
    ["appoint", "NEW_APPOINT_AUTHORITY", "appointAuthority", "setAppointAuthority"],
    ["freeze",  "NEW_FREEZE_AUTHORITY",  "freezeAuthority",  "setFreezeAuthority"],
  ].map(([name, env, getter, setter]) => ({
    name, getter, setter,
    target: requireAddr(env, process.env[env] || newGovernor),
  }));

  const token = await ethers.getContractAt("SatoriToken", A.token);
  const rewards = await ethers.getContractAt("SatoriRewards", A.rewards);

  console.log(`\n  network   ${network.name} (chainId ${chainId})`);
  console.log(`  deployer  ${deployer.address}`);
  console.log(`  book      ${book}`);
  console.log(`  mode      ${execute ? "EXECUTE — will send transactions" : "PLAN ONLY — nothing will be sent"}`);
  if (chainId === 8453) {
    console.log(`\n  !! BASE MAINNET. Until the root Safe runs the slot batch printed below, the`);
    console.log(`     deployer still holds the borrowed wiring slot and can redirect the sole minter.\n`);
  }

  // ---- current state ----
  const [govNow, pendingNow, adminNow, bal] = await Promise.all([
    token.rootAuthority(), token.pendingRootAuthority(), rewards.admin(), token.balanceOf(deployer.address),
  ]);
  // A root Safe handing over to a different holder burns what it holds when this
  // chain says so (Base mainnet: the genesis SATORI is not wanted).
  const burnRoot = !!BURN_ROOT_BALANCE[chainId] && govNow.toLowerCase() !== newGovernor.toLowerCase();
  const rootBal = burnRoot ? await token.balanceOf(govNow) : 0n;
  console.log(`\n== where things stand ==`);
  console.log(`  token.root              ${govNow}`);
  console.log(`  token.pendingRoot       ${pendingNow === ethers.ZeroAddress ? "(none)" : pendingNow}`);
  for (const sl of SLOTS) {
    sl.now = await token[sl.getter]();
    console.log(`  token.${(sl.name + " ").padEnd(18)}${sl.now}`);
  }
  console.log(`  rewards.admin           ${adminNow}`);
  // The airdrop loader lives on SatoriAirdrop (no proxy) and starts on
  // REWARDS_ADMIN, which at deploy time is normally the deployer. It goes
  // wherever the admin goes: loading the table is an operational job.
  let loaderNow = null;
  let loaderDone = true;
  if (A.airdrop) {
    loaderNow = await (await ethers.getContractAt("SatoriAirdrop", A.airdrop)).airdropAuthority();
    loaderDone = loaderNow.toLowerCase() === newAdmin.toLowerCase();
    console.log(`  airdrop.loader          ${loaderNow}`);
  }
  console.log(`  deployer SATORI         ${ethers.formatEther(bal)}`);
  console.log(`\n== where they should end up ==`);
  console.log(`  root      ${newGovernor}`);
  for (const sl of SLOTS) {
    console.log(`  ${sl.name.padEnd(9)} ${sl.target}${sl.target === newGovernor ? "  (same as root)" : "  (separate — deliberate?)"}`);
  }
  console.log(`  admin     ${newAdmin}`);
  console.log(`  treasury  ${treasury}${treasury === newGovernor ? "  (same as root)" : "  (separate — deliberate?)"}`);

  if (newGovernor === deployer.address) {
    throw new Error("NEW_GOVERNOR is the deployer — that is not a handoff.");
  }
  // NEW_ADMIN may be the deployer: the admin can touch no funds and no root.
  for (const [name, a] of [["NEW_ROOT_PUBLISHER", newRootPublisher], ["TREASURY", treasury],
    ...SLOTS.map((sl) => [`NEW_${sl.name.toUpperCase()}_AUTHORITY`, sl.target])]) {
    if (a === deployer.address) throw new Error(`${name} is the deployer — that is not a handoff.`);
  }
  // The incoming governor has to be able to send `acceptGovernor`. An address
  // with no code is an EOA and presumed able; a contract must be one that can
  // originate calls (a Safe can, an inert contract cannot and would strand the
  // role forever — though the two-step design means it simply never takes it).
  if ((await ethers.provider.getCode(newGovernor)) === "0x") {
    console.log(`\n  note: NEW_GOVERNOR has no code — an EOA, not a multisig.`);
  }

  // ---- work out what is left ----
  const govDone = govNow.toLowerCase() === newGovernor.toLowerCase();
  const adminDone = adminNow.toLowerCase() === newAdmin.toLowerCase();
  const tokensDone = bal === 0n;
  const nominated = pendingNow.toLowerCase() === newGovernor.toLowerCase();

  // The merkle root publisher is read BEFORE the completion check, not with the
  // other steps below, because it is a role held by the DEPLOYER and this
  // script used to declare "HANDOFF COMPLETE — nothing further to do" without
  // ever looking at it. On D4 that happened for real: governor, admin and the
  // treasury had all moved to the Safe, the script reported complete, and the
  // root publisher was still the throwaway deploy key with the Safe merely
  // nominated. "Complete" has to mean every role, or it means nothing.
  let pubDone = true;
  let pubNow = null;
  let pubPending = null;
  if (A.merkle) {
    const m = await ethers.getContractAt("SatoriMerkle", A.merkle);
    [pubNow, pubPending] = await Promise.all([m.rootPublisher(), m.pendingRootPublisher()]);
    pubDone = pubNow.toLowerCase() === newRootPublisher.toLowerCase();
  }

  const slotsDone = SLOTS.every((sl) => sl.now.toLowerCase() === sl.target.toLowerCase());
  let proposerDone = true;
  if (A.lockVoteGovernor) {
    const p = await (await ethers.getContractAt("LockVoteGovernor", A.lockVoteGovernor)).proposer();
    proposerDone = p.toLowerCase() === newGovernor.toLowerCase();
  }
  if (govDone && adminDone && tokensDone && pubDone && loaderDone && slotsDone && proposerDone && rootBal === 0n) {
    console.log(`\n== HANDOFF COMPLETE ==`);
    console.log(`\n  The deployer holds no SATORI and no token slot, is not the governor, the lock-vote`);
    console.log(`  proposer or the merkle root publisher; the admin and airdrop loader are ${newAdmin}.`);
    console.log(`  Nothing further to do.\n`);
    return;
  }

  if (govDone && adminDone && tokensDone && loaderDone && slotsDone && proposerDone && !pubDone) {
    console.log(`\n== ALMOST — ONE ROLE IS STILL ON THE DEPLOYER ==`);
    console.log(`\n  governor, admin and treasury are handed over, but the merkle`);
    console.log(`  root publisher is still ${pubNow}`);
    console.log(`  (pending: ${pubPending === ethers.ZeroAddress ? "(none)" : pubPending}).`);
    if (pubPending && pubPending.toLowerCase() === newRootPublisher.toLowerCase()) {
      const d = (await ethers.getContractAt("SatoriMerkle", A.merkle))
        .interface.encodeFunctionData("acceptRootPublisher", []);
      console.log(`\n  It is already nominated. The nominee must accept:\n`);
      console.log(`    to     ${A.merkle}`);
      console.log(`    value  0`);
      console.log(`    data   ${d}      (acceptRootPublisher())\n`);
    }
  }

  if (!govDone && govNow.toLowerCase() !== deployer.address.toLowerCase() && (await ethers.provider.getCode(govNow)) === "0x") {
    throw new Error(
      `the deployer is not the current governor (${govNow}) and the handoff is not ` +
      `complete — wrong PRIVATE_KEY, or someone else already moved it.`
    );
  }

  const steps = [];
  if (!tokensDone) {
    steps.push({
      n: 1, label: `move ${ethers.formatEther(bal)} SATORI to the treasury`,
      why: "unilateral and instant — takes the prize off the hot key first",
      run: () => token.transfer(treasury, bal),
    });
  }
  // 2. The four non-root slots, BEFORE the root moves. They are `onlyRoot` and
  //    the deployer is still root; once the Safe accepts, the deployer cannot
  //    send these at all. `wiring` is the one that matters most — it carries
  //    `setController`, so this is where the minter hole actually closes.
  const rootIsDeployer = govNow.toLowerCase() === deployer.address.toLowerCase();
  // Slots only the root can move, when the root is not the deployer: a Safe
  // root sends them as one batch (below).
  const rootCalls = [];
  for (const sl of SLOTS) {
    if (sl.now.toLowerCase() === sl.target.toLowerCase()) continue;
    if (!rootIsDeployer) {
      rootCalls.push({ to: A.token, data: token.interface.encodeFunctionData(sl.setter, [sl.target]),
        label: `${sl.setter}(${sl.target})`,
        check: [`${sl.name} authority is ${sl.target}`, async () => (await token[sl.getter]()).toLowerCase() === sl.target.toLowerCase()] });
      continue;
    }
    steps.push({
      n: 2, label: `set ${sl.name} authority to ${sl.target}`,
      why: sl.name === "wiring"
        ? "carries setController — narrows the minter hole to two txs (root can still take it back)"
        : "one-step and immediate; must happen while the deployer is still root",
      run: () => token[sl.setter](sl.target),
    });
  }

  if (!rootIsDeployer && !govDone) {
    if (!nominated) {
      rootCalls.push({ to: A.token, data: token.interface.encodeFunctionData("setRootAuthority", [newGovernor]),
        label: `setRootAuthority(${newGovernor})`,
        check: [`pending root is ${newGovernor}`, async () => (await token.pendingRootAuthority()).toLowerCase() === newGovernor.toLowerCase()] });
    }
    if (A.lockVoteGovernor) {
      const lockGov = await ethers.getContractAt("LockVoteGovernor", A.lockVoteGovernor);
      if ((await lockGov.proposer()).toLowerCase() === govNow.toLowerCase()) {
        rootCalls.push({ to: A.lockVoteGovernor, data: lockGov.interface.encodeFunctionData("transferProposer", [newGovernor]),
          label: `lockVoteGovernor.transferProposer(${newGovernor})`,
          check: [`lock-vote proposer is ${newGovernor}`, async () => (await lockGov.proposer()).toLowerCase() === newGovernor.toLowerCase()] });
      }
    }
    if (rootBal > 0n) {
      rootCalls.push({ to: A.token, data: token.interface.encodeFunctionData("burn", [rootBal]),
        label: `burn(${ethers.formatEther(rootBal)} SATORI)`,
        check: [`root Safe burned its SATORI`, async () => (await token.balanceOf(govNow)) === 0n] });
    }
  }
  if (rootIsDeployer && !govDone && !nominated) {
    steps.push({
      n: 4, label: `nominate ${newGovernor} as root authority`,
      why: "only nominates; the deployer stays root until the Safe accepts",
      run: () => token.setRootAuthority(newGovernor),
    });
  }
  if (!adminDone && adminNow.toLowerCase() === deployer.address.toLowerCase()) {
    steps.push({
      n: 3, label: `set rewards admin to ${newAdmin}`,
      why: "single-step and immediate — no accept leg; zero is rejected",
      run: () => rewards.setAdmin(newAdmin),
    });
  } else if (!adminDone) {
    console.log(`\n  note: admin is ${adminNow}, not the deployer — cannot move it from here.`);
  }

  // 3a. THE AIRDROP LOADER. One-step like the admin, and it follows the admin.
  if (A.airdrop && !loaderDone) {
    if (loaderNow.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log(`\n  note: airdrop loader is ${loaderNow}, not the deployer — cannot move it from here.`);
    } else {
      const airdrop = await ethers.getContractAt("SatoriAirdrop", A.airdrop);
      // The snapshot is loaded by this single key before the loader moves:
      // after the move, each batch is a Safe signing round (load-airdrop.js).
      if ((await airdrop.airdropLoadedTotal()) === 0n && !process.env.AIRDROP_LOAD_LATER) {
        throw new Error("the airdrop is not loaded yet. Load it first with the deployer " +
          "(LOAD=1 SIGNER_KEYS=$PRIVATE_KEY node scripts/load-airdrop.js <dir>/batch-*.json), " +
          "or set AIRDROP_LOAD_LATER=1 to move the loader with an empty table.");
      }
      steps.push({
        n: 3, label: `set airdrop loader to ${newAdmin}`,
        why: "one-step and immediate — loading the table is an operational job, so it follows the admin",
        run: () => airdrop.setAirdropAuthority(newAdmin),
      });
    }
  }

  // 3b. THE LOCK-VOTE PROPOSER — the association's seat on the second voting
  //     path (docs/design/lock-vote-governor.md). One-step like the admin;
  //     grouped with it. Skipped silently on a stack whose book predates the
  //     lock governor, same posture as the merkle block below.
  if (A.lockVoteGovernor) {
    const lockGov = await ethers.getContractAt("LockVoteGovernor", A.lockVoteGovernor);
    const propNow = await lockGov.proposer();
    if (propNow.toLowerCase() === newGovernor.toLowerCase()) {
      console.log(`\n  note: lock-vote proposer is already ${newGovernor}.`);
    } else if (propNow.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log(`\n  note: lock-vote proposer is ${propNow}, not the deployer — cannot move it from here.`);
    } else {
      steps.push({
        n: 3, label: `set lock-vote proposer to ${newGovernor}`,
        why: "one-step and immediate — only the association should open lock-vote proposals",
        run: () => lockGov.transferProposer(newGovernor),
      });
    }
  }

  // 4. NOMINATE THE MERKLE ROOT PUBLISHER. Two-step like the governor
  //    (setRootPublisher nominates, acceptRootPublisher confirms), for the same
  //    reason: a typo here would otherwise hand the claim channel to an address
  //    nobody controls, and the channel is what real entitlements are proven
  //    against. Skipped silently on a stack whose book predates the always-on
  //    merkle change, where A.merkle simply does not exist.
  if (A.merkle) {
    const merkle = await ethers.getContractAt("SatoriMerkle", A.merkle);
    const pubNow = await merkle.rootPublisher();
    const pubPending = await merkle.pendingRootPublisher();
    if (pubNow.toLowerCase() === newRootPublisher.toLowerCase()) {
      console.log(`\n  note: root publisher is already ${newRootPublisher}.`);
    } else if (pubNow.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log(`\n  note: root publisher is ${pubNow}, not the deployer — cannot move it from here.`);
    } else if (pubPending.toLowerCase() === newRootPublisher.toLowerCase()) {
      console.log(`\n  note: root publisher already nominated to ${newRootPublisher}; awaiting accept.`);
    } else {
      steps.push({
        n: 5, label: `nominate ${newRootPublisher} as merkle root publisher`,
        why: "only nominates; the deployer keeps publishing until the nominee accepts",
        run: () => merkle.setRootPublisher(newRootPublisher),
      });
    }
  }

  // SORT BY STEP NUMBER. The array is built in source order, which put the root
  // nomination (4) ahead of the admin move (3) purely because of where the code
  // sits. The numbers exist because the ORDER IS CHOSEN — printing and sending
  // them out of order makes the script contradict its own header.
  steps.sort((a, b) => a.n - b.n);

  console.log(`\n== what this run will do ==`);
  if (!steps.length) {
    console.log(`  nothing — every deployer-side step is already done.`);
  }
  for (const s of steps) console.log(`  ${s.n}. ${s.label}\n       ${s.why}`);

  if (!execute) {
    console.log(`\n  PLAN ONLY. Re-run with HANDOFF_EXECUTE=1 to send these.\n`);
  } else {
    for (const s of steps) {
      process.stdout.write(`\n  ${s.n}. ${s.label} ... `);
      const r = await (await s.run()).wait();
      console.log(`ok (block ${r.blockNumber})`);
    }
  }

  // ---- verify what we claim to have done ----
  const policy = readPolicy(network.name);
  if (execute && steps.length) {
    console.log(`\n== verifying ==`);
    const checks = [];
    if (steps.some((s) => s.n === 1)) {
      checks.push([`deployer holds no SATORI`, async () => (await token.balanceOf(deployer.address)) === 0n]);
      checks.push([`treasury holds the genesis supply`, async () => (await token.balanceOf(treasury)) >= bal]);
    }
    for (const sl of SLOTS) {
      if (!steps.some((s) => s.n === 2 && s.label.startsWith(`set ${sl.name} `))) continue;
      checks.push([`${sl.name} authority is ${sl.target}`,
        async () => (await token[sl.getter]()).toLowerCase() === sl.target.toLowerCase()]);
    }
    if (steps.some((s) => s.n === 4)) {
      checks.push([`pending root is ${newGovernor}`,
        async () => (await token.pendingRootAuthority()).toLowerCase() === newGovernor.toLowerCase()]);
      checks.push([`root is STILL the deployer (accept not yet done)`,
        async () => (await token.rootAuthority()).toLowerCase() === deployer.address.toLowerCase()]);
    }
    if (steps.some((s) => s.n === 3 && s.label.startsWith("set rewards admin"))) {
      checks.push([`rewards.admin is ${newAdmin}`,
        async () => (await rewards.admin()).toLowerCase() === newAdmin.toLowerCase()]);
    }
    if (steps.some((s) => s.n === 3 && s.label.startsWith("set airdrop loader"))) {
      checks.push([`airdrop loader is ${newAdmin}`,
        async () => (await (await ethers.getContractAt("SatoriAirdrop", A.airdrop)).airdropAuthority()).toLowerCase() === newAdmin.toLowerCase()]);
    }
    const { failed, lastError } = await runChecks(checks, { ...policy, log: console.log });
    for (const [msg] of checks) {
      const bad = failed.some(([m]) => m === msg);
      console.log(`  ${bad ? "FAIL" : "ok  "} ${msg}${bad && lastError.get(msg) ? `  (${lastError.get(msg)})` : ""}`);
    }
    if (failed.length) {
      console.error(`\n  ${failed.length} check(s) failed — do NOT proceed to the accept step.\n`);
      process.exit(1);
    }
  }

  // ---- the root's own transaction, when the root is a Safe ----
  if (rootCalls.length) {
    const batchPath = book.replace(/\.json$/, "") + ".safe-handoff.json";
    fs.writeFileSync(batchPath, JSON.stringify(txBuilderBatch({
      chainId, safe: govNow, name: "Satori handoff: every token slot to its holder", calls: rootCalls }), null, 2));
    const data = encodeMultiSend(rootCalls);
    const keys = (process.env.SIGNER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
    console.log(`\n== THE ROOT SAFE MUST MOVE ${rootCalls.length} SLOT(S) ==\n`);
    console.log(`  Root is ${govNow}. Until this runs, the deployer still holds what deploy.js borrowed.`);
    for (const c of rootCalls) console.log(`    ${c.label}`);
    console.log(`  As one Safe transaction (Transaction Builder batch: ${batchPath}), or raw:`);
    console.log(`    to        ${SAFE.multiSendCallOnly}  (MultiSendCallOnly 1.4.1)`);
    console.log(`    operation 1 (delegatecall)\n    data      ${data}\n`);
    if (execute && keys.length) {
      if (!network.config.url) throw new Error("SIGNER_KEYS needs a network with a URL");
      console.log("  executing it with SIGNER_KEYS (testnet convenience)...");
      await execViaSafe({ provider: new ethers.JsonRpcProvider(network.config.url), safe: govNow,
        to: SAFE.multiSendCallOnly, data, operation: 1, keys, log: console.log });
      const { failed } = await runChecks(rootCalls.map((c) => c.check), { ...policy, log: console.log });
      if (failed.length) {
        console.error(`\n  the Safe ran, but ${failed.map(([m]) => m).join("; ")} did not hold — check the Safe transaction.\n`);
        process.exit(1);
      }
      console.log("  the root Safe's batch landed.\n");
    }
  }

  // ---- the new root accepts ----
  const acceptKeys = (process.env.NEW_GOVERNOR_SIGNER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!govDone && execute && acceptKeys.length
      && (await token.pendingRootAuthority()).toLowerCase() === newGovernor.toLowerCase()) {
    if (!network.config.url) throw new Error("NEW_GOVERNOR_SIGNER_KEYS needs a network with a URL");
    console.log(`\n== ${newGovernor} accepts root, signed with NEW_GOVERNOR_SIGNER_KEYS ==`);
    await execViaSafe({ provider: new ethers.JsonRpcProvider(network.config.url), safe: newGovernor,
      to: A.token, data: token.interface.encodeFunctionData("acceptRootAuthority", []), operation: 0,
      keys: acceptKeys, log: console.log });
    const { failed } = await runChecks([[`root is ${newGovernor}`,
      async () => (await token.rootAuthority()).toLowerCase() === newGovernor.toLowerCase()]], { ...policy, log: console.log });
    if (failed.length) { console.error(`\n  the accept ran but root did not move.\n`); process.exit(1); }
    console.log(`  root is ${newGovernor}. Re-run this script to confirm the handoff is complete.\n`);
    return;
  }

  // ---- the half this script cannot do ----
  if (!govDone) {
    const data = token.interface.encodeFunctionData("acceptRootAuthority", []);
    console.log(`\n== THE SAFE MUST NOW ACCEPT ==\n`);
    console.log(`  Until this runs, the deployer is still ROOT and can reassign every`);
    console.log(`  other slot — including handing wiring back to itself. This script`);
    console.log(`  cannot send it: acceptRootAuthority only accepts a call FROM the`);
    console.log(`  incoming root, which is the whole point of the two-step.\n`);
    console.log(`  From the Safe, execute a transaction:\n`);
    console.log(`    to     ${A.token}`);
    console.log(`    value  0`);
    console.log(`    data   ${data}      (acceptRootAuthority())\n`);
    if ((await ethers.provider.getCode(newGovernor)) !== "0x") {
      console.log(`    https://app.safe.global/home?safe=${chainId === 8453 ? "base" : "basesep"}:${newGovernor}\n`);
    }
    console.log(`  Then re-run this script to confirm the handoff is complete.\n`);
  }

  // Same two-step, same reason, different role — and easy to forget precisely
  // because the governor accept is the one everybody remembers. Until this runs
  // the DEPLOYER is still the root publisher, so a hot throwaway key can publish
  // the root that off-chain claims are proven against.
  if (A.merkle) {
    const merkle = await ethers.getContractAt("SatoriMerkle", A.merkle);
    const pubNow = await merkle.rootPublisher();
    const pubPending = await merkle.pendingRootPublisher();
    if (pubPending !== ethers.ZeroAddress && pubNow.toLowerCase() !== pubPending.toLowerCase()) {
      const data = merkle.interface.encodeFunctionData("acceptRootPublisher", []);
      console.log(`== THE NOMINATED ROOT PUBLISHER MUST ALSO ACCEPT ==\n`);
      console.log(`  Until this runs the deployer still publishes merkle roots.\n`);
      console.log(`  From ${pubPending}, execute:\n`);
      console.log(`    to     ${A.merkle}`);
      console.log(`    value  0`);
      console.log(`    data   ${data}      (acceptRootPublisher())\n`);
    }
  }
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
