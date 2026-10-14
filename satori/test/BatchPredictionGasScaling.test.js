// How does a batch predict SCALE with the number of games in it?
//
// The dapp shows "gas left ≈ N more predictions", and that figure is only
// honest if we know what one prediction costs. If batching were nearly free
// after the first game, a per-game estimate would badly UNDER-state how far a
// balance goes; if it is linear, a per-batch estimate would badly OVER-state it.
// Guessing either way misleads the user about when they run out of gas.
//
// So measure: identical predictions, batches of 1..5, printing the marginal
// cost of each additional game. Asserts only the SHAPE (a real fixed overhead,
// a stable marginal cost) so it documents the economics without pinning exact
// numbers that any optimisation would break.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const l of r.logs) {
    try {
      const p = satori.interface.parseLog(l);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) { /* not ours */ }
  }
  throw new Error("DataStreamCreated missing");
}
async function nextRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

describe("Gas: how a batch predict scales with batch size", function () {
  this.timeout(180000);

  it("reports the marginal cost of each extra game in a batch", async function () {
    const fix = await deploySatoriFixture();
    const { satori, registry } = fix;
    const signers = await ethers.getSigners();
    const owner = fix.owner;

    const MAX = 5;
    // One predictor per batch size, so no wallet predicts twice in a round and
    // every measurement starts from the same cold state.
    const actors = signers.slice(10, 10 + MAX);
    const streams = [];

    // MAX streams, each carrying burnt vote weight so every game is eligible —
    // an ineligible game skips the reward-side writes and would understate the
    // marginal cost.
    for (let i = 0; i < MAX; i++) {
      const id = await streamIdFrom(
        await satori[SIMPLE3](`S${i}`, owner.address, 1440), satori);
      streams.push(id);
    }
    const voter = signers[6];
    await satori.transfer(voter.address, ethers.parseEther("100"));
    for (const id of streams) await satori.connect(voter).vote(id, VOTE);

    for (const a of actors) await satori.transfer(a.address, ethers.parseEther("50"));

    await nextRound();
    for (const id of streams) await registry.setValue(id, 100);

    // The round's FIRST predictor also pays flushDefaultStream(), a once-per-
    // round cost that has nothing to do with batch size. Burn it on a warm-up
    // actor so it does not land on the n=1 measurement and make one game look
    // more expensive than two.
    await satori.connect(signers[7]).predictMultipleWithPayloads(
      [{ gameId: streams[0], payload: pack1(UP) }]);

    const measure = async (label) => {
      const out = [];
      for (let n = 1; n <= MAX; n++) {
        const reqs = streams.slice(0, n).map((g) => ({ gameId: g, payload: pack1(UP) }));
        const rc = await (await satori.connect(actors[n - 1])
          .predictMultipleWithPayloads(reqs)).wait();
        out.push({ n, gas: Number(rc.gasUsed) });
      }
      const marginal = (out[MAX - 1].gas - out[0].gas) / (MAX - 1);
      const fixed = out[0].gas - marginal;
      console.log(`\n=== ${label} ===`);
      console.log("games |      gas | marginal | per game");
      out.forEach((r, i) => console.log(
        String(r.n).padStart(5), "|", String(r.gas).padStart(8),
        "|", String(i === 0 ? r.gas : r.gas - out[i - 1].gas).padStart(8),
        "|", String(Math.round(r.gas / r.n)).padStart(8)));
      console.log(`  ≈ ${Math.round(fixed)} fixed + N × ${Math.round(marginal)} per game`);
      return { out, fixed, marginal };
    };

    // FIRST EVER predictions: nothing to settle, storage slots cold.
    const cold = await measure("COLD — first predictions, nothing to settle");

    // STEADY STATE: play the same games again next round. Now each game in the
    // batch ALSO settles its previous prediction, which is what anyone playing
    // regularly actually pays.
    await nextRound();
    for (const id of streams) await registry.setValue(id, 110);
    await nextRound();
    for (const id of streams) await registry.setValue(id, 120);
    await satori.connect(signers[7]).predictMultipleWithPayloads(
      [{ gameId: streams[0], payload: pack1(UP) }]); // absorb the round flush again
    const steady = await measure("STEADY STATE — predict + settle the previous round");

    console.log(
      `\nBatching a round of N games costs ~${Math.round(steady.fixed)} + N × ` +
      `${Math.round(steady.marginal)} gas, NOT N separate transactions.\n`);

    // SHAPE, not magnitudes:
    // 1. Every extra game costs something real — batching is not free.
    expect(cold.marginal).to.be.greaterThan(20000);
    // 2. An extra game is much CHEAPER than the first, because the per-batch
    //    work (participation, lock, round counters, unsettled bump) is paid
    //    once. That is what makes batching worth offering at all.
    expect(cold.marginal).to.be.lessThan(cold.out[0].gas / 2);
    // 3. Growth stays essentially linear — no runaway term. The duplicate guard
    //    is O(n²) but runs in memory, so it must not dominate at these sizes.
    const steps = cold.out.slice(1).map((r, i) => r.gas - cold.out[i].gas);
    expect(Math.max(...steps)).to.be.lessThan(Math.min(...steps) * 2);
    // 4. Settling is the dominant per-game cost in steady state, so a regular
    //    player's marginal game costs more than a first-timer's.
    expect(steady.marginal).to.be.greaterThan(cold.marginal);
  });
});
