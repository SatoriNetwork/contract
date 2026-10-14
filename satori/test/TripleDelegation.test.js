const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("./fixtures");
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

// This suite used to cover THREE delegation types. Vote delegation is gone —
// voting burns tokens for permanent game weight, so there is no voting power to
// hand to anyone and nothing to keep in sync on transfer. Prediction delegation
// and claim delegation are unchanged, and the point of the suite survives: the
// two remaining delegations are independent, can point at different people, and
// do not interfere with each other or with a delegator's own voting.
describe("Phase 1: Delegation System (prediction + claim)", function() {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob, carol, dave;
  let stream1, stream2;
  const UP = 1;
  const DOWN = 2;

  beforeEach(async function() {
    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties, owner } = fix);
    [, alice, bob, carol, dave] = await ethers.getSigners();

    // Create 2 streams for predictions (the default stream owns id 1, so these
    // come back as 2 and 3). Cadence 1440 minutes (every round): the subject
    // is prediction + claim delegation, and the streams are only scaffolding.
    const tx1 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("BTC Price", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, satori);

    const tx2 = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("ETH Price", owner.address, 1440);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // Set initial stream values
    await registry.setValue(stream1, 100);
    await registry.setValue(stream2, 200);

    // Distribute tokens to users
    await satori.transfer(alice.address, ethers.parseEther("200"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("160"));
    await satori.transfer(dave.address, ethers.parseEther("60"));
  });

  it("Should handle both delegation types simultaneously", async function() {
    // Alice: delegate prediction AND claim to Bob
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await satori.connect(alice).delegateClaimAbility(bob.address);

    // Carol: same two delegations, both to Bob
    await satori.connect(carol).delegatePredictionPower(bob.address);
    await satori.connect(carol).delegateClaimAbility(bob.address);

    console.log("\n=== DELEGATION SETUP ===");
    console.log("Alice -> Bob: Prediction + Claim");
    console.log("Carol -> Bob: Prediction + Claim");
    console.log("Dave: no delegations (predicts on his own power)");

    // Round 0: buy the two games weight so they earn. Voting BURNS, so only
    // people who have NOT delegated their prediction power can do it — a
    // prediction delegator's tokens are locked until they undelegate.
    await voteFor(satori, bob, stream1);
    await voteFor(satori, bob, stream2);
    await voteFor(satori, dave, stream1);

    // Weight is exactly what was burnt for each game.
    expect(await voting.weightOf(stream1)).to.equal(VOTE * 2n);
    expect(await voting.weightOf(stream2)).to.equal(VOTE);

    const bobBalance = await satori.balanceOf(bob.address);
    const aliceBalance = await satori.balanceOf(alice.address);
    const carolBalance = await satori.balanceOf(carol.address);
    const daveBalance = await satori.balanceOf(dave.address);

    // The burns are gone from circulation, not staked.
    expect(bobBalance).to.equal(ethers.parseEther("100") - VOTE * 2n);
    expect(daveBalance).to.equal(ethers.parseEther("60") - VOTE);

    console.log("\n=== ROUND 0: VOTING (BURN) ===");
    console.log("Bob burnt for stream1 + stream2, balance now:", ethers.formatEther(bobBalance));
    console.log("Dave burnt for stream1, balance now:", ethers.formatEther(daveBalance));

    // Advance to Round 1
    const startDate = await satori.getCurrentRound();
    await time.increase(86400);
    const date1 = await satori.getCurrentRound();
    expect(date1).to.equal(startDate + 1n);

    // Update values before predictions to avoid "Expired"
    await registry.setValue(stream1, 110); // UP - will make previous predictions correct
    await registry.setValue(stream2, 190); // DOWN - will make previous predictions correct

    // Round 1: Bob predicts using his own balance + Alice's + Carol's delegated power
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }]);

    // Bob's prediction power = own balance + both delegators' balances. There is
    // no first-predictor liveness bonus any more, so the sum is exact.
    const bobPredictionPower = await rewards.getPredictionPower(bob.address);
    expect(bobPredictionPower).to.equal(bobBalance + aliceBalance + carolBalance);

    // Dave predicts on his own power (he delegated nothing)
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }]);

    const davePredictionPower = await rewards.getPredictionPower(dave.address);
    expect(davePredictionPower).to.equal(daveBalance);

    console.log("\n=== ROUND 1: PREDICTIONS ===");
    console.log("Bob predicts Stream2 UP with power:", ethers.formatEther(bobPredictionPower));
    console.log("  - Own:", ethers.formatEther(bobBalance));
    console.log("  - From Alice:", ethers.formatEther(aliceBalance));
    console.log("  - From Carol:", ethers.formatEther(carolBalance));
    console.log("Dave predicts Stream2 DOWN with power:", ethers.formatEther(davePredictionPower));
    console.log("  - Own:", ethers.formatEther(daveBalance));
    console.log("  - No delegations");

    // Advance to Round 2
    await time.increase(86400);
    const date2 = await satori.getCurrentRound();
    expect(date2).to.equal(startDate + 2n);

    // Update stream values before predictions
    await registry.setValue(stream1, 105);
    await registry.setValue(stream2, 195);

    // Round 2: Make another prediction to trigger scoring of Round 1 predictions
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }]);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }]);

    // Advance to Round 3
    await time.increase(86400);
    const date3 = await satori.getCurrentRound();
    expect(date3).to.equal(startDate + 3n);

    // Update stream values before predictions
    await registry.setValue(stream1, 100);
    await registry.setValue(stream2, 200);

    // Round 3: Make predictions to trigger scoring of Round 2 predictions
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }]);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }]);

    console.log("\n=== VERIFICATION: DELEGATION INDEPENDENCE ===");

    // Prediction delegation and claim delegation are separate pointers.
    expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
    expect((await rewards.predictionDelegateInfo(carol.address)).delegate).to.equal(bob.address);
    expect(await rewards.claimDelegateInfo(alice.address)).to.equal(bob.address);
    expect(await rewards.claimDelegateInfo(carol.address)).to.equal(bob.address);
    console.log("1. Bob has prediction AND claim delegation from BOTH Alice and Carol");

    // Dave delegated nothing at all.
    expect((await rewards.predictionDelegateInfo(dave.address)).delegate).to.equal(ethers.ZeroAddress);
    expect(await rewards.claimDelegateInfo(dave.address)).to.equal(ethers.ZeroAddress);
    expect(davePredictionPower).to.equal(daveBalance);
    console.log("2. Dave has no delegations of any kind");

    // Bob's power is strictly more than his own stack, because of the inbound
    // delegations.
    expect(bobPredictionPower).to.be.gt(bobBalance);
    console.log("3. Bob's prediction power exceeds his own balance (inbound delegations)");

    // Alice delegated her prediction power away, so she has none of her own.
    const alicePredictionPower = await rewards.getPredictionPower(alice.address);
    expect(alicePredictionPower).to.equal(0);
    console.log("4. Alice delegated her prediction power to Bob (she reads 0)");

    // Her burnt vote weight, however, is untouchable by any of this: it belongs
    // to the GAME, permanently, and was bought with tokens that no longer exist.
    expect(await voting.weightOf(stream1)).to.equal(VOTE * 2n);
    expect(await voting.weightOf(stream2)).to.equal(VOTE);
    console.log("5. Burnt vote weight is unaffected by any delegation");

    console.log("\n=== FINAL DELEGATION POWER SUMMARY ===");
    console.log("Alice:");
    console.log("  Prediction Power:", ethers.formatEther(alicePredictionPower), "(delegated to Bob)");
    console.log("  Claim Power: (delegated to Bob)");
    console.log("\nBob:");
    console.log("  Prediction Power:", ethers.formatEther(bobPredictionPower), "(has Alice's + Carol's delegation)");
    console.log("  Claim Delegators: Alice + Carol");
    console.log("\nCarol:");
    console.log("  Prediction Power:", ethers.formatEther(carolBalance), "(delegated to Bob)");
    console.log("  Claim Power: (delegated to Bob)");
    console.log("\nDave:");
    console.log("  Prediction Power:", ethers.formatEther(davePredictionPower), "(no delegation)");
    console.log("  Claim Delegators: none");

    console.log("\n=== TEST COMPLETE ===");
    console.log("Prediction and claim delegation work simultaneously without conflicts!");
  });
});
