// Adversarial COVERAGE for the default-stream subsystem.
//
// Targets the high/med-priority coverage gaps from
//   adversarial-findings/_raw_review.json -> systems[system=="default-stream"].
//
// BURN-VOTING REWRITE. The original file existed for the "Default Stream Cut &
// Top-Dog Guard" feedback loop: SatoriRewards.accrueDefaultStreamCut minted the
// default stream a 5% catch-up slice while it trailed the heap leader, and
// _computeReward deducted that same slice from the default's predictors. BOTH
// halves of that mechanism are gone — there is no value-provider cut, no
// default-stream cut, no getMaxWeightAtRound and no heap to be top dog of — so
// the four cut/guard tests were deleted rather than weakened.
//
// What REPLACED the loop is a derived weight, and it is the thing worth
// covering now: the default game (id 1) can never be voted on, and its weight is
// DERIVED as `totalBurnedWeight * 100 / 9900` floored at 1e18. That is 1% of a
// denominator that includes itself — but at the small burns these tests use (10
// and 20 ether) 1% is well under the 1e18 floor, so in practice the default sits
// ON its floor and its share of the denominator is `1e18 / (1e18 + Σ burns)`,
// not a fixed fraction. The tests below pin that floored share end-to-end, plus
// the denominator-integrity and provider-gating properties that outlived the cut.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, voteFor, onChainGrossNow } = require("../fixtures");

const UP = 1;
const DEFAULT_ID = 1;
// On-chain game gross per round. The dev fee is the token's senior carve-out,
// so the game pool is the residual (emission net of the fee) — READ FROM THE
// CHAIN, because the emission is the hub's decaying schedule now. This was
// `parseEther("1152")` = 1440 − 288, which held only while it was fixed.
// The old first-predictor bonus reservation (−0.44) is GONE: the full gross is
// distributable to predictors now, so this is the whole payable budget.
let BUDGET;
// The default's share of the denominator in the "derived 1%" test below. The 1%
// derivation (DEFAULT_SHARE_BPS = 100) is under the 1e18 floor at that test's
// 10-ether burn, so the default sits on its floor: 1e18 against a 10e18 user
// weight makes the denominator 11e18, and the default is exactly 1/11 of it.
const DEFAULT_SHARE_DIVISOR = 11n;

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

// Standard fixture wiring + zeroed platform fee (so the on-chain per-round
// budget is the clean residual after the senior dev fee, which is off-budget at
// the token). The fixture itself now calls initializeDefaultStream(), exactly as
// production does, so the default stream/game already occupies id 1 and the
// first stream a test creates is id 2.
async function setup() {
  const fix = await deploySatoriFixtureNoFee();
  BUDGET = await onChainGrossNow(fix.satori);
  return fix;
}

describe("default-stream COVERAGE: derived weight, denominator integrity, provider gating", function () {
  this.timeout(120000);

  // GAP (high): the default's slice is real and is paid IN FULL.
  // Replaces defaultCut_conservation / "pays a solo default predictor the FULL
  // slice". With the default as the SOLE game predicted that round, its derived
  // weight IS the whole denominator, so its lone predictor must receive the
  // entire round budget — proving nothing is skimmed off the default's pool
  // (the 5% cut deduction that used to live in _computeReward is gone).
  it("pays a solo default predictor the FULL round budget (nothing is skimmed off its pool)", async function () {
    const { satori, voting, registry, signers, lens } = await setup();
    const [owner, alice] = signers;
    await satori.transfer(alice.address, ethers.parseEther("10"));
    // Fillers are FUNDED with real balance (10 each, same as alice) so their
    // predictions add real CAPITAL to the round's deployedPower. The default
    // game's flushed value is now a participation-by-capital ratio
    // (deployedPower * 1e18 / totalSupply), so only committed capital — never a
    // bare prediction count — can move it. (Total supply is a tight 1440, so the
    // per-wallet amounts are kept small.)
    for (let k = 2; k < 20; k++) await satori.transfer(signers[k].address, ethers.parseEther("10"));

    // Filler stream with NO burnt weight -> recordGameVotesForRound skips it, so
    // it never enters the denominator and the default stays the SOLE entry. Used
    // only to let FUNDED predictors commit capital on successive rounds so the
    // default's value (yesterday's deployedPower ratio) climbs and alice's UP
    // prediction wins.
    //
    // It is created at cadence 1 as the ADMIN (`satori` is connected to the
    // deployer, which is rewards.admin() here). A public stream is cadence 2 or
    // slower, and this filler has to take a fresh value on THREE CONSECUTIVE
    // rounds so predictors can deploy capital against it every round — the
    // default game is cadence 1 and that is the rhythm under test. The filler is
    // pure scaffolding: it carries no weight and is never asserted on.
    const filler = await streamIdFrom(
      await satori["createSimpleDataStream(string,address,uint24)"]("Filler", owner.address, 720),
      satori
    );

    let sigIdx = 2;
    async function fillerPredicts(n, val) {
      await registry.setValue(filler, val);
      for (let i = 0; i < n; i++) {
        await satori.connect(signers[sigIdx++]).predictMultipleWithPayloads([{ gameId: filler, payload: pack1(UP) }]);
      }
    }

    // R1: alice predicts UP on the default game. Committed CAPITAL rises across
    // the two scored rounds — deployedPower(R1) = alice(10) + 1 funded filler
    // (10) = 20, deployedPower(R2) = 3 funded fillers (30) — so the default's
    // value B (deployedPower(R1) ratio, flushed at R1+1) is below C
    // (deployedPower(R2) ratio, flushed at R1+2), and her UP prediction wins.
    // (R3's 5 fillers = 50 keeps the ramp rising but does not affect alice's
    // R1 ABC score, which reads only R1 vs R2.)
    await advanceRound();
    const r1 = await satori.getCurrentRound();
    await satori.flushDefaultStream();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
    await fillerPredicts(1, 100);

    await advanceRound();
    await satori.flushDefaultStream();
    await fillerPredicts(3, 110);

    await advanceRound();
    await satori.flushDefaultStream();
    await fillerPredicts(5, 120);

    await advanceRound();
    await satori.flushDefaultStream();

    // Nobody burned anything, so the default sits on its 1e18 derived FLOOR and
    // is the only game in the round's denominator.
    const dv = await voting.getGameVotesAtRound(DEFAULT_ID, r1);
    expect(dv).to.equal(ethers.parseEther("1"));            // DEFAULT_WEIGHT_FLOOR
    expect(dv).to.equal(await voting.defaultDerivedWeight());
    expect(dv).to.equal(await voting.roundDenominator(r1));  // sole entry
    // The zero-weight filler game never made it into the denominator.
    expect(await voting.getGameVotesAtRound(filler, r1)).to.equal(0n);

    const claimableBefore = await getClaimable(lens, alice.address);
    const marketingBefore = await getMarketingBucket(satori);
    await satori.settlePrediction(alice.address, DEFAULT_ID);
    const claimableAfter = await getClaimable(lens, alice.address);
    const marketingAfter = await getMarketingBucket(satori);

    // Sole producer => streamPool == budget => the solo predictor's GROSS reward
    // is the full budget. Under eager credit the 5% referral skim moves to the
    // marketing bucket at credit time, so alice's net claimable + the marketing
    // cut reconstruct the full budget exactly. (Tolerance for rawPower
    // quantization.)
    const aliceReward = claimableAfter - claimableBefore;
    const marketingCut = marketingAfter - marketingBefore;
    const gross = aliceReward + marketingCut;
    expect(gross).to.be.closeTo(BUDGET, ethers.parseEther("0.001"));
    // The skim really did fire (this is a reward credit, not a raw mint): the
    // marketing cut is exactly floor(gross * 5%), so alice's net is strictly
    // below the gross full slice.
    expect(marketingCut).to.equal((gross * 500n) / 10000n);
    expect(aliceReward).to.be.lt(gross);
  });

  // GAP (high): the default's FLOORED share of the round is paid to its
  // predictor exactly. Replaces
  // defaultCut_conservation_mint_equals_predictor_deduction: the mint side is
  // gone, so the whole conservation statement collapses to
  //     defaultPredictorGross == BUDGET * defaultDerivedWeight / roundDenominator
  // with the derived weight on its 1e18 floor (the 1% derivation of a 10-ether
  // burn is ≈0.101, under the floor), making that ratio precisely 1/11.
  it("pays the default's predictor exactly its floored 1/11 share of the round denominator", async function () {
    const { satori, voting, registry, signers, lens } = await setup();
    const [owner, alice, bob, voter] = signers;
    await satori.transfer(alice.address, ethers.parseEther("20"));
    await satori.transfer(bob.address, ethers.parseEther("20"));
    await satori.transfer(voter.address, ethers.parseEther("20"));
    // Fillers FUNDED (20 each) so their predictions deploy real capital — the
    // default's value is a deployedPower ratio now, not a prediction count.
    for (let k = 4; k < 20; k++) await satori.transfer(signers[k].address, ethers.parseEther("20"));

    // One user game carrying 10 burnt weight. The default's 1% derivation of that
    // (10 * 100/9900 ≈ 0.101) is under the 1e18 floor, so the default sits ON its
    // floor: weight 1, denominator 11, and the default is exactly 1/11 of it.
    const user = await streamIdFrom(await satori.createSimpleDataStream("User", owner.address), satori);
    await voteFor(satori, voter, user, ethers.parseEther("10"));
    expect(await voting.weightOf(user)).to.equal(ethers.parseEther("10"));
    expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));

    // No-weight filler stream that FUNDED predictors deploy capital against so
    // the default's deployedPower ratio rises (B < C) and alice's UP prediction
    // wins. Cadence 1, created as the ADMIN: it must be writable on three
    // consecutive rounds so capital can be committed every round, which a public
    // (cadence >= 2) stream cannot do. Scaffolding only — no weight, never
    // asserted on.
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

    // R1: BOTH the user game and the default are predicted, so both enter the
    // round's accumulated denominator.
    await advanceRound();
    const r1 = await satori.getCurrentRound();
    await registry.setValue(user, 100);
    await satori.flushDefaultStream();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: user, payload: pack1(UP) }]);
    await fill(1, 100);
    // deployedPower(R1) = alice(20) + bob(20) + 1 funded filler(20) = 60.

    // R2..R4: keep committed CAPITAL rising so C > B. `user` is a normal PUBLIC
    // stream (cadence 2), so it produces every OTHER round — writing it at R2
    // would trip CadenceRoundsNotElapsed. Only the default's deployedPower has to
    // move every round, and the funded cadence-1 fillers supply that.
    await advanceRound();
    await satori.flushDefaultStream();
    await fill(4, 110); // deployedPower(R2) = 4 funded fillers(20) = 80 > 60 => alice's UP wins

    await advanceRound();
    await registry.setValue(user, 120); // one full cadence period after the R1 write
    await satori.flushDefaultStream();
    await fill(6, 120); // deployedPower(R3) = 6 funded fillers(20) = 120 (keeps the ramp rising)

    await advanceRound();
    await satori.flushDefaultStream();

    const dv = await voting.getGameVotesAtRound(DEFAULT_ID, r1);
    const total = await voting.roundDenominator(r1);
    expect(dv).to.equal(ethers.parseEther("1"));    // on the floor
    expect(total).to.equal(ethers.parseEther("11")); // 10 burnt + 1 floored
    // The structural claim: the floored default is exactly 1/11 of the round.
    expect(dv * DEFAULT_SHARE_DIVISOR).to.equal(total);

    const before = await getClaimable(lens, alice.address);
    const marketingBefore = await getMarketingBucket(satori);
    await satori.settlePrediction(alice.address, DEFAULT_ID);
    const predReward = (await getClaimable(lens, alice.address)) - before;
    const predCut = (await getMarketingBucket(satori)) - marketingBefore;
    expect(predReward).to.be.gt(0n);

    // The predictor's reward is credited through the referral chokepoint, so 5%
    // is skimmed to the marketing bucket at credit time. Reconstruct the GROSS
    // and pin it to the nominal allocation — no cut, no bonus, no residue.
    const nominal = (BUDGET * dv) / total;
    expect(nominal).to.equal(BUDGET / DEFAULT_SHARE_DIVISOR);
    expect(predCut).to.equal((predReward + predCut) * 500n / 10000n); // skim is floor(gross*5%)
    expect(predReward + predCut).to.be.closeTo(nominal, ethers.parseEther("0.0001"));
  });

  // GAP (med): default_activeVotes_counted_once_per_round.
  // The old mechanism folded the default into the denominator through
  // accrueDefaultStreamCut, and the risk was a second, defensive path
  // double-counting it. The accumulator replaced both paths with ONE branch in
  // recordGameVotesForRound, so the property is now directly checkable: every
  // game that was predicted appears in the round's participating set exactly
  // once, and Σ numerators == the denominator, however many predictors show up.
  it("counts every game — the default included — exactly once in the round denominator", async function () {
    const { satori, voting, registry, signers } = await setup();
    const [owner, alice, carol, dave, erin] = signers;
    await satori.transfer(alice.address, ethers.parseEther("40"));
    await satori.transfer(carol.address, ethers.parseEther("20"));
    await satori.transfer(dave.address, ethers.parseEther("20"));
    await satori.transfer(erin.address, ethers.parseEther("20"));

    // Two user games, both burnt to 10 -> total burnt 20. The default's 1%
    // derivation of that (20 * 100/9900 ≈ 0.202) is under the 1e18 floor, so the
    // default sits ON its floor at weight 1.
    const a = await streamIdFrom(await satori.createSimpleDataStream("A", owner.address), satori);
    const b = await streamIdFrom(await satori.createSimpleDataStream("B", owner.address), satori);
    await voteFor(satori, carol, a, ethers.parseEther("10"));
    await voteFor(satori, dave, b, ethers.parseEther("10"));
    expect(await voting.defaultDerivedWeight()).to.equal(ethers.parseEther("1"));

    await advanceRound();
    const r = await satori.getCurrentRound();
    await registry.setValue(a, 100);
    await registry.setValue(b, 100);
    await satori.flushDefaultStream();

    // alice predicts BOTH user games in one batch; erin predicts the default.
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: a, payload: pack1(UP) },
      { gameId: b, payload: pack1(UP) },
    ]);
    await satori.connect(erin).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);

    // More predictors on the SAME games must not re-add anything.
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: a, payload: pack1(UP) }]);
    await satori.connect(dave).predictMultipleWithPayloads([{ gameId: DEFAULT_ID, payload: pack1(UP) }]);

    const participating = await voting.getEligibleGamesAtRound(r);
    const ids = participating.map(Number);
    expect(new Set(ids).size, "no game recorded twice").to.equal(ids.length);
    expect(ids.filter((g) => g === DEFAULT_ID).length, "default counted exactly once").to.equal(1);
    expect(ids.sort((x, y) => x - y)).to.deep.equal([DEFAULT_ID, a, b].sort((x, y) => x - y));

    // Σ numerators == denominator, exactly (the two are written in one branch).
    let sum = 0n;
    for (const g of ids) sum += await voting.getGameVotesAtRound(g, r);
    await advanceRound();
    const denom = await voting.roundDenominator(r);
    expect(sum).to.equal(denom);
    expect(denom).to.equal(ethers.parseEther("21")); // 10 + 10 + 1 floored default
  });

  // GAP (med): the denominator may not be read while the round is still open.
  // The accumulator grows as each game's first predictor arrives, so a mid-round
  // read is a PARTIAL sum and every share computed against it would be too big.
  // (This is the accumulator's replacement for the old round-totals lock.)
  it("refuses to serve the denominator for a round that is still open", async function () {
    const { satori, voting } = await setup();
    const r = await satori.getCurrentRound();
    await expect(voting.roundDenominator(r))
      .to.be.revertedWithCustomError(voting, "RoundNotFinal");
    await advanceRound();
    await expect(voting.roundDenominator(r)).to.not.be.reverted;
  });

  // GAP (med): the default stream's value is written by the core alone.
  // setValue() never runs for the default stream (its provider is the hub), so
  // no external caller can inject a value and manufacture a win on it.
  it("setValue on the default stream reverts for any external caller", async function () {
    const { registry, signers } = await setup();
    const [owner, alice] = signers;
    await expect(registry.connect(owner).setValue(DEFAULT_ID, 5))
      .to.be.revertedWithCustomError(registry, "NotStreamProvider");
    await expect(registry.connect(alice).setValue(DEFAULT_ID, 5))
      .to.be.revertedWithCustomError(registry, "NotStreamProvider");
  });

  // The default game is structurally unpurchasable and unkillable: its weight is
  // derived, so buying it would double-count, and disabling it would erase the
  // protocol's baseline game. Both are hard reverts, not conventions.
  it("the default game can be neither voted on nor disabled", async function () {
    const { satori, voting, signers } = await setup();
    const [owner, alice] = signers;
    await satori.transfer(alice.address, ethers.parseEther("20"));
    await expect(satori.connect(alice).vote(DEFAULT_ID, ethers.parseEther("1")))
      .to.be.revertedWithCustomError(voting, "CannotVoteDefault");
    // owner is the rewards admin in the fixture, so this is the authorized caller
    // failing on the default-specific guard, not on the role check.
    await expect(voting.connect(owner).setGameApproved(DEFAULT_ID, false))
      .to.be.revertedWithCustomError(voting, "CannotSetDefaultApproval");
  });
});

// Read a user's total claimable SATORI from the read-only rewards lens
// (getTotalClaimableRewards moved from SatoriRewards to SatoriRewardsLens;
// the fixture deploys and returns the lens).
async function getClaimable(lens, who) {
  return lens.getTotalClaimableRewards(who).then((r) => r[0]);
}

// Eager-credit skim (referral-eager-credit): every reward credit routes
// REFERRAL_BPS (5%) into the earner's referrer bucket, or — for an unset/self
// referral, which is the case for every earner in these tests — into
// MARKETING_FEE_RECIPIENT's unclaimedRewards bucket. Reading that bucket's
// delta lets us reconstruct the gross (pre-skim) reward so conservation stays
// EXACT: earner_net + marketing_cut == original_amount.
async function getMarketingBucket(satori) {
  const rewardsAddr = await satori.satoriRewards();
  const rewards = await ethers.getContractAt("SatoriRewards", rewardsAddr);
  const marketing = await rewards.marketingFeeRecipient();
  return rewards.unclaimedRewards(marketing);
}
