/**
 * THREE-WAY INTERACTIONS TEST SUITE
 *
 * Tests for interactions between Vote + Prediction + Claim.
 *
 * Vote DELEGATION is gone — voting now burns tokens for permanent game weight,
 * so there is nothing to delegate and nothing to keep in sync. The two
 * delegations that remain (prediction and claim) are unchanged, and the vote
 * side is now an economic interaction instead of a delegation one: burning to
 * vote spends the very tokens that prediction power is measured in.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch { return false; }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  return satoriContract.interface.parseLog(event).args.streamId;
}

async function advanceRound() {
  await time.increase(86400);
}

describe("Three-Way Interactions (Vote + Prediction + Claim)", function () {
  let satori, voting, rewards, bounties, registry;
  let PER_ACTOR;
  let owner, alice, bob, carol, dave;
  let stream1, stream2;
  const UP = 1, DOWN = 2;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties } = fix);
    [owner, alice, bob, carol, dave] = fix.signers;

    // The default stream owns id 1, so these come back as 2 and 3. Cadence
    // 1440 minutes (every round): the subject is the vote / prediction / claim
    // interaction, and the stream is only scaffolding.
    const tx1 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, satori);
    const tx2 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // Equal-actor setup derived from INITIAL_MINT (4 × INITIAL_MINT/8).
    const INITIAL_MINT = await satori.INITIAL_MINT();
    PER_ACTOR = INITIAL_MINT / 8n;
    await satori.transfer(alice.address, PER_ACTOR);
    await satori.transfer(bob.address, PER_ACTOR);
    await satori.transfer(carol.address, PER_ACTOR);
    await satori.transfer(dave.address, PER_ACTOR);

    // Carol and dave buy the two streams their baseline weight; alice and bob
    // each add some of their own. Every voter is down exactly VOTE afterwards —
    // the tokens are burnt, not staked.
    await voteFor(satori, carol, stream1);
    await voteFor(satori, dave, stream2);
    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream2);
    await advanceRound();
  });

  describe("1. Independent prediction + claim delegation", function () {
    it("Should handle vote, prediction→A and claim→C all working together", async function () {
      // Owner buys stream1 more weight.
      await voteFor(satori, owner, stream1);
      await advanceRound();

      // Alice delegates prediction to Bob and claiming to Dave. Delegating
      // prediction power locks the delegator's tokens indefinitely, so any
      // burning she wants to do must already have happened (it did, in the
      // beforeEach).
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(alice).delegateClaimAbility(dave.address);

      // Bob predicts in round 2
      await registry.setValue(stream1, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Carol buys stream2 some weight in the same round — voting is open to
      // anyone who is not transfer-locked.
      await voteFor(satori, carol, stream2);

      // Advance to round 3 and make prediction correct
      await advanceRound();
      await registry.setValue(stream1, 1100); // Stream went up - Bob was correct

      // Advance to round 4 and trigger scoring by Bob predicting again
      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // scores round 2

      // Bob claims his own rewards.
      const bobBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob).claim();
      const bobAfter = await satori.balanceOf(bob.address);
      expect(bobAfter).to.be.greaterThan(bobBefore, "Bob earned and claimed rewards");

      // Dave, Alice's claim delegate, may also claim on her behalf.
      await satori.connect(dave).claimFor(alice.address, alice.address);
    });
  });

  describe("2. Predict + Vote Same Round", function () {
    it("Should allow voting and predicting in the same round", async function () {
      await registry.setValue(stream1, 1000);

      const currentRound = await satori.getCurrentRound();
      const stream2WeightBefore = await voting.weightOf(stream2);

      // Alice buys stream2 more weight...
      await voteFor(satori, alice, stream2);
      expect(await voting.weightOf(stream2)).to.equal(stream2WeightBefore + VOTE);

      // ...and predicts on stream1 in the SAME round.
      // NOTE the ordering: predicting sets the token's transfer lock, and a
      // vote burns tokens, so the burn has to come first.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const prediction = await satori.predictions(alice.address, stream1, currentRound);
      expect(prediction.direction).to.equal(UP);
    });
  });

  describe("3. Delegated Prediction + Own Vote", function () {
    it("Should allow delegating prediction while still voting", async function () {
      // Alice burns for stream1 first — delegating prediction power locks her
      // tokens indefinitely, so afterwards she could not burn.
      await voteFor(satori, alice, stream1);
      await satori.connect(alice).delegatePredictionPower(bob.address);

      const currentRound = await satori.getCurrentRound();

      // Bob can predict with Alice's power.
      await registry.setValue(stream2, 1000);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }]);

      // Bob's prediction power = his own balance + Alice's delegated balance.
      // Bob burnt VOTE once (beforeEach), Alice burnt VOTE twice (beforeEach
      // plus the vote above). The first-predictor liveness bonus is gone, so
      // there is nothing else in the sum.
      const bobPower = await rewards.getPredictionPower(bob.address);
      expect(bobPower).to.equal(PER_ACTOR * 2n - VOTE * 3n);
    });
  });

  describe("4. Claim Delegator's Rewards", function () {
    it("Should allow claim delegate to claim on behalf of delegator", async function () {
      // Owner buys stream1 more weight.
      await voteFor(satori, owner, stream1);
      await advanceRound();

      await satori.connect(alice).delegateClaimAbility(bob.address);

      // Alice predicts in round 2. Her stream1 burn from the beforeEach is
      // permanent, so no re-voting is needed to keep the game earning.
      await registry.setValue(stream1, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Advance to round 3 and make prediction correct (value B)
      await advanceRound();
      await registry.setValue(stream1, 1100);

      // Advance to round 4 and trigger scoring (value C)
      await advanceRound();
      await registry.setValue(stream1, 1200);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]); // scores round 2

      // Advance more rounds to accumulate rewards
      await advanceRound();
      await advanceRound();
      await advanceRound();

      // Alice delegated claiming to Bob, so Bob may call claimFor on her behalf.
      const aliceBalanceBefore = await satori.balanceOf(alice.address);
      const bobBalanceBefore = await satori.balanceOf(bob.address);

      await satori.connect(bob).claimFor(alice.address, bob.address);

      const aliceBalanceAfter = await satori.balanceOf(alice.address);
      const bobBalanceAfter = await satori.balanceOf(bob.address);

      // The recipient argument decides who is paid — here, Bob.
      expect(bobBalanceAfter).to.be.greaterThan(bobBalanceBefore);
      expect(aliceBalanceAfter).to.equal(aliceBalanceBefore);
    });
  });

  describe("5. Vote Weight with Delegated Prediction", function () {
    it("Should keep burnt vote weight when prediction is delegated", async function () {
      // Alice's beforeEach burn already bought stream1 weight.
      const stream1WeightBefore = await voting.weightOf(stream1);
      expect(stream1WeightBefore).to.be.gt(0n);

      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Weight is backed by DESTROYED tokens, so moving prediction power
      // around cannot move, reduce, or revoke it.
      expect(await voting.weightOf(stream1)).to.equal(stream1WeightBefore);
      expect(await voting.isEligible(stream1)).to.equal(true);
    });
  });

  describe("6. Prediction Power and Voting", function () {
    it("Should reduce prediction power by exactly the amount burnt to vote", async function () {
      // Alice already burnt VOTE once in the beforeEach.
      const alicePredPowerBefore = await rewards.getPredictionPower(alice.address);
      expect(alicePredPowerBefore).to.equal(PER_ACTOR - VOTE);

      await voteFor(satori, alice, stream2);

      // Voting SPENDS: prediction power is balance + unclaimed, and the burnt
      // tokens no longer exist.
      const alicePredPowerAfter = await rewards.getPredictionPower(alice.address);
      expect(alicePredPowerAfter).to.equal(PER_ACTOR - VOTE * 2n);

      const currentRound = await satori.getCurrentRound();

      // She can still predict with what is left.
      await registry.setValue(stream2, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }]);

      const prediction = await satori.predictions(alice.address, stream2, currentRound);
      expect(prediction.direction).to.equal(UP);
    });
  });
});
