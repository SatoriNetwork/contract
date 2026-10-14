/**
 * ThreeBugFixes.test.js
 *
 * Tests for two correctness fixes:
 *   Bug 1: predict() used midnight timestamp for its 23-hour freshness window.
 *          Phase 6 (targets-on-games) DELETED the window outright — moment-
 *          anchored scoring keys the anchor to the prediction's own hour, so
 *          predicting works any moment. The Bug 1 block now pins the window's
 *          absence, plus the freshness gate that survives: StaleValue on a
 *          repeat prediction with no intervening stream write.
 *   Bug 2: Lock check <= vs < inconsistency between predict() and _update()
 *          Fixed: _update() now uses <= instead of < for consistency
 *
 *   (Bug 3 — "vote direction-switch removes the correct weight after a balance
 *   change" — is gone with burn voting. A vote burns tokens and buys permanent
 *   weight: there is no switching, no per-voter booking, and a balance change
 *   cannot move weight that was bought with destroyed tokens. The case it
 *   guarded cannot arise, so it was deleted rather than migrated.)
 */

const { expect } = require("chai");
const { deploySatoriFixture: deploySplitStack, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const DOWN = 2;

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch {
      return false;
    }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

async function deploySatoriFixture() {
  const fix = await deploySplitStack();
  const [owner, alice, bob, carol] = fix.signers;
  return { ...fix, owner, alice, bob, carol };
}

describe("Bug Fix Tests", function () {

  // =========================================================================
  // Bug 1: predict() 23-hour window uses actual update timestamp
  // =========================================================================
  describe("Bug 1 (superseded by phase 6): the predict expiry window is gone; StaleValue remains", function () {
    let satori, voting, rewards, bounties, registry;
    let owner, alice, bob;
    let stream1;
    let bug1Unit;

    beforeEach(async function () {
      ({ satori, voting, rewards, registry, owner, alice, bob } = await deploySatoriFixture());

      // Mint tokens to alice and bob in derived ratios (alice dominant).
      // UNIT = INITIAL_MINT/9. alice = 4U, bob = U; voter3/voter4 used later
      // each take U. Sum = 7U fits well under bootstrap.
      const INITIAL_MINT = await satori.INITIAL_MINT();
      bug1Unit = INITIAL_MINT / 9n;
      await satori.transfer(alice.address, bug1Unit * 4n);
      await satori.transfer(bob.address, bug1Unit);

      // Create a stream
      const tx = await satori.createSimpleDataStream("TestStream", owner.address);
      stream1 = await getStreamIdFromTx(tx, registry);

      // Burn for the stream so it carries weight and earns
      await voteFor(satori, alice, stream1);
      await voteFor(satori, bob, stream1);
    });

    it("Should allow predict within 23 hours of actual setValue timestamp", async function () {
      // Set value at beginning of day (timestamp = 00:01)
      const updateTime = await time.latest();
      await registry.setValue(stream1, 1000);

      // Predict immediately at 00:02 - well within 23 hours of actual update
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.not.be.reverted;
    });

    it("predict 25 hours after setValue SUCCEEDS — the 23-hour window is gone (phase 6)", async function () {
      // Set value now
      await registry.setValue(stream1, 1000);

      // Advance 25 hours past the actual update timestamp — under the old
      // window this reverted PredictExpired; moment-anchored scoring makes
      // the late prediction safe (its anchor is the last write before it).
      await time.increase(25 * 3600);

      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.not.be.reverted;
    });

    it("Should allow predict later in the same round as setValue", async function () {
      // Align to round start so the setValue lands at the beginning of a
      // 24-hour round, giving the predict window the full round to play with.
      const now = await time.latest();
      const nextRound = Math.floor(now / 86400) * 86400 + 86400;
      await time.increaseTo(nextRound + 1);

      await registry.setValue(stream1, 1000);

      // Advance ~10 hours — still in the same round (rounds are 24h).
      await time.increase(10 * 3600);

      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.not.be.reverted;
    });

    it("StaleValue is the freshness gate that remains: a repeat prediction with no new write reverts", async function () {
      // The old midnight-vs-timestamp window bug is moot — the window itself
      // was deleted in phase 6. What still protects freshness: a user's
      // SECOND prediction on a game requires a stream write since their last
      // one (StaleValue).
      await time.increase(60);
      await registry.setValue(stream1, 1000);

      // First prediction: fine at any moment.
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // 25 hours later — a NEW round, so not DuplicatePrediction — but the
      // stream has not written since alice's prediction: StaleValue.
      await time.increase(25 * 3600);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }])
      ).to.be.revertedWithCustomError(satori, "StaleValue");
    });

    it("predictMultiple: no expiry window either; StaleValue still binds on repeats", async function () {
      // Create second stream
      const tx2 = await satori.createSimpleDataStream("TestStream2", owner.address);
      const stream2 = await getStreamIdFromTx(tx2, registry);

      // Burn for stream2 so it carries weight too. There is no threshold and no
      // top-N any more — any enabled game with weight > 0 earns — so a couple of
      // fresh voters is all this needs.
      const [,,,,,voter3, voter4] = await ethers.getSigners();
      await satori.transfer(voter3.address, bug1Unit);
      await satori.transfer(voter4.address, bug1Unit);
      await voteFor(satori, voter3, stream2);
      await voteFor(satori, voter4, stream2);

      await registry.setValue(stream1, 1000);
      await registry.setValue(stream2, 2000);

      // Advance 25 hours
      await time.increase(25 * 3600);

      // predictMultiple also has no expiry window any more (phase 6) — a
      // batch 25 hours after the writes goes through...
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([
          { gameId: stream1, payload: pack1(UP) },
          { gameId: stream2, payload: pack1(DOWN) }
        ])
      ).to.not.be.reverted;

      // ...and the surviving gate binds batch-wide too: repeating the batch
      // next round with no intervening writes reverts StaleValue.
      await time.increase(25 * 3600);
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([
          { gameId: stream1, payload: pack1(UP) },
          { gameId: stream2, payload: pack1(DOWN) }
        ])
      ).to.be.revertedWithCustomError(satori, "StaleValue");
    });
  });

  // =========================================================================
  // Bug 2: Lock check consistency between predict() and _update()
  // =========================================================================
  describe("Bug 2: Lock expiration is consistent between predict() and transfer()", function () {
    let satori, voting, rewards, bounties, registry;
    let owner, alice, bob;
    let stream1;
    let bug2Unit;

    beforeEach(async function () {
      ({ satori, voting, rewards, registry, owner, alice, bob } = await deploySatoriFixture());

      // bug2Unit = INITIAL_MINT/9 = 80 SATORI per actor.
      const INITIAL_MINT = await satori.INITIAL_MINT();
      bug2Unit = INITIAL_MINT / 9n;
      await satori.transfer(alice.address, bug2Unit);
      await satori.transfer(bob.address, bug2Unit);

      const tx = await satori.createSimpleDataStream("TestStream", owner.address);
      stream1 = await getStreamIdFromTx(tx, registry);

      // Burn for the stream so it carries weight and earns. Each voter is down
      // VOTE (10) afterwards, so alice/bob hold 70 each.
      await voteFor(satori, alice, stream1);
      await voteFor(satori, bob, stream1);

      await registry.setValue(stream1, 1000);
    });

    it("When lockedUntil == currentDate, predict is allowed but transfer is blocked", async function () {
      const round = await satori.getCurrentRound();

      // Alice predicts, locking until round + 1
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      expect(await satori.lockedUntil(alice.address)).to.equal(round + 1n);

      // Advance to round + 1 (lockedUntil == currentDate)
      await time.increase(86400);
      const newRound = await satori.getCurrentRound();
      expect(newRound).to.equal(round + 1n);

      // Transfer should be BLOCKED on expiry day (strict < check for transfers).
      // alice holds bug2Unit - VOTE = 70 SATORI, so use 50 (below her balance).
      await expect(
        satori.connect(alice).transfer(bob.address, ethers.parseEther("50"))
      ).to.be.revertedWithCustomError(satori, "Locked");

      // But transfer succeeds on day D+1 (one round after expiry)
      await time.increase(86400);
      await expect(
        satori.connect(alice).transfer(bob.address, ethers.parseEther("50"))
      ).to.not.be.reverted;
    });

    it("When lockedUntil > currentDate, transfer should be blocked", async function () {
      const round = await satori.getCurrentRound();

      // Alice predicts, locking until round + 1
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

      // Transfer in SAME round (lockedUntil = round + 1 > currentDate = round) - blocked
      await expect(
        satori.connect(alice).transfer(bob.address, ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("predict() allows on expiry day (<=), transfer() blocks on expiry day (<)", async function () {
      // predict() uses: require(lockedUntil[user] <= getCurrentRound(), "Locked")
      // _update() uses: require(lockedUntil[from] < getCurrentRound(), "Locked")

      const round = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
      // lockedUntil[alice] = round + 1

      // Advance to the locked round (currentDate = round + 1 = lockedUntil)
      await time.increase(86400);

      // Need a new stream value for predicting again
      const tx2 = await satori.createSimpleDataStream("Stream2", owner.address);
      const stream2 = await getStreamIdFromTx(tx2, registry);
      // Burn for stream2 so it carries weight alongside stream1. Eligibility has
      // no threshold and no top-N now, so weight > 0 is the whole requirement —
      // the old dummy stream that existed purely to move the threshold is gone.
      const [,,,,,voter3, voter4] = await ethers.getSigners();
      await satori.transfer(voter3.address, (bug2Unit * 3n) / 5n);
      await satori.transfer(voter4.address, (bug2Unit * 3n) / 5n);
      await voteFor(satori, voter3, stream2);
      await voteFor(satori, voter4, stream2);
      await registry.setValue(stream2, 500);

      // predict() allows when lockedUntil <= currentDate (on expiry day)
      await expect(
        satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(DOWN) }])
      ).to.not.be.reverted;
    });
  });

});
