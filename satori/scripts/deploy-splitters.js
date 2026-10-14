// PHASE 1 of the Satori deploy — the fee-splitter tree.
//
//   npx hardhat run scripts/deploy-splitters.js --network baseSepolia
//
// Why this runs FIRST: `PLATFORM_FEE_RECIPIENT` is a constructor-set `immutable`
// on SatoriToken — a contract with no upgrade path and no setter. Splitter A's
// address becomes that value permanently, so A must exist before the token is
// constructed. There is no on-chain action, ever, that changes it afterwards.
// That makes this the most irreversible step in the whole deploy.
//
// THE TREE
//
//     A (top)  ->  C 60% , B 40%          <- PLATFORM_FEE_RECIPIENT
//     C        ->  PAYEE_1 50% , PAYEE_2 50%
//     B        ->  PAYEE_3 50% , PAYEE_4 50%
//
//   net: PAYEE_1 30%, PAYEE_2 30%, PAYEE_3 20%, PAYEE_4 20%
//
// Every node is a SatoriSplitterImmutable: recipients and shares are sealed at
// construction and can never change. There is no manager, no owner, no
// distribute, no token registry, and therefore no closing ceremony — the tree is
// final the moment it is deployed. Shares must total exactly 10000, so `shares`
// IS the percentage.
//
// Deployed leaf-first (C, B, then A) because A must name its children.
//
// THE ESCAPE HATCH, AND THE ROLES THAT GOVERN IT
// Immutable shares mean the only way to ever change a split is to deploy a NEW
// splitter and have the old one tell its PARENT to rotate the slot to it
// (`rotateAt` -> parent's `rotateRecipient`). That redirects future income only;
// funds already banked stay claimable under the old shares. Two doors open it:
//
//   * the AUTHORITY, unilaterally; or
//   * consent from slots holding >= the node's rotation threshold.
//
// So the roles are set per node, deliberately:
//
//   A  authority = NONE (address(0)),  threshold = default (90%)
//        Nothing sits above A, so it has no parent to rotate into and the power
//        would be meaningless. Passing address(0) means the door is never even
//        built. A's threshold is inert for the same reason. A is therefore
//        unchangeable by anyone, for any reason, forever — while C and B can
//        still each move their OWN slot within it.
//   C  authority = SPLITTER_AUTHORITY_C,  threshold = default (90%)
//   B  authority = SPLITTER_AUTHORITY_B,  threshold = 10%
//        B's low threshold lets a single leaf move B's slot in A without
//        waiting on its co-recipient. Both leaves are trusted parties, and B
//        carries the smaller 40% branch.
//
// The two authorities are SEPARATE ENV VARS on purpose: `authority` is per-node
// state on the contract (constructor arg -> `authority`), so each branch can be
// governed by a different party. Passing the same address to both is allowed and
// simply reproduces the older single-authority tree. Note that the authority is
// the only role here that is NOT frozen — each node's holder can hand it on with
// `transferAuthority` or close the door for good with `renounceAuthority`.
//
// Note the consequence of a threshold at or below 50%: a holder of a minority of
// the branch can redirect all of that branch's future income. That is chosen
// here, not overlooked — see rotationThresholdBps in the contract.
const { ethers, network } = require("hardhat");
// On a live network every read that follows a write is eventually consistent — a
// receipt is not a read barrier. Here that lands harder than anywhere else in the
// deploy: this script runs FIRST, and the tree it would wrongly declare unusable
// contains the node that becomes the token's IRREVERSIBLE PLATFORM_FEE_RECIPIENT.
// "Redeploy" is the natural response to a failed check and the expensive one — it
// builds a second tree, and on mainnet spends the one chance to set slot 7 right.
// See docs/issues/closed/rpc-read-after-write-lag-on-live-networks.md.
const { runChecks, waitForCode, readPolicy } = require("./live-reads-lib");
const fs = require("fs");
const path = require("path");

const BPS = 10000n;
const TOP_C_SHARE = 6000n;   // A -> C
const TOP_B_SHARE = 4000n;   // A -> B
const LEAF_SHARE  = 5000n;   // each leaf recipient

const DEFAULT_THRESHOLD = 0n;    // 0 == "use the contract default" (9000 = 90%)
const B_THRESHOLD       = 1000n; // 10%

function requireAddr(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`${name} is required. See .env.example.`);
  let a;
  try { a = ethers.getAddress(v); }
  catch { throw new Error(`${name} is not a valid address: ${v}`); }
  if (a === ethers.ZeroAddress) throw new Error(`${name} must not be the zero address`);
  return a;
}

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — set PRIVATE_KEY in .env");

  console.log(`\n  network   ${network.name} (chainId ${chainId})`);
  console.log(`  deployer  ${deployer.address}`);
  if (chainId === 8453) {
    console.log(`\n  !! BASE MAINNET. A's address becomes PLATFORM_FEE_RECIPIENT, an`);
    console.log(`     immutable on a token with no upgrade path. It can never be changed,`);
    console.log(`     and A's shares can never be changed either. Confirm below.\n`);
  }

  const payees = [1, 2, 3, 4].map((i) => requireAddr(`PAYEE_${i}`));
  const authorityC = requireAddr("SPLITTER_AUTHORITY_C");
  const authorityB = requireAddr("SPLITTER_AUTHORITY_B");

  const dupes = payees.filter((p, i) => payees.indexOf(p) !== i);
  if (dupes.length) throw new Error(`duplicate payee(s): ${[...new Set(dupes)].join(", ")}`);

  // A payee with code is allowed. Two things are worth confirming before the tree
  // is sealed, and neither is a reason to refuse one, so this warns and continues.
  //
  //   1. ETH. `_payOut` sends ETH with `call{value:}` and reverts EthTransferFailed
  //      if the payee rejects it (`SatoriSplitterImmutable.sol`), so a contract
  //      with no payable receive can never take an ETH share. ERC20 is unaffected —
  //      `safeTransfer` lands anywhere — and the dev fee is SATORI, so this is
  //      about stray ETH, not the fee.
  //   2. Rotation. `rotateRecipient` is payee-only and needs an originated call, so
  //      a contract that cannot originate can never move its own slot. The address
  //      is frozen; the money is not.
  //
  // What is explicitly NOT a risk, because it is easy to assume otherwise: being
  // unable to originate a call cannot strand a payee's SATORI. `withdraw(token,
  // slotId)` is permissionless while the gate is open and always pays
  // `_slots[slotId].payee`, never `msg.sender` — so anyone can push a payee's share
  // to it. That is the same property the tree's internal tiers rely on.
  // See docs/issues/closed/contract-payees-eth-and-rotation.md.
  for (const p of payees) {
    if ((await ethers.provider.getCode(p)) === "0x") continue;   // EOA, nothing to say
    const isSplitter = await new ethers.Contract(
      p, ["function slotCount() view returns (uint256)"], ethers.provider
    ).slotCount().then(() => true, () => false);
    console.log(`\n  !! payee ${p} is a contract${isSplitter ? " (a splitter — a normal sub-tree)" : ""}.`);
    console.log(`     Its SATORI arrives regardless: claiming is permissionless and always pays`);
    console.log(`     the slot's payee. Confirm anyway that it can accept ETH (or it forfeits any`);
    console.log(`     ETH share) and can originate a call (or its address is frozen, because`);
    console.log(`     rotateRecipient is payee-only).`);
  }

  console.log(`\n  rotation authority for C (60% branch)   ${authorityC}`);
  console.log(`  rotation authority for B (40% branch)   ${authorityB}`);
  if (authorityC === authorityB) {
    console.log(`  (both branches share one authority — allowed, but it is the`);
    console.log(`   single-authority tree; pass different addresses to separate them)`);
  }
  console.log(`  (A is deployed with NO authority — it has no parent to rotate into)\n`);
  console.log(`  PAYEE_1  ${payees[0]}   -> 30%   (via C)`);
  console.log(`  PAYEE_2  ${payees[1]}   -> 30%   (via C)`);
  console.log(`  PAYEE_3  ${payees[2]}   -> 20%   (via B)`);
  console.log(`  PAYEE_4  ${payees[3]}   -> 20%   (via B)`);

  const F = await ethers.getContractFactory("SatoriSplitterImmutable");

  async function deployLeaf(label, a, b, threshold, nodeAuthority) {
    const s = await F.deploy(nodeAuthority, [a, b], [LEAF_SHARE, LEAF_SHARE], threshold);
    await s.waitForDeployment();
    const addr = await s.getAddress();
    console.log(`\n  ${label}  ${addr}`);
    console.log(`     slot 0  ${a}  ${LEAF_SHARE} bps`);
    console.log(`     slot 1  ${b}  ${LEAF_SHARE} bps`);
    // Print the INTENT, which needs no chain read. Reading a contract back this
    // early is exactly where lag bites — the call reverts on a node that cannot
    // see the code yet and kills the run right after the tree was created, before
    // the operator has been shown a single address. The verification section below
    // asserts what is actually on chain, after a proper barrier.
    console.log(`     threshold ${threshold === DEFAULT_THRESHOLD ? "contract default" : `${threshold} bps`}   authority ${nodeAuthority}`);
    return s;
  }

  console.log(`\n== deploying leaf-first ==`);
  const C = await deployLeaf("C (60% branch)", payees[0], payees[1], DEFAULT_THRESHOLD, authorityC);
  const B = await deployLeaf("B (40% branch)", payees[2], payees[3], B_THRESHOLD, authorityB);

  const cAddr = await C.getAddress();
  const bAddr = await B.getAddress();
  const A = await F.deploy(
    ethers.ZeroAddress,               // no authority, by design
    [cAddr, bAddr],
    [TOP_C_SHARE, TOP_B_SHARE],
    DEFAULT_THRESHOLD
  );
  await A.waitForDeployment();
  const aAddr = await A.getAddress();
  console.log(`\n  A (top)   ${aAddr}`);
  console.log(`     slot 0  ${cAddr}  ${TOP_C_SHARE} bps  (C)`);
  console.log(`     slot 1  ${bAddr}  ${TOP_B_SHARE} bps  (B)`);
  console.log(`     threshold contract default   authority NONE`);

  // ---- read barrier ----------------------------------------------------------
  // All three nodes are brand new, so the lag that matters here is not a stale
  // pointer but the CODE not being visible yet — every verification read reverts
  // against a node that has not applied the creation block. Waiting on code is
  // strictly more targeted than waiting on block height: it asks the precise
  // question the reads below depend on.
  const policy = readPolicy(network.name);
  if (!policy.local) {
    console.log(`\n== waiting for the tree to be visible ==`);
    for (const [label, addr] of [["C", cAddr], ["B", bAddr], ["A", aAddr]]) {
      const size = await waitForCode(ethers.provider, addr, { log: console.log });
      if (size === 0) {
        throw new Error(
          `could not confirm code at ${label} (${addr}). The deployment transactions ` +
          `SUCCEEDED — this is a read that has not caught up, not a failed deploy. Check ` +
          `a block explorer before doing anything else: re-running builds a SECOND tree, ` +
          `and on mainnet spends the one chance to set PLATFORM_FEE_RECIPIENT correctly.`
        );
      }
      console.log(`  ok   ${label}  ${addr}  ${size} bytes`);
    }
  }

  // The contract's own default, read with the same retry discipline as everything
  // else: the A and C threshold checks compare against it, so a lagging read here
  // would poison their expected value rather than merely delay them.
  let DEFAULT_BPS;
  const pre = await runChecks([["read the contract's default rotation threshold", async () => {
    DEFAULT_BPS = BigInt(await A.DEFAULT_ROTATION_THRESHOLD_BPS());
    return DEFAULT_BPS > 0n;
  }]], { ...policy, log: console.log });
  if (pre.failed.length) {
    throw new Error(
      `could not read DEFAULT_ROTATION_THRESHOLD_BPS from A (${aAddr}) — the tree IS ` +
      `deployed; confirm on a block explorer before redeploying.`
    );
  }

  // ---- verify the FINISHED tree on-chain, not the calls we just made ----
  // Each check is a PROBE, not a pre-computed boolean, so one that fails can be
  // re-read on its own — the whole point, since a stale read and a genuinely wrong
  // tree are indistinguishable from a single look. See live-reads-lib.js.
  console.log(`\n== verifying on-chain ==`);
  const checks = [];
  const check = (msg, probe) => checks.push([msg, probe]);

  for (const [label, s, expected, wantThreshold, wantAuthority] of [
    ["A", A, [[cAddr, TOP_C_SHARE], [bAddr, TOP_B_SHARE]], DEFAULT_BPS, ethers.ZeroAddress],
    ["C", C, [[payees[0], LEAF_SHARE], [payees[1], LEAF_SHARE]], DEFAULT_BPS, authorityC],
    ["B", B, [[payees[2], LEAF_SHARE], [payees[3], LEAF_SHARE]], B_THRESHOLD, authorityB],
  ]) {
    check(`${label} has exactly 2 slots`, async () => Number(await s.slotCount()) === 2);
    for (let i = 0; i < expected.length; i++) {
      const [wantPayee, wantShares] = expected[i];
      check(`${label} slot ${i} payee is ${wantPayee}`, async () =>
        ethers.getAddress((await s.getSlot(i))[0]) === ethers.getAddress(wantPayee));
      check(`${label} slot ${i} is ${wantShares} bps`, async () =>
        BigInt((await s.getSlot(i))[1]) === wantShares);
    }
    check(`${label} shares total exactly 100%`, async () => {
      let sum = 0n;
      for (let i = 0; i < expected.length; i++) sum += BigInt((await s.getSlot(i))[1]);
      return sum === BPS;
    });
    check(`${label} totalShares == ${BPS}`, async () => BigInt(await s.totalShares()) === BPS);
    check(`${label} rotation threshold is ${wantThreshold} bps`, async () =>
      BigInt(await s.rotationThresholdBps()) === wantThreshold);
    check(`${label} authority is ${wantAuthority === ethers.ZeroAddress ? "NONE" : wantAuthority}`,
      async () => ethers.getAddress(await s.authority()) === ethers.getAddress(wantAuthority));
    // Immutability is structural — assert the mutable-splitter surface is absent
    // rather than merely unused, so a future swap back cannot pass unnoticed.
    // ABI-only: no chain read, so lag cannot reach these either way.
    for (const fn of ["addRecipient", "setShares", "removeRecipient", "distribute", "trackToken", "renounceManager"]) {
      check(`${label} has no ${fn}() — shares are structurally fixed`, async () =>
        s.interface.fragments.filter((f) => f.type === "function" && f.name === fn).length === 0);
    }
    // The withdraw gate (`withdrawCaller`, 9a9b9994) is per-slot state a PAYEE
    // sets, never a deploy-time decision — the constructor cannot write it, so
    // every slot starts at address(0), meaning anyone may trigger. Asserted
    // rather than assumed because the tree's payout path depends on it: A's
    // slots are the C and B contracts, and a splitter has no way to call
    // setWithdrawCaller, so an internal tier that started life gated could
    // never ungate itself. Same reasoning as the absent-function checks above.
    for (let i = 0; i < expected.length; i++) {
      check(`${label} slot ${i} withdraw gate is open (anyone may trigger)`, async () =>
        (await s.withdrawCaller(i)) === ethers.ZeroAddress);
    }
  }

  const treeAddrs = [aAddr, bAddr, cAddr].map((x) => x.toLowerCase());
  for (const p of payees) {
    check(`payee ${p} is not part of the tree (no cycle)`, async () =>
      !treeAddrs.includes(p.toLowerCase()));
  }

  // Effective distribution, derived from what is actually on chain. The probe
  // populates `eff`, so the table printed below is the data this check verified
  // rather than a second, unverified read of the same slots.
  let eff = {};
  check(`effective distribution totals 100%`, async () => {
    const next = {};
    for (const [parentShare, leaf] of [[TOP_C_SHARE, C], [TOP_B_SHARE, B]]) {
      for (let i = 0; i < 2; i++) {
        const [payee, shares] = await leaf.getSlot(i);
        next[ethers.getAddress(payee)] = (parentShare * BigInt(shares)) / BPS;
      }
    }
    eff = next;
    return Object.values(next).reduce((a, b) => a + b, 0n) === BPS;
  });

  const { passedOn, failed, lastError } = await runChecks(checks, { ...policy, log: console.log });
  const failedMsgs = new Set(failed.map(([m]) => m));
  for (const [msg] of checks) {
    const why = failedMsgs.has(msg) ? lastError.get(msg) : null;
    console.log(`  ${failedMsgs.has(msg) ? "FAIL" : "ok  "} ${msg}${why ? `  (${why})` : ""}`);
  }

  if (Object.keys(eff).length) {
    console.log(`\n== effective distribution ==`);
    for (const [addr, bps] of Object.entries(eff)) {
      console.log(`  ${addr}  ${Number(bps) / 100}%`);
    }
  }

  if (failed.length > 0) {
    console.error(`\n  ${failed.length} CHECK(S) FAILED — do NOT use this tree.`);
    if (policy.attempts > 1) {
      console.error(`  Each was re-read ${policy.attempts}x over ~${(policy.attempts - 1) * policy.delayMs / 1000}s against code`);
      console.error(`  already confirmed on chain, so this is a real fault, not RPC lag.`);
    }
    console.error(`  Fix the inputs and redeploy; nothing points at this tree yet, and the`);
    console.error(`  addresses above are inert until PLATFORM_FEE_RECIPIENT names one.\n`);
    process.exit(1);
  }
  const lagged = [...passedOn.values()].filter((a) => a > 1).length;
  if (lagged) {
    console.log(`\n  (${lagged} check(s) confirmed only on a re-read — RPC lag, not a tree fault)`);
  }

  // Hand the tree to Phase 2 as a FILE, not as something to retype. A's address
  // becomes an immutable on a token with no upgrade path, so a transcription slip
  // here is the one mistake in this whole system that can never be corrected —
  // and "copy this line into .env" is exactly the step where that happens.
  // deploy.js reads this and, if PLATFORM_FEE_RECIPIENT is also set in the
  // environment, refuses to run unless the two agree.
  const out = path.join(__dirname, "..", "deployments", `splitters-${network.name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({
    network: network.name, chainId,
    platformFeeRecipient: aAddr,          // <- what Phase 2 consumes
    a: aAddr, c: cAddr, b: bAddr,
    payees: { PAYEE_1: payees[0], PAYEE_2: payees[1], PAYEE_3: payees[2], PAYEE_4: payees[3] },
    authorities: { C: authorityC, B: authorityB },
    deployer: deployer.address,
  }, null, 2));

  console.log(`\n== PHASE 1 COMPLETE — the tree is already final ==`);
  console.log(`\n  Written to ${out}`);
  console.log(`  deploy.js reads PLATFORM_FEE_RECIPIENT from there — do not retype it.\n`);
  console.log(`    PLATFORM_FEE_RECIPIENT=${aAddr}\n`);
  console.log(`  Record the branches (needed only to propose a future rotation):\n`);
  console.log(`    SPLITTER_A=${aAddr}`);
  console.log(`    SPLITTER_C=${cAddr}   (60% branch)`);
  console.log(`    SPLITTER_B=${bAddr}   (40% branch)\n`);
  console.log(`  There is no closing step. Shares are sealed, there is no token`);
  console.log(`  registry, and withdrawals need no poke. NEXT: run deploy.js.\n`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
