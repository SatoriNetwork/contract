const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, voteFor, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Helper function to extract streamId from DataStreamCreated event
async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch {
      return false;
    }
  });

  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

// Helper to advance to next round (test mode enabled)
async function advanceToNextRound() {
  await time.increase(86400);
}

describe("Prediction Delegation", function () {
  let satori, voting, rewards, bounties, registry, engine, lens;
  let owner;
  let alice;
  let bob;
  let carol;
  let dave;
  let platform;

  let stream1, stream2;
  // UNIT = INITIAL_MINT/12 (=60 ether). alice=4U (400), bob=2U (200),
  // carol=3U (300), dave=2U (200). SMALL=UNIT*5/3 = 100 ether (inner
  // transfers). Sum of actor allocations = 11U = 660 ether (fits).
  let UNIT, SMALL;

  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, platform] = await ethers.getSigners();

    // Deploy the restructured Satori stack (0 bps platform fee) via the shared
    // fixture. Protocol fee deployed at 0 bps so reward math matches the legacy
    // 1440 ether/round budget, uncluttered by the flat fee.
    const fix = await deploySatoriFixtureNoFee();
    ;({ satori, voting, rewards, registry, bounties, engine, lens, owner } = fix);

    // Enable test mode to allow rapid round advancement

    // Create test streams. The value-provider cut is gone (providers are not
    // paid at all), so the plain 3-arg overload is all that is left and the
    // allocation reaching the delegation split is the full game pool.
    const tx1 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, satori);

    const tx2 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 2", owner.address, 1440);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // Give users tokens
    const INITIAL_MINT = await satori.INITIAL_MINT();
    UNIT = INITIAL_MINT / 12n;
    SMALL = (UNIT * 5n) / 3n; // = 100 ether when UNIT = 60
    // Alice and bob are also the two burners below, and voting DESTROYS the
    // tokens it spends — so they are funded with an extra VOTE each and end the
    // setup holding exactly UNIT*4 / UNIT*2, which is what every delegated-power
    // and reward-split figure in this file is expressed in.
    await satori.transfer(alice.address, UNIT * 4n + VOTE);
    await satori.transfer(bob.address, UNIT * 2n + VOTE);
    await satori.transfer(carol.address, UNIT * 3n);
    await satori.transfer(dave.address, UNIT * 2n);

    // Burn for both streams so each carries weight and therefore earns.
    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream2);
    expect(await satori.balanceOf(alice.address)).to.equal(UNIT * 4n);
    expect(await satori.balanceOf(bob.address)).to.equal(UNIT * 2n);

    // Advance one round so the burns predate every prediction below.
    await advanceToNextRound();
  });

  describe("Basic Delegation", function () {
    it("Should allow delegating prediction power to another address", async function () {
      // Alice delegates to Bob
      await expect(satori.connect(alice).delegatePredictionPower(bob.address))
        .to.emit(rewards, "PredictionDelegated")
        .withArgs(alice.address, bob.address, UNIT * 4n, await satori.getCurrentRound(), UNIT * 4n);

      // Check delegation stored
      const delegate = (await rewards.predictionDelegateInfo(alice.address)).delegate;
      expect(delegate).to.equal(bob.address);
    });

    it("Should update delegatedPredictionPower correctly", async function () {
      // Initially Bob has no delegated power
      expect((await rewards.predictionDelegateInfo(bob.address)).power).to.equal(0);

      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob should now have Alice's balance delegated to him
      const delegated = (await rewards.predictionDelegateInfo(bob.address)).power;
      expect(delegated).to.equal(UNIT * 4n);
    });

    it("Should only delegate own balance (not received delegations)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob's delegated power = 1000 (from Alice)
      expect((await rewards.predictionDelegateInfo(bob.address)).power).to.equal(UNIT * 4n);

      // Bob tries to delegate to Carol - should only delegate his OWN balance (500), not Alice's 1000
      await satori.connect(bob).delegatePredictionPower(carol.address);

      // Carol should receive only Bob's own balance
      const carolDelegated = (await rewards.predictionDelegateInfo(carol.address)).power;
      expect(carolDelegated).to.equal(UNIT * 2n);

      // Bob should still have Alice's delegation
      expect((await rewards.predictionDelegateInfo(bob.address)).power).to.equal(UNIT * 4n);
    });

    it("Should allow delegation to self (undelegation)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);

      // Alice undelegates by delegating to ZeroAddress
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Check delegation updated
      const delegate = (await rewards.predictionDelegateInfo(alice.address)).delegate;
      expect(delegate).to.equal(ethers.ZeroAddress);

      // Bob should no longer have Alice's delegation
      expect((await rewards.predictionDelegateInfo(bob.address)).power).to.equal(0);
    });

    it("Should emit PredictionDelegated event", async function () {
      await expect(satori.connect(alice).delegatePredictionPower(bob.address))
        .to.emit(rewards, "PredictionDelegated")
        .withArgs(alice.address, bob.address, UNIT * 4n, await satori.getCurrentRound(), UNIT * 4n);
    });
  });

  describe("Transfer Restrictions", function () {
    it("Should prevent transfers when delegated", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Try to transfer - should fail
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow transfers when not delegated", async function () {
      // Alice can transfer normally
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.not.be.reverted;

      // Carol started with 3U; received SMALL from alice.
      expect(await satori.balanceOf(carol.address)).to.equal(UNIT * 3n + SMALL);
    });

    it("Should prevent transfers even after receiving tokens while delegated", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Carol sends Alice more tokens
      await satori.connect(carol).transfer(alice.address, SMALL);

      // Alice still cannot transfer ANY tokens (entire balance is locked)
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL / 2n)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow transfers after undelegating (after timing requirements)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice undelegates (using ZeroAddress)
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Cannot transfer yet (locked until next round)
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Advance to next round
      await advanceToNextRound();
      await advanceToNextRound(); // Need to advance 2 rounds after undelegation

      // Now can transfer
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.not.be.reverted;
    });
  });

  describe("Prediction with Delegation", function () {
    it("Should allow predictor to use delegated power", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob can predict using both his own + Alice's balance
      await registry.setValue(stream1, 100);
      const currentRound = await satori.getCurrentRound();
      await expect(satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]))
        .to.emit(engine, "PredictionMade");

      // Check prediction stored
      const pred = await satori.predictions(bob.address, stream1, currentRound);
      expect(pred.direction).to.equal(UP);

      // Bob's prediction power should be his balance (200) + Alice's (400) = 600
      expect(pred.rawPredictionPower).to.be.closeTo(UNIT * 6n, RAW_TOLERANCE);
    });

    it("Should calculate total prediction power correctly", async function () {
      // Check Bob's initial prediction power
      let power = await rewards.getPredictionPower(bob.address);
      expect(power).to.equal(UNIT * 2n); // Just his own balance

      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Check Bob's updated prediction power
      power = await rewards.getPredictionPower(bob.address);
      expect(power).to.equal(UNIT * 6n); // 200 + 400
    });

    it("Should store delegation info at prediction time", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check delegation info stored (ownPower + delegatedPower snapshot)
      const currentRound = await satori.getCurrentRound();
      const delInfo = await rewards.predictionDelegationInfo(bob.address, stream1, currentRound);

      expect(delInfo.ownPower).to.equal(UNIT * 2n);
      expect(delInfo.delegatedPower).to.equal(UNIT * 4n);
    });

    it("Should handle multiple delegators to same predictor", async function () {
      // Alice, Carol, and Dave all delegate to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(carol).delegatePredictionPower(bob.address);
      await satori.connect(dave).delegatePredictionPower(bob.address);

      // Bob's prediction power = 200 + 400 + 300 + 200 = 1100
      const power = await rewards.getPredictionPower(bob.address);
      expect(power).to.equal(UNIT * 11n);

      // Bob predicts
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check delegation info
      const currentRound = await satori.getCurrentRound();
      const delInfo = await rewards.predictionDelegationInfo(bob.address, stream1, currentRound);

      expect(delInfo.ownPower).to.equal(UNIT * 2n);
      expect(delInfo.delegatedPower).to.equal(UNIT * 9n); // 400 + 300 + 200
    });

    it("Should prevent delegator from predicting while delegated", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice tries to predict - should fail
      await registry.setValue(stream1, 100);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Delegated");
    });

    it("Should ALLOW prediction without power (no balance, no delegations) — it just pays nothing", async function () {
      // Transfer all of Dave's balance away
      const daveBalance = await satori.balanceOf(dave.address);
      await satori.connect(dave).transfer(owner.address, daveBalance);

      // Dave has no balance and no delegations
      expect(await rewards.getPredictionPower(dave.address)).to.equal(0);

      // Dave tries to predict - should fail
      await registry.setValue(stream1, 100);
      await expect(
        satori.connect(dave).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      // A zero-power wallet is ADMITTED now. It earns nothing (weight is
      // power x multiplier) and cannot grow a streak (the farming threshold), so
      // there is nothing to gain and no reason to lock it out.
      // docs/design/farming-threshold.md; substantive coverage in
      // test/FarmingThreshold.test.js.
      ).to.not.be.reverted;
    });
  });

  describe("Reward Splitting", function () {
    it("Should split delegated rewards 90% delegator / 10% predictor (no per-prediction fee)", async function () {
      // Set platform fee address

      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await time.increase(86400);

      // No re-voting: burnt weight is PERMANENT, so stream1 keeps the weight
      // alice bought it in the setup. (A vote here would also revert `Locked`:
      // predicting transfer-locks the balance a burn would come out of.)

      // R1: Bob predicts with Alice's delegation
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value goes UP
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1 (correct)
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim rewards (platform2 is owner)
      const aliceBalBefore = await satori.balanceOf(alice.address);
      const bobBalBefore = await satori.balanceOf(bob.address);
      const platform1BalBefore = await satori.balanceOf(platform.address);
      const platform2BalBefore = await satori.balanceOf(owner.address);

      await satori.connect(alice)['claim()']();
      await satori.connect(bob)['claim()']();
      await satori.connect(platform)['claim()']();
      await satori.connect(owner)['claim()']();

      const aliceGained = (await satori.balanceOf(alice.address)) - aliceBalBefore;
      const bobGained = (await satori.balanceOf(bob.address)) - bobBalBefore;
      const platform1Gained = (await satori.balanceOf(platform.address)) - platform1BalBefore;
      const platform2Gained = (await satori.balanceOf(owner.address)) - platform2BalBefore;

      // Bob's own: 200 / 600 = 1/3 of total
      // Alice's delegated: 400 / 600 = 2/3 of total
      // From the delegated portion: 90% to Alice, 10% bonus to Bob.
      // No per-prediction platform fee anymore (item 2) — the platform fee
      // is zeroed in this suite's setup, so the fee addresses gain nothing.
      const totalReward = aliceGained + bobGained;

      const aliceExpected = (totalReward * 400n * 90n) / (600n * 100n);
      const bobExpected = totalReward - aliceExpected;

      const tolerance = totalReward / 50n;
      expect(aliceGained).to.be.closeTo(aliceExpected, tolerance);
      expect(bobGained).to.be.closeTo(bobExpected, tolerance);
      expect(platform1Gained).to.equal(0);
      expect(platform2Gained).to.equal(0);
    });

    it("Should distribute to all delegators proportionally", async function () {
      // Set platform fee address

      // Alice (1000), Carol (300), Dave (200) delegate to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(carol).delegatePredictionPower(bob.address);
      await satori.connect(dave).delegatePredictionPower(bob.address);

      // No re-voting: burnt weight is PERMANENT, so stream1 keeps the weight
      // alice bought it in the setup. (A vote here would also revert `Locked`:
      // predicting transfer-locks the balance a burn would come out of.)

      // R1: Bob predicts (power = 500 + 1000 + 300 + 200 = 2000)
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value goes UP
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Get balances before claim
      const aliceBalBefore = await satori.balanceOf(alice.address);
      const carolBalBefore = await satori.balanceOf(carol.address);
      const daveBalBefore = await satori.balanceOf(dave.address);

      // Claim rewards - all delegators and Bob need to claim
      await satori.connect(alice)['claim()']();
      await satori.connect(carol)['claim()']();
      await satori.connect(dave)['claim()']();
      await satori.connect(bob)['claim()']();

      // Get balances after claim
      const aliceGained = (await satori.balanceOf(alice.address)) - aliceBalBefore;
      const carolGained = (await satori.balanceOf(carol.address)) - carolBalBefore;
      const daveGained = (await satori.balanceOf(dave.address)) - daveBalBefore;

      // Delegators should receive proportional to their delegation
      // Alice: 1000, Carol: 300, Dave: 200
      // Ratios: 10:3:2
      const totalDelegatorReward = aliceGained + carolGained + daveGained;

      // Check proportions (with tolerance for rounding)
      const tolerance = totalDelegatorReward / 1000n;
      expect(aliceGained).to.be.closeTo((totalDelegatorReward * 400n) / 900n, tolerance);
      expect(carolGained).to.be.closeTo((totalDelegatorReward * 300n) / 900n, tolerance);
      expect(daveGained).to.be.closeTo((totalDelegatorReward * 200n) / 900n, tolerance);
    });

    it("Should give predictor 100% if no delegation used", async function () {
      // No re-voting: burnt weight is PERMANENT, so stream1 keeps the weight
      // alice bought it in the setup. (A vote here would also revert `Locked`:
      // predicting transfer-locks the balance a burn would come out of.)

      // R1: Bob predicts with only his own balance (no delegation)
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2: Value goes UP
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim rewards
      const bobBalBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob)['claim()']();
      const bobBalAfter = await satori.balanceOf(bob.address);

      const bobGained = bobBalAfter - bobBalBefore;

      // Bob should receive all rewards (no split)
      expect(bobGained).to.be.gt(0);

      // No platform fee should be charged
      const platformBal = await satori.balanceOf(platform.address);
      expect(platformBal).to.equal(0);
    });

    // (Removed: "Should send platform fee to correct address" — there is no
    //  per-prediction SATORI delegation fee anymore (item 2). The platform's
    //  SATORI take is the flat per-round fee, covered by
    //  PlatformFeeManagement.test.js.)

    it("Should handle mixed own + delegated power", async function () {
      // Set platform fee address

      // Carol delegates to Bob (Bob has own 500 + Carol's 300 = 800 total)
      await satori.connect(carol).delegatePredictionPower(bob.address);
      await time.increase(86400);

      // No re-voting: burnt weight is PERMANENT, so stream1 keeps the weight
      // alice bought it in the setup. (A vote here would also revert `Locked`:
      // predicting transfer-locks the balance a burn would come out of.)

      // R1: Bob predicts
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check delegation info stored correctly
      const currentRound = await satori.getCurrentRound();
      const delInfo = await rewards.predictionDelegationInfo(bob.address, stream1, currentRound);
      expect(delInfo.ownPower).to.equal(UNIT * 2n);
      expect(delInfo.delegatedPower).to.equal(UNIT * 3n);

      // R2: Value goes UP
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: Score R1
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Claim and verify split
      const bobBalBefore = await satori.balanceOf(bob.address);
      const carolBalBefore = await satori.balanceOf(carol.address);
      const platformBalBefore = await satori.balanceOf(platform.address);

      // All parties need to claim their rewards
      await satori.connect(bob)['claim()']();
      await satori.connect(carol)['claim()']();
      await satori.connect(platform)['claim()']();

      const bobGained = (await satori.balanceOf(bob.address)) - bobBalBefore;
      const carolGained = (await satori.balanceOf(carol.address)) - carolBalBefore;
      const platformGained = (await satori.balanceOf(platform.address)) - platformBalBefore;

      // Bob (own + 10% bonus) and Carol (90% of delegated) both earn.
      // No per-prediction platform fee anymore (item 2): the fee address
      // gains nothing here (the flat fee is zeroed in this suite's setup).
      expect(bobGained).to.be.gt(0);
      expect(carolGained).to.be.gt(0);
      expect(platformGained).to.equal(0);
    });

    it("Should emit RewardSplit events", async function () {
      // Set platform fee address

      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // No re-voting: burnt weight is PERMANENT, so stream1 keeps the weight
      // alice bought it in the setup. (A vote here would also revert `Locked`:
      // predicting transfer-locks the balance a burn would come out of.)

      // R1: Bob predicts
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3: under v5 eager credit, the RewardSplit event fires inside
      //     _scorePreviousPrediction at score time — i.e. during this predict,
      //     not the subsequent claim.
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await expect(satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]))
        .to.emit(rewards, "RewardSplit");
    });

    it("Should mint correct token amounts to each party", async function () {
      // Set platform fee address

      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // No re-voting: burnt weight is PERMANENT, so stream1 keeps the weight
      // alice bought it in the setup. (A vote here would also revert `Locked`:
      // predicting transfer-locks the balance a burn would come out of.)

      // R1: Bob predicts
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Get total supply before
      const totalSupplyBefore = await satori.totalSupply();

      // Claim rewards
      await satori.connect(bob)['claim()']();

      // Get total supply after
      const totalSupplyAfter = await satori.totalSupply();

      // Total supply should increase (new tokens minted)
      expect(totalSupplyAfter).to.be.gt(totalSupplyBefore);
    });
  });

  describe("Undelegation Timing", function () {
    it("Should lock balance until next round after undelegation", async function () {
      // Alice delegates to Bob (locks indefinitely)
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Check locked to max value
      let lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Alice undelegates in round 1
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Check locked until next round (currentRound + 1)
      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);

      // Try to transfer in same round - should fail
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Try to predict in same round - should fail
      await registry.setValue(stream1, 100);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("Should allow operations after next round", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Alice undelegates in R1
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      // Advance to next round
      await advanceToNextRound();
      await registry.setValue(stream1, 150);

      // Now should be able to predict
      await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]))
        .to.emit(engine, "PredictionMade");

      // Balance is now locked from prediction until next round
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Advance to next round (still locked - lock uses < not <=)
      await advanceToNextRound();

      // Advance one more round to unlock
      await advanceToNextRound();

      // Now can transfer
      await expect(
        satori.connect(alice).transfer(carol.address, SMALL)
      ).to.not.be.reverted;
    });

    it("Should handle changing delegation without affecting locks", async function () {
      // Alice delegates to Bob (locks to max)
      await satori.connect(alice).delegatePredictionPower(bob.address);

      let lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Alice changes delegation to Carol (still locked to max)
      await satori.connect(alice).delegatePredictionPower(carol.address);

      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(2n ** 24n - 1n);

      // Alice undelegates (locks until next round)
      const currentRound = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);

      lockedUntil = await satori.lockedUntil(alice.address);
      expect(lockedUntil).to.equal(currentRound + 1n);
    });
  });

  describe("Multiple Delegators", function () {
    it("Should handle 3+ delegators to one predictor", async function () {
      // Alice, Carol, and Dave all delegate to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(carol).delegatePredictionPower(bob.address);
      await satori.connect(dave).delegatePredictionPower(bob.address);

      // Check Bob's total delegated power
      const delegated = (await rewards.predictionDelegateInfo(bob.address)).power;
      expect(delegated).to.equal(UNIT * 9n); // 400 + 300 + 200

      // Bob's total prediction power
      const power = await rewards.getPredictionPower(bob.address);
      expect(power).to.equal(UNIT * 11n); // 200 + 900
    });

    it("Should split rewards among all delegators correctly", async function () {
      // Set platform fee address

      // Alice, Carol, Dave delegate to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(carol).delegatePredictionPower(bob.address);
      await satori.connect(dave).delegatePredictionPower(bob.address);
      await time.increase(86400);

      // No re-voting: burnt weight is PERMANENT, so stream1 keeps the weight
      // alice bought it in the setup. (A vote here would also revert `Locked`:
      // predicting transfer-locks the balance a burn would come out of.)

      // R1: Bob predicts
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R2
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R3
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Get balances before
      const aliceBalBefore = await satori.balanceOf(alice.address);
      const carolBalBefore = await satori.balanceOf(carol.address);
      const daveBalBefore = await satori.balanceOf(dave.address);

      // Pull-based: Bob settles his rounds; each delegator claims their share.
      await satori.connect(bob)['claim()']();
      await satori.connect(alice)['claim()']();
      await satori.connect(carol)['claim()']();
      await satori.connect(dave)['claim()']();

      // All delegators should receive rewards
      expect(await satori.balanceOf(alice.address)).to.be.gt(aliceBalBefore);
      expect(await satori.balanceOf(carol.address)).to.be.gt(carolBalBefore);
      expect(await satori.balanceOf(dave.address)).to.be.gt(daveBalBefore);
    });

    it("Should handle delegators with different balance amounts", async function () {
      // Alice (1000), Carol (300), Dave (200) delegate to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(carol).delegatePredictionPower(bob.address);
      await satori.connect(dave).delegatePredictionPower(bob.address);

      // Bob predicts
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Check delegation info captures aggregate delegated pool
      const currentRound = await satori.getCurrentRound();
      const delInfo = await rewards.predictionDelegationInfo(bob.address, stream1, currentRound);

      expect(delInfo.delegatedPower).to.equal(UNIT * 9n); // 400 + 300 + 200
    });

    it("Should update delegatedPredictionPower when balances change", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Initial delegation
      expect((await rewards.predictionDelegateInfo(bob.address)).power).to.equal(UNIT * 4n);

      // Carol sends Alice more tokens
      await satori.connect(carol).transfer(alice.address, SMALL);

      // Bob's delegated power should update (alice's 4U + received SMALL)
      expect((await rewards.predictionDelegateInfo(bob.address)).power).to.equal(UNIT * 4n + SMALL);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero balance delegation (no effect)", async function () {
      // Dave sends all his tokens away
      const daveBalance = await satori.balanceOf(dave.address);
      await satori.connect(dave).transfer(owner.address, daveBalance);

      // Dave delegates to Bob (has 0 balance)
      await satori.connect(dave).delegatePredictionPower(bob.address);

      // Bob's delegated power should not increase
      expect((await rewards.predictionDelegateInfo(bob.address)).power).to.equal(0);

      // Bob can still predict with just his own balance
      await registry.setValue(stream1, 100);
      await expect(satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]))
        .to.emit(engine, "PredictionMade");
    });

    it("Should handle delegator receiving tokens after prediction made", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Bob predicts (snapshot: own=200, delegated=400)
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      const currentRound = await satori.getCurrentRound();
      const delInfoBefore = await rewards.predictionDelegationInfo(bob.address, stream1, currentRound);
      expect(delInfoBefore.delegatedPower).to.equal(UNIT * 4n);

      // Alice receives more tokens AFTER prediction
      await satori.connect(carol).transfer(alice.address, SMALL);

      // Snapshot should remain unchanged — it was recorded at prediction time
      const delInfoAfter = await rewards.predictionDelegationInfo(bob.address, stream1, currentRound);
      expect(delInfoAfter.delegatedPower).to.equal(UNIT * 4n);
    });

    it("Should handle delegator balance changes before claim", async function () {
      // Set platform fee address

      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await time.increase(86400);

      // No re-voting: burnt weight is PERMANENT, so stream1 keeps the weight
      // alice bought it in the setup. (A vote here would also revert `Locked`:
      // predicting transfer-locks the balance a burn would come out of.)

      // R1: Bob predicts (snapshot: own = 2U, delegated = alice's 4U)
      await registry.setValue(stream1, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const r1 = await satori.getCurrentRound();

      // Alice receives more tokens (but delegation info already stored)
      await satori.connect(carol).transfer(alice.address, SMALL);

      // WHY THIS CHANGED (P9 — empty-bucket claim() as proof of nothing): the
      // whole test used to end at `expect(claim()).to.not.be.reverted`, which
      // has no reachable revert path for a self-claim (a zero bucket is a
      // silent no-op, `_checkClaimAuth` passes for the owner) — so the property
      // the comment named ("original delegation amounts, 1000 not 1100") was
      // never asserted, and the doc-mandated deferral could be deleted with the
      // test still green. A_prediction_delegation.md:110/:176-178 — the frozen
      // (ownPower, delegatedPower) snapshot plus "a new effective balance takes
      // effect the round AFTER the change" (SatoriRewards `activation =
      // today + 1`) — is what actually has to hold, so assert it directly.
      const r1Snapshot = await rewards.predictionDelegationInfo(bob.address, stream1, r1);
      expect(r1Snapshot.ownPower).to.equal(UNIT * 2n, "R1 own power is frozen at prediction time");
      expect(r1Snapshot.delegatedPower).to.equal(
        UNIT * 4n,
        "R1 delegated power must stay alice's PRE-transfer balance, not 4U + SMALL"
      );

      // R2 — alice's mid-R1 receipt activates here (today + 1), never in R1.
      await advanceToNextRound();
      await registry.setValue(stream1, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      const r2 = await satori.getCurrentRound();
      expect(r2).to.equal(r1 + 1n);
      expect((await rewards.predictionDelegationInfo(bob.address, stream1, r2)).delegatedPower).to.equal(
        UNIT * 4n + SMALL,
        "the enlarged balance takes effect the round AFTER the change"
      );
      // R1 is still frozen after the fact — the receipt did not back-date.
      expect((await rewards.predictionDelegationInfo(bob.address, stream1, r1)).delegatedPower)
        .to.equal(UNIT * 4n);

      // R3
      await advanceToNextRound();
      await registry.setValue(stream1, 200);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // R1's prediction (A=100, B=150, C=200 → UP) is scored eagerly by the
      // later predict; settle again for determinism, then read the split the
      // win actually banked.
      await satori.settlePrediction(bob.address, stream1);
      const splits = (await rewards.queryFilter(rewards.filters.RewardSplit(bob.address, stream1)))
        .filter((e) => e.args.round === r1);
      expect(splits.length).to.equal(1, "R1's win must emit exactly one RewardSplit");
      const delegatorAmount = splits[0].args.delegatorAmount;
      expect(delegatorAmount).to.be.gt(0n);

      // THE POINT OF THE TEST. Alice is the only delegator, so the rate the
      // split banked (delegatorAmount / frozen 4U) must pay her back EXACTLY
      // delegatorAmount — no more. Had her mid-R1 receipt back-dated into R1
      // (i.e. had the `today + 1` activation been dropped), she would pull
      // (4U + SMALL)/4U × delegatorAmount out of a pot that only ever held
      // delegatorAmount: a phantom mint. Anchored on the event payload, not on
      // a sum of the two halves.
      const [alicePendingGross] = await lens.pendingDelegatorRewards(alice.address);
      // closeTo, not equal: the rate and the payout are floored, so the pull
      // sits a few wei under the pot — the strand-dust direction, never over-mint.
      expect(alicePendingGross).to.be.closeTo(
        delegatorAmount, RAW_TOLERANCE,
        "delegator pulls her share against the FROZEN 4U denominator"
      );

      const bobOwed = await rewards.unclaimedRewards(bob.address);
      expect(bobOwed).to.be.gt(0n, "settling the win must credit bob's bucket");

      const bobBalanceBefore = await satori.balanceOf(bob.address);
      await satori.connect(bob)['claim()']();
      expect((await satori.balanceOf(bob.address)) - bobBalanceBefore).to.equal(
        bobOwed,
        "claim mints exactly the credited bucket"
      );
      expect(await rewards.unclaimedRewards(bob.address)).to.equal(0n, "bucket is zeroed by the claim");
    });

    it("Should allow delegation to address(0) for undelegation", async function () {
      // Delegating to zero address is used for undelegation
      await satori.connect(alice).delegatePredictionPower(bob.address);

      // Undelegation via zero address should work
      await expect(
        satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress)
      ).to.not.be.reverted;

      // Verify undelegation worked
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);
    });

    it("Should handle changing delegation (from Bob to Carol)", async function () {
      // Alice delegates to Bob
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect((await rewards.predictionDelegateInfo(bob.address)).power).to.equal(UNIT * 4n);

      // Alice changes delegation to Carol
      await satori.connect(alice).delegatePredictionPower(carol.address);

      // Bob should lose the delegation
      expect((await rewards.predictionDelegateInfo(bob.address)).power).to.equal(0);

      // Carol should gain the delegation
      expect((await rewards.predictionDelegateInfo(carol.address)).power).to.equal(UNIT * 4n);

      // Alice's delegate should be Carol
      expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);
    });

    it("Should handle predictor with only delegated power (no own balance)", async function () {
      // Transfer all of Dave's balance away
      const daveBalance = await satori.balanceOf(dave.address);
      await satori.connect(dave).transfer(owner.address, daveBalance);

      // Alice delegates to Dave
      await satori.connect(alice).delegatePredictionPower(dave.address);

      // Dave has 0 own balance but 1000 delegated
      expect(await satori.balanceOf(dave.address)).to.equal(0);
      expect((await rewards.predictionDelegateInfo(dave.address)).power).to.equal(UNIT * 4n);
      expect(await rewards.getPredictionPower(dave.address)).to.equal(UNIT * 4n);

      // Dave should be able to predict using only delegated power
      await registry.setValue(stream1, 100);
      const currentRound = await satori.getCurrentRound();
      await expect(satori.connect(dave).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]))
        .to.emit(engine, "PredictionMade");

      // Check prediction stored correctly
      const pred = await satori.predictions(dave.address, stream1, currentRound);
      expect(pred.rawPredictionPower).to.be.closeTo(UNIT * 4n, RAW_TOLERANCE);

      // Check delegation info
      const delInfo = await rewards.predictionDelegationInfo(dave.address, stream1, currentRound);
      expect(delInfo.ownPower).to.equal(0);
      expect(delInfo.delegatedPower).to.equal(UNIT * 4n);
    });
  });
});
