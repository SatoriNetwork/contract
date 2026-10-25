// Adversarial COVERAGE round 2 for the default-stream subsystem.
//
// Targets the MEDIUM-priority coverage gaps from
//   adversarial-findings/_raw_review.json -> systems[system=="default-stream"]
// that the first round (default-stream.cov.test.js) did NOT exercise, plus
// the IMMUTABLE-fee-recipient contract change that post-dates the audit.
//
// The default stream is the Sentiment stream "satori" now, so there is no flush and
// no cursor. What these gaps were really about survives:
//   1. A multi-round idle gap needs nothing from anyone: no keeper, no write, and a
//      prediction after the gap works and mints nothing.
//   2. Conservation across multiple producing games: sum of payouts <= the round
//      budget, with the default counted in the denominator exactly once (the
//      accumulator has a single write branch, so no double count).
//   3. Genesis edge: the first prediction right after the default stream is
//      initialized is clean: no mint, no revert.
//
// Plus the post-audit CONTRACT CHANGE (platform fee moved to the immutable
// SatoriToken, see test/next/DevFee.test.js):
//   4. The platform/dev fee recipient no longer lives on rewards — it is the
//      token's immutable PLATFORM_FEE_RECIPIENT (no setter). What we still assert
//      on rewards is the ABSENCE of any fee-redirect surface (no
//      setPlatformFeeRecipient/wireFeeRecipient) and that feeSlot() is inert; the
//      admin can transfer admin but can never redirect the fee.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, voteFor } = require("../fixtures");

const UP = 1;
const DEFAULT_ID = 1;
// PER-ROUND PAYABLE POOL. Derived from the chain, NOT hardcoded, because the
// number moves and a literal would not: the dev fee lives on the IMMUTABLE
// SatoriToken (devFeeBps, 1500 by default, DAO-settable within [5%, 25%]) and the per-round emission
// lives on the HUB as a decaying schedule, so the game pool is the RESIDUAL
// after the fee — even "NoFee" fixtures carve it out; deploySatoriFixtureNoFee
// only zeroes the rewards-level bps fee.
// SatoriRewards._onChainGrossNow / _computeRoundBudget:
//   gross   = emissionRateNow() − devRateNow() − offchainBudget
//   payable = gross
// The payable budget IS the gross now: the first-predictor bonus was removed and
// its reservation went with it, so the whole on-chain gross is distributable to
// predictors.
//
// The first term was `ROUND_REWARD_BUDGET()` — the token's 1440. That is the
// outer constitutional ENVELOPE, not the rate: the hub mints under it at its own
// schedule, so sizing a payout from it over-states the pool by the difference.
async function roundBudget(satori, rewards) {
  return (await satori.emissionRateNow())
    - (await satori.devRateNow())
    - (await rewards.offchainBudget());
}

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return Number(satori.interface.parseLog(ev).args.streamId);
}

// getTotalClaimableRewards moved from SatoriRewards to the read-only
// SatoriRewardsLens (review #12) — same signature, same values. The fixture
// already deploys and returns the lens.
async function getClaimable(lens, who) {
  return lens.getTotalClaimableRewards(who).then((r) => r[0]);
}

// Standard fixture + zero platform fee (clean 576 per-round budget). The
// fixture itself now calls initializeDefaultStream(), exactly as production
// does, so the default stream/game already occupies id 1 (a second call would
// revert AlreadySet) and the first stream a test creates is id 2.
async function setup() {
  return deploySatoriFixtureNoFee();
}

describe("default-stream COVERAGE 2: cursor gaps, multi-producer conservation, genesis, immutable fee recipient", function () {
  this.timeout(120000);

  // GAP (med): an idle gap. Nothing writes the default stream's value but a
  // prediction's own pull, so five idle rounds leave no state to repair and need
  // no call: the next prediction just works, mints nothing, and cannot move the
  // default's derived weight.
  it("needs nothing across a multi-round idle gap, and a prediction after it mints nothing", async function () {
    const { satori, voting, signers } = await setup();
    const [owner, alice, bob] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("20"));

    // A user game carrying real burnt weight, so the default is NOT the only
    // thing in the system while the gap elapses.
    const sid = await streamIdFrom(await satori.createSimpleDataStream("User", owner.address), satori);
    await voteFor(satori, alice, sid, ethers.parseEther("10"));

    for (let i = 0; i < 5; i++) await advanceRound();
    const core = await satori.getAddress();
    const balBefore = await satori.balanceOf(core);
    const derivedBefore = await voting.defaultDerivedWeight();

    await expect(
      satori.connect(bob).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }])
    ).to.not.be.reverted;

    expect((await satori.balanceOf(core)) - balBefore).to.equal(0n);
    expect(await voting.defaultDerivedWeight()).to.equal(derivedBefore);
    expect(await voting.gameWeight(DEFAULT_ID)).to.equal(0n); // never burned for
  });

  // GAP (med): Σ producing-game payouts <= budget with the default counted
  // exactly once in the round denominator.
  // The denominator is now ACCUMULATED by recordGameVotesForRound — one write
  // branch, first predictor of each game per round — so total rewards across ALL
  // winning predictors of participating games can never exceed the budget. If
  // the default were double-counted the denominator would inflate and dilute
  // everyone, but the SUM would still be bounded — so we assert the tight bound
  // AND that the default's slice is present (not dropped) AND that the three
  // numerators reconstruct the denominator exactly.
  it("keeps Σ participating-game payouts <= budget with the default counted once", async function () {
    const { satori, voting, registry, rewards, signers, lens } = await setup();
    const BUDGET = await roundBudget(satori, rewards);
    const [owner, alice, bob, carol, dan, erin] = signers;
    for (const u of [alice, bob, carol, dan, erin]) await satori.transfer(u.address, ethers.parseEther("20"));

    // Two user games carrying 10 burnt weight each (total burnt 20). The
    // default's 1% derivation of that (20 * 100/9900 ≈ 0.202) is under the 1e18
    // floor, so it sits ON its floor at 1. Denominator == 10 + 10 + 1 == 21.
    // Explicit cadence-2 (2880-minute) streams keep the AB scoring lens this
    // test's R1->R3 rhythm is written against.
    const a = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("A", owner.address, 2880), satori);
    const b = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("B", owner.address, 2880), satori);
    await voteFor(satori, alice, a, ethers.parseEther("10"));
    await voteFor(satori, bob, b, ethers.parseEther("10"));
    expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));

    // R1: all three produce. On the default (a Sentiment game) dan leans UP first,
    // then carol and erin lean DOWN: carol is right (erin leaned her way after
    // her) and is paid out of dan's weight.
    await advanceRound();
    const r1 = await satori.getCurrentRound();
    await registry.setValue(a, 100);
    await registry.setValue(b, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: a, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: b, payload: pack1(UP) }]);
    await satori.connect(dan).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(2) }]);
    await satori.connect(erin).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(2) }]);

    // R3: one full cadence period after R1, so a and b take their POST value.
    // Cadence 2 => AB lens: anchor = value AT R1 (100), post = this write (120)
    // => post > anchor => alice's and bob's UP predictions win.
    await advanceRound();
    await advanceRound();
    await registry.setValue(a, 120);
    await registry.setValue(b, 120);
    await registry.updateValue(DEFAULT_ID); // the default's post sample (24h+ after R1)

    // The denominator is exactly the three participating games' weights, each
    // added once — the default among them.
    const participating = (await voting.getEligibleGamesAtRound(r1)).map(Number);
    expect(participating.filter((g) => g === DEFAULT_ID).length, "default counted once").to.equal(1);
    expect(new Set(participating).size).to.equal(participating.length);
    let sumNumerators = 0n;
    for (const g of participating) sumNumerators += await voting.getGameVotesAtRound(g, r1);
    const denom = await voting.roundDenominator(r1);
    expect(sumNumerators).to.equal(denom);
    expect(denom).to.equal(ethers.parseEther("21"));

    const before = {
      alice: await getClaimable(lens, alice.address),
      bob: await getClaimable(lens, bob.address),
      carol: await getClaimable(lens, carol.address),
    };
    await satori.settlePrediction(alice.address, a);
    await satori.settlePrediction(bob.address, b);
    await satori.settlePrediction(carol.address, DEFAULT_ID);
    const after = {
      alice: await getClaimable(lens, alice.address),
      bob: await getClaimable(lens, bob.address),
      carol: await getClaimable(lens, carol.address),
    };

    const paid = (after.alice - before.alice) + (after.bob - before.bob) + (after.carol - before.carol);

    // Conservation: the sum of all R1 participating-game payouts cannot exceed
    // the round budget. The bound is the REAL post-dev-fee residual.
    expect(BUDGET, "budget must be the post-dev-fee residual").to.equal(
      (await satori.emissionRateNow()) - (await satori.devRateNow())
    );
    expect(BUDGET).to.be.lt(await satori.ROUND_REWARD_BUDGET());
    expect(paid).to.be.lte(BUDGET);
    expect(paid, "the round must actually have paid the three winners").to.be.gt(0n);
    // And the default DID earn (its slice was not dropped from the denominator).
    expect(after.carol - before.carol).to.be.gt(0n);
    expect(after.alice - before.alice).to.be.gt(0n);
    expect(after.bob - before.bob).to.be.gt(0n);
    expect(await voting.getGameVotesAtRound(DEFAULT_ID, r1)).to.equal(ethers.parseEther("1"));
  });

  // GAP (low, genesis): the first prediction right after initializeDefaultStream
  // must be clean. The stream has no value yet; the prediction's own pull writes
  // the first one. It must NOT mint and must NOT revert.
  it("does not mint or revert on the first prediction after genesis", async function () {
    const { satori, voting, signers } = await setup();
    const alice = signers[1];
    await satori.transfer(alice.address, ethers.parseEther("20"));
    const core = await satori.getAddress();

    await advanceRound();
    const balBefore = await satori.balanceOf(core);
    const derivedBefore = await voting.defaultDerivedWeight();
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }])
    ).to.not.be.reverted;
    expect((await satori.balanceOf(core)) - balBefore).to.equal(0n);
    expect(derivedBefore).to.equal(ethers.parseEther("1"));
    expect(await voting.defaultDerivedWeight()).to.equal(derivedBefore);
  });

  // CONTRACT CHANGE (platform fee moved to immutable token, see
  // test/next/DevFee.test.js): the platform/dev fee recipient no longer lives on
  // rewards at all. What we still assert here is that rewards exposes NO
  // fee-redirect surface (no setPlatformFeeRecipient/wireFeeRecipient) and that
  // feeSlot() is now inert — it carries only (bps, lastAccrualRound), never a
  // recipient field.
  it("rewards has no platform-fee-recipient setter and no feeSlot surface at all", async function () {
    const { rewards } = await setup();
    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // recipient no longer lives on rewards; only its NO-redirect surface remains.

    // No redirect / wire entrypoints exist on the ABI.
    const fnNames = rewards.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    expect(fnNames).to.not.include("setPlatformFeeRecipient");
    expect(fnNames).to.not.include("wireFeeRecipient");
    // feeSlot joined them 2026-08-31: the dead fee storage and its getter are gone.
    expect(fnNames).to.not.include("feeSlot");
  });

  // CONTRACT CHANGE: the admin can transfer the admin role but can NEVER
  // redirect the recipient. Transfer re-gates; the recipient stays constant.
  it("admin can transfer admin, never redirect the recipient", async function () {
    const { rewards, signers } = await setup();
    const [owner, alice, bob] = signers;

    // Admin transfer re-gates: old admin loses control, new admin gains it.
    //
    // Checked through BOB, not through `owner`. This fixture deploys governor and
    // admin from the same signer, and the governor now keeps a recovery path into
    // setAdmin (an admin key compromise was otherwise unrecoverable — see
    // test/AdminRecovery.test.js). So `owner` handing the role away does not make
    // it unauthorized here; it is still the governor. Bob has no such second claim.
    await rewards.connect(owner).setAdmin(bob.address);
    expect(await rewards.admin()).to.equal(bob.address);
    await rewards.connect(bob).setAdmin(alice.address);
    expect(await rewards.admin()).to.equal(alice.address);
    await expect(rewards.connect(bob).setAdmin(bob.address))
      .to.be.revertedWithCustomError(rewards, "Unauthorized");
    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // recipient is no longer on rewards, so an admin transfer structurally can
    // never redirect it.
  });
});
