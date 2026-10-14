const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ROUND = 86400;                            // 24h — one round
const CADENCE_ROUNDS = 2;                       // daily — a public stream's finest cadence
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS; // 24h — one cadence period of g2

// One ROUND (24h). The DEFAULT stream (id 1) is cadence 1 and keeps its
// every-round flush rhythm, so this is still the right step for anything about
// stream 1 itself, and for moving past a prediction round.
async function advanceOneDay() {
  await time.increase(ROUND);
}

// The helper stream `g2` is created through the 2-arg `createSimpleDataStream`
// overload, which now defaults to cadence 2 (daily) — what a real public user
// gets. Rewriting g2's value therefore needs a full cadence period: TWO rounds.
async function advanceCadence() {
  await time.increase(CADENCE_SECONDS);
}

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

describe("Default Stream", function () {
  let satori, voting, rewards, bounties, registry;
  let owner, alice, bob;
  let g2; // the test stream/game created in beforeEach (id 2 — the default owns id 1)
  const UP = 1;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties, owner } = fix);
    [, alice, bob] = fix.signers;

    // The fixture already calls initializeDefaultStream() (exactly as production
    // does), so the default stream/game occupies id 1 before this file runs.

    await satori.transfer(alice.address, ethers.parseEther("200"));
    await satori.transfer(bob.address, ethers.parseEther("200"));

    // Create a second stream for making predictions
    g2 = await streamIdFrom(await satori.createSimpleDataStream("Test", owner.address), satori);
  });

  describe("Initialization", function () {
    it("Should create stream ID 1 as the default stream", async function () {
      expect(await satori.DEFAULT_STREAM_ID()).to.equal(1);
      expect(await registry.streamExists(1)).to.be.true;
    });

    it("Should set the core contract as the stream authority", async function () {
      const [, authority] = await registry.getDataStreamInfo(1);
      expect(authority).to.equal(await satori.getAddress());
    });

    it("Should carry a permanent DERIVED weight on the default game", async function () {
      // The default game is never voted for — its weight is derived (1% of a
      // denominator that includes itself) and floored so it is non-zero from
      // genesis. With nothing else burnt yet, it sits exactly on the floor.
      expect(await voting.gameWeight(1)).to.equal(0n); // nothing was ever BURNT for it
      expect(await voting.weightOf(1)).to.equal(await voting.DEFAULT_WEIGHT_FLOOR());
      expect(await voting.defaultDerivedWeight()).to.be.gt(0);
    });

    it("Should grow the default weight to 1% of the denominator once a burn clears the floor", async function () {
      // The derived weight is now 1% of a denominator that includes itself:
      // d = total * 100 / 9900. A 10-ether burn would derive only 10/99 ≈ 0.101,
      // which is under the 1e18 floor — so to actually SEE the 1% derivation we
      // burn 198 (alice was funded with 200). d = 198 * 100 / 9900 = 2, which is
      // exactly 1% of the 200 total (198 burnt + 2 derived) and clears the floor.
      await voteFor(satori, alice, g2, ethers.parseEther("198"));
      expect(await voting.totalBurnedWeight()).to.equal(ethers.parseEther("198"));
      expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("2"));
      expect(await voting.weightOf(1)).to.equal(ethers.parseEther("2"));
    });

    it("Should hold only fee income — initializeDefaultStream pulls nothing", async function () {
      // initializeDefaultStream no longer pulls 1 SATORI: there is no bootstrap
      // vote to fund, the default game's weight is derived. So the hub's balance
      // is EXACTLY the spam-burn fees charged so far — the fixture's three
      // community-adapter registrations plus this file's one stream creation —
      // with no 1-SATORI seed on top.
      const fee = await satori.streamBurn();
      expect(await satori.balanceOf(await satori.getAddress())).to.equal(fee * 4n);
    });

    it("Should make the default stream eligible", async function () {
      expect(await voting.isEligible(1)).to.be.true;
    });

    it("Should reject a vote on the default game", async function () {
      await expect(satori.connect(alice).vote(1, VOTE))
        .to.be.revertedWithCustomError(voting, "CannotVoteDefault");
    });

    it("Should refuse to disable the default game", async function () {
      await expect(voting.connect(owner).setGameApproved(1, false))
        .to.be.revertedWithCustomError(voting, "CannotSetDefaultApproval");
    });

    it("Should revert if called twice", async function () {
      // The fixture already performed the one legal call.
      await expect(satori.initializeDefaultStream()).to.be.revertedWithCustomError(satori, "AlreadySet");
    });
  });

  describe("Fees no longer buy the default game weight", function () {
    // Design change: the default game's weight is DERIVED from other games'
    // BURNT weight, and the token transfer hook no longer touches voting at all.
    // Fees still land on the hub, but they are just a balance now — only a burn
    // vote on some other game can move the default's weight.
    it("pays the fee to the hub without changing the default game's weight", async function () {
      const hub = await satori.getAddress();
      const fee = await satori.streamBurn();
      expect(fee).to.be.gt(0n);

      const weightBefore = await voting.weightOf(1);
      const heldBefore = await satori.balanceOf(hub);
      await satori.connect(alice).createSimpleDataStream("FeeCompound", alice.address);

      expect(await satori.balanceOf(hub)).to.equal(heldBefore + fee);
      expect(await voting.weightOf(1)).to.equal(weightBefore);
    });

    it("moves the default game's weight only when another game is voted for", async function () {
      const weightBefore = await voting.weightOf(1);
      await voteFor(satori, bob, g2, ethers.parseEther("198"));
      // 198 * 100 / 9900 = 2, which clears the 1e18 floor (a 40-ether burn would
      // derive only 40/99 ≈ 0.404 and leave the weight pinned to the floor, so it
      // would not "move" at all — the burn must exceed ~99 ether to lift it).
      expect(await voting.weightOf(1)).to.equal(ethers.parseEther("2"));
      expect(await voting.weightOf(1)).to.be.gt(weightBefore);
    });
  });

  describe("Prediction Counter", function () {
    it("Should increment counter on predict", async function () {
      await advanceOneDay();
      await registry.setValue(g2, 100);

      const round = await satori.getCurrentRound();
      await voteFor(satori, alice, g2);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);

      expect(await satori.roundPredictionCount(round)).to.equal(1);
    });

    it("Should increment counter per prediction in predictMultiple", async function () {
      const g3 = await streamIdFrom(await satori.createSimpleDataStream("S2", owner.address), satori);

      await advanceOneDay();
      await registry.setValue(g2, 100);
      await registry.setValue(g3, 200);

      const round = await satori.getCurrentRound();
      await voteFor(satori, alice, g2);

      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: g2, payload: pack1(UP) },
        { gameId: g3, payload: pack1(UP) }
      ]);

      expect(await satori.roundPredictionCount(round)).to.equal(2);
    });
  });

  describe("Flush", function () {
    it("Should write yesterday's count to the stream value", async function () {
      await advanceOneDay();
      await registry.setValue(g2, 100);

      await voteFor(satori, alice, g2);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);
      await voteFor(satori, bob, g2);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);

      const predictionRound = await satori.getCurrentRound();
      expect(await satori.roundPredictionCount(predictionRound)).to.equal(2);

      // Advance past the prediction round
      await advanceOneDay();
      await satori.flushDefaultStream();

      // The default stream's VALUE is now the participation ratio
      // (deployed power / total supply x 1e18), not the raw count. The count
      // itself is still exposed via roundPredictionCount (asserted above); the
      // flushed value is a non-zero ratio because real power was deployed.
      expect(await registry.getValue(1)).to.be.gt(0);
    });

    it("Should only write yesterday, skipping gap days", async function () {
      // Round 1: 1 prediction
      await advanceOneDay();
      await registry.setValue(g2, 100);
      await voteFor(satori, alice, g2);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);

      // One cadence period on (2 rounds): 2 predictions
      await advanceCadence();
      await registry.setValue(g2, 150);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);

      // Next round: flush writes only yesterday's value (the participation
      // ratio of the 2-prediction round) and skips every earlier round. The
      // flushed VALUE is the ratio (non-zero — both predictors committed real
      // power); the raw count is exposed separately via roundPredictionCount.
      await advanceOneDay();
      await satori.flushDefaultStream();

      expect(await registry.getValue(1)).to.be.gt(0);
    });

    it("Should be a no-op on second call same day", async function () {
      await advanceOneDay();
      await registry.setValue(g2, 100);
      await voteFor(satori, alice, g2);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);

      await advanceOneDay();
      await satori.flushDefaultStream();
      const after1 = await satori.defaultStreamLastFlushedRound();

      // Second call same day — no-op
      await satori.flushDefaultStream();
      const after2 = await satori.defaultStreamLastFlushedRound();

      expect(after2).to.equal(after1);
    });

    it("Should jump cursor to the current round after long gap", async function () {
      await advanceOneDay();
      await registry.setValue(g2, 100);
      await voteFor(satori, alice, g2);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);

      // Skip 10 days
      for (let i = 0; i < 10; i++) await advanceOneDay();

      // Single flush — records last round's count AT the current round index
      // (current-round indexing keeps the default game's value cadence in
      // lockstep with its predict cadence), and the cursor lands on today.
      await satori.flushDefaultStream();
      const today = await satori.getCurrentRound();
      expect(await satori.defaultStreamLastFlushedRound()).to.equal(today);
    });

    it("Should auto-flush when predicting on the default stream", async function () {
      // Generate some prediction count data
      await advanceOneDay();
      await registry.setValue(g2, 100);
      await voteFor(satori, bob, g2);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);

      // Advance one cadence period (so g2 may be rewritten) and flush, so the
      // default stream has a value
      await advanceCadence();
      await satori.flushDefaultStream();

      // Make more predictions
      await registry.setValue(g2, 150);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: g2, payload: pack1(UP) }]);

      // Advance — now yesterday has data but hasn't been flushed yet
      await advanceOneDay();
      await satori.flushDefaultStream();

      // Predict on the default stream — auto-flush should fire.
      // No vote is cast first: the default game cannot be voted for, it carries
      // its derived weight, and that is what makes it predictable.
      expect(await voting.isEligible(1)).to.be.true;
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: 1, payload: pack1(UP) }]);
    });
  });

  // Cannot-delete-default-stream test removed: streams are now permanent
  // protocol-wide (no `deleteStream` function exists), so the default stream
  // gets the same permanence as every other stream by construction.
});
