/**
 * VoteMove.test.js — moving burned weight off an UNAPPROVED game.
 *
 * Decided by the owner 2026-09-05 (docs/issues/vote-weight-doors.md, door 1):
 * a burner may re-point their own weight, but ONLY off a game the admin has
 * disabled. This is the narrow exception to "no vote can ever be moved":
 *  - the source must be disabled — weight on live games stays immovable, so
 *    every exploit-closure that rests on immovability (mid-round chase, JIT
 *    eligibility) is untouched for enabled games;
 *  - the destination must pass every guard `vote` itself applies;
 *  - a disabled game's weight is not in `totalBurnedWeight`, so the move ADDS
 *    the amount back as it lands on an enabled game;
 *  - the one timing fence: if the source was predicted THIS round while still
 *    enabled and only then disabled, its weight is already frozen into the
 *    round's numerator — moving it now would let the same weight enter a
 *    second numerator in the same round. The move waits for the boundary.
 */

const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const E = ethers.parseEther;

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find((log) => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === "DataStreamCreated";
    } catch { return false; }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  return satoriContract.interface.parseLog(event).args.streamId;
}

describe("Moving weight off an unapproved game", function () {
  let satori, voting, registry;
  let owner, alice, bob;
  let gameA, gameB, gameC;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, registry } = fix);
    [owner, alice, bob] = fix.signers;

    let tx = await satori.createSimpleDataStream("Stream A", owner.address);
    gameA = await getStreamIdFromTx(tx, satori);
    tx = await satori.createSimpleDataStream("Stream B", owner.address);
    gameB = await getStreamIdFromTx(tx, satori);
    tx = await satori.createSimpleDataStream("Stream C", owner.address);
    gameC = await getStreamIdFromTx(tx, satori);

    await satori.transfer(alice.address, E("200"));
    await satori.transfer(bob.address, E("100"));
  });

  it("moves weight off a disabled game, with exact accounting on both sides", async function () {
    await voteFor(satori, alice, gameA, E("10"));
    await voteFor(satori, bob, gameA, E("4"));
    const totalBefore = await voting.totalBurnedWeight();

    await voting.connect(owner).setGameApproved(gameA, false);
    expect(await voting.totalBurnedWeight()).to.equal(totalBefore - E("14"));

    const round = await satori.getCurrentRound();
    await expect(voting.connect(alice).moveVotes(gameA, gameB, E("6")))
      .to.emit(voting, "VotesMoved")
      .withArgs(alice.address, gameA, gameB, round, E("6"), E("8"), E("6"), totalBefore - E("8"));

    // Raw ledgers on both sides.
    expect(await voting.gameWeight(gameA)).to.equal(E("8"));
    expect(await voting.gameWeight(gameB)).to.equal(E("6"));
    // Per-voter ledgers: alice's split moves, bob's stays put.
    expect(await voting.voterGameWeight(alice.address, gameA)).to.equal(E("4"));
    expect(await voting.voterGameWeight(alice.address, gameB)).to.equal(E("6"));
    expect(await voting.voterGameWeight(bob.address, gameA)).to.equal(E("4"));
    // The moved weight re-enters the burnt total (the disabled source's
    // weight was subtracted wholesale at disable time).
    expect(await voting.totalBurnedWeight()).to.equal(totalBefore - E("14") + E("6"));
    // And it is live on the destination immediately.
    expect(await voting.weightOf(gameB)).to.equal(E("6"));
    expect(await voting.isEligible(gameB)).to.equal(true);
  });

  it("re-enabling after a partial exodus restores exactly what remains", async function () {
    await voteFor(satori, alice, gameA, E("10"));
    const totalBefore = await voting.totalBurnedWeight();
    await voting.connect(owner).setGameApproved(gameA, false);
    await voting.connect(alice).moveVotes(gameA, gameB, E("6"));
    await voting.connect(owner).setGameApproved(gameA, true);
    // 4 came back with the re-enable, 6 lives on B: nothing lost, nothing doubled.
    expect(await voting.totalBurnedWeight()).to.equal(totalBefore);
    expect(await voting.weightOf(gameA)).to.equal(E("4"));
    expect(await voting.weightOf(gameB)).to.equal(E("6"));
  });

  it("every guard: source must be disabled, destination must be votable, amount must be real", async function () {
    await voteFor(satori, alice, gameA, E("10"));
    await voteFor(satori, alice, gameB, E("5"));

    // Source enabled → refused. Weight on live games stays immovable.
    await expect(voting.connect(alice).moveVotes(gameB, gameC, E("1")))
      .to.be.revertedWithCustomError(voting, "SourceStillApproved");

    await voting.connect(owner).setGameApproved(gameA, false);

    await expect(voting.connect(alice).moveVotes(gameA, gameB, 0))
      .to.be.revertedWithCustomError(voting, "ZeroVote");
    // More than alice's own recorded share (bob's or nobody's weight is not hers to move).
    await expect(voting.connect(alice).moveVotes(gameA, gameB, E("11")))
      .to.be.revertedWithCustomError(voting, "InsufficientVoterWeight");
    // Bob burned nothing on A.
    await expect(voting.connect(bob).moveVotes(gameA, gameB, E("1")))
      .to.be.revertedWithCustomError(voting, "InsufficientVoterWeight");
    // Destination guards mirror vote()'s exactly.
    await expect(voting.connect(alice).moveVotes(gameA, 1, E("1")))
      .to.be.revertedWithCustomError(voting, "CannotVoteDefault");
    await expect(voting.connect(alice).moveVotes(gameA, 9999, E("1")))
      .to.be.revertedWithCustomError(voting, "UnknownGame");
    await voting.connect(owner).setGameApproved(gameC, false);
    await expect(voting.connect(alice).moveVotes(gameA, gameC, E("1")))
      .to.be.revertedWithCustomError(voting, "GameNotApproved");
  });

  it("fence: a source frozen into the current round cannot move until the boundary", async function () {
    await voteFor(satori, alice, gameA, E("10"));
    // Freeze A into the current round the real way: value, then a prediction.
    await registry.setValue(gameA, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
    const round = await satori.getCurrentRound();
    expect(await voting.getGameVotesAtRound(gameA, round)).to.equal(E("10"));

    await voting.connect(owner).setGameApproved(gameA, false);
    await expect(voting.connect(alice).moveVotes(gameA, gameB, E("10")))
      .to.be.revertedWithCustomError(voting, "SourceFrozenThisRound");

    // Next round the numerator is history and the move goes through.
    await time.increase(86400);
    await voting.connect(alice).moveVotes(gameA, gameB, E("10"));
    expect(await voting.weightOf(gameB)).to.equal(E("10"));
  });

  it("the default game's derived share follows the total as weight re-enters", async function () {
    await voteFor(satori, alice, gameA, E("100"));
    const withA = await voting.defaultDerivedWeight();
    await voting.connect(owner).setGameApproved(gameA, false);
    const whileOff = await voting.defaultDerivedWeight();
    expect(whileOff).to.be.lessThan(withA);
    await voting.connect(alice).moveVotes(gameA, gameB, E("100"));
    // All 100 re-homed: the default's entitlement is back where it started.
    expect(await voting.defaultDerivedWeight()).to.equal(withA);
  });
});
