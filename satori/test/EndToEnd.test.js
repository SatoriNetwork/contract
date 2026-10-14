/**
 * End-to-End Integration Test: Full Satori Protocol Flow
 *
 * Covers the complete prediction → score → reward → claim pipeline:
 *   1. Deploy all 5 contracts and wire them together
 *   2. Mint initial tokens to deployer, transfer to Alice and Bob
 *   3. Create a Simple data stream and set authority
 *   4. Alice and Bob vote for the stream
 *   5. Day 1: set valueA (first update), Alice & Bob predict UP
 *   6. Day 2: set valueB (higher → direction is UP → day-1 prediction correct)
 *             Alice & Bob predict again (settling the day-1 prediction → streak 1)
 *   7. Day 3: set valueC; Alice & Bob predict again (settling the day-2
 *             prediction → streak 2)
 *   8. Day 4: Alice & Bob claim rewards
 *
 * SCORING NOTE: the stream is created through the public entry point, so it is
 * cadence 2 (daily) — the finest a public caller may ask for. A stream at
 * cadence >= 2 is NOT on the every-round A-B-C window (SatoriEngine:
 * `isABC = minCadenceRounds <= 1`); it resolves a prediction against the value
 * at the prediction round versus the NEXT value written. So each day's
 * prediction settles on the following day, and by day 3 TWO of them have.
 *   9. Assertions:
 *      - Both received minted tokens (balance increased)
 *      - Total minted ≤ 2880 tokens (1440/round × 2 scored rounds)
 *      - Alice received more than Bob (proportional to prediction power / stake)
 *      - No tokens were minted before the claim
 */
const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === "DataStreamCreated";
    } catch {
      return false;
    }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

// A round is 24h, and this scenario's stream is created at a 2880-minute
// (two-round) cadence so it scores on the AB window — one value per "day",
// scored by the next "day's" value. A scenario "day" is therefore one cadence
// period: CADENCE_ROUNDS protocol rounds (48h of wall clock).
const CADENCE_ROUNDS = 2;

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

async function advanceToNextDay() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceToNextRound();
}

// --------------------------------------------------------------------------
// Test Suite
// --------------------------------------------------------------------------

describe("End-to-End Integration: Full Satori Protocol Flow", function () {
  const UP = 1;

  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob;
  let streamId;

  // Track Alice & Bob balances before any claim so we can verify the delta
  let aliceBalanceBefore;
  let bobBalanceBefore;
  let totalSupplyBefore;
  // Snapshot taken BEFORE the first prediction of step 5, so assertion #4
  // ("no tokens were minted before the claim") spans the whole
  // predict → score → credit stretch instead of a zero-transaction window.
  let totalSupplyBeforePredicts;

  // -----------------------------------------------------------------------
  // Step 1: Deploy all 5 contracts and wire them together
  // -----------------------------------------------------------------------
  before(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, bounties, registry } = fix);
    owner = fix.owner;
    [, alice, bob] = fix.signers;
  });

  // -----------------------------------------------------------------------
  // Step 2: Transfer tokens to Alice and Bob
  // -----------------------------------------------------------------------
  it("2 — Transfer tokens: Alice gets 300, Bob gets 200 SATORI", async function () {
    await satori.transfer(alice.address, ethers.parseEther("300"));
    await satori.transfer(bob.address, ethers.parseEther("200"));

    expect(await satori.balanceOf(alice.address)).to.equal(ethers.parseEther("300"));
    expect(await satori.balanceOf(bob.address)).to.equal(ethers.parseEther("200"));
  });

  // -----------------------------------------------------------------------
  // Step 3: Create data stream and set authority
  // -----------------------------------------------------------------------
  it("3 — Create Simple data stream with owner as authority", async function () {
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("E2E Test Stream", owner.address, 2880);
    streamId = await getStreamIdFromTx(tx, registry);
    expect(streamId).to.not.equal(0);

    // Confirm authority (no-op — same address — but exercises the code path)
    await registry.setProvider(streamId, owner.address);
  });

  // -----------------------------------------------------------------------
  // Step 4: Alice and Bob vote for the stream; advance one day for eligibility
  // -----------------------------------------------------------------------
  it("4 — Alice and Bob burn SATORI to weight the stream", async function () {
    const supplyBefore = await satori.totalSupply();

    await satori.connect(alice).vote(streamId, VOTE);
    await satori.connect(bob).vote(streamId, VOTE);

    // Voting BURNS: the two 10-SATORI votes are destroyed, and the stream's
    // game keeps that 20 as PERMANENT weight — it never has to be refreshed.
    expect(await satori.balanceOf(alice.address)).to.equal(ethers.parseEther("290"));
    expect(await satori.balanceOf(bob.address)).to.equal(ethers.parseEther("190"));
    expect(await satori.totalSupply()).to.equal(supplyBefore - VOTE * 2n);
    expect(await voting.weightOf(streamId)).to.equal(VOTE * 2n);

    // Advance one day so the stream's weight is recorded and it becomes eligible
    await advanceToNextDay();
  });

  // -----------------------------------------------------------------------
  // Step 5 (Day 1): Set valueA, then both predict UP
  // Cadence-2 scoring: the prediction is resolved against valueA (the value at
  // the prediction round) versus the next value written, i.e. day 2's valueB.
  // -----------------------------------------------------------------------
  it("5 — Day 1: set stream value (valueA = 1000) and both predict UP", async function () {
    // Supply BEFORE any prediction/scoring happens. Everything from here to the
    // claim in step 9 is eager CREDIT into unclaimedRewards only — no mint
    // (docs/narratives/A_rewards.md:100-125).
    totalSupplyBeforePredicts = await satori.totalSupply();

    await registry.setValue(streamId, 1000); // valueA

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
  });

  // -----------------------------------------------------------------------
  // Step 6 (Day 2): Advance, set valueB (higher → UP direction)
  //   Predicting on day 2 settles the day-1 prediction: valueB (1500) > valueA
  //   (1000) → UP → both are CORRECT → streak = 1.
  // -----------------------------------------------------------------------
  it("6 — Day 2: valueB = 1500 (UP from 1000), Alice & Bob predict UP again", async function () {
    await advanceToNextDay();

    await registry.setValue(streamId, 1500); // valueB > valueA → direction UP

    // No re-vote: burned weight is permanent, so the stream stays weighted
    // without anyone spending again (and a burn here would move totalSupply,
    // which step 9 asserts is untouched between the first predict and the claim).

    // Predict again — this settles the day-1 prediction against valueB.
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // Day-1 prediction scored: 1500 > 1000 → UP → correct → streak 1.
    expect(await satori.streaks(alice.address, streamId)).to.equal(1);
    expect(await satori.streaks(bob.address, streamId)).to.equal(1);
  });

  // -----------------------------------------------------------------------
  // Step 7 (Day 3): Advance, set valueC (even higher → UP direction)
  //   Predicting on day 3 settles the DAY-2 prediction (anchor 1500, next value
  //   2000) → C > B → UP → both are CORRECT → streak = 2.
  // -----------------------------------------------------------------------
  it("7 — Day 3: valueC = 2000, predict again — the day-2 predictions are now scored", async function () {
    await advanceToNextDay();

    await registry.setValue(streamId, 2000); // valueC > valueB → direction UP

    // Still no re-vote needed — see step 6.

    // This predict call triggers scoring of the day-2 prediction
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // Two consecutive correct calls (day-1 settled on day 2, day-2 settled now).
    expect(await satori.streaks(alice.address, streamId)).to.equal(2);
    expect(await satori.streaks(bob.address, streamId)).to.equal(2);
  });

  // -----------------------------------------------------------------------
  // Step 8 (Day 4): Advance to day 4, snapshot balances, then claim
  // -----------------------------------------------------------------------
  it("8 — Advance to day 4 and snapshot balances before any claim", async function () {
    await advanceToNextDay();
    await registry.setValue(streamId, 2500); // provide a fresh value

    // Still no re-vote needed — see step 6.

    // Snapshot before any minting occurs
    aliceBalanceBefore = await satori.balanceOf(alice.address);
    bobBalanceBefore = await satori.balanceOf(bob.address);
    totalSupplyBefore = await satori.totalSupply();
  });

  // -----------------------------------------------------------------------
  // Step 9: Claim and verify all assertions
  // -----------------------------------------------------------------------
  it("9 — Claim rewards: both gain tokens, ≤2880 minted, proportional split", async function () {
    // Assertion #4 from the file header: NO tokens were minted before the claim.
    // Scoring is lazy and credit is EAGER into `unclaimedRewards`; the actual
    // `_rewardMint` only ever happens on the claim path.
    //
    // This used to compare against `totalSupplyBefore`, snapshotted as the last
    // statement of step 8 — i.e. AFTER every predict/score had already run, with
    // no transaction in between (this describe has no beforeEach). That was
    // `x == x` and could not fail: a settle-time mint would have been baked into
    // both sides. The snapshot now predates step 5's first prediction, so the
    // whole predict → score → credit stretch is covered.
    expect(await satori.totalSupply()).to.equal(totalSupplyBeforePredicts);

    await satori.connect(alice)["claim()"]();
    await satori.connect(bob)["claim()"]();

    const aliceBalanceAfter = await satori.balanceOf(alice.address);
    const bobBalanceAfter = await satori.balanceOf(bob.address);
    const totalSupplyAfter = await satori.totalSupply();

    const aliceGained = aliceBalanceAfter - aliceBalanceBefore;
    const bobGained = bobBalanceAfter - bobBalanceBefore;
    const totalMinted = totalSupplyAfter - totalSupplyBefore;

    // Both Alice and Bob received minted tokens
    expect(aliceGained).to.be.gt(0n, "Alice should receive rewards");
    expect(bobGained).to.be.gt(0n, "Bob should receive rewards");

    // Total minted must not exceed 2880 tokens — the 1440/round protocol cap
    // across the two rounds that scored here.
    expect(totalMinted).to.be.lte(
      ethers.parseEther("2880"),
      "Total minted must not exceed 2880 tokens"
    );

    // Sum of individual gains equals total minted (no tokens lost or duplicated)
    expect(aliceGained + bobGained).to.equal(
      totalMinted,
      "Sum of individual gains must equal total newly minted supply"
    );

    // Proportional check: Alice had 300 SATORI vs Bob's 200 SATORI →
    // higher prediction power → Alice should earn more.
    expect(aliceGained).to.be.gt(
      bobGained,
      "Alice (higher stake) should earn more than Bob"
    );
  });
});
