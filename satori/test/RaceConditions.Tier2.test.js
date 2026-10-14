/**
 * RACE CONDITIONS TEST SUITE — TIER 2
 *
 * Medium-risk ordering tests: delegation state changes interleaved
 * with transfers, votes (burns), claims, and scoring.
 *
 * Vote delegation is gone (weight is bought by burning and is permanent, so
 * there is nothing to delegate), which removed the "Transfer + Vote delegation"
 * block wholesale. The remaining two delegation lanes — PREDICTION delegation
 * and CLAIM delegation — are unchanged and still covered here.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// A round is 24h and a public caller may only create streams at cadence >= 2
// rounds — which is what `createSimpleDataStream(name, provider)` now hands out.
// So a "day" here is a real 24h day (CADENCE_ROUNDS rounds), which is also the
// spacing the streams below require between two value writes. The ordering
// hazards under test all play out INSIDE one round and are unaffected.
const ROUND = 86400;                            // 24h
const CADENCE_ROUNDS = 2;                       // daily

async function advanceOneDay() {
  await time.increase(ROUND * CADENCE_ROUNDS);
}

async function getStreamIdFromTx(tx, contract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try { return contract.interface.parseLog(log)?.name === 'DataStreamCreated'; }
    catch { return false; }
  });
  return contract.interface.parseLog(event).args.streamId;
}

describe("Race Conditions: Tier 2", function () {
  let satori, voting, rewards, bounties, registry, lens;
  let owner, alice, bob, carol, dave;
  let stream1, stream2;
  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, bounties, registry, lens } = fix);
    [owner, alice, bob, carol, dave] = fix.signers;

    // Equal-actor setup derived from INITIAL_MINT (4 × INITIAL_MINT/8).
    // Each actor burns VOTE (10) below and keeps 80 — enough for the inner
    // transfers (50 ether, 30 ether) and for predicting.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const PER_ACTOR = INITIAL_MINT / 8n;
    await satori.transfer(alice.address, PER_ACTOR);
    await satori.transfer(bob.address, PER_ACTOR);
    await satori.transfer(carol.address, PER_ACTOR);
    await satori.transfer(dave.address, PER_ACTOR);

    // The fixture initializes the default stream at id 1, so S1/S2 are 2/3.
    const tx1 = await satori.createSimpleDataStream("S1", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.createSimpleDataStream("S2", owner.address);
    stream2 = await getStreamIdFromTx(tx2, satori);

    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream1);
    await voteFor(satori, carol, stream2);
    await voteFor(satori, dave, stream2);

    await advanceOneDay();
    await registry.setValue(stream1, 100);
    await registry.setValue(stream2, 200);
  });

  // The previous "Transfer + Vote delegation" block was removed: vote
  // delegation no longer exists, and vote weight no longer follows token
  // balances at all (it is burnt into a game permanently). The successor
  // property — weight is untouched by transfers and mints — is asserted in
  // "Vote weight conservation" at the bottom of this file.

  // ============================================================
  // UNDELEGATION + RE-DELEGATION + CLAIM (same round)
  // ============================================================
  describe("Undelegation + re-delegation + claim chains", function () {
    it("prediction: undelegate then re-delegate same round", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Undelegate
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Re-delegate to carol in same round
      // Alice's lockedUntil is now currentDate + 1 (from undelegation cooldown)
      // Delegating while locked should fail
      await expect(
        satori.connect(alice).delegatePredictionPower(carol.address)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("claim: undelegate then claim same round succeeds (no cooldown)", async function () {
      await satori.connect(alice).delegateClaimAbility(bob.address);
      await satori.connect(alice).delegateClaimAbility(ethers.ZeroAddress);

      // Same-round self-claim succeeds.
      await expect(
        satori.connect(alice)["claim()"]()
      ).to.not.be.reverted;
    });

    it("claim: undelegate then re-delegate then new delegate claims same round succeeds", async function () {
      await satori.connect(alice).delegateClaimAbility(bob.address);
      await satori.connect(alice).delegateClaimAbility(ethers.ZeroAddress);
      await satori.connect(alice).delegateClaimAbility(carol.address);

      // Carol claims for alice in the same round — succeeds.
      await expect(
        satori.connect(carol)["claimFor(address,address)"](alice.address, carol.address)
      ).to.not.be.reverted;
    });

    // The "vote: undelegate then re-delegate same round works" case was removed
    // with setVoteDelegation. There is no vote-delegation state to churn: a
    // burn is a one-way purchase of permanent weight.
  });

  // ============================================================
  // MULTIPLE DELEGATION TYPES CHANGING SIMULTANEOUSLY
  // ============================================================
  describe("Multiple delegation types in same round", function () {
    it("delegate both remaining types to different people in same round", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(alice).delegateClaimAbility(dave.address);

      // Verify both are set independently (vote delegation no longer exists).
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(dave.address);
    });

    it("delegate predictions then vote: the delegation lock blocks the burn", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Delegating locks alice's tokens (lane A) and voting BURNS them, so the
      // two collide — but the hub resolves it rather than refusing: it
      // undelegates her, burns, and re-delegates in one transaction, so the
      // delegate is never left predicting on destroyed tokens. The vote lands
      // and the delegation survives.
      const w2 = await voting.weightOf(stream2);
      const [delegateBefore] = await rewards.predictionDelegateInfo(alice.address);
      await voteFor(satori, alice, stream2);
      expect(await voting.weightOf(stream2)).to.equal(w2 + VOTE);
      const [delegateAfter] = await rewards.predictionDelegateInfo(alice.address);
      expect(delegateAfter).to.equal(delegateBefore);
    });

    it("voting does not disturb an existing prediction delegation", async function () {
      // Burn first (while unlocked), then delegate prediction power.
      await voteFor(satori, alice, stream2);
      const weightAfterBurn = await voting.weightOf(stream2);
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob can still predict with alice's power, and the burnt weight is
      // untouched by the delegation.
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const round = await satori.getCurrentRound();
      expect(await satori.predictedStreamsCount(bob.address, round)).to.equal(1);
      expect(await voting.weightOf(stream2)).to.equal(weightAfterBurn);
    });

    it("claim delegate change doesn't affect prediction delegation", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(alice).delegateClaimAbility(dave.address);

      // Change claim delegate
      await satori.connect(alice).delegateClaimAbility(owner.address);

      // Prediction delegation unchanged
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
      expect(await rewards.claimDelegateInfo(alice.address)).to.equal(owner.address);
    });
  });

  // ============================================================
  // SCORING ACROSS DELEGATION CHANGES
  // ============================================================
  describe("Scoring across delegation changes", function () {
    it("delegate predicts, delegator undelegates, then scoring happens", async function () {
      // Alice delegates to bob, bob predicts
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Value goes up (correct prediction)
      await advanceOneDay();
      await registry.setValue(stream1, 150);

      // Alice undelegates before scoring happens
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Bob predicts again — triggers scoring of previous prediction
      // Scoring should use the delegation snapshot from prediction time, not current state
      await advanceOneDay();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Bob should have rewards from his share of the scored prediction
      const bobClaimable = (await lens.getTotalClaimableRewards(bob.address))[0];
      expect(bobClaimable).to.be.gt(0);
    });

    it("delegator switches delegate between prediction and scoring", async function () {
      // Alice delegates to bob, bob predicts
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Value goes up
      await advanceOneDay();
      await registry.setValue(stream1, 150);

      // Alice switches to carol before scoring
      // First alice needs to be unlocked from undelegation cooldown
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
      await advanceOneDay();
      await registry.setValue(stream1, 200);
      await satori.connect(alice).delegatePredictionPower(carol.address);

      // Carol predicts — bob's old prediction gets scored in bob's predict call
      await advanceOneDay();
      await registry.setValue(stream1, 250);
      await satori.connect(carol).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Bob's original prediction should still be scorable
      // He needs to interact to trigger his own scoring
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const bobClaimable = (await lens.getTotalClaimableRewards(bob.address))[0];
      expect(bobClaimable).to.be.gt(0);
    });

    it("claim during scoring round: rewards from scored predictions included", async function () {
      // A cadence-2 stream resolves a prediction against the value at its own
      // round versus the NEXT value written, so each predict below settles the
      // one before it.
      // R1: predict
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: value goes up
      await advanceOneDay();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: another value — the R2 prediction now has 150 → 200 to resolve on
      await advanceOneDay();
      await registry.setValue(stream1, 200);

      // Alice predicts (scores R2: anchor 150, next 200 → correct) then claims
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const balBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice)["claim()"]();
      const balAfter = await satori.balanceOf(alice.address);

      expect(balAfter).to.be.gt(balBefore);
    });
  });

  // ============================================================
  // VOTE WEIGHT CONSERVATION UNDER STRESS
  //
  // Successor to the old "voting power == total supply" invariant. Voting power
  // is no longer a view over balances: weight is BURNT into a game and is
  // permanent, so the invariant that matters now is that `totalBurnedWeight`
  // exactly accounts for the per-game weights and that neither moves when
  // tokens move or new tokens are minted.
  // ============================================================
  describe("Vote weight conservation", function () {
    it("totalBurnedWeight equals the sum of the voted games' weights", async function () {
      const w1 = await voting.weightOf(stream1);
      const w2 = await voting.weightOf(stream2);
      expect(w1).to.equal(VOTE * 2n);   // alice + bob
      expect(w2).to.equal(VOTE * 2n);   // carol + dave
      expect(await voting.totalBurnedWeight()).to.equal(w1 + w2);

      // The default game is NOT part of totalBurnedWeight — its weight is
      // DERIVED from it (1% of the resulting denominator, total*100/9900) and
      // never burnt. Here total is 40e18, so 1% (~0.4e18) is under the 1e18
      // floor and the derived weight clamps to exactly the 1e18 floor.
      expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));
    });

    it("conservation holds across transfers between holders", async function () {
      const totalBefore = await voting.totalBurnedWeight();
      const w1Before = await voting.weightOf(stream1);
      const w2Before = await voting.weightOf(stream2);

      await satori.connect(alice).transfer(carol.address, ethers.parseEther("50"));
      await satori.connect(dave).transfer(bob.address, ethers.parseEther("30"));

      // Weight is burnt, not balance-backed: moving tokens moves nothing.
      expect(await voting.weightOf(stream1)).to.equal(w1Before);
      expect(await voting.weightOf(stream2)).to.equal(w2Before);
      expect(await voting.totalBurnedWeight()).to.equal(totalBefore);
      expect(await voting.totalBurnedWeight()).to.equal(w1Before + w2Before);
    });

    it("conservation holds after claim mints new tokens", async function () {
      // Generate rewards
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceOneDay();
      await registry.setValue(stream1, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      await advanceOneDay();
      await registry.setValue(stream1, 200);
      // 100 → 150 → 200 are now all on the ring, so alice has two settled,
      // correct predictions and a real credited reward to claim.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const totalBefore = await voting.totalBurnedWeight();
      const w1Before = await voting.weightOf(stream1);
      const w2Before = await voting.weightOf(stream2);
      const supplyBefore = await satori.totalSupply();

      // Claim (mints tokens)
      await satori.connect(alice)["claim()"]();
      expect(await satori.totalSupply()).to.be.gt(supplyBefore);

      // Minting new supply cannot inflate anyone's vote weight.
      expect(await voting.weightOf(stream1)).to.equal(w1Before);
      expect(await voting.weightOf(stream2)).to.equal(w2Before);
      expect(await voting.totalBurnedWeight()).to.equal(totalBefore);
      expect(await voting.totalBurnedWeight()).to.equal(w1Before + w2Before);
    });
  });

});
