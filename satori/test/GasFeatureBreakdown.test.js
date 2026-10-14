// Per-feature gas breakdown for a bundled "predict + settle yesterday" call.
//
// Strategy: measure a baseline call with everything stripped down, then
// add features one at a time and measure the delta. Each delta is the
// approximate "cost of having this feature enabled" per cadence period,
// per stream, per predictor.
//
// The "bundled" measurement is the realistic one: a real predictor calls
// `predict(stream, dir)` once per cadence period (daily on a public,
// cadence-2 stream), which settles yesterday's prediction and makes
// today's new one in a single tx.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, deploySatoriFixtureNoFee, pack1, VOTE } = require("./fixtures");

const UP = 1;
const ROUND_SECONDS = 86400;                                  // 24h
// The stream comes from the 2-arg overload, i.e. cadence 2 (daily) — what a real
// user gets. The bundled predict+settle a real predictor makes therefore happens
// once per cadence period, and every value write below is spaced accordingly.
const CADENCE_ROUNDS = 2;
const CADENCE_SECONDS = ROUND_SECONDS * CADENCE_ROUNDS;       // 24h

async function getStreamIdFromTx(tx, satori) {
  const rc = await tx.wait();
  for (const log of rc.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (_) {}
  }
  throw new Error("DataStreamCreated missing");
}

// One full cadence period — the gap between two legal value writes.
async function advance() {
  await time.increase(CADENCE_SECONDS);
}

// Set up the baseline scenario: one predictor with one prior correct
// prediction ready to settle. Returns gas for the bundled tx (which
// settles yesterday's correct prediction AND makes today's new one).
//
// `setup` is a hook that can add features to the baseline before the
// bundled measurement (e.g. fund bounty, delegate to alice, etc.).
async function measureBundled(setup, { noFee = false } = {}) {
  const fix = await loadFixture(noFee ? deploySatoriFixtureNoFee : deploySatoriFixture);
  const { satori, rewards, registry, owner, signers } = fix;
  const [, alice, bob, funder, refUser] = signers;
  // The fixture initializes the default stream itself now (game id 1).

  const INITIAL_MINT = await satori.INITIAL_MINT();
  await satori.transfer(alice.address, INITIAL_MINT / 4n);
  await satori.transfer(bob.address, INITIAL_MINT / 4n);
  await satori.transfer(funder.address, INITIAL_MINT / 10n);

  // One stream, weighted by a burn from both alice and bob.
  const txS = await satori.createSimpleDataStream("S", owner.address);
  const streamId = await getStreamIdFromTx(txS, satori);
  await registry.setValue(streamId, 1000);
  await satori.connect(alice).vote(streamId, VOTE);
  await satori.connect(bob).vote(streamId, VOTE);

  // Run the per-test setup hook BEFORE alice's first prediction so any
  // delegation, bounty, stake, etc. is in place when she predicts.
  await setup({ fix, alice, bob, funder, refUser, streamId });

  // === First round: alice predicts UP. ===
  await advance();
  await registry.setValue(streamId, 1000);   // A
  await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

  // === Set B above A so UP wins. ===
  await advance();
  await registry.setValue(streamId, 1100);   // B
  await advance();
  await registry.setValue(streamId, 1200);   // C

  // === Second round: bundled tx — settles yesterday's correct + predicts. ===
  await advance();
  await registry.setValue(streamId, 1300);
  const tx = await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
  const rc = await tx.wait();
  return Number(rc.gasUsed);
}

describe("Gas: per-feature breakdown for bundled predict+settle", function () {
  it("measures each feature's marginal cost", async function () {
    this.timeout(600000);

    // ============================================================
    // BASELINE — default fees on, no delegation, no bounty, no stakes
    // ============================================================
    const baseline = await measureBundled(async () => {});

    // ============================================================
    // PLATFORM FEES — set both to 0 (cost of having them ON = baseline - this)
    // ============================================================
    const noPlatformFees = await measureBundled(async () => {}, { noFee: true });

    // ============================================================
    // PROTOCOL FEES — zero them out (cost on predict+settle path)
    // ============================================================
    const noProtocolFees = await measureBundled(async () => {}, { noFee: true });

    // ============================================================
    // PREDICTION DELEGATION — bob delegates HIS power TO alice.
    // This means alice's predict has someone-delegated-to-her, so
    // _splitReward runs the delegated branch + writes the per-round
    // delegator-rate accumulator at score time.
    // ============================================================
    const withDelegation = await measureBundled(async ({ fix, alice, bob }) => {
      await fix.satori.connect(bob).delegatePredictionPower(alice.address);
    });

    // ============================================================
    // BOUNTY FUNDED — funder funds a bounty token on the stream.
    // This adds the per-token drip-capture and per-token credit work
    // inside scoreCorrectPrediction.
    // ============================================================
    const withBounty = await measureBundled(async ({ fix, funder, streamId }) => {
      const M = await ethers.getContractFactory("MockERC20");
      const t = await M.deploy("Mock", "M");
      await t.waitForDeployment();
      await t.mint(funder.address, ethers.parseEther("1000000"));
      await t.connect(funder).approve(fix.bounties.target, ethers.parseEther("1000000"));
      await fix.bounties.connect(funder).fundBounty(
        streamId,
        await t.getAddress(),
        ethers.parseEther("1000000"),
        ethers.parseEther("100"),    // 100 tokens per round
      );
    });

    // ============================================================
    // BOUNTY STAKE — alice has a stake in a bounty-funded token.
    // This adds applyBoost work at predict time + per-prediction
    // boost-snapshot reads at score time.
    // ============================================================
    const withStake = await measureBundled(async ({ fix, alice, funder, streamId }) => {
      const M = await ethers.getContractFactory("MockERC20");
      const t = await M.deploy("Mock", "M");
      await t.waitForDeployment();
      // Fund stream so the boost actually pays out
      await t.mint(funder.address, ethers.parseEther("1000000"));
      await t.connect(funder).approve(fix.bounties.target, ethers.parseEther("1000000"));
      await fix.bounties.connect(funder).fundBounty(
        streamId,
        await t.getAddress(),
        ethers.parseEther("1000000"),
        ethers.parseEther("100"),
      );
      // Alice stakes some
      await t.mint(alice.address, ethers.parseEther("10000"));
      await t.connect(alice).approve(fix.bounties.target, ethers.parseEther("10000"));
      await fix.bounties.connect(alice).stakeBountyToken(await t.getAddress(), ethers.parseEther("10000"));
    });

    // ============================================================
    // REFERRAL — alice has a referral pointer.
    // Referral cut is taken at CLAIM, not predict — expected ~0 delta.
    // ============================================================
    const withReferral = await measureBundled(async ({ fix, alice, refUser }) => {
      await fix.rewards.connect(alice).setReferral(refUser.address);
    });

    // ============================================================
    // CLAIM DELEGATION — alice has a claim delegate set.
    // Affects claim, not predict — expected ~0 delta.
    // ============================================================
    const withClaimDelegate = await measureBundled(async ({ fix, alice, bob }) => {
      await fix.satori.connect(alice).delegateClaimAbility(bob.address);
    });

    // ============================================================
    // REPORT
    // ============================================================
    const fmt = (n) => Number(n).toLocaleString().padStart(9);
    const delta = (m, b) => {
      const d = m - b;
      const sign = d >= 0 ? "+" : "";
      return `${sign}${Number(d).toLocaleString()}`;
    };
    console.log("\n=== Per-feature gas breakdown (bundled predict+settle) ===\n");
    console.log(`BASELINE (default fees on, no other features):      ${fmt(baseline)}`);
    console.log("");
    console.log("Each line below: scenario gas — delta vs baseline (negative = feature saves gas when disabled)");
    console.log("");
    console.log(`Platform fees DISABLED:                              ${fmt(noPlatformFees)}   ${delta(noPlatformFees, baseline)}`);
    console.log(`Protocol fees DISABLED:                              ${fmt(noProtocolFees)}   ${delta(noProtocolFees, baseline)}`);
    console.log(`Prediction delegation ADDED (bob → alice):           ${fmt(withDelegation)}   ${delta(withDelegation, baseline)}`);
    console.log(`Bounty token funded on stream:                       ${fmt(withBounty)}   ${delta(withBounty, baseline)}`);
    console.log(`Bounty token funded + alice has stake:               ${fmt(withStake)}   ${delta(withStake, baseline)}`);
    console.log(`Referral set (alice → refUser):                      ${fmt(withReferral)}   ${delta(withReferral, baseline)}`);
    console.log(`Claim delegation set (alice → bob):                  ${fmt(withClaimDelegate)}   ${delta(withClaimDelegate, baseline)}`);
    console.log("");
    console.log("Interpretation:");
    console.log("  - Negative delta with feature DISABLED = cost of having that feature ON.");
    console.log("  - Positive delta with feature ADDED   = direct cost of adding that feature.");
  });
});
