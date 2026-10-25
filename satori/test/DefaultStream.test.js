const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const ROUND = 86400;                            // 24h — one round
const CADENCE_ROUNDS = 2;                       // daily — a public stream's finest cadence
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS; // 24h — one cadence period of g2

// One ROUND (24h): the step for moving past a prediction round.
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
  let satori, voting, rewards, bounties, registry, engine;
  let owner, alice, bob;
  let g2; // the test stream/game created in beforeEach (id 2 — the default owns id 1)
  const UP = 1;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ;({ satori, voting, rewards, registry, bounties, owner } = fix);
    [, alice, bob] = fix.signers;
    engine = await ethers.getContractAt("SatoriEngine", await satori.engine());

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

    it("Should make stream 1 the Sentiment stream \"satori\", provided by the engine", async function () {
      const info = await registry.getDataStreamInfo(1);
      expect(info[0]).to.equal("satori");
      expect(info[1]).to.equal(await engine.getAddress());
      expect(await registry.isNamedStream(1)).to.equal(true);
    });

    it("Should hold the name \"satori\" among Sentiment streams: a second one reverts NameTaken", async function () {
      const namedId = await registry.namedAdapterId();
      await expect(
        satori.connect(alice)["createAdapterDataStream(string,uint32,address,bytes,uint24)"](
          "satori", namedId, await engine.getAddress(), "0x", 60)
      ).to.be.revertedWithCustomError(registry, "NameTaken");
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

    it("Should hold nothing — initializeDefaultStream pulls nothing and the fees burn", async function () {
      // initializeDefaultStream no longer pulls 1 SATORI: there is no bootstrap
      // vote to fund, the default game's weight is derived. The fixture's three
      // community-adapter registrations and this file's stream creation paid
      // their fees by burning them, so the hub holds none.
      expect(await satori.balanceOf(await satori.getAddress())).to.equal(0n);
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

      expect(await satori.balanceOf(hub)).to.equal(heldBefore);
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

  describe("The default stream is an ordinary Sentiment stream", function () {
    it("Should have no value until something predicts (nothing writes it)", async function () {
      expect((await registry.getLatestUpdateInfo(1))[0]).to.equal(0);
      await advanceOneDay();
      await advanceOneDay();
      expect((await registry.getLatestUpdateInfo(1))[0]).to.equal(0);
    });

    it("Should have no flush, no seed write and no setValueForRound any more", async function () {
      expect(engine.flushDefaultStream).to.equal(undefined);
      expect(satori.flushDefaultStream).to.equal(undefined);
      expect(registry.setValueForRound).to.equal(undefined);
      expect(engine.defaultStreamLastFlushedRound).to.equal(undefined);
    });

    it("Should be predictable with no vote, and its value is the crowd's flow", async function () {
      await advanceOneDay();
      expect(await voting.isEligible(1)).to.be.true;
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: 1, payload: pack1(UP) }]);
      expect(await engine.namedStreamValue(1)).to.be.gt(0n);
      // The first prediction's own pull wrote the first ring entry.
      expect((await registry.getLatestUpdateInfo(1))[0]).to.equal(1);
    });

    it("Should accept a prediction after a long quiet gap with no keeper: nothing is missing or skipped", async function () {
      await advanceOneDay();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: 1, payload: pack1(UP) }]);
      for (let i = 0; i < 10; i++) await advanceOneDay();
      await expect(
        satori.connect(bob).predictMultipleWithPayloads([{ gameId: 1, payload: pack1(UP) }])
      ).to.not.be.reverted;
    });

    it("Should let a predictor call it once per 24 hours, as any Sentiment game", async function () {
      await advanceOneDay();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: 1, payload: pack1(UP) }]);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: 1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(engine, "AlreadyPredicted");
    });
  });

  // Cannot-delete-default-stream test removed: streams are now permanent
  // protocol-wide (no `deleteStream` function exists), so the default stream
  // gets the same permanence as every other stream by construction.
});
