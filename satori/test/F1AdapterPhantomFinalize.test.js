// F1 (audit 2026-07) — a malicious/untrusted game adapter must not be able to
// strand a victim's SHARED per-(user, round) unsettled-prediction counter.
//
// settlePrediction(user, gameId) is permissionless. For an adapter game it
// calls the untrusted adapter's score(), then decrements the victim's shared
// unsettled counter. The decrement used to run UNCONDITIONALLY, even when the
// victim had no real bet on that game — so an attacker could register a phantom
// adapter whose score() reports "resolved" for any user/round and drive a
// victim's counter to zero, after which the victim's REAL predictions could
// never finalize (revert NoPendingPrediction, forever).
//
// The fix: SatoriRewards.scoreAdapterPrediction reports whether it actually
// consumed a real pending bet (finalized), and the engine only notifies the
// counter when finalized == true. This test drives the exact attack and asserts
// the victim's real prediction still settles and pays.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  createYesNoGame,
  pack1,
  VOTE,
} = require("./fixtures");

const ROUND = 86400;
const YES = 1;

async function advanceRounds(n) {
  await time.increase(ROUND * n);
}

async function streamIdFrom(tx, fix) {
  const receipt = await tx.wait();
  const iface = fix.registry.interface;
  for (const log of receipt.logs) {
    try {
      const p = iface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function registerPhantomAdapter(fix) {
  const Phantom = await ethers.getContractFactory("PhantomFinalizeGame");
  const phantom = await Phantom.deploy();
  await phantom.waitForDeployment();
  const tx = await fix.satori
    .connect(fix.owner)
    .registerGameAdapter(await phantom.getAddress(), "Phantom");
  const receipt = await tx.wait();
  let gameTypeId;
  for (const log of receipt.logs) {
    try {
      const parsed = fix.games.interface.parseLog(log);
      if (parsed && parsed.name === "GameAdapterRegistered") {
        gameTypeId = Number(parsed.args.gameTypeId);
        break;
      }
    } catch (e) {}
  }
  if (gameTypeId === undefined) throw new Error("GameAdapterRegistered event missing");
  return { phantom, gameTypeId };
}

describe("F1 — a malicious game adapter cannot strand a victim's unsettled counter", function () {
  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, owner, signers } = fix;

    // The victim's REAL bet sits on the stream's built-in BINARY game (type 0,
    // auto-created with the stream, so its id is the stream id). Only type 0 is
    // mint-eligible, so it is the only game that can be voted for and can pay —
    // and the unsettled counter the phantom attacks is shared per (user, round)
    // across every game, so a binary victim bet exercises the same counter.
    const realStream = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("REAL", owner.address, 2880),
      fix
    );
    await fix.registry.connect(owner).setValue(realStream, 100);
    const realGameId = realStream;

    // Malicious phantom adapter game on its own stream. In production it is
    // registered permissionlessly (registerCommunityGameAdapter); registering
    // via the admin door here is equivalent for the counter mechanics.
    const { phantom, gameTypeId: phType } = await registerPhantomAdapter(fix);
    const phantomStream = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("PHANTOM", owner.address, 2880),
      fix
    );
    await fix.registry.connect(owner).setValue(phantomStream, 100);
    // PhantomFinalizeGame ignores config, so any cfg works.
    const phantomGameId = await createYesNoGame(satori.connect(owner), phType, phantomStream, 0, "phantom");

    const alice = signers[1];
    const bob = signers[2];
    await satori.transfer(alice.address, ethers.parseEther("10"));
    // Bob gets 20: he burns 10 of it to weight the real game (voting destroys
    // tokens now), leaving him the same 10 float alice has.
    await satori.transfer(bob.address, ethers.parseEther("20"));

    return { ...fix, phantom, realGameId, phantomGameId, realStream, alice, bob };
  }

  it("control: without the attack, the victim's real prediction settles and pays", async function () {
    const { satori, rewards, registry, realGameId, realStream, alice, bob, owner } =
      await loadFixture(setup);

    await satori.connect(bob).vote(realGameId, VOTE);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: realGameId, payload: pack1(YES) },
    ]);
    // realStream is cadence-2: the last write (setValue 100 in setup) must be
    // >= 2 rounds behind this one, so advance two rounds before writing again.
    await advanceRounds(2);
    await registry.connect(owner).setValue(realStream, 200); // > threshold ⇒ YES wins

    const before = await rewards.unclaimedRewards(alice.address);
    await satori.connect(bob).settlePrediction(alice.address, realGameId);
    expect(await rewards.unclaimedRewards(alice.address)).to.be.gt(before);
  });

  it("a phantom finalize on a game the victim never bet is a no-op; the real prediction still settles and pays", async function () {
    const { satori, rewards, registry, realGameId, phantomGameId, realStream, phantom, alice, bob, owner } =
      await loadFixture(setup);

    await satori.connect(bob).vote(realGameId, VOTE);
    const R = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: realGameId, payload: pack1(YES) },
    ]);
    // Aim the phantom finalize at alice's prediction round.
    await phantom.setTargetRound(R);

    // realStream is cadence-2: the last write (setValue 100 in setup) must be
    // >= 2 rounds behind this one, so advance two rounds before writing again.
    await advanceRounds(2);
    await registry.connect(owner).setValue(realStream, 200); // > threshold ⇒ YES wins

    // ATTACK: an unprivileged caller phantom-finalizes alice's round R via a
    // game she never touched. alice has exactly one pending (counter == 1), so a
    // single phantom finalize is enough to zero it pre-fix.
    await satori.connect(bob).settlePrediction(alice.address, phantomGameId);

    // The victim's REAL prediction must still settle and pay. Pre-fix this
    // reverts NoPendingPrediction because the phantom drove her counter to 0.
    const before = await rewards.unclaimedRewards(alice.address);
    await expect(
      satori.connect(bob).settlePrediction(alice.address, realGameId)
    ).to.not.be.reverted;
    expect(await rewards.unclaimedRewards(alice.address)).to.be.gt(before);
  });
});
