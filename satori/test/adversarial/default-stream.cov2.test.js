// Adversarial COVERAGE round 2 for the default-stream subsystem.
//
// Targets the MEDIUM-priority coverage gaps from
//   adversarial-findings/_raw_review.json -> systems[system=="default-stream"]
// that the first round (default-stream.cov.test.js) did NOT exercise, plus
// the IMMUTABLE-fee-recipient contract change that post-dates the audit.
//
// BURN-VOTING REWRITE. The default-stream CUT (accrueDefaultStreamCut) and its
// top-dog guard (getMaxWeightAtRound) are gone, so every "…and mints the cut
// once" clause below was dropped. What SURVIVES — and is what these gaps were
// really about — is the flushDefaultStream CURSOR and the round accounting it
// feeds. The cursor is still the thing that must collapse a multi-round gap into
// a single write, and it is still the only writer of the default stream's value.
//
// Remaining gaps covered here:
//   1. flushDefaultStream cursor across MULTI-ROUND gaps: a single flush after
//      several idle rounds jumps the cursor straight to the current round and
//      writes only the most-recent count — ONE write, not one per gap round —
//      and mints nothing (there is no cut to back-bill any more).
//   2. Conservation across multiple producing games: Σ producing-game payouts
//      <= the round budget, with the default counted in the denominator exactly
//      once (the accumulator has a single write branch, so no double count).
//   3. Genesis edge: the first flush right after the default stream is
//      initialized is a clean no-op — no mint, no revert.
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

  // GAP (med): cursor across MULTI-ROUND gaps.
  // Intent (SatoriEngine.flushDefaultStream): "Skips gap rounds — only the most
  // recent matters for scoring." After several idle rounds, ONE flush must:
  //   - advance defaultStreamLastFlushedRound straight to the current round,
  //     NOT round-by-round;
  //   - write last round's count to the registry ONCE (one event, not one per
  //     gap round);
  //   - mint NOTHING (the default-stream cut it used to carry is gone, and the
  //     default's weight is derived, so a flush can never move it either).
  it("collapses a multi-round idle gap into a single flush that mints nothing", async function () {
    const { satori, engine, voting, registry, signers } = await setup();
    const [owner, alice] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));

    // A user game carrying real burnt weight, so the default is NOT the only
    // thing in the system while the gap elapses.
    const sid = await streamIdFrom(await satori.createSimpleDataStream("User", owner.address), satori);
    await voteFor(satori, alice, sid, ethers.parseEther("10"));

    const initRound = await satori.getCurrentRound();
    expect(await satori.defaultStreamLastFlushedRound()).to.equal(initRound);

    // Idle for FIVE rounds: no flush, no predict, just time. The cursor stays put.
    for (let i = 0; i < 5; i++) await advanceRound();
    expect(await satori.defaultStreamLastFlushedRound()).to.equal(initRound);

    // Now a producer touch in the registry + ONE flush.
    await registry.setValue(sid, 100);
    const today = await satori.getCurrentRound();
    const core = await satori.getAddress();

    const balBefore = await satori.balanceOf(core);
    const derivedBefore = await voting.defaultDerivedWeight();
    // Exactly ONE DefaultStreamFlushed, for the CURRENT round, carrying only the
    // most-recent count (nobody predicted during the gap, so 0) — never one
    // event (or one value write) per skipped round.
    await expect(satori.flushDefaultStream())
      .to.emit(engine, "DefaultStreamFlushed").withArgs(today, 0);
    const balAfter = await satori.balanceOf(core);

    // Cursor jumped straight to the current round (NOT initRound+1, not
    // round-by-round) — current-round indexing.
    expect(await satori.defaultStreamLastFlushedRound()).to.equal(today);

    // A flush is now purely a value write: it mints no SATORI to the core...
    expect(balAfter - balBefore).to.equal(0n);
    // ...and cannot move the default's weight, which is DERIVED from other
    // games' burns and has no self-compounding path any more.
    expect(await voting.defaultDerivedWeight()).to.equal(derivedBefore);
    expect(await voting.gameWeight(DEFAULT_ID)).to.equal(0n); // never burned for

    // A SECOND flush in the same round is a no-op (cursor already == today).
    const b2 = await satori.balanceOf(core);
    await satori.flushDefaultStream();
    expect((await satori.balanceOf(core)) - b2).to.equal(0n);
    expect(await satori.defaultStreamLastFlushedRound()).to.equal(today);
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
    const [owner, alice, bob, carol] = signers;
    await satori.transfer(alice.address, ethers.parseEther("20"));
    await satori.transfer(bob.address, ethers.parseEther("20"));
    await satori.transfer(carol.address, ethers.parseEther("20"));
    // Fillers FUNDED (20 each) so their predictions deploy real capital into the
    // round's deployedPower — the default's value is a participation-by-capital
    // ratio now, not a prediction count, so only committed capital can move it.
    for (let k = 4; k < 20; k++) await satori.transfer(signers[k].address, ethers.parseEther("20"));

    // Two user games carrying 10 burnt weight each (total burnt 20). The
    // default's 1% derivation of that (20 * 100/9900 ≈ 0.202) is under the 1e18
    // floor, so it sits ON its floor at 1. Denominator == 10 + 10 + 1 == 21.
    // Explicit cadence-2 (2880-minute) streams: coarser than a round, so they
    // keep the AB scoring lens this test's R1->R3 rhythm is written against.
    const a = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("A", owner.address, 2880), satori);
    const b = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("B", owner.address, 2880), satori);
    await voteFor(satori, alice, a, ethers.parseEther("10"));
    await voteFor(satori, bob, b, ethers.parseEther("10"));
    expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));

    // No-weight filler stream: never recorded into the denominator, used only as
    // a target for FUNDED predictors to deploy capital against, so the default
    // game's value (last round's deployedPower ratio, indexed at the current
    // round) rises across rounds (B < C) and carol's UP prediction on the
    // default wins.
    // Sub-round (720-minute), created as the ADMIN (`satori` is connected to the
    // deployer, which is rewards.admin() here): the filler must be writable on
    // THREE CONSECUTIVE rounds so capital can be committed against it every
    // round, and the default game is itself every-round. A public stream is
    // round-length (1440 minutes) or slower.
    // Scaffolding only — no weight, never recorded, never asserted on.
    const filler = await streamIdFrom(
      await satori["createSimpleDataStream(string,address,uint24)"]("Filler", owner.address, 720),
      satori
    );
    let sigIdx = 4;
    async function fill(n, v) {
      await registry.setValue(filler, v);
      for (let i = 0; i < n; i++) {
        await satori.connect(signers[sigIdx++]).predictMultipleWithPayloads([{ gameId: filler, payload: pack1(UP) }]);
      }
    }

    // R1: all three produce; three distinct predictors each predict one game.
    await advanceRound();
    const r1 = await satori.getCurrentRound();
    await registry.setValue(a, 100);
    await registry.setValue(b, 100);
    await satori.flushDefaultStream(); // default produces (counts once)
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: a, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: b, payload: pack1(UP) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
    await fill(1, 100);
    // deployedPower(R1) = alice(20)+bob(20)+carol(20)+1 funded filler(20) = 80.

    // R2: a and b are cadence-2 (2880-minute) streams, so they cannot take a
    // value again until R3 — that is the whole point of the floor. Only the
    // every-round default and the sub-round filler move this round. The
    // flush writes the default's value AT R2 = R1's deployedPower ratio
    // (current-round indexing); make R2's committed CAPITAL strictly exceed
    // R1's so the default's ABC values after R1 — deployedPower(R1) then
    // deployedPower(R2) — rise (B < C).
    await advanceRound();
    await satori.flushDefaultStream();
    await fill(6, 110); // deployedPower(R2) = 6 funded fillers(20) = 120 > 80 => carol's UP wins

    // R3: one full cadence period after R1, so a and b take their POST value.
    // They are cadence 2 => AB lens: anchor = value AT R1 (100), post = this
    // write (120) => post > anchor => alice's and bob's UP predictions win.
    // The flush writes the default's value AT R3 = R2's (higher) deployedPower,
    // keeping the default's own capital ramp strictly rising.
    await advanceRound();
    await registry.setValue(a, 120); // post for a (> anchor 100)
    await registry.setValue(b, 120); // post for b (> anchor 100)
    await satori.flushDefaultStream();
    await fill(8, 120); // deployedPower(R3) = 8 funded fillers(20) = 160 (ramp keeps rising)

    await advanceRound();
    await satori.flushDefaultStream();

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

    // Settle every R1 prediction.
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
    // the round budget (mint never over-pays the budget for that round). The
    // bound is the REAL post-dev-fee residual, not a stale literal that would
    // leave slack for a double count to hide in — so pin that it really is the
    // residual, and that it is strictly under the token's 1440 envelope.
    expect(BUDGET, "budget must be the post-dev-fee residual").to.equal(
      (await satori.emissionRateNow()) - (await satori.devRateNow())
    );
    expect(BUDGET).to.be.lt(await satori.ROUND_REWARD_BUDGET());
    expect(paid).to.be.lte(BUDGET);
    // Liveness: the bound is an upper bound, so it holds trivially on a round
    // that paid nothing. Pin that this round really distributed.
    expect(paid, "the round must actually have paid the three winners").to.be.gt(0n);
    // And the default DID earn (its slice was not dropped from the denominator).
    expect(after.carol - before.carol).to.be.gt(0n);
    expect(after.alice - before.alice).to.be.gt(0n);
    expect(after.bob - before.bob).to.be.gt(0n);
    expect(await voting.getGameVotesAtRound(DEFAULT_ID, r1)).to.equal(ethers.parseEther("1"));
  });

  // GAP (low, genesis): the first flush right after initializeDefaultStream must
  // be a clean no-op — the prior round was seeded with a ZERO count, nothing has
  // been predicted, and there is no accrual path left on this call at all. It
  // must NOT mint and must NOT revert.
  it("does not mint or revert on the genesis flush", async function () {
    const { satori, voting } = await setup();
    const core = await satori.getAddress();

    // Immediately advance ONE round and flush (cursor lands on the current
    // round; the value written is initRound's count, which is 0).
    await advanceRound();
    const balBefore = await satori.balanceOf(core);
    const derivedBefore = await voting.defaultDerivedWeight();
    await expect(satori.flushDefaultStream()).to.not.be.reverted;
    const balAfter = await satori.balanceOf(core);
    // No SATORI minted to the core, and the default sits on its 1e18 derived
    // floor throughout (nothing has been burned for anything yet).
    expect(balAfter - balBefore).to.equal(0n);
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
