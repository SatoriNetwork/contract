// Regression guard — adv_4 game-adapters: a later predict must NOT orphan an
// earlier unfinalized adapter prediction.
//
// FINDING (medium): YesNoGame tracks only ONE `pendingRound` per (game,user).
// `record` overwrites it. The auditor's mechanism EXPLICITLY presumes the
// eviction bug (adv_3): "if the prior round became unresolvable (anchor
// evicted), score returns false and the prior pendingRound is then OVERWRITTEN
// by the new round" → the prior round's adapterUserRecord + its unsettled-count
// bump are orphaned permanently.
//
// RESOLUTION: subsumed by the adv_3 fix. predict is score-first — the protocol
// calls score() on the current pendingRound BEFORE record() overwrites it. With
// adv_3, score() now force-finalizes an anchor-evicted prior round (returns
// resolved=true; the adapter clears its per-user record and the core decrements
// the unsettled count) instead of returning false. So the prior round is
// finalized before the overwrite — never orphaned.
//
// The only other way score() returns not-resolved is "data not ready"
// (!found && !anchorEvicted). That can't coincide with a later predict: a
// predict requires a fresh stream value in the later round (PredictExpired
// guard), and that value is "after" the prior round, so getFirstValueAfter(prior)
// finds it and resolves the prior round during the same score-first. Hence a
// later predict ALWAYS finalizes the prior round — covered by test 2.
//
// THE REFACTOR (bucket -> score/total): SatoriRewards.adapterUserRecord is GONE
// (the core no longer stores per-bet bucket/weight). The adapter owns its
// per-user state, so "finalized / not orphaned" is observed BEHAVIORALLY on the
// adapter: score() CLEARS its record (pendingRound/pendingWeight read back 0)
// when it finalizes a round. A still-pending prior round would instead keep a
// live, non-zero record for that round (orphaned). We also confirm the adapter
// re-points pendingRound at the later bet (the overwrite happened) and that the
// resolvable case genuinely RESOLVED, distinguishing it from a void or a strand.
//
// MINT ELIGIBILITY: only the built-in binary game (type 0) earns from the mint,
// so an adapter game can never be voted for, holds no weight, and pays zero. The
// resolvable case used to prove "not a void" by showing the win PAID; it now
// proves it with the adapter's `roundOutcome(gameId, round)` cache, which score()
// writes with the resolved direction. That is the stricter probe: the
// anchor-evicted force-finalize branch returns before writing it, and a "data not
// ready" score never reaches it, so only a real data-backed resolve leaves a
// direction there.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture, time, impersonateAccount, setBalance,
} = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor, VOTE } = require("../fixtures");

const ROUND = 86400;
const YES = 1;
const NO = 2;

// Advances EXACTLY two rounds. The adapter host stream is 2880 minutes (two
// rounds), so a
// setValue may only be written every 2 rounds (>= 2 rounds AND >= 2*ROUND - 30min
// of wall clock between writes). Every advanceRound() call in this file sits
// directly before a host setValue, so spacing each write two rounds apart
// satisfies both halves of the cadence rhythm. Adapter scoring keys on round
// advance (currentRound > predictRound), so the extra round does not change any
// prediction outcome.
async function advanceRound() { await time.increase(2 * ROUND); }

// Genesis creates the DEFAULT stream at id 1 plus its derived family at ids
// 2..4, so the first stream a test creates is id 5. Read it off the event.
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

describe("adv_4 game-adapters — a later predict never orphans an earlier adapter prediction", function () {
  this.timeout(600000);

  async function deploy() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, rewards, registry, games, engine, owner } = fix;

    const YesNoGame = await ethers.getContractFactory("YesNoGame");
    const yesNo = await YesNoGame.deploy(
      await engine.getAddress(),
      await games.getAddress(),
      await registry.getAddress());
    await yesNo.waitForDeployment();

    const satoriAddr = await satori.getAddress();
    await impersonateAccount(satoriAddr);
    await setBalance(satoriAddr, ethers.parseEther("10"));
    const coreSigner = await ethers.getSigner(satoriAddr);
    await games.connect(coreSigner).registerGameAdapter(
      await yesNo.getAddress(), owner.address, "YesNo", false
    );

    // An adapter game's host stream must be >= 2880 minutes (GameCadenceTooShort
    // otherwise),
    // which is why every host write in this file is two rounds apart.
    const streamId = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
        "BTC-Test", owner.address, 2880),
      satori);
    // The stream's own auto-created binary (type-0) game — NOT gameId 1, which
    // is the protocol default game living on the default stream.
    const binaryGameId = Number(await games.binaryGameByStream(streamId));

    const threshold = 150;
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [threshold]);
    const tx = await satori.connect(owner).createGame(streamId, 1, cfg, "BTC-yesno");
    const yesNoGameId = await gameIdFrom(tx, games);

    return { ...fix, yesNo, streamId, binaryGameId, yesNoGameId, threshold };
  }

  it("EVICTION: a later predict force-finalizes the evicted prior round (not orphaned)", async function () {
    const { satori, rewards, registry, engine, voting, yesNo, yesNoGameId,
            binaryGameId, streamId, signers, owner } = await loadFixture(deploy);
    const alice = signers[1];
    await satori.transfer(alice.address, ethers.parseEther("10"));

    await advanceRound();
    await registry.connect(owner).setValue(streamId, 100);

    // Round R: Alice predicts YES on the adapter AND co-stages the SAME
    // STREAM's binary UP bet. Both share _unsettledPredictionCount[alice][R].
    // The binary bet keeps its OWN per-round slot (the adapter's single
    // per-(game,user) pointer can't overwrite it), giving us a probe for round
    // R's terminal state that survives the later adapter predict.
    await advanceRound();
    await registry.connect(owner).setValue(streamId, 100);
    const roundR = await satori.getCurrentRound();
    // Only the BINARY game can be given weight — `vote` on an adapter game
    // reverts GameNotMintEligible. That does not weaken the probe: the adapter
    // receives the predictor's UNDIVIDED prediction power whether or not the
    // game is mint-eligible, so there is real committed weight to orphan.
    const v1 = signers[2], v2 = signers[3];
    await satori.transfer(v1.address, ethers.parseEther("10"));
    await satori.transfer(v2.address, ethers.parseEther("10"));
    await expect(satori.connect(v1).vote(yesNoGameId, VOTE))
      .to.be.revertedWithCustomError(voting, "GameNotMintEligible");
    await voteFor(satori, v2, binaryGameId);
    const alicePower = await rewards.getPredictionPower(alice.address);
    expect(alicePower).to.be.gt(0n);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: yesNoGameId, payload: pack1(YES) },
      { gameId: binaryGameId, payload: pack1(YES) },
    ]);
    // PRE-state on the adapter (the core no longer stores per-bet bucket/weight).
    // The weight is Alice's FULL power — undivided across the 2-game batch,
    // because that division exists only to apportion SATORI and an adapter game
    // draws none.
    expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(alicePower);
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(roundR);

    // Evict R's anchor: 769 strictly-later ticks roll the 768-entry ring past
    // it. The probe queries R*24+23 — the last hour of round R, the exact
    // hour-keyed query the adapter's score() makes.
    for (let i = 0; i < 769; i++) {
      await advanceRound();
      await registry.connect(owner).setValue(streamId, 200 + i);
    }
    const [, found, anchorEvicted] = await registry.getFirstValueAfter(streamId, Number(roundR) * 24 + 23);
    expect(found).to.equal(false);
    expect(anchorEvicted).to.equal(true);

    // Later round: Alice predicts again on the same adapter game. predict is
    // score-first, so score() runs on pendingRound == R BEFORE record overwrites
    // it. With the adv_3 fix score() force-finalizes the evicted R.
    const roundLater = await satori.getCurrentRound();
    expect(roundLater).to.be.greaterThan(roundR);
    // Read Alice's live power so the single-game weight assertion below is
    // exact rather than hardcoded (prediction power is balance + unclaimed, and
    // round R's bets were force-finalized, so nothing was credited).
    const laterPower = await rewards.getPredictionPower(alice.address);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: yesNoGameId, payload: pack1(NO) },
    ]);

    // R's adapter bet was force-finalized during score-first: the adapter's
    // single per-(game,user) pointer now cleanly points at the LATER round, and
    // its committed weight is the later bet's (the prior bet was cleared, not
    // orphaned-and-stranded). A non-cleared prior round would have reverted the
    // overwrite or left a corrupt pointer.
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(roundLater);
    expect(await yesNo.pendingWeight(yesNoGameId, alice.address))
      .to.equal(laterPower); // later single-game bet, full (bonus-inclusive) power

    // Independent confirmation that round R's bookkeeping is intact (not
    // orphaned): the co-pending BINARY bet on round R still force-finalizes
    // terminally (PredictionUnrecoverable). If the adapter's score-first had
    // failed to decrement the shared per-(user,R) counter, R's accounting would
    // be corrupt; this clean terminal settle shows it is not.
    await expect(satori.settlePrediction(alice.address, binaryGameId))
      .to.emit(engine, "PredictionUnrecoverable");

    // Extra adapter settles are clean no-ops on the later round (no revert).
    for (let i = 0; i < 3; i++) {
      await expect(satori.connect(owner).settlePrediction(alice.address, yesNoGameId))
        .to.not.be.reverted;
    }
  });

  it("RESOLVABLE: a later predict resolves (finalizes) the prior round during score-first", async function () {
    const { satori, rewards, registry, yesNo, yesNoGameId, streamId, signers, owner } =
      await loadFixture(deploy);
    const alice = signers[1];
    await satori.transfer(alice.address, ethers.parseEther("10"));
    // No vote: the game is an ADAPTER game, so `vote` reverts
    // GameNotMintEligible and it can never draw a SATORI pool. The "resolved vs
    // voided" distinction the payout used to carry is instead read straight off
    // the adapter's `roundOutcome` cache — a stronger probe, since it names the
    // resolved direction rather than inferring it from a credit.

    await advanceRound();
    await registry.connect(owner).setValue(streamId, 100);

    // Round R: Alice predicts YES.
    await advanceRound();
    await registry.connect(owner).setValue(streamId, 100);
    const roundR = await satori.getCurrentRound();
    const powerR = await rewards.getPredictionPower(alice.address);
    expect(powerR).to.be.gt(0n);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: yesNoGameId, payload: pack1(YES) },
    ]);
    // PRE-state on the adapter (the core no longer stores per-bet bucket/weight).
    expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(powerR);
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(roundR);

    // Later round (NOT evicted): a fresh value is posted (required to predict),
    // and it is "after" round R, so getFirstValueAfter(R) finds it -> score()
    // resolves R during the new predict's score-first. R can never be orphaned.
    await advanceRound();
    await registry.connect(owner).setValue(streamId, 500); // 500 > threshold 150 => YES wins R
    const roundLater = await satori.getCurrentRound();
    const laterPower = await rewards.getPredictionPower(alice.address);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: yesNoGameId, payload: pack1(NO) },
    ]);

    // R was resolved + finalized during score-first; Alice (YES) won R. The
    // adapter's single per-(game,user) pointer cleanly advanced to the later
    // round (the prior bet was cleared, not orphaned)...
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(roundLater);
    // ...and round R genuinely RESOLVED rather than being voided or stranded:
    // score() read the 500, decided the direction and cached it. This is the
    // discriminator that used to be carried by "the YES win paid". It is the
    // sharper one — the eviction/force-finalize branch returns BEFORE writing
    // roundOutcome, and a "data not ready" score returns without touching it at
    // all, so only a real data-backed resolve can leave YES here.
    expect(await yesNo.roundOutcome(yesNoGameId, roundR)).to.equal(YES);
    // INVERTED (mint eligibility): the YES win for R credited NOTHING. An
    // adapter game cannot be voted for, so it holds no weight and draws no pool.
    // The zero is safe to read as "resolved and paid nothing" rather than
    // "never settled" precisely because roundOutcome above proves the resolve.
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
    // The later bet's committed weight is the predictor's undivided power at
    // record time — unchanged from the original stake, since the R win paid no
    // SATORI to fold back in.
    expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(laterPower);
    expect(laterPower).to.equal(powerR);
  });
});
