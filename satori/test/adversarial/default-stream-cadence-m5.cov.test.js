// Regression guard for audit finding M5 (MED): default-game cadence.
//
// The default stream's streamLastUpdate always lags one round (flushDefaultStream
// writes "yesterday"), which is why the predict-window check uses
// `_expectedRound = round - 1` for the default game. But the freshness/anti-replay
// check (`streamLastUpdate <= lastPredRound → StaleValue`) did NOT apply that lag:
// after predicting at round R, at R+1 `streamLastUpdate == R <= lastPredRound == R`
// → StaleValue, so the flagship default game was predictable only every OTHER
// round (half its intended cadence; A_default_stream.md says cadence 1 = "every
// round").
//
// FIX (M5): the default game's staleness threshold lags too —
// `staleThreshold = lastPredRound - 1` — symmetric with `_expectedRound`. The
// adjustment is default-only; regular streams keep `streamLastUpdate <= lastPredRound`.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const ROUND = 86400, UP = 1;

function errName(e) {
  const m = e.message.match(/custom error '(\w+)/);
  return m ? m[1] : e.message.slice(0, 60);
}
async function getSid(tx, satori) {
  const r = await tx.wait();
  for (const l of r.logs) {
    try { const p = satori.interface.parseLog(l); if (p && p.name === "DataStreamCreated") return Number(p.args.streamId); } catch {}
  }
  throw new Error("no DataStreamCreated");
}
async function nextRoundFull() {
  const now = await time.latest();
  const b = Math.floor(now / ROUND) * ROUND + ROUND;
  await time.increaseTo(b + 100);
}

describe("M5 cov — default game is predictable every round (cadence 1)", function () {
  this.timeout(300000);

  it("default game (gameId 1) accepts a prediction EVERY round, matching a regular stream", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner, signers } = fix;
    if (!(await satori.defaultStreamInitialized())) await satori.initializeDefaultStream();

    const alice = signers[1];
    await satori.transfer(alice.address, ethers.parseEther("100"));
    // The default game (id 1) needs no vote — and cannot take one
    // (`CannotVoteDefault`). Its weight is DERIVED (20% of all other burn,
    // floored at DEFAULT_WEIGHT_FLOOR = 1e18), so it is always eligible.

    // The CONTROL is the "regular stream" the default game is measured against,
    // so it has to share the default's every-round cadence — a cadence-2 control
    // could not be predicted every round no matter what the default game does,
    // and the comparison would prove nothing. Cadence 1 is ADMIN-ONLY now
    // (`StreamCadenceTooShort` for anyone else); `satori` is connected to the
    // deployer, which is rewards.admin() in this fixture.
    const sid = await getSid(
      await satori["createSimpleDataStream(string,address,uint24)"]("CTRL", owner.address, 720),
      satori
    );
    const bob = signers[2];
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await voteFor(satori, bob, sid); // burn 10 -> the control game carries weight

    const defResults = [], ctrlResults = [];
    for (let k = 0; k < 5; k++) {
      await nextRoundFull();
      await satori.flushDefaultStream();
      await registry.setValue(sid, 100 + k); // fresh control value each round
      try { await satori.connect(alice).predictMultipleWithPayloads([{ gameId: 1, payload: pack1(UP) }]); defResults.push(true); }
      catch (e) { defResults.push(errName(e)); }
      try { await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]); ctrlResults.push(true); }
      catch (e) { ctrlResults.push(errName(e)); }
    }

    // FIXED: the default game now lands a prediction every round — no every-other
    // round StaleValue — exactly like a regular stream.
    expect(defResults).to.deep.equal([true, true, true, true, true]);
    expect(ctrlResults).to.deep.equal([true, true, true, true, true]);
  });

  it("normal-stream freshness guard is INTACT: a non-advanced regular stream still reverts StaleValue", async function () {
    // The fix is default-only; a regular stream that has NOT advanced since the
    // user's last prediction must still be rejected (no replay against stale data).
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, owner, signers } = fix;

    const sid = await getSid(await satori.createSimpleDataStream("S", owner.address), satori);
    const alice = signers[1];
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await voteFor(satori, alice, sid); // burn 10 -> the game carries weight

    await nextRoundFull();
    await registry.setValue(sid, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    // Next round, but DO NOT update the stream value → streamLastUpdate unchanged.
    await nextRoundFull();
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }])
    ).to.be.revertedWithCustomError(satori, "StaleValue");
  });
});
