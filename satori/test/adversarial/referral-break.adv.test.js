/**
 * ADVERSARIAL BREAK-TEST — CREDIT-TIME REFERRAL SKIM
 *
 * Target: SatoriRewards.sol `_creditReward` chokepoint. REFERRAL_BPS=500 (5%)
 * is skimmed from EVERY reward credit at credit time and routed to
 * `referral[who]` — or to `MARKETING_FEE_RECIPIENT` (the constructor-set
 * immutable recipient) when the earner
 * has no referral. The skim applies to predictor wins and delegator shares. It
 * does NOT apply to the platform fee or to bounties (those never route through
 * `_creditReward`).
 *
 * MIGRATION NOTE (burn voting). Two attack groups were deleted outright, not
 * weakened, because their subject no longer exists:
 *   • ATTACK 6 — "the first-predictor bonus is exempt from the skim". The bonus
 *     and its budget reservation were both removed; there is no skim-exempt
 *     component riding on a predictor's credit any more, so the whole credit is
 *     the skimmed base. Every assertion that used to back the exempt bonus out
 *     of the credit now anchors directly on ROUND_BUDGET.
 *   • ATTACK 8 — "the value-provider cut is skimmed to the provider's referral".
 *     Value providers are not paid by the protocol at all now
 *     (`accrueProviderCut` is gone), so that third `_creditReward` call site
 *     does not exist and cannot be exercised.
 *
 * Rules of the feature under attack:
 *   - 5% of every credited reward goes to the referral (or marketing).
 *   - NO MLM: crediting a referral's OWN received cut does NOT itself skim.
 *   - Self-referral disallowed (setReferral reverts InvalidReferral; the
 *     core-only setReferralFor silently no-ops a self ref).
 *   - Zero referral disallowed on the user path; routes to marketing when unset.
 *   - setReferral is set-once / immutable.
 *   - Claim mints EXACTLY the net bucket.
 *
 * This file is a genuine adversary: it tries to (a) pay yourself via a
 * self-referral, (b) construct an MLM chain so a referral's cut is itself
 * re-skimmed to your own wallet, (c) rewrite an already-set referral, (d) get
 * the bonus or bounties skimmed, (e) prove dust math is consistent and that
 * conservation and the mint-cap are never violated.
 *
 * Every assertion below either holds (defense confirmed) or is encoded as a
 * documented it.skip("BUG: ...") — the suite stays green.
 *
 * Harness: ../fixtures (deploySatoriFixtureNoFee — zero platform fee so the
 * gross we read equals what's minted and the split math is clean).
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, warmUpStreak, VOTE, voteFor } = require("../fixtures");
const { TEST_MARKETING_FEE_RECIPIENT } = require("../next/splitFixture");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
// The old 4-arg overload carried the (now removed) valueProviderCutBps
// param. Streams are created with (name, provider, minCadenceRounds).
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
// A sole recorded game takes the whole round budget: the hub's per-round
// emission minus the senior dev fee carved at the immutable token. The
// first-predictor bonus (which used to ride skim-exempt on top) is gone, so the
// ENTIRE credit is now skimmable base.
//
// READ FROM THE HUB, not written out. The emission is the hub's decaying
// schedule now and the fee a flat 15% of it; the old 1440 − 288 literal is
// exactly the kind of value that goes quietly wrong when the rate moves.
let ROUND_BUDGET;
// The constructor-set immutable MARKETING_FEE_RECIPIENT the fixture wires in.
const MARKETING = TEST_MARKETING_FEE_RECIPIENT;
const REFERRAL_BPS = 500n; // 5%

// floor(amount * 500 / 10000) — matches `amount * REFERRAL_BPS / 10000` for BPS=500.
const cutOf = (amount) => (amount * REFERRAL_BPS) / 10000n;
const netOf = (amount) => amount - cutOf(amount);

async function advanceRound() {
  await time.increase(86400);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try {
      return satori.interface.parseLog(l)?.name === "DataStreamCreated";
    } catch {
      return false;
    }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

function referralPaidEvents(receipt, rewards) {
  const out = [];
  for (const log of receipt.logs) {
    try {
      const p = rewards.interface.parseLog(log);
      if (p && p.name === "ReferralPaid") out.push(p.args);
    } catch {}
  }
  return out;
}

function hasReferralPaid(receipt, rewards) {
  return referralPaidEvents(receipt, rewards).length > 0;
}

describe("Referral credit-time skim — adversarial break-test", function () {
  this.timeout(180000);

  let satori, voting, rewards, registry, bounties, lens;
  let owner, alice, bob, carol, dave, eve, frank;

  beforeEach(async function () {
    const f = await deploySatoriFixtureNoFee();
    satori = f.satori;
    voting = f.voting;
    rewards = f.rewards;
    registry = f.registry;
    bounties = f.bounties;
    lens = f.lens;
    [owner, alice, bob, carol, dave, eve, frank] = f.signers;
    ROUND_BUDGET = (await satori.emissionRateNow()) - (await satori.devRateNow());
  });

  // Drive `predictor`'s UP prediction on `gameId` to a win; `settler` settles.
  async function winOneRound(predictor, gameId, settler) {
    await registry.setValue(gameId, 100);
    await satori
      .connect(predictor)
      .predictMultipleWithPayloads([{ gameId, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(gameId, 110);
    await advanceRound();
    await registry.setValue(gameId, 120); // UP wins
    await satori.connect(settler).settlePrediction(predictor.address, gameId);
  }

  // Make a stream eligible (voter gets voting power, votes, one round passes)
  // and return its id. The voter needs a SATORI balance to carry vote weight,
  // so we fund them here unless they already hold tokens.
  async function makeEligibleStream(name, voter) {
    const gid = await streamIdFrom(
      await satori[SIMPLE3](name, owner.address, 1440),
      satori
    );
    if ((await satori.balanceOf(voter.address)) < ethers.parseEther("50")) {
      await satori.transfer(voter.address, ethers.parseEther("50"));
    }
    // Burn voting: the voter destroys VOTE (10) SATORI to buy `gid` permanent
    // weight. It is the only weighted game, so it takes the whole round budget.
    await voteFor(satori, voter, gid);
    await advanceRound();
    return gid;
  }

  // =========================================================================
  // ATTACK 1 — Self-referral: try to pay yourself. Must be blocked.
  // =========================================================================
  describe("ATTACK: self-referral (pay yourself)", function () {
    it("setReferral(self) reverts InvalidReferral — cannot point at yourself", async function () {
      await expect(
        rewards.connect(alice).setReferral(alice.address)
      ).to.be.revertedWithCustomError(rewards, "InvalidReferral");
      // Slot stays empty → any future credit routes to marketing, not to alice.
      expect(await rewards.referral(alice.address)).to.equal(ethers.ZeroAddress);
    });

    it("setReferral(0) reverts InvalidReferral — zero pointer rejected", async function () {
      await expect(
        rewards.connect(alice).setReferral(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(rewards, "InvalidReferral");
    });

    it("even after a valid set, you cannot re-point to yourself (self-guard fires FIRST → InvalidReferral)", async function () {
      await rewards.connect(alice).setReferral(bob.address);
      // The self/zero guard is checked BEFORE the set-once guard in setReferral
      // (contract line order: InvalidReferral check, then AlreadySet). So a
      // self re-point surfaces InvalidReferral. Either way the rewrite is
      // rejected and the stored referral is unchanged — no self-pay is possible.
      await expect(
        rewards.connect(alice).setReferral(alice.address)
      ).to.be.revertedWithCustomError(rewards, "InvalidReferral");
      expect(await rewards.referral(alice.address)).to.equal(bob.address);
    });

    it("earning with NO referral pays the cut to marketing, NEVER back to the earner", async function () {
      const gid = await makeEligibleStream("SelfPay", dave);
      await satori.transfer(alice.address, ethers.parseEther("300"));

      const aliceBucketBefore = await rewards.unclaimedRewards(alice.address);
      const mktBefore = await rewards.unclaimedRewards(MARKETING);

      await winOneRound(alice, gid, dave);

      const aliceNet =
        (await rewards.unclaimedRewards(alice.address)) - aliceBucketBefore;
      const mktCut = (await rewards.unclaimedRewards(MARKETING)) - mktBefore;

      // alice is the sole predictor on the only weighted game, so her credit is
      // the whole round budget and the skim is an exact 5% of it.
      expect(mktCut).to.be.gt(0n);
      expect(aliceNet + mktCut).to.equal(ROUND_BUDGET);
      // The cut went to marketing (the constructor-set immutable recipient),
      // not to alice. Alice cannot recover
      // it by "self-referring" — that path is closed.
      expect(mktCut).to.equal(cutOf(ROUND_BUDGET));
      expect(aliceNet).to.equal(netOf(ROUND_BUDGET));
      expect(aliceNet).to.be.gt(0n);
    });
  });

  // =========================================================================
  // ATTACK 2 — MLM chain: make a referral's received cut itself get skimmed
  // to YOUR wallet. Must be blocked (referral payment never re-enters
  // _creditReward).
  // =========================================================================
  describe("ATTACK: MLM chain / referral-on-referral", function () {
    it("a referral's RECEIVED cut is credited whole — it is NOT re-skimmed to the referral's own referral", async function () {
      // Chain: alice --ref--> bob --ref--> carol.
      // alice earns. bob receives 5% of alice's reward. If MLM existed, bob's
      // received cut would itself skim 5% to carol. It must NOT.
      const gid = await makeEligibleStream("MLM", dave);
      await satori.transfer(alice.address, ethers.parseEther("300"));

      await rewards.connect(alice).setReferral(bob.address);
      await rewards.connect(bob).setReferral(carol.address);

      const bobBefore = await rewards.unclaimedRewards(bob.address);
      const carolBefore = await rewards.unclaimedRewards(carol.address);
      const mktBefore = await rewards.unclaimedRewards(MARKETING);

      await winOneRound(alice, gid, dave);

      const bobCut = (await rewards.unclaimedRewards(bob.address)) - bobBefore;
      const carolGain =
        (await rewards.unclaimedRewards(carol.address)) - carolBefore;
      const mktGain = (await rewards.unclaimedRewards(MARKETING)) - mktBefore;

      // bob got a positive cut …
      expect(bobCut).to.be.gt(0n);
      // … and NONE of it leaked onward to carol (bob's own referral) or to
      // marketing. No MLM: the referral payment is terminal.
      expect(carolGain).to.equal(0n);
      expect(mktGain).to.equal(0n);
    });

    it("closing an MLM loop back to yourself pays you nothing extra beyond a single cut on your OWN earnings", async function () {
      // Adversary tries: alice --ref--> bob, bob --ref--> alice (a 2-cycle).
      // Goal: alice hopes bob's cut re-skims back to her. It must not.
      const gid = await makeEligibleStream("Loop", dave);
      await satori.transfer(alice.address, ethers.parseEther("300"));

      await rewards.connect(alice).setReferral(bob.address);
      await rewards.connect(bob).setReferral(alice.address); // close the loop

      const aliceBefore = await rewards.unclaimedRewards(alice.address);
      const bobBefore = await rewards.unclaimedRewards(bob.address);

      await winOneRound(alice, gid, dave);

      const aliceGain =
        (await rewards.unclaimedRewards(alice.address)) - aliceBefore;
      const bobGain = (await rewards.unclaimedRewards(bob.address)) - bobBefore;

      // ANTI-MLM / anti-loop invariant, anchored on the INDEPENDENT round
      // budget — never on the sum of the two halves (P1).
      //
      // WHY THIS CHANGED: the old body defined `raw = aliceGain + bobGain` and
      // then asserted `aliceGain == raw - bobGain`, i.e. (a+b)-b == a — an
      // identity on bigints that absorbs ANY leak — plus
      // `bobGain == cutOf(recoverSkimmedShare(bobGain))`, which expands to
      // `cut*20*500/10000 == cut`, another identity. Under a genuine MLM
      // implementation (bob's received cut itself re-skimmed 5% back to his
      // referral alice) the SUM is unchanged and 0.95×cut is still < raw/20, so
      // every surviving assertion held and this test passed against the exact
      // bug it is named for. Pin both halves to values the chain cannot fudge.
      //
      // (ROUND_BUDGET is the hub's emission net of the dev fee. The
      // first-predictor bonus that used to ride skim-exempt on alice's side is
      // gone, so the WHOLE budget is now the skimmed base.)
      // Conservation against the budget, not against itself.
      expect(aliceGain + bobGain).to.equal(ROUND_BUDGET);
      // EXACTLY one terminal 5% skim, taken on the whole budget. An MLM/loop-back
      // would leave bob with 0.95 × this and hand the difference back to alice.
      const expectedCut = cutOf(ROUND_BUDGET);
      expect(bobGain).to.equal(expectedCut);
      expect(aliceGain).to.equal(ROUND_BUDGET - expectedCut); // no loop-back to alice
      expect(aliceGain).to.equal(netOf(ROUND_BUDGET));
      // And bob's cut is a POSITIVE, single, terminal payment — no MLM.
      expect(bobGain).to.be.gt(0n);
      // Belt and braces: not one wei reached any third party either.
      expect(await rewards.unclaimedRewards(MARKETING)).to.equal(0n);
      expect(await rewards.unclaimedRewards(carol.address)).to.equal(0n);
    });
  });

  // =========================================================================
  // ATTACK 3 — setReferral immutability. Try to rewrite a set referral to
  // redirect the cut. Must be blocked.
  // =========================================================================
  describe("ATTACK: rewrite an already-set referral", function () {
    it("second setReferral reverts AlreadySet — even to a different valid address", async function () {
      await rewards.connect(alice).setReferral(bob.address);
      await expect(
        rewards.connect(alice).setReferral(carol.address)
      ).to.be.revertedWithCustomError(rewards, "AlreadySet");
      expect(await rewards.referral(alice.address)).to.equal(bob.address);
    });

    it("second setReferral reverts even when re-setting to the SAME address", async function () {
      await rewards.connect(alice).setReferral(bob.address);
      await expect(
        rewards.connect(alice).setReferral(bob.address)
      ).to.be.revertedWithCustomError(rewards, "AlreadySet");
    });

    it("setReferralFor (core-only) reverts for a non-core caller", async function () {
      await expect(
        rewards.connect(alice).setReferralFor(alice.address, bob.address)
      ).to.be.revertedWithCustomError(rewards, "Unauthorized");
    });

    it("setReferralFor via predictMultipleWithReferral sets on first predict, then is locked", async function () {
      const gid = await makeEligibleStream("SetForLock", dave);
      await satori.transfer(alice.address, ethers.parseEther("100"));

      // First predict-with-referral registers bob for alice.
      await registry.setValue(gid, 100);
      await satori
        .connect(alice)
        .predictMultipleWithReferral(bob.address, [
          { gameId: gid, payload: pack1(UP) },
        ]);
      expect(await rewards.referral(alice.address)).to.equal(bob.address);

      // A later direct setReferral cannot overwrite it.
      await expect(
        rewards.connect(alice).setReferral(carol.address)
      ).to.be.revertedWithCustomError(rewards, "AlreadySet");
    });

    it("setReferralFor silently no-ops a SELF referrer (does not block the predict)", async function () {
      const gid = await makeEligibleStream("SelfForNoop", dave);
      await satori.transfer(alice.address, ethers.parseEther("100"));

      await registry.setValue(gid, 100);
      // alice passes HERSELF as referrer. Must not revert, must not store.
      await satori
        .connect(alice)
        .predictMultipleWithReferral(alice.address, [
          { gameId: gid, payload: pack1(UP) },
        ]);
      expect(await rewards.referral(alice.address)).to.equal(
        ethers.ZeroAddress
      );
    });
  });

  // =========================================================================
  // ATTACK 4 — exact 5% math, ReferralPaid event fields, conservation, and
  // the claim minting exactly the net bucket. Single-predictor full-budget.
  // =========================================================================
  describe("exact 5% math + ReferralPaid event + claim mints net bucket", function () {
    it("predictor win: cut == floor(share/20), net == share - cut, event fields exact, claim mints net", async function () {
      const gid = await makeEligibleStream("Exact", dave);
      await satori.transfer(alice.address, ethers.parseEther("300"));

      await rewards.connect(alice).setReferral(carol.address);

      const mktBefore = await rewards.unclaimedRewards(MARKETING);
      await winOneRound(alice, gid, dave);

      // carol is alice's referral — the cut lands in carol's bucket, NOT marketing.
      const carolCut = await rewards.unclaimedRewards(carol.address);
      const net = await rewards.unclaimedRewards(alice.address);
      expect(carolCut).to.be.gt(0n);
      // Marketing untouched: a real referral diverts the whole cut away from it.
      expect(await rewards.unclaimedRewards(MARKETING)).to.equal(mktBefore);

      // The ReferralPaid event pins the exact skimmed share.
      const evs = await rewards.queryFilter(
        rewards.filters.ReferralPaid(alice.address)
      );
      expect(evs.length).to.equal(1);
      const ev = evs[0].args;
      expect(ev.owner).to.equal(alice.address);
      expect(ev.referral).to.equal(carol.address);
      expect(ev.amount).to.equal(carolCut);

      // Conservation: alice keeps net, carol gets cut, and together they are the
      // entire credit — nothing minted twice, nothing lost. Anchored on the
      // INDEPENDENT round budget, not on the sum of the two halves (which would
      // be an identity that absorbs any leak).
      const share = net + carolCut;
      expect(share).to.equal(ROUND_BUDGET);
      // Exact floor-5% relationship on the whole credit: there is no skim-exempt
      // component any more, so the skimmed base IS the credit.
      expect(carolCut).to.equal(cutOf(ROUND_BUDGET));
      expect(net).to.equal(netOf(ROUND_BUDGET));

      // Claim mints EXACTLY alice's net bucket — not the gross, not the cut.
      const mintedBefore = await satori.totalRewardsMinted();
      const aBefore = await satori.balanceOf(alice.address);
      const cBefore = await satori.balanceOf(carol.address);
      await satori.connect(alice)["claim()"]();
      expect((await satori.balanceOf(alice.address)) - aBefore).to.equal(net);
      // carol's balance is untouched by alice's claim (her cut is a separate bucket).
      expect((await satori.balanceOf(carol.address)) - cBefore).to.equal(0n);
      expect((await satori.totalRewardsMinted()) - mintedBefore).to.equal(net);

      // carol independently claims her cut — mints exactly the cut, no more.
      const mintedBefore2 = await satori.totalRewardsMinted();
      await satori.connect(carol)["claim()"]();
      expect((await satori.balanceOf(carol.address)) - cBefore).to.equal(
        carolCut
      );
      expect((await satori.totalRewardsMinted()) - mintedBefore2).to.equal(
        carolCut
      );

      // Cross-claim conservation: total minted for this credit == share.
      expect(net + carolCut).to.equal(share);
    });

    it("NO double-skim: exactly ONE ReferralPaid per credited reward", async function () {
      const gid = await makeEligibleStream("NoDouble", dave);
      await satori.transfer(alice.address, ethers.parseEther("300"));
      await rewards.connect(alice).setReferral(carol.address);

      const filterAll = rewards.filters.ReferralPaid();
      const before = (await rewards.queryFilter(filterAll)).length;
      await winOneRound(alice, gid, dave);
      const after = await rewards.queryFilter(filterAll);
      // Exactly one skim event for alice's single credited predictor share.
      const aliceEvents = after.filter(
        (e) => e.args.owner === alice.address
      );
      expect(aliceEvents.length).to.equal(1);
      // And the total number of new events is 1 (no phantom second skim on
      // carol's received cut — that would be MLM).
      expect(after.length - before).to.equal(1);
    });
  });

  // =========================================================================
  // ATTACK 5 — dust / tiny credits. A sub-20-wei credit floors the cut to 0.
  // Verify it is safe (no ReferralPaid, recipient keeps everything) and
  // consistent (no value created or destroyed).
  // =========================================================================
  describe("dust / tiny-credit rounding", function () {
    it("gross in [1,19] wei skims 0, recipient keeps ALL, no ReferralPaid, no marketing credit", async function () {
      const gid = await makeEligibleStream("Dust", carol);
      await satori.transfer(dave.address, ethers.parseEther("100"));
      await satori.transfer(bob.address, ethers.parseEther("300"));
      // eve holds a few wei — small enough that her pro-rata pull of
      // the whole round pool still lands under the 20-wei skim floor.
      await satori.transfer(eve.address, 5n);

      // bob (large) + eve (tiny) delegate to dave. eve's pull lands < 20 wei.
      await satori.connect(bob).delegatePredictionPower(dave.address);
      await satori.connect(eve).delegatePredictionPower(dave.address);
      await time.increase(86400);
      await rewards.connect(eve).setReferral(alice.address);

      await winOneRound(dave, gid, carol);

      const gross = (await lens.getTotalClaimableRewards(eve.address))[0];
      expect(gross).to.be.gt(0n);
      expect(gross).to.be.lt(20n);

      const mktBefore = await rewards.unclaimedRewards(MARKETING);
      const eveBefore = await satori.balanceOf(eve.address);
      const aliceBefore = await satori.balanceOf(alice.address);

      const tx = await satori.connect(eve)["claim()"]();
      const receipt = await tx.wait();

      // Floor to 0: referral gets nothing, marketing gets nothing, eve gets all.
      expect((await satori.balanceOf(alice.address)) - aliceBefore).to.equal(0n);
      expect((await satori.balanceOf(eve.address)) - eveBefore).to.equal(gross);
      expect(await rewards.unclaimedRewards(MARKETING)).to.equal(mktBefore);
      expect(hasReferralPaid(receipt, rewards)).to.equal(false);
    });

    it("exactly 20 wei credit → cut==1, net==19 (boundary consistency)", async function () {
      // WHY THIS CHANGED: the body used to be six `expect`s on the file-local
      // `cutOf`/`netOf` arrow functions (lines 44-48) applied to the literals
      // 19/20/39 — no await, no contract call, no fixture. True by
      // construction and unable to fail no matter what SatoriRewards does:
      // REFERRAL_BPS is `internal constant` with no getter, so nothing tied the
      // JS mirror to the chain. Change the on-chain bps or the truncation and
      // this "boundary consistency" test stayed green. So: recover the rate the
      // CONTRACT actually applied from a real skim, then state the documented
      // boundary in terms of THAT rate.
      const gid = await makeEligibleStream("Boundary", dave);
      await satori.transfer(alice.address, ethers.parseEther("300"));
      await rewards.connect(alice).setReferral(carol.address);

      await winOneRound(alice, gid, dave);

      const carolCut = await rewards.unclaimedRewards(carol.address);
      const aliceNet = await rewards.unclaimedRewards(alice.address);
      // Independent anchor: the full on-chain round budget for a sole predictor.
      expect(aliceNet + carolCut).to.equal(ROUND_BUDGET);
      // Nothing rides skim-exempt on a predictor credit any more (the
      // first-predictor bonus is gone), so the skimmed base IS the whole budget.
      const skimmedBase = ROUND_BUDGET;
      expect(carolCut).to.be.gt(0n);

      // The rate the chain actually charged, recovered from that single skim.
      // CEILING division, not floor: the chain floors `base * bps / 10000`, so
      // dividing back down floors a second time and lands a bps SHORT whenever
      // the base is not a clean multiple. It always was when the base was a
      // round 1152e18; the hub's emission is not a round number, which is what
      // exposed the double floor.
      const onChainBps = (carolCut * 10000n + skimmedBase - 1n) / skimmedBase;
      expect(onChainBps).to.equal(REFERRAL_BPS, "on-chain skim rate must be 5%");
      // …and it truncates (floor), it does not round.
      expect(carolCut).to.equal((skimmedBase * onChainBps) / 10000n);
      // The JS mirror this file uses everywhere agrees with the chain.
      expect(cutOf(skimmedBase)).to.equal(carolCut);
      expect(netOf(skimmedBase)).to.equal(skimmedBase - carolCut);

      // THE DOCUMENTED BOUNDARY, expressed with the recovered on-chain rate:
      // below 20 wei the cut floors to zero (no skim, no event); at exactly
      // 20 wei it is 1 and the earner keeps 19; 39 still skims only 1.
      const chainCut = (amount) => (amount * onChainBps) / 10000n;
      expect(chainCut(19n)).to.equal(0n);
      expect(19n - chainCut(19n)).to.equal(19n);
      expect(chainCut(20n)).to.equal(1n);
      expect(20n - chainCut(20n)).to.equal(19n);
      expect(chainCut(39n)).to.equal(1n); // remainder to earner
      expect(39n - chainCut(39n)).to.equal(38n);
    });
  });

  // =========================================================================
  // ATTACK 6 — DELETED. It asserted that the first-predictor bonus rides
  // skim-EXEMPT on the first predictor's credit ("cut < 5% of the whole
  // budget"). The first-predictor bonus and its budget reservation were both
  // removed, so there is no exempt component left to exempt: a predictor's
  // credit is now entirely skimmable base, which every surviving case above
  // asserts directly against ROUND_BUDGET.
  // =========================================================================

  // =========================================================================
  // ATTACK 7 — bounties are EXCLUDED from the skim. A bounty win pays out in
  // the external ERC20 bounty token via the bounty pool, never through
  // _creditReward, so no ReferralPaid fires and marketing/referral SATORI
  // buckets are unmoved by the bounty payout.
  // =========================================================================
  describe("bounties are exempt from the skim", function () {
    it("a REAL bounty win pays out in the bounty ERC20 (bountyStake) and NEVER emits a bounty-side ReferralPaid or moves SATORI marketing/referral buckets", async function () {
      // Fund a bounty on the game, stake into it, predict-with-boost, win, and
      // settle. The bounty payout accrues to `bountyStake` in the bounty ERC20
      // token — an entirely separate accounting path from SATORI
      // `unclaimedRewards` / `_creditReward`. The ONLY ReferralPaid that may
      // fire is on the SATORI predictor reward (one cut), never on the bounty.
      const gid = await makeEligibleStream("Bnty", dave);
      await satori.transfer(alice.address, ethers.parseEther("300"));
      // audit C-2: streak 0 takes no bounty boost — warm alice up before funding
      await warmUpStreak(satori, registry, owner, alice, gid);  // owner is the stream provider
      // alice sets a referral so, IF the bounty leaked into the skim, carol
      // would receive a bounty-ERC20 or an extra SATORI cut. She must not.
      await rewards.connect(alice).setReferral(carol.address);

      // Deploy + fund a bounty token pool on the stream.
      const Mock = await ethers.getContractFactory("MockERC20");
      const usd = await Mock.deploy("USDC", "USDC");
      await usd.waitForDeployment();
      const usdAddr = await usd.getAddress();
      const bAddr = await bounties.getAddress();
      const POT = ethers.parseEther("1000");
      const RATE = ethers.parseEther("200");
      await usd.mint(frank.address, ethers.parseEther("100000"));
      await usd.connect(frank).approve(bAddr, ethers.parseEther("100000"));
      // Funding a NON-SATORI bounty now charges an upfront SATORI bountyBurn to
      // the funder (frank). This is frank's only first-fund of (gid, usdAddr),
      // so give him exactly one bountyBurn worth of SATORI from the owner.
      await satori.transfer(frank.address, await satori.bountyBurn());
      await bounties.connect(frank).fundBounty(gid, usdAddr, POT, RATE);

      // alice stakes into the bounty so her winning prediction earns a share.
      await usd.mint(alice.address, ethers.parseEther("300"));
      await usd.connect(alice).approve(bAddr, ethers.parseEther("300"));
      await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("300"));

      const mktBefore = await rewards.unclaimedRewards(MARKETING);
      const carolSatoriBefore = await rewards.unclaimedRewards(carol.address);
      const aliceStakeBefore = await bounties.bountyStake(alice.address, usdAddr);
      const carolBountyBefore = await bounties.bountyStake(carol.address, usdAddr);
      // Count ReferralPaid only from HERE — the streak warm-up above credited a
      // reward of its own, and this assertion is about the measured win alone.
      const evFromBlock = await ethers.provider.getBlockNumber();

      // Win the round (predict-with-boost happens inside winOneRound's predict,
      // which snapshots the boost because alice has an active bounty stake).
      await winOneRound(alice, gid, dave);

      // 1) The bounty actually paid out: alice's bounty stake grew.
      const aliceBountyEarned =
        (await bounties.bountyStake(alice.address, usdAddr)) - aliceStakeBefore;
      expect(aliceBountyEarned).to.be.gt(0n);

      // 2) The referral got ZERO of the bounty ERC20 — bounties never skim.
      expect(
        (await bounties.bountyStake(carol.address, usdAddr)) - carolBountyBefore
      ).to.equal(0n);

      // 3) Exactly ONE ReferralPaid fired for alice — the SATORI predictor
      //    reward — and its amount equals the SATORI cut carol received. The
      //    bounty win added NO extra ReferralPaid.
      const evs = await rewards.queryFilter(
        rewards.filters.ReferralPaid(alice.address), evFromBlock
      );
      expect(evs.length).to.equal(1);
      const carolSatoriCut =
        (await rewards.unclaimedRewards(carol.address)) - carolSatoriBefore;
      expect(evs[0].args.amount).to.equal(carolSatoriCut);

      // 4) The SATORI marketing bucket is unmoved (alice has a real referral, so
      //    her SATORI cut went to carol; the bounty contributed nothing here).
      expect(await rewards.unclaimedRewards(MARKETING)).to.equal(mktBefore);
    });
  });

  // =========================================================================
  // ATTACK 8 — DELETED. It exercised the value-provider cut as the third
  // `_creditReward` call site (skim to the provider's referral, and to
  // marketing when unset). Value providers are not paid by the protocol at all
  // any more — `accrueProviderCut` and the per-stream valueProviderCutBps are
  // both gone — so that call site does not exist and there is nothing left to
  // attack here. The remaining two call sites (predictor wins, delegator
  // shares) are covered by ATTACKs 1-5, 9 and 11.
  // =========================================================================

  // =========================================================================
  // ATTACK 9 — conservation invariant across a mixed round: net + all cuts ==
  // total credited, and totalRewardsMinted across every claimant == the sum of
  // net buckets (cut is not double-minted).
  // =========================================================================
  describe("conservation: nothing minted twice, nothing lost", function () {
    it("net + cut == raw and claims mint each bucket exactly once", async function () {
      const gid = await makeEligibleStream("Cons", dave);
      await satori.transfer(alice.address, ethers.parseEther("300"));
      await rewards.connect(alice).setReferral(carol.address);

      await winOneRound(alice, gid, dave);

      const net = await rewards.unclaimedRewards(alice.address);
      const cut = await rewards.unclaimedRewards(carol.address);
      const raw = net + cut;
      // Anchor on the INDEPENDENT round budget: alice is the sole predictor on
      // the only weighted game, so the credit is the whole budget, the cut is an
      // exact floor-5% of it, and the two buckets partition it with nothing left
      // over. (Asserting `net == raw - cut` alone would be the identity
      // (n+c)-c == n and would absorb any leak.)
      expect(raw).to.equal(ROUND_BUDGET);
      expect(cut).to.equal(cutOf(ROUND_BUDGET));
      expect(net).to.equal(netOf(ROUND_BUDGET));

      const mintedBefore = await satori.totalRewardsMinted();
      await satori.connect(alice)["claim()"]();
      await satori.connect(carol)["claim()"]();
      const minted = (await satori.totalRewardsMinted()) - mintedBefore;

      // The two claims together mint exactly raw — net once, cut once. The cut
      // is NOT minted a second time against the round budget cap.
      expect(minted).to.equal(raw);
      // Buckets zeroed after claim.
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
      expect(await rewards.unclaimedRewards(carol.address)).to.equal(0n);
    });
  });

  // =========================================================================
  // ATTACK 10 — the marketing address itself earning with NO referral. The
  // `dest == who == MARKETING` case: _creditReward writes (amount-cut) then
  // (+cut) to the SAME bucket. It must total exactly `amount` — no loss, no
  // double-credit, no over-mint.
  // =========================================================================
  describe("earner IS the marketing address (dest == who) — self-credit is exact", function () {
    it("crediting the marketing wallet with no referral lands the FULL amount, not amount+cut or amount-cut", async function () {
      // Impersonate the marketing constant so it can predict directly.
      await ethers.provider.send("hardhat_impersonateAccount", [MARKETING]);
      await ethers.provider.send("hardhat_setBalance", [
        MARKETING,
        "0x56BC75E2D63100000", // 100 ETH for gas
      ]);
      const mkt = await ethers.getSigner(MARKETING);

      const gid = await makeEligibleStream("MktEarn", dave);
      // Fund the marketing wallet with SATORI so it can predict.
      await satori.transfer(MARKETING, ethers.parseEther("300"));

      const mktBefore = await rewards.unclaimedRewards(MARKETING);
      // Marketing predicts and wins. It has NO referral, so dest == MARKETING.
      await registry.setValue(gid, 100);
      await satori
        .connect(mkt)
        .predictMultipleWithPayloads([{ gameId: gid, payload: pack1(UP) }]);
      await advanceRound();
      await registry.setValue(gid, 110);
      await advanceRound();
      await registry.setValue(gid, 120);
      await satori.connect(dave).settlePrediction(MARKETING, gid);

      // The whole credit (net + cut) landed in the single marketing bucket:
      // amount - cut + cut == amount. The credit equals the full on-chain round
      // budget (emission net of the dev fee, single predictor) because the
      // "referral" is itself.
      const gained = (await rewards.unclaimedRewards(MARKETING)) - mktBefore;
      expect(gained).to.equal(ROUND_BUDGET);

      await ethers.provider.send("hardhat_stopImpersonatingAccount", [
        MARKETING,
      ]);
    });
  });

  // =========================================================================
  // ATTACK 11 — dust accumulation asymmetry. Many separate sub-20-wei credits
  // each floor the cut to 0, so the referral is systematically shortchanged vs.
  // a single aggregated credit. This is a documented, SAFE property (favors the
  // earner, never over-credits, never mints extra) — assert it holds and is
  // bounded, so nobody can weaponize it to STEAL (it only ever LOSES the
  // referral fractions of a wei per credit, capped at <1 wei each).
  // =========================================================================
  describe("dust accumulation only ever shortchanges the referral (never over-mints)", function () {
    it("per-credit flooring means Σ(per-credit cuts) <= cut(Σ credits); the gap stays with the earner, is never minted twice", async function () {
      // WHY THIS CHANGED: the old body was a pure JS model — `v = 19n`,
      // `N = 1000n` through the file-local `cutOf` — with no await and no
      // contract call anywhere. Its two closing "no over-mint" assertions were
      // algebraic identities (`N*(v-c) + N*c == N*v` and `(N*v-a) + a == N*v`),
      // true for EVERY c and a: substituting a 200%-over-crediting cut function
      // leaves both green (P1). So the documented "never mints on top or
      // over-credits" property (A_rewards.md:139) was never exercised. Run the
      // asymmetry on-chain instead: eve's delegator share is a few wei per
      // round, and claiming EACH round produces one separate `_creditReward`
      // below the 20-wei skim boundary.
      const gid = await makeEligibleStream("DustAccum", carol);
      await satori.transfer(dave.address, ethers.parseEther("100"));
      await satori.transfer(bob.address, ethers.parseEther("300"));
      await satori.transfer(eve.address, 3n); // eve holds a few wei
      await satori.connect(bob).delegatePredictionPower(dave.address);
      await satori.connect(eve).delegatePredictionPower(dave.address);
      await time.increase(86400);
      await rewards.connect(eve).setReferral(alice.address);

      const eveStart = await satori.balanceOf(eve.address);
      const ROUNDS = 4;
      let totalCredited = 0n;
      let v = 100;
      for (let i = 0; i < ROUNDS; i++) {
        if (i > 0) await advanceRound();
        await registry.setValue(gid, v);
        await satori
          .connect(dave)
          .predictMultipleWithPayloads([{ gameId: gid, payload: pack1(UP) }]);
        await advanceRound();
        v += 10;
        await registry.setValue(gid, v);
        await advanceRound();
        v += 10;
        await registry.setValue(gid, v); // UP wins
        await satori.connect(carol).settlePrediction(dave.address, gid);

        // One separate sub-20-wei credit per iteration.
        const [pending] = await lens.pendingDelegatorRewards(eve.address);
        expect(pending).to.be.gt(0n);
        expect(pending).to.be.lt(20n, "the credit must sit below the skim boundary");

        const eveBefore = await satori.balanceOf(eve.address);
        const mktBefore = await rewards.unclaimedRewards(MARKETING);
        await satori.connect(eve)["claim()"]();
        const minted = (await satori.balanceOf(eve.address)) - eveBefore;

        // The cut floors to 0: the earner keeps ALL of it, the referral and
        // marketing get nothing, and nothing is minted on top of the credit.
        expect(minted).to.equal(pending, "claim mints exactly the credited amount — never more");
        expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
        expect(await satori.balanceOf(alice.address)).to.equal(0n);
        expect(await rewards.unclaimedRewards(MARKETING)).to.equal(mktBefore);
        totalCredited += minted;
      }

      // Σ(per-credit cuts) — measured on-chain, not modelled — is ZERO, …
      const actualSkimTotal = await rewards.unclaimedRewards(alice.address);
      expect(actualSkimTotal).to.equal(0n);
      expect(
        (await rewards.queryFilter(rewards.filters.ReferralPaid(eve.address))).length
      ).to.equal(0, "no skim event ever fired for eve's dust credits");

      // … while ONE aggregated credit of the same total would have skimmed a
      // positive cut. Σ(per-credit cuts) < cut(Σ credits): the gap is the
      // documented asymmetry and it favours the earner.
      expect(totalCredited).to.be.gte(20n, "the run must cross the 20-wei boundary to have a gap at all");
      const aggregatedCut = cutOf(totalCredited);
      expect(aggregatedCut).to.be.gt(0n);
      expect(actualSkimTotal).to.be.lt(aggregatedCut);

      // No over-mint: every wei eve received is a wei the lens had already
      // promised her, and she holds exactly her starting dust plus that sum.
      expect(await satori.balanceOf(eve.address)).to.equal(eveStart + totalCredited);
    });
  });
});
