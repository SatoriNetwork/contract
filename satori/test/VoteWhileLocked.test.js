const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");

/**
 * Voting while transfer-locked.
 *
 * Burning to vote moves tokens, so it hits the token's lane-A transfer gate —
 * which is immutable and knows only "locked or not", never why. Two different
 * things set that lock, and they need different treatment:
 *
 *   PREDICTING locks you until round+1, so you cannot shuttle tokens to a second
 *   address and predict again. Burning DESTROYS tokens, so it cannot fund a
 *   second prediction, and `rawPredictionPower` was already snapshotted at
 *   predict time — nothing depends on a predictor's balance holding steady.
 *   Voting here is therefore risk-free and simply allowed.
 *
 *   DELEGATING locks you indefinitely, and that one is load-bearing: the
 *   delegated-power accounting has no correct path for a delegator's balance
 *   FALLING. Its from-side branch decrements only the live power figure, leaving
 *   the deferred rate pool (what the delegate actually predicts against) and the
 *   delegator's checkpoint history untouched — so the delegate would keep
 *   predicting on destroyed tokens for as long as the delegation lasted.
 *
 * The hub resolves that by sequencing three operations the protocol already
 * performs correctly rather than inventing a fourth: undelegate (the tested
 * clean-removal path), burn, re-delegate at the new smaller balance.
 *
 * THE SEAM THIS FILE EXISTS TO PROVE: a delegate predicts in round R against a
 * pool that includes the delegator; the delegator then votes in R, which closes
 * and reopens their delegation period inside that same round. Both parties then
 * claim. Nobody may be paid twice, and the protocol must not mint more than the
 * round's budget.
 */

const UP = 1;

// The stream here is pure scaffolding — this file is about the transfer lock,
// the burn-vote and the delegation period seam, all of which are ROUND-level
// mechanics. It needs an every-round stream so a predict/settle cycle fits into
// consecutive rounds. Public callers may no longer create cadence-1 streams, so
// these are created by the ADMIN (`owner`, which is `rewards.admin()`) with an
// explicit cadence of 1 via the 3-arg overload.
const ADMIN_CADENCE_1 = "createSimpleDataStream(string,address,uint24)";

async function nextRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(Number(t) / 86400) * 86400 + 86400 + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (_) {}
  }
  throw new Error("DataStreamCreated not found");
}

describe("voting while transfer-locked", function () {
  this.timeout(180000);

  let fx, satori, voting, rewards, registry, token, owner, signers;

  beforeEach(async function () {
    fx = await deploySatoriFixture();
    ({ satori, voting, rewards, registry, token, owner, signers } = fx);
  });

  // ---------------------------------------------------------------------------
  // The easy case: locked by predicting.
  // ---------------------------------------------------------------------------
  describe("locked by a prediction", function () {
    it("can still vote, and the lock is left exactly as it was", async function () {
      const [, alice] = signers;
      await satori.transfer(alice.address, ethers.parseEther("100"));

      const sid = await streamIdFrom(
        await satori[ADMIN_CADENCE_1]("S", owner.address, 720), satori);
      await satori.connect(alice).vote(sid, VOTE);

      await nextRound();
      await registry.setValue(sid, 100);
      await satori.connect(alice)
        .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

      // Predicting locked her: a plain transfer is refused.
      const lockAfterPredict = await token.lockUntil(alice.address, 0);
      expect(lockAfterPredict).to.be.gt(0);
      await expect(
        satori.connect(alice).transfer(owner.address, 1n)
      ).to.be.revertedWithCustomError(satori, "Locked");

      // ...but voting works, because burning cannot fund a second prediction.
      const weightBefore = await voting.weightOf(sid);
      const balBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice).vote(sid, VOTE);

      expect(await voting.weightOf(sid)).to.equal(weightBefore + VOTE);
      expect(await satori.balanceOf(alice.address)).to.equal(balBefore - VOTE);

      // The lock is restored byte-for-byte — the hub only borrowed it.
      expect(await token.lockUntil(alice.address, 0)).to.equal(lockAfterPredict);
      await expect(
        satori.connect(alice).transfer(owner.address, 1n)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });
  });

  // ---------------------------------------------------------------------------
  // The load-bearing case: locked by delegating.
  // ---------------------------------------------------------------------------
  describe("locked by prediction delegation", function () {
    it("votes by leaving and rejoining the pool; delegation survives and power drops by exactly the burn", async function () {
      const [, alice, bob] = signers;
      await satori.transfer(alice.address, ethers.parseEther("100"));
      await satori.transfer(bob.address, ethers.parseEther("50"));

      const sid = await streamIdFrom(
        await satori[ADMIN_CADENCE_1]("S", owner.address, 720), satori);
      await satori.connect(owner).vote(sid, VOTE);

      // Alice delegates her prediction power to Bob.
      await satori.connect(alice).delegatePredictionPower(bob.address);
      const [delBefore] = await rewards.predictionDelegateInfo(alice.address);
      expect(delBefore).to.equal(bob.address);

      // She is indefinitely locked and cannot transfer.
      await expect(
        satori.connect(alice).transfer(owner.address, 1n)
      ).to.be.revertedWithCustomError(satori, "Locked");

      const bobPowerBefore = await rewards.getPredictionPower(bob.address);
      const aliceBalBefore = await satori.balanceOf(alice.address);

      await satori.connect(alice).vote(sid, VOTE);

      // Still delegated to the same person afterwards — the hub put her back.
      const [delAfter] = await rewards.predictionDelegateInfo(alice.address);
      expect(delAfter, "delegation must survive the vote").to.equal(bob.address);

      // Her balance fell by the burn...
      expect(await satori.balanceOf(alice.address)).to.equal(aliceBalBefore - VOTE);

      // ...and CRITICALLY Bob's prediction power fell by exactly the same
      // amount. This is the assertion that would fail under the naive
      // "just let them burn" approach, where the rate pool is never reduced
      // and Bob keeps predicting on destroyed tokens.
      expect(
        await rewards.getPredictionPower(bob.address),
        "delegate power must drop by exactly the burnt amount"
      ).to.equal(bobPowerBefore - VOTE);

      // And she is locked again, indefinitely, because she is delegated again.
      await expect(
        satori.connect(alice).transfer(owner.address, 1n)
      ).to.be.revertedWithCustomError(satori, "Locked");
    });

    it("a second vote compounds correctly: power tracks the running balance", async function () {
      const [, alice, bob] = signers;
      await satori.transfer(alice.address, ethers.parseEther("100"));

      const sid = await streamIdFrom(
        await satori[ADMIN_CADENCE_1]("S", owner.address, 720), satori);
      await satori.connect(owner).vote(sid, VOTE);
      await satori.connect(alice).delegatePredictionPower(bob.address);

      const before = await rewards.getPredictionPower(bob.address);
      await satori.connect(alice).vote(sid, VOTE);
      await satori.connect(alice).vote(sid, VOTE);

      expect(await rewards.getPredictionPower(bob.address))
        .to.equal(before - VOTE * 2n);
      expect(await voting.gameWeight(sid)).to.equal(VOTE * 3n); // owner + alice x2
    });
  });

  // ---------------------------------------------------------------------------
  // THE SEAM. Delegate predicts in R, delegator votes in R (closing and
  // reopening their period inside R), both then claim.
  // ---------------------------------------------------------------------------
  describe("the period seam: delegate predicts and delegator votes in the SAME round", function () {
    it("neither party double-claims and the protocol does not over-mint", async function () {
      const [, alice, bob, carol] = signers;
      await satori.transfer(alice.address, ethers.parseEther("100"));
      await satori.transfer(bob.address, ethers.parseEther("100"));
      await satori.transfer(carol.address, ethers.parseEther("100"));

      const sid = await streamIdFrom(
        await satori[ADMIN_CADENCE_1]("S", owner.address, 720), satori);
      await satori.connect(carol).vote(sid, VOTE);

      // Alice backs Bob.
      await satori.connect(alice).delegatePredictionPower(bob.address);

      await nextRound();
      await registry.setValue(sid, 100);

      // Bob predicts in round R, against a pool that INCLUDES Alice.
      await satori.connect(bob)
        .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

      // Alice votes in the SAME round R — closing and reopening her period.
      await satori.connect(alice).vote(sid, VOTE);

      // Resolve the prediction upward so Bob wins.
      await nextRound();
      await registry.setValue(sid, 150);
      await nextRound();
      await registry.setValue(sid, 200);
      await satori.settlePrediction(bob.address, sid);

      const supplyBeforeClaims = await satori.totalSupply();

      // Both claim, twice each — a second claim must be a no-op, which is what
      // catches a period seam that pays the same round from two periods.
      await satori.connect(bob).claim();
      const bobAfterFirst = await satori.balanceOf(bob.address);
      await satori.connect(bob).claim();
      expect(await satori.balanceOf(bob.address),
        "second claim must pay nothing").to.equal(bobAfterFirst);

      await satori.connect(alice).claim();
      const aliceAfterFirst = await satori.balanceOf(alice.address);
      await satori.connect(alice).claim();
      expect(await satori.balanceOf(alice.address),
        "second claim must pay nothing").to.equal(aliceAfterFirst);

      // The protocol minted no more than one round's budget across both parties.
      const minted = (await satori.totalSupply()) - supplyBeforeClaims;
      expect(minted, "must not exceed a single round's budget")
        .to.be.lte(ethers.parseEther("720"));
    });

    it("the round the delegator voted in yields them nothing — the cost is theirs alone", async function () {
      const [, alice, bob, carol] = signers;
      await satori.transfer(alice.address, ethers.parseEther("100"));
      await satori.transfer(bob.address, ethers.parseEther("100"));
      await satori.transfer(carol.address, ethers.parseEther("100"));

      const sid = await streamIdFrom(
        await satori[ADMIN_CADENCE_1]("S", owner.address, 720), satori);
      await satori.connect(carol).vote(sid, VOTE);
      await satori.connect(alice).delegatePredictionPower(bob.address);

      await nextRound();
      await registry.setValue(sid, 100);
      await satori.connect(bob)
        .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

      // Alice votes in R. Her period closes at R, and a closed period pays
      // through endRound - 1 — so R itself earns her nothing.
      await satori.connect(alice).vote(sid, VOTE);

      await nextRound();
      await registry.setValue(sid, 150);
      await nextRound();
      await registry.setValue(sid, 200);
      await satori.settlePrediction(bob.address, sid);

      // Bob (the predictor) is still paid for R.
      await satori.connect(bob).claim();
      expect(await rewards.unclaimedRewards(bob.address)).to.equal(0n);

      // Alice forfeited round R's delegator share by voting in it. That share is
      // simply never claimed — stranded, not redirected — so the cost lands on
      // her and on nobody else.
      const aliceBalBefore = await satori.balanceOf(alice.address);
      await satori.connect(alice).claim();
      expect(await satori.balanceOf(alice.address),
        "voting in R forfeits R's delegator yield").to.equal(aliceBalBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // Exactly what a locked holder may and may not do. Voting is the ONLY thing
  // the lock now lets through; everything it guarded before stays guarded.
  // ---------------------------------------------------------------------------
  describe("the lock still blocks everything except voting", function () {
    it("locked by predicting: may vote repeatedly, may not transfer", async function () {
      const [, alice, bob] = signers;
      await satori.transfer(alice.address, ethers.parseEther("100"));

      const sid = await streamIdFrom(
        await satori[ADMIN_CADENCE_1]("S", owner.address, 720), satori);
      await satori.connect(owner).vote(sid, VOTE);

      await nextRound();
      await registry.setValue(sid, 100);
      await satori.connect(alice)
        .predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

      const lock = await token.lockUntil(alice.address, 0);
      expect(lock).to.be.gt(0);

      // Voting: allowed, and repeatable.
      const w = await voting.gameWeight(sid);
      await satori.connect(alice).vote(sid, VOTE);
      await satori.connect(alice).vote(sid, VOTE);
      expect(await voting.gameWeight(sid)).to.equal(w + VOTE * 2n);

      // Transfers: still refused, in both directions of intent.
      await expect(satori.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(satori, "Locked");
      await satori.connect(alice).approve(bob.address, ethers.MaxUint256);
      await expect(satori.connect(bob).transferFrom(alice.address, bob.address, 1n))
        .to.be.revertedWithCustomError(satori, "Locked");

      // The lock itself is untouched by all that voting.
      expect(await token.lockUntil(alice.address, 0)).to.equal(lock);
    });

    it("locked by delegating: may vote, may not transfer, stays delegated", async function () {
      const [, alice, bob] = signers;
      await satori.transfer(alice.address, ethers.parseEther("100"));

      const sid = await streamIdFrom(
        await satori[ADMIN_CADENCE_1]("S", owner.address, 720), satori);
      await satori.connect(owner).vote(sid, VOTE);
      await satori.connect(alice).delegatePredictionPower(bob.address);

      await satori.connect(alice).vote(sid, VOTE);

      await expect(satori.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(satori, "Locked");
      await satori.connect(alice).approve(bob.address, ethers.MaxUint256);
      await expect(satori.connect(bob).transferFrom(alice.address, bob.address, 1n))
        .to.be.revertedWithCustomError(satori, "Locked");

      const [d] = await rewards.predictionDelegateInfo(alice.address);
      expect(d).to.equal(bob.address);
    });
  });

  // ---------------------------------------------------------------------------
  // The exploit this whole design exists to prevent.
  // ---------------------------------------------------------------------------
  describe("the double-spend it closes", function () {
    it("burning everything leaves the delegate with no phantom power", async function () {
      const [, alice, bob] = signers;
      const stake = ethers.parseEther("40");
      await satori.transfer(alice.address, stake);

      const sid = await streamIdFrom(
        await satori[ADMIN_CADENCE_1]("S", owner.address, 720), satori);
      await satori.connect(owner).vote(sid, VOTE);
      await satori.connect(alice).delegatePredictionPower(bob.address);

      const bobBase = await rewards.getPredictionPower(bob.address);

      // Alice burns her ENTIRE balance for vote weight.
      await satori.connect(alice).vote(sid, stake);

      expect(await satori.balanceOf(alice.address)).to.equal(0n);
      // She got permanent governance weight for it...
      expect(await voting.gameWeight(sid)).to.equal(VOTE + stake);
      // ...and Bob got NOTHING lasting from it. Under the naive approach he
      // would still be predicting with all 40 of her destroyed tokens.
      expect(
        await rewards.getPredictionPower(bob.address),
        "no phantom power may survive the burn"
      ).to.equal(bobBase - stake);
    });
  });
});
