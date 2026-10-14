const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");

/**
 * The FIRST predictor of a game in a round must not be penalised.
 *
 * There was a real ordering bug here. The predict path decided eligibility by
 * asking "does this game have a recorded weight for this round yet?" — but that
 * record is written LATER in the very same transaction, by the first predictor.
 * So the first predictor read zero, was marked ineligible, got zero prediction
 * power, and paid the gas that made everyone AFTER them eligible. A game with a
 * single predictor would never have paid anyone at all.
 *
 * The fix: eligibility reads the game's LIVE burnt weight (`weightOf`), never a
 * per-round record. The round record is written by the same first predictor, but
 * it is only ever the reward NUMERATOR — it is no longer consulted to decide
 * whether the predictor themselves counts.
 */
describe("first predictor of a game in a round", function () {
  this.timeout(120000);

  const UP = 1;
  let satori, voting, registry, rewards, owner, signers;

  async function nextRound() {
    const t = await time.latest();
    await time.increaseTo(Math.floor(Number(t) / 86400) * 86400 + 86400 + 1);
  }
  async function streamIdFrom(tx) {
    const r = await tx.wait();
    for (const l of r.logs) {
      try { const p = satori.interface.parseLog(l); if (p?.name === "DataStreamCreated") return p.args.streamId; }
      catch (_) {}
    }
    throw new Error("DataStreamCreated not found");
  }

  beforeEach(async function () {
    const fx = await deploySatoriFixture();
    ({ satori, voting, registry, rewards, owner, signers } = fx);
  });

  it("is credited real power, and writes the round record in the same call", async function () {
    const [, alice] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));

    const sid = await streamIdFrom(await satori.createSimpleDataStream("S", owner.address));
    await satori.connect(owner).vote(sid, VOTE);

    await nextRound();
    await registry.setValue(sid, 100);
    const round = await satori.getCurrentRound();

    // Nothing recorded for this game/round yet — alice is genuinely first.
    expect(await voting.getGameVotesAtRound(sid, round)).to.equal(0n);

    await satori.connect(alice)
      .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // Her prediction carries real power: rawPredictionPower is only non-zero if
    // the game was judged ELIGIBLE at predict time. Under the old ordering this
    // was 0 for the first predictor of every game, every round.
    const pred = await satori.predictions(alice.address, sid, round);
    expect(pred.rawPredictionPower, "first predictor must carry power").to.be.gt(0n);
    expect(pred.eligible).to.equal(true);

    // And her call is what wrote the round record + denominator.
    expect(await voting.getGameVotesAtRound(sid, round))
      .to.equal(await voting.weightOf(sid));
    expect(await voting.roundVoteTotal(round)).to.be.gt(0n);
  });

  it("a game with exactly ONE predictor still pays that predictor", async function () {
    // The sharpest form of the old bug: with a single predictor, nobody ever
    // came along afterwards to benefit, so the game paid nothing at all.
    const [, alice, bob] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));

    // 2880 minutes (two rounds) so the game scores on the AB window: the
    // single post value two rounds on settles the bet.
    const sid = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("Solo", owner.address, 2880));
    await satori.connect(owner).vote(sid, VOTE);

    await nextRound();
    await registry.setValue(sid, 100);
    await satori.connect(alice)
      .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    await nextRound(); await nextRound();
    await registry.setValue(sid, 150);   // UP wins

    const before = await rewards.unclaimedRewards(alice.address);
    await satori.connect(bob).settlePrediction(alice.address, sid);
    expect(await rewards.unclaimedRewards(alice.address),
      "the only predictor must still be paid").to.be.gt(before);
  });

  it("first and second predictor of the same game are treated identically", async function () {
    const [, alice, bob] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));

    const sid = await streamIdFrom(await satori.createSimpleDataStream("Pair", owner.address));
    await satori.connect(owner).vote(sid, VOTE);

    await nextRound();
    await registry.setValue(sid, 100);
    const round = await satori.getCurrentRound();

    await satori.connect(alice)
      .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await satori.connect(bob)
      .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    const a = await satori.predictions(alice.address, sid, round);
    const b = await satori.predictions(bob.address, sid, round);
    // Equal balances, equal stake: being first must confer no disadvantage.
    expect(a.rawPredictionPower).to.equal(b.rawPredictionPower);
    expect(a.eligible).to.equal(b.eligible);
  });

  it("a game with NO burnt weight is ineligible for everyone, first or not", async function () {
    // The flip side: eligibility still means something. Live weight is the test,
    // so a game nobody has burnt for carries no power for anyone.
    const [, alice] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));

    const sid = await streamIdFrom(await satori.createSimpleDataStream("Unloved", owner.address));
    expect(await voting.weightOf(sid)).to.equal(0n);

    await nextRound();
    await registry.setValue(sid, 100);
    const round = await satori.getCurrentRound();
    await satori.connect(alice)
      .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    const pred = await satori.predictions(alice.address, sid, round);
    expect(pred.eligible).to.equal(false);
    expect(pred.rawPredictionPower).to.equal(0n);
    expect(await voting.getGameVotesAtRound(sid, round)).to.equal(0n);
  });
});
