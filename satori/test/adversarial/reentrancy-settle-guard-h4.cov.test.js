// Regression guard for audit finding H4 (HIGH): adapter-callback reentrancy.
//
// settlePrediction and predictMultipleWithPayloads are the ONLY external entry
// points that invoke untrusted adapter callbacks (score / record), yet neither
// was nonReentrant. A malicious community adapter (ReentrantGameAdapter) reenters
// settlePrediction during its own score(): the inner call finalizes the SAME
// prediction (counter 2→1, record deleted) and the outer _scoreAdapterPrediction
// no-ops on the record side BUT still calls _notifyFinalized (1→0). A genuinely
// co-pending prediction in that round then reverts NoPendingPrediction on settle
// → permanently stranded.
//
// FIX (Option A): nonReentrant on settlePrediction + predictMultipleWithPayloads.
// The reentrant inner settlePrediction trips the guard (ReentrancyGuardReentrantCall),
// the revert bubbles up, and the malicious game can only DoS itself — the honest
// co-pending prediction settles cleanly and is paid.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("../fixtures");

const ROUND = 86400;
const YES = 1;

async function advanceRounds(n) { await time.increase(ROUND * n); }

async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = games.interface.parseLog(log);
      if (p && p.name === "GameCreated") return Number(p.args.gameId);
    } catch (e) {}
  }
  throw new Error("GameCreated event missing");
}

// The fixture now calls initializeDefaultStream(), so stream/game id 1 is the
// DEFAULT game and the first stream a test creates is id 2. Capture ids from the
// creation event instead of hardcoding them.
async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function impersonateCore(satori) {
  const satoriAddr = await satori.getAddress();
  await impersonateAccount(satoriAddr);
  await setBalance(satoriAddr, ethers.parseEther("10"));
  return ethers.getSigner(satoriAddr);
}

async function deployYesNo(fix) {
  const { satori, engine, games, registry, rewards, owner } = fix;
  const YesNoGame = await ethers.getContractFactory("YesNoGame");
  const yesNo = await YesNoGame.deploy(
    await engine.getAddress(), await games.getAddress(),
    await registry.getAddress());
  await yesNo.waitForDeployment();
  const coreSigner = await impersonateCore(satori);
  const typeId = Number(await games.connect(coreSigner).registerGameAdapter.staticCall(
    await yesNo.getAddress(), owner.address, "YesNo", false));
  await games.connect(coreSigner).registerGameAdapter(
    await yesNo.getAddress(), owner.address, "YesNo", false);
  // The instance comes back too: with adapter games unable to hold voting weight,
  // "this bet settled" is read off the adapter's own pending record rather than
  // off a payout.
  return { yesNo, typeId };
}

describe("H4 cov — adapter-callback entry points are nonReentrant", function () {
  this.timeout(300000);

  it("malicious adapter reentry into settlePrediction is blocked; honest co-pending prediction survives + pays", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, engine, rewards, registry, games, owner, signers } = fix;
    const coreSigner = await impersonateCore(satori);

    // Malicious reentrant adapter via the permissionless community path.
    const Mal = await ethers.getContractFactory("ReentrantGameAdapter");
    const mal = await Mal.deploy(await engine.getAddress());
    await mal.waitForDeployment();
    const malTypeId = Number(await games.connect(coreSigner).registerGameAdapter.staticCall(
      await mal.getAddress(), owner.address, "Mal", true));
    await games.connect(coreSigner).registerGameAdapter(
      await mal.getAddress(), owner.address, "Mal", true);

    // Honest YesNo adapter for the co-pending game.
    const { yesNo, typeId: yesTypeId } = await deployYesNo(fix);

    // Two streams + two adapter games.
    const s1 = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S1", owner.address, 2880), satori);
    await registry.connect(owner).setValue(s1, 100);
    const s2 = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S2", owner.address, 2880), satori);
    await registry.connect(owner).setValue(s2, 100);
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [150]);
    const malGameId = await gameIdFrom(
      await satori.connect(owner).createGame(s1, malTypeId, cfg, "MalGame"), games);
    const yesGameId = await gameIdFrom(
      await satori.connect(owner).createGame(s2, yesTypeId, cfg, "YesGame"), games);

    // Neither ADAPTER game can be voted any more — only the built-in binary game
    // (gameTypeId 0) is mint-eligible, so `vote` on an adapter reverts
    // GameNotMintEligible. The "survives + pays" half of this test therefore
    // rides on s2's auto-created BINARY game, which is votable and does pay. It is
    // co-pending in the same round as the malicious bet, which is all H4 needs:
    // the unsettled counter is shared per (user, round) across the binary and
    // adapter paths. (Resolved by lookup — game ids and stream ids stop running in
    // lockstep as soon as an extra game is created.)
    const binGameId = Number(await games.binaryGameByStream(s2));
    const v2 = signers[9];
    await satori.transfer(v2.address, VOTE);
    await voteFor(satori, v2, binGameId);

    // Victim predicts all three games in the SAME round → unsettled counter == 3:
    // the malicious adapter, an honest adapter, and the honest binary game.
    const user = signers[1];
    await satori.transfer(user.address, ethers.parseEther("10"));
    await satori.connect(user).predictMultipleWithPayloads([
      { gameId: malGameId, payload: pack1(YES) },
      { gameId: yesGameId, payload: pack1(YES) },
      { gameId: binGameId, payload: pack1(YES) },
    ]);

    await advanceRounds(2);
    await registry.connect(owner).setValue(s1, 200); // YES/UP wins on both streams
    await registry.connect(owner).setValue(s2, 200);
    await mal.arm(); // arm() now takes NO args under the score/total model

    // Reentry is still blocked — the inner settlePrediction trips the guard, so
    // score() reverts and NOTHING is consumed or paid for the malicious game.
    //
    // What changed (audit B-1): that revert no longer bubbles to the outer call.
    // The engine now decodes score()'s return manually and treats any failure as
    // the "not resolved yet" signal, so a hostile adapter cannot force the outer
    // settle to revert. This test was in fact a second instance of the B-1
    // bricking vector: pre-fix, a reentrant adapter made settlePrediction revert
    // unconditionally and forever, stranding the victim's unsettled counter. The
    // guard property is unchanged and the outcome is strictly better.
    const beforeMal = await rewards.unclaimedRewards(user.address);
    await expect(satori.settlePrediction(user.address, malGameId)).to.not.be.reverted;
    expect(await rewards.unclaimedRewards(user.address)).to.equal(
      beforeMal,
      "a reentrant adapter must not be paid through the blocked inner call"
    );

    // The honest co-pending ADAPTER bet is NOT stranded: it settles cleanly and
    // its record is consumed. (It cannot be PAID any more — an adapter game holds
    // no voting weight, so it draws no slice of the round budget — so survival is
    // proven structurally here and by the paying binary bet below.)
    expect(await yesNo.pendingRound(yesGameId, user.address)).to.not.equal(0n);
    await satori.settlePrediction(user.address, yesGameId); // no NoPendingPrediction
    expect(await yesNo.pendingRound(yesGameId, user.address)).to.equal(
      0n, "honest co-pending adapter bet must still reach a terminal state"
    );

    // ...and the honest co-pending BINARY bet still PAYS. This is the half of the
    // H4 guard that a mere "did not revert" would lose: the malicious adapter
    // contained itself, taking neither the victim's round nor their money with it.
    const before = await rewards.unclaimedRewards(user.address);
    await satori.settlePrediction(user.address, binGameId);
    const after = await rewards.unclaimedRewards(user.address);
    expect(after).to.be.gt(before, "honest co-pending prediction must still pay");
  });

  it("CONTROL: two honest adapter games both settle cleanly (guard doesn't break normal settle)", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, games, owner, signers } = fix;
    const { yesNo, typeId: yesTypeId } = await deployYesNo(fix);

    const s1 = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S1", owner.address, 2880), satori);
    await registry.connect(owner).setValue(s1, 100);
    const s2 = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S2", owner.address, 2880), satori);
    await registry.connect(owner).setValue(s2, 100);
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [150]);
    const g1 = await gameIdFrom(await satori.connect(owner).createGame(s1, yesTypeId, cfg, "G1"), games);
    const g2 = await gameIdFrom(await satori.connect(owner).createGame(s2, yesTypeId, cfg, "G2"), games);
    // No vote on g1: an adapter game is not mint-eligible, so `vote` reverts
    // GameNotMintEligible. Both games now sit at zero weight, which is the state
    // this control is about anyway — that an unmolested settle runs to completion.

    const user = signers[1];
    await satori.transfer(user.address, ethers.parseEther("10"));
    await satori.connect(user).predictMultipleWithPayloads([
      { gameId: g1, payload: pack1(YES) },
      { gameId: g2, payload: pack1(YES) },
    ]);

    await advanceRounds(2);
    await registry.connect(owner).setValue(s1, 200);
    await registry.connect(owner).setValue(s2, 200);

    // Both settle without revert when no adapter reenters — and both bets are
    // really CONSUMED, not silently skipped. (The payout is zero on both sides
    // now that adapter games carry no weight, so the terminal-state read is what
    // makes this control bite.)
    await satori.settlePrediction(user.address, g1);
    await satori.settlePrediction(user.address, g2);
    expect(await yesNo.pendingRound(g1, user.address)).to.equal(0n);
    expect(await yesNo.pendingRound(g2, user.address)).to.equal(0n);
  });
});
