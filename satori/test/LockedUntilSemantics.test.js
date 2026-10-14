const { expect } = require("chai");
const { deploySatoriFixture, pack1, makeEligible } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

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

describe("LockedUntil Transfer vs Predict Semantics", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob;
  let stream1, stream2;

  const UP = 1;
  const DOWN = 2;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry, bounties, owner } = fix);
    const signers = await ethers.getSigners();
    alice = signers[1];
    bob = signers[2];

    // Create stream1
    const tx1 = await satori.createSimpleDataStream("Stream 1", owner.address);
    stream1 = await getStreamIdFromTx(tx1, satori);

    // Create stream2 for predicting on expiry day
    const tx2 = await satori.createSimpleDataStream("Stream 2", owner.address);
    stream2 = await getStreamIdFromTx(tx2, satori);

    // Give alice and bob tokens, then weight both streams.
    // There is no eligibility threshold any more — every enabled game with
    // weight > 0 earns — so the two "Dummy" streams that existed purely to
    // dilute the old 50% bar, and the balance shuffling that funded their
    // voters, are gone. A single dedicated `voter` burns for both real streams,
    // which also keeps the burn off alice's and bob's balances.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const UNIT = INITIAL_MINT / 20n;
    await satori.transfer(alice.address, UNIT * 8n);
    await satori.transfer(bob.address, UNIT * 4n);

    const voter = signers[5];
    await satori.transfer(voter.address, ethers.parseEther("40"));
    await makeEligible(satori, voter, [stream1, stream2]);
  });

  it("Transfer FAILS on lock-expiry day (lockedUntil == currentDate)", async function () {
    // Set stream value and alice predicts (locks until day D+1)
    await registry.setValue(stream1, 100);
    const dayD = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // Verify locked until D+1
    const lockedUntil = await satori.lockedUntil(alice.address);
    expect(lockedUntil).to.equal(dayD + 1n);

    // Advance to day D+1 (the lock-expiry day)
    await time.increase(86400);
    const currentDay = await satori.getCurrentRound();
    expect(currentDay).to.equal(dayD + 1n); // confirm we're on D+1

    // Transfer FAILS on day D (lock still in effect for transfers, strict < check)
    await expect(
      satori.connect(alice).transfer(bob.address, ethers.parseEther("100"))
    ).to.be.revertedWithCustomError(satori, "Locked");
  });

  it("Predict SUCCEEDS on lock-expiry day (lockedUntil == currentDate)", async function () {
    // Set stream value and alice predicts (locks until day D+1)
    await registry.setValue(stream1, 100);
    const dayD = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    // Verify locked until D+1
    const lockedUntil = await satori.lockedUntil(alice.address);
    expect(lockedUntil).to.equal(dayD + 1n);

    // Advance to day D+1 (the lock-expiry day)
    await time.increase(86400);
    const currentDay = await satori.getCurrentRound();
    expect(currentDay).to.equal(dayD + 1n);

    // Predict SUCCEEDS on day D+1 (allowed per design, uses <= check)
    await registry.setValue(stream2, 500);
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }])
    ).to.not.be.reverted;
  });

  it("Transfer SUCCEEDS on day D+2 (lock has fully expired)", async function () {
    // Set stream value and alice predicts (locks until day D+1)
    await registry.setValue(stream1, 100);
    const dayD = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    const lockedUntil = await satori.lockedUntil(alice.address);
    expect(lockedUntil).to.equal(dayD + 1n);

    // Advance to day D+2
    await time.increase(86400 * 2);
    const currentDay = await satori.getCurrentRound();
    expect(currentDay).to.equal(dayD + 2n);

    // Transfer SUCCEEDS on day D+2 (lock has expired: lockedUntil D+1 < currentDate D+2)
    await expect(
      satori.connect(alice).transfer(bob.address, ethers.parseEther("100"))
    ).to.not.be.reverted;
  });
});
