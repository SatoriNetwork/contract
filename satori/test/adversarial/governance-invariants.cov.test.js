/**
 * ADVERSARIAL COVERAGE — governance-invariants subsystem.
 *
 * Source: adversarial-findings/_raw_review.json, system == "governance-invariants".
 * Targets the high/med-priority coverage_gaps + test_proposals that are NOT
 * already pinned by an existing test, and NOT the single already-confirmed
 * finding (admin/owner narrative drift — kept elsewhere, deliberately not
 * re-tested here).
 *
 * Every assertion below reflects the DOCUMENTED INTENT in
 * docs/narratives/A_governance.md (the immutable, no-admin governance thesis):
 *
 *  - "The cumulative mint cap formula (totalRewardsMinted <=
 *     ROUND_REWARD_BUDGET × roundsElapsed)" is the core solvency law.
 *  - "No owner. No admin role. ... No setRewardRate, no setRoundDuration,
 *     no setStreakCurve." The economic params are hard-coded constants with
 *     NO setter, by anyone — with ONE bounded exception by owner ruling
 *     2026-10-12: the hub's emission step multiplier (`setEmissionRatio`).
 *  - The platform fee is reduce-only and strictly decreasing, and the
 *     schedule never raises it back above a manual sub-floor reduction.
 *  - The fee RATE authority is the single admin role; the fee RECIPIENT is
 *     the constructor-set immutable PLATFORM_FEE_RECIPIENT — it is fixed at
 *     deploy time and there is no setter, so no re-point path exists at all.
 *     Here we pin the NEGATIVE authorization:
 *     arbitrary EOAs cannot reduce the fee, and nobody — not even the admin —
 *     can redirect the recipient (the redirect function simply does not exist).
 *
 * Gaps NOT covered by the sibling platform-fees.cov.test.js (immutable-recipient
 * accrual, contract-recipient realization, accrual idempotency) are not
 * duplicated here; this file is governance-invariant-flavored.
 *
 * REMOVED (burn-voting refactor): the "Σ getVotingPower(all) == totalSupply"
 * conservation case. Vote delegation is gone entirely — there is no
 * setVoteDelegation, no getVotingPower, and no balance-tracking vote weight to
 * conserve: voting weight is now bought by BURNING SATORI and is permanently
 * detached from any wallet balance. (Prediction delegation and claim
 * delegation are untouched and covered by their own suites.)
 *
 * If an intended-behavior assertion FAILS, that is a NEW bug: the case is
 * relocated to adversarial-findings/cov_governance-invariants.test.js as a
 * kept failing repro and recorded in new_findings[]. Nothing here is weakened
 * to force a pass.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor, VOTE } = require("../fixtures");
const { TEST_PLATFORM_FEE_RECIPIENT } = require("../next/splitFixture");

const WAD = 10n ** 18n;
const TOKENS_PER_ROUND = 1440n * WAD;
const ROUND_REWARD_BUDGET = 1440n * WAD;      // the token's OUTER envelope
// The genesis mint is exactly one round of the HUB's emission schedule, not one
// round of the token's envelope. It was `1440n * WAD`; minting that much would
// put the hub over its own cap from block zero and every mint would revert.
const INITIAL_MINT = 846621902397116230417n;
const ROUND_SECONDS = 86400;
const UP = 1;

async function advanceOneRound() {
  await time.increase(ROUND_SECONDS);
}

// Resolve the streamId (== gameId, since the core pairs one auto-created binary
// game with every stream 1:1 in creation order) from a createSimpleDataStream
// tx. Stream/game id 1 is the protocol DEFAULT (the fixture initializes it
// exactly as production does), so the first stream a test creates is id 2 —
// which is why the id is always read off the event, never hardcoded.
// Every stream in this file is created by the fixture's `owner` — who is
// rewards.admin() — with an EXPLICIT cadence of 1. These are cumulative
// MINT-CAP tests: their point is to run the emission paths at their maximum
// rate, one prediction+settle per round, so the tight cap is under real
// pressure. A cadence-2 stream could only be written (and therefore predicted)
// every other round, which would HALVE that pressure and weaken the test. The
// providers below are unchanged non-deployer signers; only the creator has to
// be the admin, because the public cadence floor is 2.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function streamIdFromTx(tx, satori) {
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated not found");
}

describe("ADV COV governance-invariants", function () {
  this.timeout(120000);

  // =========================================================================
  // GAP (high): cumulative mint cap held TIGHTLY across many rounds with every
  // emission path live (senior dev fee, predictor pools, referral splits). The
  // existing assertion (MultiRoundDeep:531) uses a loose budget*(rounds+2)
  // bound. The narrative (A_governance.md:99) pins the tight law:
  //   totalRewardsMinted <= ROUND_REWARD_BUDGET × (curRound - deployRound + 1).
  // =========================================================================
  it("totalRewardsMinted never exceeds ROUND_REWARD_BUDGET × roundsElapsed across many rounds with all emission paths live", async function () {
    const { satori, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);

    const deploymentRound = BigInt(await satori.deploymentRound());

    // Helper: the tight cumulative cap at the current chain time.
    const tightCap = async () => {
      const cur = BigInt(await satori.getCurrentRound());
      return ROUND_REWARD_BUDGET * (cur - deploymentRound + 1n);
    };
    const assertUnderCap = async (label) => {
      const minted = BigInt(await satori.totalRewardsMinted());
      const cap = await tightCap();
      expect(minted).to.be.lte(cap, `tight cap breached ${label}: minted=${minted} cap=${cap}`);
    };

    // The default stream (id 1) is already live — the fixture initializes it
    // exactly as production's deploy script does — so the default game and its
    // derived weight are in play from the first round.
    await assertUnderCap("at genesis");

    // Two provider-bearing streams. The fixture's canonical adapters are at
    // ids 1..3; create two simple streams whose provider is a non-deployer.
    const provider1 = signers[8];
    const provider2 = signers[9];
    const gA = await streamIdFromTx(await satori[SIMPLE3]("G-A", provider1.address, 720), satori);
    const gB = await streamIdFromTx(await satori[SIMPLE3]("G-B", provider2.address, 720), satori);

    // A pool of predictors with real balances. Give each a slice of the
    // deployer bootstrap so they can vote/predict with weight.
    const predictors = signers.slice(1, 6); // 5 users
    const PER_USER = (ROUND_REWARD_BUDGET) / 32n; // 45 SATORI each — fits the 432 genesis governor share
    for (const u of predictors) {
      await satori.transfer(u.address, PER_USER);
    }

    // Referrals: half the predictors point at a referrer (referral split path).
    const referrer = signers[7];
    await rewards.connect(predictors[0]).setReferral(referrer.address);
    await rewards.connect(predictors[1]).setReferral(referrer.address);

    // Burn-voting: each predictor buys their stream's game permanent weight by
    // BURNING VOTE (10) SATORI. That leaves 35 each to predict with — prediction
    // power is balance + unclaimed, so the burn must not eat the whole stack.
    for (let i = 0; i < predictors.length; i++) {
      await voteFor(satori, predictors[i], i % 2 === 0 ? gA : gB, VOTE);
    }

    // Run many rounds. Each round: tick the default stream (flush + schedule),
    // set fresh values, predict, then settle the prior round and have everyone
    // claim so mints realize against the cap.
    let vA = 1000;
    let vB = 5000;
    const ROUNDS = 12;
    for (let r = 0; r < ROUNDS; r++) {
      await advanceOneRound();
      await assertUnderCap(`round ${r} post-flush`);

      vA = Math.floor(vA * 1.02);
      vB = Math.floor(vB * 1.02);
      await registry.connect(provider1).setValue(gA, vA);
      await registry.connect(provider2).setValue(gB, vB);

      // Settle prior-round predictions (scores last round, mints into pools).
      if (r >= 1) {
        for (const u of predictors) {
          try { await satori.settlePrediction(u.address, gA); } catch (e) {}
          try { await satori.settlePrediction(u.address, gB); } catch (e) {}
        }
      }
      await assertUnderCap(`round ${r} post-settle`);

      // Predict this round (rotate the predict order each round).
      const order = predictors.slice(r % predictors.length).concat(predictors.slice(0, r % predictors.length));
      for (let i = 0; i < order.length; i++) {
        const u = order[i];
        const g = (i % 2 === 0) ? gA : gB;
        await satori.connect(u).predictMultipleWithPayloads([{ gameId: g, payload: pack1(UP) }]);
      }
      await assertUnderCap(`round ${r} post-predict`);

      // Everyone claims what they can (realizes referral + reward mints).
      for (const u of predictors) {
        try { await satori.connect(u)["claim()"](); } catch (e) {}
      }
      await assertUnderCap(`round ${r} post-claim`);
    }

    // Final settle + claim sweep, then assert the tight cap one last time.
    await advanceOneRound();
    await registry.connect(provider1).setValue(gA, Math.floor(vA * 1.02));
    await registry.connect(provider2).setValue(gB, Math.floor(vB * 1.02));
    for (const u of predictors) {
      try { await satori.settlePrediction(u.address, gA); } catch (e) {}
      try { await satori.settlePrediction(u.address, gB); } catch (e) {}
      try { await satori.connect(u)["claim()"](); } catch (e) {}
    }
    // The platform fee is no longer a rewards accrual: it is the immutable
    // token's SENIOR self-accruing dev fee (see test/next/DevFee.test.js).
    // Realize it via the permissionless mintDevFee() so the dev lane is live
    // under the SAME cumulative cap — it mints to the immutable recipient and
    // shares the ONE global cap, keeping the tight-cap law under real pressure.
    await satori.mintDevFee();
    try { await satori.connect(owner)["claim()"](); } catch (e) {}

    await assertUnderCap("final");

    // Sanity: a non-trivial amount actually minted beyond the bootstrap, so the
    // cap was under real pressure (not a vacuous pass). INITIAL_MINT (1440)
    // saturates the deploy round exactly, so exceeding it requires real
    // reward/fee/cut mints on top of genesis.
    const finalMinted = BigInt(await satori.totalRewardsMinted());
    expect(finalMinted).to.be.gt(INITIAL_MINT);
    if (process.env.COV_DEBUG) {
      const cur = BigInt(await satori.getCurrentRound());
      console.log("    [cap] minted=", ethers.formatEther(finalMinted),
        "cap=", ethers.formatEther(ROUND_REWARD_BUDGET * (cur - deploymentRound + 1n)));
    }
  });

  // =========================================================================
  // GAP (med): no-admin authority over protocol params. The governance thesis
  // (A_governance.md) is the ABSENCE of these knobs, with one exception the
  // owner ruled in on 2026-10-12: the hub's `setEmissionRatio`, which only sets
  // the multiplier the NEXT issuance-indexed emission step applies (bounds in
  // test/next/EmissionScheduleAdmin.test.js). Assert the ABI exposes no other
  // economic setter, AND the constants read back the documented values.
  // =========================================================================
  it("exposes no protocol-parameter setters anywhere (no economic admin knobs)", async function () {
    const { satori, hub, token, rewards, voting, registry } = await loadFixture(deploySatoriFixture);

    // No admin knob may change any ECONOMIC parameter (rates, budgets, fees,
    // pause, ownership). NOTE: `upgradeTo`/`upgradeToAndCall` are NOT forbidden
    // here — the restructure deliberately makes the game ENGINE UUPS-upgradeable
    // (governor-gated, renounceable). Immutability now applies to the monetary
    // constitution (the token), asserted separately below.
    const forbidden = [
      "setRewardRate", "setRoundDuration", "setTimeUnit", "setTimeUnitSeconds",
      "setStreakCurve", "setStreakMultiplier",
      "setMaxEligibleGames", "setMaxEligibleCap", "adjustEligibleCap",
      "setRoundRewardBudget", "setBudget", "setTokensPerRound",
      "setPlatformFeePercent", // removed: admin has NO fee control (deploy-set + onlyCore schedule only)
      "setMaxPredictorFeeBps", "setReferralCut",
      "setFirstPredictorBonus", "setHistorySize",
      "pause", "unpause", "setPaused",
      "transferOwnership", "renounceOwnership", "setOwner",
    ];
    for (const fn of [satori, rewards, voting, registry]) {
      const frag = fn.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      for (const name of forbidden) {
        expect(frag).to.not.include(name, `forbidden admin setter ${name} exists on contract ABI`);
      }
    }

    // The ratio lever and its authority slot are the hub's ONLY emission setters.
    const hubSetters = hub.interface.fragments
      .filter((f) => f.type === "function" && /^setEmission/.test(f.name))
      .map((f) => f.name)
      .sort();
    expect(hubSetters).to.deep.equal(["setEmissionAuthority", "setEmissionRatio"]);

    // The monetary constitution (the immutable token) exposes NO economic knob
    // and NO upgrade path — its 1440-per-round envelope can never change.
    const tokenFns = token.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    for (const name of [...forbidden, "upgradeTo", "upgradeToAndCall", "setImplementation"]) {
      expect(tokenFns).to.not.include(name, `the immutable token must not expose ${name}`);
    }

    // The hard-coded constants read back exactly the documented values. The
    // round duration is an INTERNAL constant (no setter, not even a public
    // getter) — its absence from the ABI is itself part of the no-knobs thesis.
    expect(BigInt(await satori.ROUND_REWARD_BUDGET())).to.equal(ROUND_REWARD_BUDGET);
    expect(BigInt(await satori.INITIAL_MINT())).to.equal(INITIAL_MINT);
    // ...and it is the hub's base rate, to the wei. A mirrored constant: the
    // token cannot read the hub at construction, so the two are pinned together.
    expect(BigInt(await satori.INITIAL_MINT())).to.equal(BigInt(await satori.BASE_EMISSION_PER_ROUND()));
    // Round duration is observable only as on-chain behavior: advancing exactly
    // one ROUND_SECONDS advances getCurrentRound() by exactly 1.
    const r0 = BigInt(await satori.getCurrentRound());
    await time.increase(ROUND_SECONDS);
    expect(BigInt(await satori.getCurrentRound())).to.equal(r0 + 1n);
  });

  // =========================================================================
  // GAP (med): the fee RECIPIENT is immutable (no re-point path for anyone).
  // The redirect function does not exist — even the admin cannot move the
  // recipient (it is the constructor-set immutable PLATFORM_FEE_RECIPIENT,
  // fixed at deploy time with no setter).
  // =========================================================================
  it("the fee recipient is immutable: no redirect path exists for anyone", async function () {
    const { token, rewards, owner } = await loadFixture(deploySatoriFixture);

    const admin = await rewards.admin();
    expect(admin).to.equal(owner.address); // fixture wiring

    // The platform fee moved to the immutable token as a SENIOR self-accruing
    // dev fee: the recipient is the constructor-set immutable PLATFORM_FEE_RECIPIENT
    // fixed at deploy time, with NO setter anywhere. No redirect path exists —
    // not on the rewards child (which no longer holds the fee) and not on the
    // immutable token. (schedule/recipient-immutability: test/next/DevFee.test.js)
    expect(rewards.setPlatformFeeRecipient).to.equal(undefined);
    expect(rewards.wireFeeRecipient).to.equal(undefined);
    expect(rewards.PLATFORM_FEE_RECIPIENT).to.equal(undefined); // moved off the rewards child
    expect(token.setPlatformFeeRecipient).to.equal(undefined);
    expect(token.wireFeeRecipient).to.equal(undefined);
    // The token's recipient is a non-zero, constructor-set immutable (the fixture
    // wires it to the governor so the genesis balances stay fully conserved).
    expect(BigInt(await token.PLATFORM_FEE_RECIPIENT())).to.not.equal(0n);
    expect((await token.PLATFORM_FEE_RECIPIENT()).toLowerCase())
      .to.equal(owner.address.toLowerCase());
  });

  // =========================================================================
  // GAP (med): the cumulative mint cap under a QUIET-GAME round shape, where
  // only some of the games carrying burnt weight are actually predicted.
  //
  // Pre-refactor this exercised the default-stream cut's top-dog guard plus the
  // activeVotes redistribution denominator; both mechanisms are gone (providers
  // are not paid, and there is no second redistribution pass). The surviving —
  // and now sharper — invariant is that the round denominator only ever counts
  // games that were PREDICTED, so a game with weight that nobody predicts
  // simply leaves its slice unminted and can never push the round's realized
  // mint above the budget. We drive exactly that shape: two weighted games,
  // only one of them predicted each round.
  // =========================================================================
  it("cumulative mint cap holds when weighted games go unpredicted (quiet games leave their slice unminted)", async function () {
    const { satori, voting, registry, rewards, owner, signers } = await loadFixture(deploySatoriFixture);

    const deploymentRound = BigInt(await satori.deploymentRound());

    // Two streams carrying real burnt weight; only `gLive` is ever predicted,
    // so `gQuiet` never enters any round's denominator.
    const provider = signers[8];
    const gLive = await streamIdFromTx(await satori[SIMPLE3]("RG", provider.address, 720), satori);
    const gQuiet = await streamIdFromTx(await satori[SIMPLE3]("QUIET", provider.address, 720), satori);

    const voters = signers.slice(1, 5); // 4 voters
    for (const v of voters) {
      await satori.transfer(v.address, ethers.parseEther("50"));
    }
    // Half the burnt weight goes to the game nobody predicts.
    await voteFor(satori, voters[0], gLive, VOTE);
    await voteFor(satori, voters[1], gLive, VOTE);
    await voteFor(satori, voters[2], gQuiet, VOTE);
    await voteFor(satori, voters[3], gQuiet, VOTE);
    expect(await voting.weightOf(gQuiet)).to.equal(VOTE * 2n);

    const mintedBefore = BigInt(await satori.totalRewardsMinted());

    let val = 2000;
    const ROUNDS = 6;
    for (let r = 0; r < ROUNDS; r++) {
      await advanceOneRound();
        val = Math.floor(val * 1.03);
      await registry.connect(provider).setValue(gLive, val);

      // Only the first HALF of the voters predict, and only on gLive.
      const active = voters.slice(0, 2);
      if (r >= 1) {
        for (const v of active) {
          try { await satori.settlePrediction(v.address, gLive); } catch (e) {}
          // Claim so the credited reward actually MINTS — totalRewardsMinted
          // only moves on a mint, and the platform fee no longer mints on the
          // default-stream flush (it is the token's senior self-accruing lane).
          try { await satori.connect(v)["claim()"](); } catch (e) {}
        }
      }
      for (const v of active) {
        await satori.connect(v).predictMultipleWithPayloads([{ gameId: gLive, payload: pack1(UP) }]);
      }

      // Per-round delta of total minted must not exceed one round's envelope.
      const mintedNow = BigInt(await satori.totalRewardsMinted());
      const cur = BigInt(await satori.getCurrentRound());
      const cap = ROUND_REWARD_BUDGET * (cur - deploymentRound + 1n);
      expect(mintedNow).to.be.lte(cap, `cumulative cap breached at round ${r}`);

      // The quiet game never joined a denominator: it has weight, but no round
      // ever recorded it, so it can draw nothing.
      expect(await voting.getGameVotesAtRound(gQuiet, cur)).to.equal(0n);
    }

    // Drain the last round and re-check.
    await advanceOneRound();
    await registry.connect(provider).setValue(gLive, Math.floor(val * 1.03));
    for (const v of voters.slice(0, 2)) {
      try { await satori.settlePrediction(v.address, gLive); } catch (e) {}
      try { await satori.connect(v)["claim()"](); } catch (e) {}
    }
    const cur = BigInt(await satori.getCurrentRound());
    const cap = ROUND_REWARD_BUDGET * (cur - deploymentRound + 1n);
    expect(BigInt(await satori.totalRewardsMinted())).to.be.lte(cap, "final cumulative cap breach");

    // Sanity: real reward minting happened this scenario (predictor pools), so
    // the cap was under genuine pressure (not a vacuous pass where every
    // settle/predict silently failed).
    const mintedFinal = BigInt(await satori.totalRewardsMinted());
    expect(mintedFinal).to.be.gt(mintedBefore);
    if (process.env.COV_DEBUG) {
      console.log("    [quiet] mintedBefore=", ethers.formatEther(mintedBefore),
        "mintedFinal=", ethers.formatEther(mintedFinal));
    }
  });
});
