// Verify an ALREADY-DEPLOYED network, from scratch, at any time.
//
//   npx hardhat run scripts/verify-deployment.js --network baseSepolia
//   npx hardhat run scripts/verify-deployment.js --network base
//
// Closes the residue of D0-2 in docs/issues/test-coverage-audit.md: deploy.js
// checks 37 post-conditions, but only ONCE, in the same process that did the
// deploying and while holding every address in memory. Nothing could re-read a
// live network later and hard-fail on a mismatch. This can, from nothing but the
// address book.
//
// Read-only. It sends no transactions and needs no signer.
//
// ── WHY THE CHECKS ARE SPLIT IN TWO ────────────────────────────────────────
// deploy.js asserts a single instant: genesis. A re-runnable verifier cannot,
// because a live protocol MOVES. `totalSupply` grows every round, capability
// flags open on purpose, and the governor is meant to become the Safe and later
// address(0). Asserting genesis values forever would mean this script starts
// failing precisely because the launch went well.
//
// So:
//   INVARIANTS — must hold on every healthy deployment, forever. A failure here
//                is a real fault. These exit non-zero.
//   STATE      — true at genesis and legitimately changes afterwards. Reported
//                with the value, never asserted. Reading them is the point:
//                "offchainBudget is 10" is exactly the kind of thing that is
//                nobody's bug and everybody's problem (LAUNCH_CHECKLIST E2).
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;
const { runChecks, readPolicy } = require("./live-reads-lib");

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", YEL = "\x1b[33m", OFF = "\x1b[0m";

async function main() {
  const net = hre.network.name;
  const bookPath = process.env.ADDRESS_BOOK ||
    path.join(__dirname, "..", "deployments", `${net}.json`);
  if (!fs.existsSync(bookPath)) {
    throw new Error(`No address book at ${bookPath}. Deploy first, or set ADDRESS_BOOK.`);
  }
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const A = book.addresses;

  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  console.log(`\n  network      ${net} (chainId ${chainId})`);
  console.log(`  address book ${bookPath}`);
  if (book.chainId && Number(book.chainId) !== chainId) {
    // The single most dangerous mistake this script can make is verifying the
    // WRONG CHAIN and reporting green. Refuse rather than guess.
    throw new Error(
      `Address book is for chainId ${book.chainId} but the RPC is chainId ${chainId}. ` +
      `Refusing to verify a different chain than the book describes.`);
  }

  const at = async (name, addr) => ethers.getContractAt(name, addr);
  const token    = await at("SatoriToken", A.token);
  const hub      = await at("SatoriHub", A.hub);
  const engine   = await at("SatoriEngine", A.engine);
  const voting   = await at("SatoriVoting", A.voting);
  const rewards  = await at("SatoriRewards", A.rewards);
  const registry = await at("SatoriRegistry", A.registry);
  const games    = await at("SatoriGames", A.games);
  const bounties = await at("SatoriBounties", A.bounties);
  const airdrop  = await at("SatoriAirdrop", A.airdrop);

  const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  // ── INVARIANTS ─────────────────────────────────────────────────────────
  const invariants = [
    // Code is actually there. A book pointing at an empty address is the
    // failure mode of a half-finished or wrong-chain deploy.
    ...Object.entries(A).map(([k, v]) => [
      `${k} has code`, async () => (await provider.getCode(v)) !== "0x",
    ]),

    // The wiring ring: every child knows the hub and the engine, and the hub
    // knows every child. A single broken edge here bricks a lane.
    ["token.controller == hub",       async () => eq(await token.controller(), A.hub)],
    // The airdrop lane: the token's pointer is the only door and it points at
    // the book's SatoriAirdrop, which points back. No proxy on either side.
    ["token.airdrop == airdrop",      async () => eq(await token.airdrop(), A.airdrop)],
    ["airdrop.token == token",        async () => eq(await airdrop.token(), A.token)],
    ["token.hook == hub",             async () => eq(await token.hook(), A.hub)],
    ["voting.satoriCore == hub",      async () => eq(await voting.satoriCore(), A.hub)],
    ["voting.satoriEngine == engine", async () => eq(await voting.satoriEngine(), A.engine)],
    ["voting.satoriToken == token",   async () => eq(await voting.satoriToken(), A.token)],
    ["rewards.satoriCore == hub",     async () => eq(await rewards.satoriCore(), A.hub)],
    ["rewards.satoriEngine == engine",async () => eq(await rewards.satoriEngine(), A.engine)],
    ["rewards.satoriToken == token",  async () => eq(await rewards.satoriToken(), A.token)],
    ["registry.satoriCore == hub",    async () => eq(await registry.satoriCore(), A.hub)],
    ["registry.satoriEngine == engine", async () => eq(await registry.satoriEngine(), A.engine)],
    ["games.satoriCore == hub",       async () => eq(await games.satoriCore(), A.hub)],
    ["bounties.satoriToken == token", async () => eq(await bounties.satoriToken(), A.token)],
    ["hub.satoriRewards == rewards",  async () => eq(await hub.satoriRewards(), A.rewards)],

    // Governance instruments (present on stacks deployed after 2026-09-15;
    // both entries absent from older books, and the spread above already
    // proved code at their addresses when present). Neither holds authority;
    // the hub door is the lock path's ONE write edge into the protocol.
    ...(A.holderGovernor ? [
      ["holderGovernor.TOKEN == token", async () =>
        eq(await (await ethers.getContractAt("HistoricalBalanceGovernor", A.holderGovernor)).TOKEN(), A.token)],
    ] : []),
    ...(A.lockVoteGovernor ? [
      ["lockVoteGovernor.TOKEN == token", async () =>
        eq(await (await ethers.getContractAt("LockVoteGovernor", A.lockVoteGovernor)).TOKEN(), A.token)],
      ["lockVoteGovernor.HUB == hub", async () =>
        eq(await (await ethers.getContractAt("LockVoteGovernor", A.lockVoteGovernor)).HUB(), A.hub)],
      ["lockVoteGovernor.proposer is set (nonzero)", async () =>
        (await (await ethers.getContractAt("LockVoteGovernor", A.lockVoteGovernor)).proposer()) !== ethers.ZeroAddress],
      ["hub.voteLockGovernor == lockVoteGovernor", async () =>
        eq(await hub.voteLockGovernor(), A.lockVoteGovernor)],
    ] : []),

    // Proxy plumbing: each proxied contract runs the implementation the book
    // names. A mismatch means someone upgraded and the book was not updated,
    // which makes every other artifact in the repo untrustworthy.
    ["engine impl matches book",   async () => eq(await engine.implementation(), A.engineImpl)],
    ["voting impl matches book",   async () => eq(await voting.implementation(), A.votingImpl)],
    ["rewards impl matches book",  async () => eq(await rewards.implementation(), A.rewardsImpl)],
    ["registry impl matches book", async () => eq(await registry.implementation(), A.registryImpl)],
    ["games impl matches book",    async () => eq(await games.implementation(), A.gamesImpl)],
    ["bounties impl matches book", async () => eq(await bounties.implementation(), A.bountiesImpl)],
    ["hub impl matches book",      async () => eq(await hub.implementation(), A.hubImpl)],

    // The monetary constitution. None of these can EVER change, on any healthy
    // deployment, so they are invariants in the strongest sense available.
    ["PLATFORM_FEE_RECIPIENT is not the placeholder", async () => {
      const r = await token.PLATFORM_FEE_RECIPIENT();
      return r !== ethers.ZeroAddress &&
             !eq(r, "0x000000000000000000000000000000000000dEaD");
    }],
    // The OUTER ENVELOPE, not the emission rate. The hub clamps its rate at
    // its own copy of this, so the two must agree.
    ["ROUND_REWARD_BUDGET == 1440 (the envelope)", async () =>
      (await token.ROUND_REWARD_BUDGET()) === ethers.parseEther("1440")],
    ["hub ROUND_REWARD_BUDGET == token's", async () =>
      (await hub.ROUND_REWARD_BUDGET()) === (await token.ROUND_REWARD_BUDGET())],
    // The fee SHIPS at 15%. It is the DAO's to move afterwards, but only
    // inside a band the immutable token fixes — so what a deploy must pin is
    // the starting value AND the band, not the rate forever.
    ["devFeeBps ships at 1500 (15%)", async () =>
      (await token.devFeeBps()) === 1500n],
    ["dev fee band is [500, 2500] and unalterable", async () =>
      (await token.DEV_FEE_BPS_MIN()) === 500n &&
      (await token.DEV_FEE_BPS_MAX()) === 2500n],
    ["no fee change is pending at deploy", async () =>
      (await token.pendingDevFeeBps()) === 0n],
    // Every governor lever starts LIVE. Freezing is a deliberate later act, and
    // a deploy that shipped one already frozen would be unrecoverable — the
    // token has no upgrade path.
    // NO SLOT MAY BE EMPTY. A zero slot is unrecoverable for that job: nothing
    // but `root` can refill it, and a zero `root` cannot refill anything at all.
    // Cheap to check, permanent to get wrong.
    ["no authority slot is the zero address", async () =>
      (await token.rootAuthority()) !== ethers.ZeroAddress &&
      (await token.feeAuthority()) !== ethers.ZeroAddress &&
      (await token.upgradeAuthority()) !== ethers.ZeroAddress &&
      (await token.wiringAuthority()) !== ethers.ZeroAddress &&
      (await token.appointAuthority()) !== ethers.ZeroAddress &&
      (await token.freezeAuthority()) !== ethers.ZeroAddress],
    ["all four governor levers start unfrozen", async () =>
      (await token.controllerFrozen()) === false &&
      (await token.hookFrozen()) === false &&
      (await token.bridgeAuthorityFrozen()) === false &&
      (await token.devFeeBpsFrozen()) === false],
    // The genesis mint must be exactly ONE ROUND of the hub's schedule. Mint a
    // full 1440 instead and the protocol is over its own emission from block
    // zero — the hub's first rewardMint reverts and nothing can ever pay out.
    ["INITIAL_MINT == one round of the hub's emission", async () =>
      (await token.INITIAL_MINT()) === (await hub.BASE_EMISSION_PER_ROUND())],
    // `<=`: a ratio above 1.0 may legitimately drive the rate onto the clamp.
    ["emission sits inside the token's envelope", async () =>
      (await hub.emissionRateNow()) <= (await token.ROUND_REWARD_BUDGET()) &&
      (await hub.emissionRateNext()) <= (await token.ROUND_REWARD_BUDGET())],
    ["emissionCeiling <= token.rewardCeiling", async () =>
      (await hub.emissionCeiling()) <= (await token.rewardCeiling())],
    // The issuance-indexed schedule (docs/issues/emission-issuance-indexed-schedule.md).
    // Its genesis seed is pinned here only in the forms that stay true forever:
    // the counter starts at INITIAL_MINT and only rises, the first rate
    // segment starts at the deploy round, and until the rate first moves
    // (`from` still the deploy round) nothing is banked and both rates are base.
    ["emission schedule constants (730 / 1460 / φ−1)", async () =>
      (await hub.STEP_ROUNDS()) === 730n && (await hub.FLAT_ROUNDS()) === 1460n &&
      (await hub.PHI_INV()) === 618033988749894848n],
    ["emission.issued >= INITIAL_MINT", async () =>
      (await hub.emission()).issued >= (await token.INITIAL_MINT())],
    ["emission.from >= deploymentRound", async () =>
      (await hub.emission()).from >= (await token.deploymentRound())],
    ["emission at genesis segment: rate == prevRate == base, banked == 0", async () => {
      const e = await hub.emission();
      if (e.from !== (await token.deploymentRound())) return true;
      const base = await hub.BASE_EMISSION_PER_ROUND();
      return e.rate === base && e.prevRate === base && e.banked === 0n;
    }],
    // A PLACEHOLDER pending the real figure (owner, 2026-09-11). Pinned anyway:
    // it lives in the non-upgradeable token, so a deploy freezes it, and a
    // deploy that ships the wrong cap is a redeploy to fix.
    ["AIRDROP_TOTAL_SUPPLY == 1,200,000 (placeholder)", async () =>
      (await token.AIRDROP_TOTAL_SUPPLY()) === ethers.parseEther("1200000")],
    // SatoriAirdrop reads the ceiling THROUGH the token, so this can only fail
    // if the pointer is wrong — which is exactly what it is here to catch.
    ["airdrop AIRDROP_TOTAL_SUPPLY reads the token's", async () =>
      (await airdrop.AIRDROP_TOTAL_SUPPLY()) === (await token.AIRDROP_TOTAL_SUPPLY())],
    // Claims open at finalize, and finalize refuses until the token's door is
    // frozen on this airdrop (docs/issues/airdrop-claim-at-finalize.md). Not
    // airdropLocked: an emptied wiring slot does not count, root can refill it.
    // Holds by construction on current code; it catches a book whose airdrop
    // predates the freeze gate.
    ["airdrop finalized only behind a frozen door", async () =>
      !(await airdrop.airdropLoadingFinalized()) ||
      ((await token.airdropFrozen()) && eq(await token.airdrop(), A.airdrop))],
    ["HOME_CHAIN_ID == this chain", async () =>
      Number(await token.HOME_CHAIN_ID()) === chainId],
    ["deploymentRound is set", async () => (await token.deploymentRound()) > 0n],

    // Supply conservation. Every mint is counted (totalRewardsMinted,
    // airdropMinted, crosschainMinted) but the only counted burn is the
    // bridge's (crosschainBurned): a plain ERC20Burnable burn, which is what a
    // vote is, lowers totalSupply and no counter. So supply sits BELOW the
    // counted net by exactly what was burned that way, and never above it. Do
    // not tighten this back to an equality: it fails on any stack that has
    // seen a vote.
    ["totalSupply <= counted mints - bridge burns", async () =>
      (await token.totalSupply()) + (await token.crosschainBurned()) <=
      (await token.totalRewardsMinted()) + (await token.airdropMinted()) +
      (await token.crosschainMinted())],
    ["airdropMinted <= AIRDROP_TOTAL_SUPPLY", async () =>
      (await token.airdropMinted()) <= (await token.AIRDROP_TOTAL_SUPPLY())],
    // ONE WEI OF SLACK, deliberately. The genesis split floors the GENERAL
    // share onto the hub's cap and gives the dev the remainder, while
    // devFeeCeiling floors the fee's own 3/17 — two roundings that need not
    // agree. So the fee can legitimately sit a wei AHEAD of its ceiling on a
    // fresh deploy, which is also why mintDevFee saturates rather than
    // subtracting. Anything beyond a wei is a real accounting break.
    ["devFeeMinted <= devFeeCeiling + 1 wei (genesis rounding)", async () =>
      (await token.devFeeMinted()) <= (await token.devFeeCeiling()) + 1n],

    // The default stream and its game exist and are initialized. Without these
    // the protocol has nothing to pay anyone for.
    ["default stream (id 1) exists", async () => {
      const [, , , , , exists] = await registry.getDataStreamInfo(1);
      return exists;
    }],
    ["default game (id 1) is stream 1's binary game", async () =>
      Number(await games.binaryGameByStream(1)) === 1],
  ];

  // ── STATE (reported, never asserted) ───────────────────────────────────
  //
  // Every read here is individually fault-tolerant, and that is not defensive
  // padding — it is the case this script exists for. A deployed stack can be
  // OLDER than this repo, so a getter that exists in source may not exist on
  // chain. Base Sepolia hit exactly that: `bridgeAuthority` was added on
  // 2026-08-15, two weeks after that stack was deployed, and reading it reverts.
  //
  // A missing getter is information ("this deployment predates that feature"),
  // not a failure, and it must not be able to take the invariants down with it.
  const safe = async (label, fn, fmt = (v) => String(v)) => {
    try { return [label, fmt(await fn())]; }
    catch { return [label, `${DIM}unavailable (predates this getter, or reverted)${OFF}`]; }
  };
  const eth = (v) => `${ethers.formatEther(v)} SATORI`;

  const round = await token.getCurrentRound();
  const depRound = await token.deploymentRound();
  const state = [
    ["chain round", round.toString()],
    ["display round", (round - depRound + 1n).toString()],
    await safe("totalSupply", () => token.totalSupply(), eth),
    await safe("totalRewardsMinted", () => token.totalRewardsMinted(), eth),
    await safe("airdropMinted", () => token.airdropMinted(), eth),
    // The gap the supply invariant allows: plain burns (votes, or anyone
    // burning their own), which no counter records.
    await safe("burned (uncounted)", async () =>
      (await token.totalRewardsMinted()) + (await token.airdropMinted()) +
      (await token.crosschainMinted()) - (await token.crosschainBurned()) -
      (await token.totalSupply()), eth),
    await safe("devFeeMinted", () => token.devFeeMinted(), eth),
    await safe("PLATFORM_FEE_RECIPIENT", () => token.PLATFORM_FEE_RECIPIENT()),
    await safe("token.rootAuthority", () => token.rootAuthority()),
    await safe("token.feeAuthority", () => token.feeAuthority()),
    await safe("token.upgradeAuthority", () => token.upgradeAuthority()),
    await safe("token.wiringAuthority", () => token.wiringAuthority()),
    await safe("token.appointAuthority", () => token.appointAuthority()),
    await safe("token.freezeAuthority", () => token.freezeAuthority()),
    await safe("rewards.admin", () => rewards.admin()),
    await safe("airdrop.loader", () => airdrop.airdropAuthority()),
    await safe("airdrop.loadedTotal", async () => {
      const t = await airdrop.airdropLoadedTotal();
      // The freeze closes every table on this token, and the door can never be
      // re-pointed after it.
      return eth(t) + (t === 0n && (await token.airdropFrozen())
        ? `  ${YEL}<- door frozen with nothing loaded: this airdrop is empty forever${OFF}` : "");
    }),
    await safe("airdrop.loadingFinalized", () => airdrop.airdropLoadingFinalized()),
    await safe("token.airdropFrozen", () => token.airdropFrozen()),
    // What finalizeAirdropLoading waits for: the token's pointer is this
    // airdrop and frozen there.
    await safe("airdrop door pinned here", async () =>
      eq(await token.airdrop(), A.airdrop) && (await token.airdropFrozen())),
    await safe("bridgeAuthority", () => token.bridgeAuthority()),
    await safe("streams", () => registry.getDataStreamCount()),
    await safe("emissionHolder", () => hub.emissionHolder()),
    await safe("emission.rate now / next", async () =>
      `${eth(await hub.emissionRateNow())} / ${eth(await hub.emissionRateNext())}`),
    await safe("emission.issued", async () => (await hub.emission()).issued, eth),
    await safe("emission.nextStepAt", async () => {
      const e = await hub.emission();
      if (e.nextStepAt === (await hub.NO_STEP())) return "none (emission ended)";
      const genesis = (await hub.FLAT_ROUNDS()) * (await hub.BASE_EMISSION_PER_ROUND());
      return eth(e.nextStepAt) + (e.nextStepAt === genesis ? `  ${DIM}(genesis default)${OFF}` : "");
    }),
    await safe("emission.ratioWad", async () => {
      const r = (await hub.emission()).ratioWad;
      return ethers.formatEther(r) + (r === (await hub.PHI_INV()) ? `  ${DIM}(default φ−1)${OFF}` :
        r === ethers.WeiPerEther ? `  ${DIM}(1.0: steps off)${OFF}` : "");
    }),
    await safe("emission.stepsTaken / from", async () => {
      const e = await hub.emission();
      return `${e.stepsTaken} / round ${e.from}`;
    }),
  ];

  // Two values that are nobody's bug and everybody's problem if wrong at launch.
  let offchainBudget = null;
  try { offchainBudget = await rewards.offchainBudget(); } catch { /* older stack */ }
  const caps = [];
  try {
    for (let c = 0; c <= 7; c++) {   // eight capabilities, 0..7
      if (await rewards.capabilityAllowed(c, ethers.ZeroAddress)) caps.push(c);
    }
  } catch { /* older stack */ }

  // ── RUN ────────────────────────────────────────────────────────────────
  // Same lag-tolerant runner deploy.js uses: a failing probe is retried, because
  // on a live network "could not confirm" and "is broken" look identical on the
  // first read and demand opposite responses.
  const policy = readPolicy(net);
  console.log(`  read policy  ${policy.attempts} attempt(s), ${policy.delayMs}ms apart\n`);
  console.log(`  ${invariants.length} invariants:`);
  const { passedOn, failed, lastError } = await runChecks(invariants, { ...policy });

  // TWO KINDS OF FAILURE, and conflating them wastes a lot of time.
  //
  //   MISMATCH — the probe ran and returned false. A real wiring fault.
  //   SKEW     — the probe THREW. On a live network, after retries have ruled
  //              out lag, that almost always means the deployed bytecode has no
  //              such function: the chain is running an OLDER build than this
  //              repo. Nothing is broken; the deployment is stale.
  //
  // Base Sepolia is the live example: HOME_CHAIN_ID and bridgeAuthority both
  // arrived on 2026-08-15, two weeks after that stack was deployed.
  const skew = [], mismatch = [];
  for (const [name] of invariants) {
    if (passedOn.has(name)) {
      const attempt = passedOn.get(name);
      // Worth surfacing: a check that only passed on attempt 3 was read lag, not
      // health. Silent retries would hide that the endpoint is struggling.
      const note = attempt > 1 ? `${DIM} (confirmed on attempt ${attempt})${OFF}` : "";
      console.log(`    ${GREEN}ok  ${OFF} ${name}${note}`);
    } else if (lastError.get(name)) {
      skew.push(name);
      console.log(`    ${YEL}SKEW${OFF} ${name}${DIM} — reverted; deployed build lacks it${OFF}`);
    } else {
      mismatch.push(name);
      console.log(`    ${RED}FAIL${OFF} ${name}${DIM} — read a wrong value${OFF}`);
    }
  }

  console.log(`\n  state (reported, not asserted):`);
  for (const [k, v] of state) console.log(`    ${DIM}${k.padEnd(24)}${OFF} ${v}`);
  console.log(`    ${DIM}${"offchainBudget".padEnd(24)}${OFF} ` +
    (offchainBudget === null ? `${DIM}unavailable${OFF}` : `${offchainBudget}` +
      (offchainBudget > 0n ? `  ${YEL}<- must be 0 at mainnet launch (E2)${OFF}` : "")));
  console.log(`    ${DIM}${"capabilities ON".padEnd(24)}${OFF} ` +
    (caps.length ? caps.join(", ") : "none") +
    (caps.length ? `  ${DIM}(progressive rollout — expected to grow after launch)${OFF}` : ""));

  void failed;
  if (mismatch.length) {
    console.log(`\n  ${RED}${mismatch.length}/${invariants.length} INVARIANT(S) READ A WRONG VALUE${OFF}`);
    console.log(`  ${DIM}Each was retried ${policy.attempts}x, so this is not read lag. This is a real fault.${OFF}\n`);
    process.exitCode = 1;
    return;
  }
  if (skew.length) {
    // Non-zero too: "your chain is not running your code" should never pass a
    // release gate silently. But the message says which problem it is.
    console.log(`\n  ${YEL}${skew.length}/${invariants.length} check(s) could not run: SOURCE/DEPLOYMENT SKEW${OFF}`);
    console.log(`  ${DIM}Every wiring invariant that COULD be read holds, so the deployment is${OFF}`);
    console.log(`  ${DIM}healthy — it is just older than this repo. Redeploy to close the gap.${OFF}\n`);
    process.exitCode = 2;
    return;
  }
  console.log(`\n  ${GREEN}all ${invariants.length} invariants hold${OFF}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
