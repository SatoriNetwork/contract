// OFF-CHAIN PREDICTION COUNT — the reporter key.
//
// The default stream's value is "how many predictions the protocol made last
// round". Once predictors move off-chain (merkle-settled), that number falls
// even though the platform is doing MORE work, not less: those predictors are
// still participating, they are just trusting the operator rather than the
// chain. A number that reads as decline while the platform grows is worse than
// no number.
//
// So one key, set by the admin, may add an arbitrary amount to the running
// count. That is the whole feature.
//
// WHY IT NEEDS NO BOOKKEEPING: `predictionCount` is structurally isolated.
// SatoriEngine's own note (the RoundState declaration) records that the round
// DENOMINATOR moved out to SatoriVoting/`roundDenominator`, and that
// `predictionCount` "survives because flushDefaultStream publishes the previous
// round's count". Three internal uses — the view, the flush, the bump — and
// SatoriHub never calls the view. Nothing economic reads it, so adding to it
// cannot touch rewards, scoring, streaks or denominators. There is nothing to
// reconcile, which is why no second slot and no per-round guard exist here.
const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const ROUND = 86400; // 24h
const UP = 1;

async function streamIdFrom(tx, satori) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = satori.interface.parseLog(log);
      if (parsed && parsed.name === "DataStreamCreated") return Number(parsed.args.streamId);
    } catch { /* not ours */ }
  }
  throw new Error("DataStreamCreated event not found");
}

describe("Off-chain prediction count", function () {
  let satori, registry, engine, rewards;
  let owner, reporter, alice, mallory;
  let g2;

  beforeEach(async function () {
    // loadFixture, NOT a bare deploy: these tests advance the clock with
    // `time.increase`, and hardhat's chain time is shared by the WHOLE run. A
    // bare deploy leaves that advance in place for every later file, and the
    // spam-fee/balance economics downstream are time-sensitive
    // (`SatoriRewardsLens._burnBase` scales with rounds elapsed) — a bare deploy
    // here broke `admin-adapter-delta.cov.test.js` two directories away.
    // loadFixture snapshots once and REVERTS before each test, so the clock this
    // file moves is put back rather than leaked.
    const fix = await loadFixture(deploySatoriFixture);
    ;({ satori, registry, engine, rewards, owner } = fix);
    [, reporter, alice, mallory] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("200"));
    g2 = await streamIdFrom(await satori.createSimpleDataStream("Test", owner.address), satori);
  });

  describe("the key", function () {
    it("starts unset, so nobody can report", async function () {
      expect(await engine.offchainReporter()).to.equal(ethers.ZeroAddress);
      await expect(engine.connect(reporter).reportOffchainPredictions(5))
        .to.be.revertedWithCustomError(engine, "NotOffchainReporter");
    });

    it("is set by the rewards admin", async function () {
      expect(await rewards.admin()).to.equal(owner.address);
      await engine.connect(owner).setOffchainReporter(reporter.address);
      expect(await engine.offchainReporter()).to.equal(reporter.address);
    });

    it("cannot be set by anyone else — not even the current reporter", async function () {
      await engine.connect(owner).setOffchainReporter(reporter.address);
      await expect(engine.connect(mallory).setOffchainReporter(mallory.address))
        .to.be.revertedWithCustomError(engine, "OnlyAdmin");
      // The reporter may report; it may not promote itself or a successor.
      await expect(engine.connect(reporter).setOffchainReporter(reporter.address))
        .to.be.revertedWithCustomError(engine, "OnlyAdmin");
    });

    it("is rotatable, and the old key goes cold immediately", async function () {
      await engine.connect(owner).setOffchainReporter(reporter.address);
      await engine.connect(owner).setOffchainReporter(alice.address);

      expect(await engine.offchainReporter()).to.equal(alice.address);
      await expect(engine.connect(reporter).reportOffchainPredictions(5))
        .to.be.revertedWithCustomError(engine, "NotOffchainReporter");
      await engine.connect(alice).reportOffchainPredictions(5); // succeeds
    });

    it("can be revoked by setting it back to zero", async function () {
      await engine.connect(owner).setOffchainReporter(reporter.address);
      await engine.connect(owner).setOffchainReporter(ethers.ZeroAddress);
      await expect(engine.connect(reporter).reportOffchainPredictions(5))
        .to.be.revertedWithCustomError(engine, "NotOffchainReporter");
    });

    it("refuses every other caller", async function () {
      await engine.connect(owner).setOffchainReporter(reporter.address);
      for (const who of [mallory, alice, owner]) {
        await expect(engine.connect(who).reportOffchainPredictions(5))
          .to.be.revertedWithCustomError(engine, "NotOffchainReporter");
      }
    });
  });

  describe("reporting", function () {
    beforeEach(async function () {
      await engine.connect(owner).setOffchainReporter(reporter.address);
    });

    it("emits OffchainPredictionsReported with the reporter, round, count and the round's new total", async function () {
      const round = await satori.getCurrentRound();
      await expect(engine.connect(reporter).reportOffchainPredictions(42))
        .to.emit(engine, "OffchainPredictionsReported").withArgs(reporter.address, round, 42, 42);
      await expect(engine.connect(reporter).reportOffchainPredictions(8))
        .to.emit(engine, "OffchainPredictionsReported").withArgs(reporter.address, round, 8, 50);
    });

    it("adds straight to the current round's count", async function () {
      const round = await satori.getCurrentRound();
      await engine.connect(reporter).reportOffchainPredictions(42);
      expect(await satori.roundPredictionCount(round)).to.equal(42);
    });

    it("stacks on top of the on-chain predictions in the same round", async function () {
      await time.increase(ROUND);
      await registry.setValue(g2, 100);
      const round = await satori.getCurrentRound();

      await voteFor(satori, alice, g2);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);
      expect(await satori.roundPredictionCount(round)).to.equal(1);

      await engine.connect(reporter).reportOffchainPredictions(99);
      expect(await satori.roundPredictionCount(round)).to.equal(100);
    });

    it("accumulates across several calls in one round — there is no once-per-round guard", async function () {
      // Deliberate: the guard would only ever stop a SECOND call, never a wrong
      // first one, so it buys nothing. Dropping it also lets the operator report
      // incrementally through a round without a contract change.
      const round = await satori.getCurrentRound();
      await engine.connect(reporter).reportOffchainPredictions(10);
      await engine.connect(reporter).reportOffchainPredictions(20);
      await engine.connect(reporter).reportOffchainPredictions(30);
      expect(await satori.roundPredictionCount(round)).to.equal(60);
    });

    it("lands in whichever round is current when it mines", async function () {
      const first = await satori.getCurrentRound();
      await engine.connect(reporter).reportOffchainPredictions(7);

      await time.increase(ROUND);
      const second = await satori.getCurrentRound();
      expect(second).to.not.equal(first);
      await engine.connect(reporter).reportOffchainPredictions(11);

      expect(await satori.roundPredictionCount(first)).to.equal(7);
      expect(await satori.roundPredictionCount(second)).to.equal(11);
    });

    it("treats zero as a no-op rather than a revert", async function () {
      const round = await satori.getCurrentRound();
      await engine.connect(reporter).reportOffchainPredictions(0);
      expect(await satori.roundPredictionCount(round)).to.equal(0);
    });
  });

  describe("the number reaches the stream", function () {
    beforeEach(async function () {
      await engine.connect(owner).setOffchainReporter(reporter.address);
    });

    it("reaches the COUNT stat, but not the scored value (off-chain has no committed capital)", async function () {
      await time.increase(ROUND);
      const r = await satori.getCurrentRound();
      await engine.connect(reporter).reportOffchainPredictions(500);
      // The count still combines on/off-chain participation...
      expect(await satori.roundPredictionCount(r)).to.equal(500);

      await time.increase(ROUND);
      await satori.flushDefaultStream();

      // ...but the default game is scored on CAPITAL deployed (deployedPower /
      // supply), and off-chain reports carry no on-chain power — so with no
      // on-chain prediction that round the scored value is 0. Feeding the
      // off-chain COUNT into the value would reopen the manipulation the
      // capital metric closes (adversary finding 2026-09-07).
      expect(await registry.getValue(1)).to.equal(0);
    });

    it("combines on/off-chain in the COUNT stat; the scored value tracks on-chain capital only", async function () {
      await time.increase(ROUND);
      const r = await satori.getCurrentRound();
      await registry.setValue(g2, 100);

      await voteFor(satori, alice, g2);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);
      await engine.connect(reporter).reportOffchainPredictions(9);

      // The COUNT is one number regardless of where predicting happened: 1
      // on-chain + 9 off-chain = 10.
      expect(await satori.roundPredictionCount(r)).to.equal(10);

      await time.increase(ROUND);
      await satori.flushDefaultStream();

      // The scored VALUE is deployedPower/supply x 1e18 — alice's one on-chain
      // prediction committed real power, so it is non-zero; the 9 off-chain
      // (capital-less) reports add nothing to it.
      expect(await registry.getValue(1)).to.be.gt(0);
    });
  });

  describe("arithmetic", function () {
    beforeEach(async function () {
      await engine.connect(owner).setOffchainReporter(reporter.address);
    });

    it("takes a uint64, so an oversized number cannot silently truncate", async function () {
      // `_bumpPredictionCount` casts `uint64(count)` internally. Had the
      // parameter been uint256, reporting 2**64 would have added ZERO and
      // 2**64 + 5 would have added 5 — a wrong answer with no revert. The
      // parameter type makes that unreachable: ethers rejects it before it is
      // ever encoded.
      await expect(
        engine.connect(reporter).reportOffchainPredictions(2n ** 64n)
      ).to.be.rejected;
    });

    it("reverts rather than wrapping when the counter would overflow", async function () {
      const MAX64 = 2n ** 64n - 1n;
      await engine.connect(reporter).reportOffchainPredictions(MAX64);
      // Checked arithmetic (pragma ^0.8.20): the second add panics instead of
      // silently rolling the count back to a small number.
      await expect(engine.connect(reporter).reportOffchainPredictions(1))
        .to.be.revertedWithPanic(0x11);
    });
  });
});
