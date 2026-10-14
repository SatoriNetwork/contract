/**
 * PER-PREDICTOR FEE RATE (proposed-changes.md item 3)
 *
 * Predictors set their own cut of the *delegated* portion of their wins,
 * in basis points, capped at 10% (1000) — which equals the default, so a
 * predictor can only ever undercut the 10% baseline, never exceed it. The
 * rate replaces the old hardcoded 10% bonus in _splitReward. 0-1-N encoding
 * on a single uint16:
 *   stored 0      → effective 1000 (default 10%, never-set)
 *   stored 1      → effective 0    (explicit zero)
 *   stored 2..999 → effective as-is (1000 is the default sentinel)
 * Setter is immutable (one call per address) and rejects the unreachable
 * input 1 and anything above the cap. When the effective rate is 0 the
 * predictor's bonus carve-out is skipped and delegators take 100% of the
 * delegated portion.
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, voteFor, warmUpLoyalty } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;

async function advanceRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

async function getStreamIdFromTx(tx, satori) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try { return satori.interface.parseLog(log)?.name === 'DataStreamCreated'; }
    catch { return false; }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  return satori.interface.parseLog(event).args.streamId;
}

describe("Per-predictor fee rate (item 3)", function () {
  let satori, voting, rewards, bounties, registry, lens;
  let owner, alice, bob, carol, dave, platform;
  // The on-chain gross for the round: the hub's emission net of the dev fee.
  // Read from the hub — the old 1152 literal was 1440 − 288 and the emission is
  // the hub's decaying schedule now. HALF is the delegated share of a 50/50
  // own/delegated split; NET applies the 5% eager-referral skim.
  let GROSS, HALF;
  const NET = (x) => (x * 95n) / 100n;

  beforeEach(async function () {
    [owner, alice, bob, carol, dave, platform] = await ethers.getSigners();
    // deploySatoriFixtureNoFee leaves the merkle dial unset, so the on-chain
    // per-round game budget is the WHOLE residual (emission minus the senior dev
    // fee, which lives on the immutable token) and the split math is uncluttered.
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, voting, rewards, registry, lens } = fix);
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("100"));
    GROSS = (await satori.emissionRateNow()) - (await satori.devRateNow());
    HALF = GROSS / 2n;
    await advanceRound();
  });

  describe("encoding / setter", function () {
    it("defaults to 1000 bps (10%) for a predictor who never sets a rate", async function () {
      expect(await lens.predictorFeeBps(bob.address)).to.equal(1000);
    });

    it("stores an explicit literal and decodes it back", async function () {
      await rewards.connect(bob).setPredictorFee(750);
      expect(await lens.predictorFeeBps(bob.address)).to.equal(750);
    });

    it("stores a near-cap literal (999) and decodes it back", async function () {
      // 1000 (the cap) is the default sentinel and encodes to the unlocked
      // default; 999 is the largest LOCKABLE literal.
      await rewards.connect(bob).setPredictorFee(999);
      expect(await lens.predictorFeeBps(bob.address)).to.equal(999);
    });

    it("input 0 decodes to an explicit 0", async function () {
      await rewards.connect(bob).setPredictorFee(0);
      expect(await lens.predictorFeeBps(bob.address)).to.equal(0);
    });

    it("input 1 is a valid literal (0.01% — recovered by the swap)", async function () {
      await rewards.connect(bob).setPredictorFee(1);
      expect(await lens.predictorFeeBps(bob.address)).to.equal(1);
    });

    it("emits PredictorFeeSet with the caller's raw input", async function () {
      await expect(rewards.connect(bob).setPredictorFee(0))
        .to.emit(rewards, "PredictorFeeSet").withArgs(bob.address, 0);
      await expect(rewards.connect(carol).setPredictorFee(999))
        .to.emit(rewards, "PredictorFeeSet").withArgs(carol.address, 999);
    });

    it("setting exactly the default (1000) is an accepted no-op — stays 10%, doesn't lock", async function () {
      // Nothing in [0..1000] reverts. Asking for the default encodes to 0 (the
      // untouched state): it neither changes the rate nor consumes the lock.
      await rewards.connect(bob).setPredictorFee(1000);
      expect(await lens.predictorFeeBps(bob.address)).to.equal(1000);
      // Still unlocked — bob can commit to a real rate afterward.
      await rewards.connect(bob).setPredictorFee(500);
      expect(await lens.predictorFeeBps(bob.address)).to.equal(500);
    });

    it("rejects an input above the 1000 cap", async function () {
      await expect(rewards.connect(bob).setPredictorFee(1001))
        .to.be.revertedWithCustomError(rewards, "InvalidPredictorFee");
    });

    it("is immutable — a second set reverts (even back to the same value)", async function () {
      await rewards.connect(bob).setPredictorFee(500);
      await expect(rewards.connect(bob).setPredictorFee(500))
        .to.be.revertedWithCustomError(rewards, "AlreadySet");
      await expect(rewards.connect(bob).setPredictorFee(0))
        .to.be.revertedWithCustomError(rewards, "AlreadySet");
    });

    it("setting an explicit 0 still locks the predictor in (immutable)", async function () {
      await rewards.connect(bob).setPredictorFee(0);
      expect(await lens.predictorFeeBps(bob.address)).to.equal(0);
      await expect(rewards.connect(bob).setPredictorFee(500))
        .to.be.revertedWithCustomError(rewards, "AlreadySet");
    });
  });

  // Shared single-delegator scoring flow. Carol delegates to Bob; Bob
  // predicts UP with equal own + delegated power (100 each). After two
  // value rises the prediction scores. streamAllocation = the WHOLE payable
  // game pool GROSS: `sid` is the only game predicted this round, so it is
  // the only entry in the round denominator (the default game at id 1 is
  // flushed, never predicted, so it never joins). Nothing is reserved out of
  // the budget any more — the first-predictor bonus is gone. ownPower =
  // delegatedPower = 100e18 → delegatedReward = HALF. Carol
  // (delegator) and Bob (predictor bonus) split that half by the predictor's
  // fee rate; Bob also keeps his own-power HALF. Total = GROSS.
  async function runDelegatedWin() {
    // Cadence-1440 (every-round) stream: one write per 24h round, which is
    // the rhythm this fee-split flow writes at.
    const sid = await getStreamIdFromTx(
      await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);
    await voteFor(satori, dave, sid);

    await satori.connect(carol).delegatePredictionPower(bob.address);
    // Delegator weight is capital x loyalty and a fresh delegation starts at
    // L = 0, so the split measured here reads zero without a warm-up. The fee
    // arithmetic itself is untouched by loyalty: it decides how the DELEGATED
    // HALF is split predictor-vs-delegators, while loyalty only divides the
    // delegator side — and with one delegator there is nothing to divide, so
    // every pinned figure below still holds. Drains to `platform` so bob's
    // ownPower and carol's capital stay at the 100e18 the comments assume.
    await warmUpLoyalty(satori, registry, null, bob, [carol], platform, sid);
    await registry.setValue(sid, 100);
    const marketing = await rewards.marketingFeeRecipient();
    // DELTA from HERE, not the absolute bucket: the loyalty warm-up above is itself a
    // scored round and skims into the same bucket, so an absolute read would
    // carry that in and break the conservation sum.
    const mktBefore = await rewards.unclaimedRewards(marketing);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);

    await advanceRound();
    await registry.setValue(sid, 110);
    await advanceRound();
    await registry.setValue(sid, 120);

    await satori.settlePrediction(bob.address, sid);

    const carolBefore = await satori.balanceOf(carol.address);
    const bobBefore = await satori.balanceOf(bob.address);
    await satori.connect(carol).claim();
    await satori.connect(bob).claim();
    return {
      carolGained: (await satori.balanceOf(carol.address)) - carolBefore,
      bobGained: (await satori.balanceOf(bob.address)) - bobBefore,
      marketingSkim: (await rewards.unclaimedRewards(marketing)) - mktBefore,
    };
  }

  describe("split behavior", function () {
    it("default 10%: delegator gets 90% of the delegated half, predictor bonus 10%", async function () {
      const { carolGained, bobGained } = await runDelegatedWin();
      // delegatedReward = HALF; delegators take 90% of it, predictor bonus 10%.
      // Bob also keeps his own-power HALF.
      // Eager-referral model: 5% is skimmed from every reward credit at settle
      // time (delegator share, own-power reward, predictor bonus) and routed to
      // the marketing bucket — so each credit lands at 95%.
      expect(carolGained).to.be.closeTo(NET((HALF * 90n) / 100n), RAW_TOLERANCE);
      expect(bobGained).to.be.closeTo(NET(HALF) + NET((HALF * 10n) / 100n), RAW_TOLERANCE);
    });

    it("custom locked rate 5%: delegator gets 95%, predictor bonus 5%", async function () {
      // The cap is now 10% (== the default), so the interesting split case is a
      // predictor who LOCKS an undercut rate; 5% (500 bps) is representative.
      await rewards.connect(bob).setPredictorFee(500);
      const { carolGained, bobGained } = await runDelegatedWin();
      // delegators take 95% of HALF; bob keeps his own HALF plus a 5% bonus.
      // Eager-referral 5% skim (see default-10% test) nets each credit to 95%.
      expect(carolGained).to.be.closeTo(NET((HALF * 95n) / 100n), RAW_TOLERANCE);
      expect(bobGained).to.be.closeTo(NET(HALF) + NET((HALF * 5n) / 100n), RAW_TOLERANCE);
    });

    it("explicit 0%: delegator gets the full half, predictor takes no bonus", async function () {
      await rewards.connect(bob).setPredictorFee(0);
      const { carolGained, bobGained } = await runDelegatedWin();
      // Eager-referral 5% skim (see default-10% test): carol takes the full HALF
      // less 5%; bob keeps his own HALF less 5% as well (no bonus at a 0% rate).
      expect(carolGained).to.be.closeTo(NET(HALF), RAW_TOLERANCE);
      expect(bobGained).to.be.closeTo(NET(HALF), RAW_TOLERANCE);      // own half only
    });

    it("conservation: delegator + predictor == the full GROSS allocation at every rate", async function () {
      await rewards.connect(bob).setPredictorFee(750);
      const { carolGained, bobGained, marketingSkim } = await runDelegatedWin();
      // Under the eager-referral model the round budget is still fully accounted
      // for — the 5% skimmed from each credit is not destroyed, it lands in the
      // marketing bucket (neither carol nor bob set a referral, so every skim
      // routes to MARKETING_FEE_RECIPIENT). Including that bucket restores the
      // invariant to the exact gross: carol_net + bob_net + marketing_skim == GROSS.
      expect(carolGained + bobGained + marketingSkim)
        .to.be.closeTo(GROSS, RAW_TOLERANCE);
    });
  });
});
