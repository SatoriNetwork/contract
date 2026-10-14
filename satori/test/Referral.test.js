const { expect } = require("chai");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

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

async function advanceToNextRound() {
  await time.increase(86400);
}

describe("Referral Commission", function () {
  let satori, voting, rewards, bounties, registry, lens;
  let owner, alice, bob, carol, dave, platform;
  let stream1;
  const UP = 1;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, bounties, registry, lens } = fix);
    [owner, alice, bob, carol, dave, platform] = fix.signers;

    // Cadence-1440 (every-round) stream: the referral mechanics under test
    // only need a stream that can be predicted on each round, and the
    // earn-and-claim cycle below rides the A-B-C rhythm of an every-round
    // stream.
    const tx1 = await satori["createSimpleDataStream(string,address,uint24)"]("Stream 1", owner.address, 1440);
    stream1 = await getStreamIdFromTx(tx1, satori);

    // 4:2:3 ratio derived from INITIAL_MINT (sum = 9U = 9/12 of bootstrap).
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const UNIT = INITIAL_MINT / 12n;
    await satori.transfer(alice.address, UNIT * 4n);
    await satori.transfer(bob.address, UNIT * 2n);
    await satori.transfer(carol.address, UNIT * 3n);

    await voteFor(satori, alice, stream1);
    await voteFor(satori, bob, stream1);

    await advanceToNextRound();
  });

  // Drives a winning prediction for `predictor` on stream1, returns the gross
  // reward amount the predictor would have received (computes claimable, claims, returns delta).
  async function earnAndClaim(predictor, claimer = predictor, recipient = null) {
    if (recipient === null) recipient = claimer.address;

    // No per-round re-voting: burnt weight is PERMANENT, so the one burn in
    // beforeEach keeps stream1 weighted for every round below. (Re-voting after
    // a prediction would also revert `Locked` — predicting transfer-locks the
    // predictor's balance and voting burns from it.)
    await registry.setValue(stream1, 100);
    await satori.connect(predictor).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceToNextRound();
    await registry.setValue(stream1, 150);
    await satori.connect(predictor).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);

    await advanceToNextRound();
    await registry.setValue(stream1, 200);
    await satori.connect(predictor).predictMultipleWithPayloads([{ gameId: stream1, payload: pack1(UP) }]);
  }

  describe("setReferral", function () {
    it("Should set referral and emit ReferralSet", async function () {
      await expect(rewards.connect(alice).setReferral(bob.address))
        .to.emit(rewards, "ReferralSet")
        .withArgs(alice.address, bob.address);

      expect(await rewards.referral(alice.address)).to.equal(bob.address);
    });

    it("Should REJECT self-referral (no longer a meaningful opt-out)", async function () {
      // Referring yourself serves no purpose now — the 1% is skimmed either way,
      // and a self-pointer would just route it to marketing. So it's disallowed.
      await expect(rewards.connect(alice).setReferral(alice.address))
        .to.be.revertedWithCustomError(rewards, "InvalidReferral");
      expect(await rewards.referral(alice.address)).to.equal(ethers.ZeroAddress);
    });

    it("A rejected self-referral does not lock the slot: a real referral still works", async function () {
      await expect(rewards.connect(alice).setReferral(alice.address))
        .to.be.revertedWithCustomError(rewards, "InvalidReferral");
      await rewards.connect(alice).setReferral(bob.address);
      expect(await rewards.referral(alice.address)).to.equal(bob.address);
    });

    it("Should revert when setting referral to address(0)", async function () {
      await expect(
        rewards.connect(alice).setReferral(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(rewards, "InvalidReferral");
    });

    it("Should revert when referral already set (immutable)", async function () {
      await rewards.connect(alice).setReferral(bob.address);

      await expect(
        rewards.connect(alice).setReferral(carol.address)
      ).to.be.revertedWithCustomError(rewards, "AlreadySet");
    });

    it("Should allow different addresses to set independent referrals", async function () {
      await rewards.connect(alice).setReferral(carol.address);
      await rewards.connect(bob).setReferral(dave.address);

      expect(await rewards.referral(alice.address)).to.equal(carol.address);
      expect(await rewards.referral(bob.address)).to.equal(dave.address);
    });

    it("Should default to address(0) when never set", async function () {
      expect(await rewards.referral(alice.address)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Claim with referral", function () {
    it("Should send 1% to referral and 99% to recipient (cut credited eagerly)", async function () {
      // Carol is alice's referral
      await rewards.connect(alice).setReferral(carol.address);

      await earnAndClaim(alice);

      // Eager credit: the 1% cut was already skimmed at settle time into Carol's
      // UNCLAIMED bucket. Alice's own bucket (getTotalClaimableRewards) is already
      // NET of it. Carol's cut sits claimable in her bucket, not her balance.
      const aliceNet = (await lens.getTotalClaimableRewards(alice.address))[0];
      const carolCut = await rewards.unclaimedRewards(carol.address);
      expect(aliceNet).to.be.gt(0);
      expect(carolCut).to.be.gt(0);

      // The cut is skimmed PER CREDIT as floor(amount_i/100) on every reward
      // credit. So Carol's bucket equals the exact sum of the per-credit
      // ReferralPaid amounts; reconstruct it from the events.
      const cutEvents = await rewards.queryFilter(
        rewards.filters.ReferralPaid(alice.address, carol.address)
      );
      const expectedCut = cutEvents.reduce((acc, e) => acc + e.args.amount, 0n);
      expect(expectedCut).to.be.gt(0);
      expect(carolCut).to.equal(expectedCut);

      // Conservation, anchored on an INDEPENDENT gross.
      //
      // WHY THIS BLOCK CHANGED: it used to read
      //     const gross = aliceNet + carolCut;
      //     expect(aliceNet).to.equal(gross - carolCut);
      // which is `x == x` (P1 self-referential conservation) — it absorbs any
      // leak, including the exact escape the doc forbids (crediting the earner
      // the full amount AND paying the referral on top). The follow-up
      // `expect(carolCut).to.be.gt(0n)` merely repeated line 137. Neither of the
      // two properties the comment claimed was asserted anywhere.
      //
      // The independent anchor is the ROUND BUDGET, read live off the token's own
      // dev rate: onChainGross = emissionRateNow − devRateNow − offchainBudget.
      // Nothing is reserved out of it any more (the first-predictor bonus is
      // gone), so the whole gross IS the single skimmable pool Alice — the only
      // predictor of the only weighted, predicted game — wins. Exactly one of the
      // three predictions earnAndClaim drives has settled by now (the first; the
      // A/B/C walk needs two later values), so exactly one round pays.
      // From the HUB's schedule, not the token's 1440 — that is the outer
      // envelope, not the rate.
      const onChainGross = (await satori.emissionRateNow())
                         - (await satori.devRateNow())
                         - (await rewards.offchainBudget());
      const roundPool = onChainGross; // the SKIMMABLE base
      expect(roundPool).to.be.gt(0n);

      // (a) The cut is a genuine floored 5% of the SKIMMED BASE — the base coming
      //     from the budget, not from Carol's bucket (A_referrals.md:45).
      expect(carolCut).to.equal((roundPool * 500n) / 10000n);

      // (b) Nothing is lost and nothing is conjured: earner net + destination cut
      //     equals the credited amount (A_rewards.md:139). An over-credit at
      //     `_creditReward` would push the left side above the budget-derived
      //     right side.
      expect(aliceNet + carolCut).to.equal(roundPool);

      // Alice's claim mints her FULL net bucket to her balance; Carol's balance is
      // untouched (Carol must claim her own bucket separately).
      const aliceBefore = await satori.balanceOf(alice.address);
      const carolBefore = await satori.balanceOf(carol.address);

      await satori.connect(alice)['claim()']();

      const aliceGained = (await satori.balanceOf(alice.address)) - aliceBefore;
      const carolGained = (await satori.balanceOf(carol.address)) - carolBefore;

      expect(aliceGained).to.equal(aliceNet);
      expect(carolGained).to.equal(0n);

      // Carol's cut is still fully claimable in her bucket after Alice's claim.
      expect(await rewards.unclaimedRewards(carol.address)).to.equal(carolCut);
    });

    it("Should emit ReferralPaid when the cut is credited (at settle, not claim)", async function () {
      await rewards.connect(alice).setReferral(carol.address);
      await earnAndClaim(alice);

      // Eager credit: ReferralPaid now fires when the cut is skimmed at settle
      // time (inside the earning txs), NOT at claim. Assert it was emitted for
      // (owner=alice, referral=carol) and that its amount matches Carol's bucket.
      const carolCut = await rewards.unclaimedRewards(carol.address);
      expect(carolCut).to.be.gt(0);

      const events = await rewards.queryFilter(
        rewards.filters.ReferralPaid(alice.address, carol.address)
      );
      expect(events.length).to.be.gt(0);
      const paidTotal = events.reduce((acc, e) => acc + e.args.amount, 0n);
      expect(paidTotal).to.equal(carolCut);

      // The claim itself no longer emits ReferralPaid (cut was already taken).
      const tx = await satori.connect(alice)['claim()']();
      const receipt = await tx.wait();
      const claimEmittedReferralPaid = receipt.logs.some((log) => {
        try {
          return rewards.interface.parseLog(log)?.name === 'ReferralPaid';
        } catch { return false; }
      });
      expect(claimEmittedReferralPaid).to.equal(false);
    });

    it("Should not affect users without a referral set", async function () {
      // No setReferral call for alice
      await earnAndClaim(alice);
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];

      const before = await satori.balanceOf(alice.address);
      await satori.connect(alice)['claim()']();
      const gained = (await satori.balanceOf(alice.address)) - before;

      expect(gained).to.equal(claimable);
    });

    it("Should route the cut to the referral's bucket, full net to recipient on claim(address)", async function () {
      await rewards.connect(alice).setReferral(carol.address);
      await earnAndClaim(alice);

      // Eager credit: Carol's 1% cut already sits in her UNCLAIMED bucket; Alice's
      // claimable is already net. claim(address) mints the full net to the chosen
      // recipient (dave) and never touches Carol's balance. The cut equals the
      // exact sum of the per-credit ReferralPaid amounts.
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      const carolCut = await rewards.unclaimedRewards(carol.address);
      const carolPaid = (await rewards.queryFilter(
        rewards.filters.ReferralPaid(alice.address, carol.address)
      )).reduce((acc, e) => acc + e.args.amount, 0n);
      expect(carolCut).to.be.gt(0);
      expect(carolCut).to.equal(carolPaid);

      const daveBefore = await satori.balanceOf(dave.address);
      const carolBefore = await satori.balanceOf(carol.address);

      await satori.connect(alice)['claim(address)'](dave.address);

      expect((await satori.balanceOf(dave.address)) - daveBefore).to.equal(claimable);
      // Carol's balance is untouched; her cut stays claimable in her bucket.
      expect((await satori.balanceOf(carol.address)) - carolBefore).to.equal(0n);
      expect(await rewards.unclaimedRewards(carol.address)).to.equal(carolCut);
    });

    it("Should report the NET (already-skimmed) amount in RewardsClaimed", async function () {
      await rewards.connect(alice).setReferral(carol.address);
      await earnAndClaim(alice);

      // Under eager credit the cut is already taken, so claim mints — and the
      // event reports — the whole net bucket. RewardsClaimed(owner, recipient,
      // totalAmount, round): assert owner and the net totalAmount.
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];

      await expect(satori.connect(alice)['claim()']())
        .to.emit(rewards, "RewardsClaimed")
        .withArgs(alice.address, alice.address, claimable, anyValue);
    });

  });

  describe("Marketing recipient rotation routes the cut (proxy storage, not an immutable)", function () {
    it("after a two-step handover the cut goes to the NEW recipient and the old one is frozen", async function () {
      // The recipient moved from an `immutable` to proxy storage precisely so it
      // can be rotated (a lost key otherwise burns the cut forever). Rotation is
      // recipient-only — see MarketingFeeRecipientRotation.test.js for the access
      // control and the upgrade-resistance proof; this asserts the money follows.
      const original = await rewards.marketingFeeRecipient();
      const successor = dave;

      await earnAndClaim(alice);
      expect(await rewards.unclaimedRewards(original)).to.be.gt(0);

      await ethers.provider.send("hardhat_setBalance", [original, "0x56BC75E2D63100000"]);
      const current = await ethers.getImpersonatedSigner(original);
      await rewards.connect(current).transferMarketingFeeRecipient(successor.address);
      await rewards.connect(successor).acceptMarketingFeeRecipient();

      const frozenOriginal = await rewards.unclaimedRewards(original);
      const beforeNew = await rewards.unclaimedRewards(successor.address);

      await advanceToNextRound();
      await earnAndClaim(bob); // a fresh un-referred earner

      expect(await rewards.unclaimedRewards(successor.address))
        .to.be.gt(beforeNew, "the new recipient must receive the cut");
      expect(await rewards.unclaimedRewards(original))
        .to.equal(frozenOriginal, "the old recipient must receive nothing further");
    });
  });

  describe("No opt-out — every earner pays the 1%", function () {
    it("an UNREFERRED earner's 1% goes to MARKETING (not waived); claim takes nothing more", async function () {
      // Alice sets NO referral. The 1% is still skimmed at credit time and routed
      // to MARKETING_FEE_RECIPIENT — there is no way to avoid it. Alice's own
      // bucket is already net.
      const marketing = await rewards.marketingFeeRecipient();
      const marketingBefore = await rewards.unclaimedRewards(marketing);

      await earnAndClaim(alice);
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
      expect(claimable).to.be.gt(0);

      // The cut went to the marketing bucket. It equals the exact sum of the
      // per-credit ReferralPaid amounts routed from alice to marketing.
      const marketingCut = (await rewards.unclaimedRewards(marketing)) - marketingBefore;
      const marketingPaid = (await rewards.queryFilter(
        rewards.filters.ReferralPaid(alice.address, marketing)
      )).reduce((acc, e) => acc + e.args.amount, 0n);
      expect(marketingCut).to.be.gt(0);
      expect(marketingCut).to.equal(marketingPaid);

      const aliceBefore = await satori.balanceOf(alice.address);
      const tx = await satori.connect(alice)['claim()']();
      const receipt = await tx.wait();

      // Claim mints alice's full (already-net) bucket — nothing further is skimmed.
      const aliceGained = (await satori.balanceOf(alice.address)) - aliceBefore;
      expect(aliceGained).to.equal(claimable);

      // No ReferralPaid event fires at claim time (the cut was taken at credit time).
      const referralPaidEvent = receipt.logs.find((log) => {
        try {
          return rewards.interface.parseLog(log)?.name === 'ReferralPaid';
        } catch { return false; }
      });
      expect(referralPaidEvent).to.equal(undefined);
    });

    it("claim(address) mints the full net bucket to the recipient (unreferred earner)", async function () {
      await earnAndClaim(alice);
      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];

      const daveBefore = await satori.balanceOf(dave.address);
      await satori.connect(alice)['claim(address)'](dave.address);

      expect((await satori.balanceOf(dave.address)) - daveBefore).to.equal(claimable);
    });

    it("self-referral is rejected — there is no self opt-out anymore", async function () {
      await expect(rewards.connect(alice).setReferral(alice.address))
        .to.be.revertedWithCustomError(rewards, "InvalidReferral");
    });
  });

  describe("Claim with referral via claimFor", function () {
    it("Should use OWNER's referral, not caller's", async function () {
      // Alice is the owner, Bob the claim delegate, Carol Alice's referral, Dave Bob's referral
      await rewards.connect(alice).setReferral(carol.address);
      await rewards.connect(bob).setReferral(dave.address);

      await earnAndClaim(alice);

      // Eager credit: the cut was skimmed at settle time to the EARNER's referral.
      // Since alice is the earner, that's Carol — Bob's referral (Dave) never
      // enters into it, regardless of who later claims. Carol's cut sits in her
      // UNCLAIMED bucket; Dave's bucket stays empty.
      const carolCut = await rewards.unclaimedRewards(carol.address);
      expect(carolCut).to.be.gt(0);
      expect(await rewards.unclaimedRewards(dave.address)).to.equal(0n);

      // The cut routed to Carol equals the exact sum of the per-credit ReferralPaid
      // amounts from alice to carol — and NONE were routed to Dave (bob's referral).
      const carolPaid = (await rewards.queryFilter(
        rewards.filters.ReferralPaid(alice.address, carol.address)
      )).reduce((acc, e) => acc + e.args.amount, 0n);
      expect(carolCut).to.equal(carolPaid);
      const davePaid = await rewards.queryFilter(
        rewards.filters.ReferralPaid(alice.address, dave.address)
      );
      expect(davePaid.length).to.equal(0);

      // Alice delegates claim to Bob
      await satori.connect(alice).delegateClaimAbility(bob.address);
      await advanceToNextRound();

      const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];

      const carolBefore = await satori.balanceOf(carol.address);
      const daveBefore = await satori.balanceOf(dave.address);
      const aliceBefore = await satori.balanceOf(alice.address);

      // Bob calls claimFor(alice, alice) — recipient is alice
      await satori.connect(bob).claimFor(alice.address, alice.address);

      // Neither referral is paid at claim (the cut was already credited): claim
      // mints Alice's full net to Alice, and no balance moves to Carol or Dave.
      expect((await satori.balanceOf(carol.address)) - carolBefore).to.equal(0n);
      expect((await satori.balanceOf(dave.address)) - daveBefore).to.equal(0n);
      expect((await satori.balanceOf(alice.address)) - aliceBefore).to.equal(claimable);
      // Carol's (the owner's referral) cut remains claimable in her bucket.
      expect(await rewards.unclaimedRewards(carol.address)).to.equal(carolCut);
    });
  });

  describe("Aggregate / no double-tax", function () {
    it("Referral cut lands in the referral's UNCLAIMED bucket and never itself pays a referral", async function () {
      // Carol is alice's referral. Carol has NEVER predicted, so she has 0 unclaimed
      // before alice earns. Under eager credit, alice's earning skims 1% into
      // Carol's UNCLAIMED bucket (claimable by Carol), and alice's own claim does
      // NOT move Carol's balance — the cut was already credited at settle time.
      await rewards.connect(alice).setReferral(carol.address);
      await earnAndClaim(alice);

      // The cut is now sitting in Carol's claimable bucket (credited eagerly),
      // and Carol's balance is unchanged by alice's claim.
      const carolCut = await rewards.unclaimedRewards(carol.address);
      expect(carolCut).to.be.gt(0);
      expect((await lens.getTotalClaimableRewards(carol.address))[0]).to.equal(carolCut);

      const carolBefore = await satori.balanceOf(carol.address);
      await satori.connect(alice)['claim()']();
      expect((await satori.balanceOf(carol.address)) - carolBefore).to.equal(0n);
      // Alice's claim doesn't disturb Carol's bucket either.
      expect(await rewards.unclaimedRewards(carol.address)).to.equal(carolCut);

      // No double-tax / no referral-on-referral: when Carol claims her own cut,
      // she receives the WHOLE amount — the cut is not itself skimmed again.
      const carolBalBeforeClaim = await satori.balanceOf(carol.address);
      await satori.connect(carol)['claim()']();
      expect((await satori.balanceOf(carol.address)) - carolBalBeforeClaim).to.equal(carolCut);
      expect(await rewards.unclaimedRewards(carol.address)).to.equal(0n);
    });
  });
});
