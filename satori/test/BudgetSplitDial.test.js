/**
 * BUDGET-SPLIT DIAL (Phase 1) — the on-chain reward slice scales with
 * `SatoriRewards.offchainBudget`.
 *
 * onChainGross = emissionRateNow − devRateNow − offchainBudget. The senior dev
 * fee (a flat 15% of the emission) is carved out first, leaving the RESIDUAL —
 * and the on-chain game budget is that residual less the dial. The whole on-chain
 * slice is payable to predictors: the first-predictor bonus reservation and
 * the value-provider cut are both gone, and the platform fee moved to the
 * immutable token (off-budget here; see test/next/DevFee.test.js).
 * Conservation: every round, the predictor pool == onChainGross exactly.
 * offchainBudget=0 gives gross == the residual; these tests exercise
 * offchainBudget > 0, setting the dial to RESIDUAL − targetGross.
 *
 * Every figure here is DERIVED from the hub's live rate. The file used to be
 * written in terms of 1440/288/1152 — the emission is the hub's schedule now and
 * decays, so a literal round budget is a value that silently goes stale.
 *
 * The dial is read exactly ONCE per round (frozen at the round's first touch), so
 * a mid-round change never rewrites an in-flight round. It's floored strictly
 * below the residual so the on-chain gross is >= 1 wei.
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, RAW_TOLERANCE, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
// The value-provider cut is gone, so the 4-arg overload that carried its bps
// no longer exists — cadence is the last stream parameter.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const E = (n) => ethers.parseEther(String(n));

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
  return satori.interface.parseLog(ev).args.streamId;
}

describe("Budget-split dial (Phase 1) — on-chain slice scales with offchainBudget", function () {
  let satori, rewards, registry, lens;
  let owner, alice, bob, platform;
  // The per-round emission net of the dev fee: the whole of what the dial splits.
  let RESIDUAL;

  beforeEach(async function () {
    // Zero-platform-fee stack so the on-chain slice math is exactly gross − bonus.
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, rewards, registry, lens } = fix);
    owner = fix.owner;
    alice = fix.signers[1];
    bob = fix.signers[2];
    // The rewards admin / platform-fee recipient is the fixture owner, so the
    // setOffchainBudget authority (msg.sender == admin) is owner.
    platform = owner;
    await satori.transfer(alice.address, E(100));
    await satori.transfer(bob.address, E(100));
    RESIDUAL = (await satori.emissionRateNow()) - (await satori.devRateNow());
    await advanceRound();
  });

  // A solo predictor earns the WHOLE on-chain slice: the predictor pool IS the
  // gross now (no bonus reservation, no provider cut). Under eager referral
  // credit the 5% REFERRAL_BPS cut is skimmed off that pool at credit time and,
  // because alice has no referral, routed to MARKETING_FEE_RECIPIENT's unclaimed
  // bucket. Alice's claim mints only her own net; the skim stays claimable by
  // marketing. So the slice is conserved EXACTLY as:
  // alice_claimed + marketing_bucket == gross.
  // Returns both halves so callers can assert that exact conservation.
  // Takes the TARGET GROSS and works the dial back from it, rather than taking a
  // dial figure that only means something against a fixed round budget.
  async function soloTotalAtGross(gross) {
    await rewards.connect(platform).setOffchainBudget(RESIDUAL - gross); // effective NEXT round (current round stays at the old dial)
    await advanceRound();                         // step into the round the new dial governs
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);            // first touch → gross frozen at the new dial
    await satori.connect(alice).vote(sid, VOTE);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await advanceRound(); await registry.setValue(sid, 110);
    await advanceRound(); await registry.setValue(sid, 120);
    await satori.settlePrediction(alice.address, sid);
    const before = await satori.balanceOf(alice.address);
    await satori.connect(alice).claim();
    const claimed = (await satori.balanceOf(alice.address)) - before;
    const marketing = await rewards.unclaimedRewards(await rewards.marketingFeeRecipient());
    return { claimed, marketing };
  }

  it("dial set to half the residual → the on-chain slice is half (whole gross payable, 5% pool cut to marketing)", async function () {
    const gross = RESIDUAL / 2n;
    const { claimed, marketing } = await soloTotalAtGross(gross);
    // Conservation: alice's net claim + the skimmed marketing bucket == the gross.
    expect(claimed + marketing).to.equal(gross);
    // The skim is 5% of the pool, and the pool is now the FULL gross.
    expect(marketing).to.be.closeTo(gross / 20n, RAW_TOLERANCE);
  });

  it("dial set to three quarters of the residual → the on-chain slice is a quarter", async function () {
    const gross = RESIDUAL / 4n;
    const { claimed, marketing } = await soloTotalAtGross(gross);
    // Conservation: alice's net claim + the skimmed marketing bucket == the gross.
    expect(claimed + marketing).to.equal(gross);
    // The skim is 5% of the pool, and the pool is now the FULL gross.
    expect(marketing).to.be.closeTo(gross / 20n, RAW_TOLERANCE);
  });

  it("functional true zero at the 1-wei floor (dial = RESIDUAL − 1): no revert, the whole 1-wei gross is the payout", async function () {
    await rewards.connect(platform).setOffchainBudget(RESIDUAL - 1n); // effective NEXT round: gross = 1 wei (dev fee carved out)
    await advanceRound();                                               // step into the round the dial governs
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);            // must NOT revert at gross 1 wei
    await satori.connect(alice).vote(sid, VOTE);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    await advanceRound(); await registry.setValue(sid, 110);
    await advanceRound(); await registry.setValue(sid, 120);
    await expect(satori.settlePrediction(alice.address, sid)).to.not.be.reverted; // 1-wei budget collapses cleanly
    // The gross IS 1 wei and the whole of it is payable (no bonus reservation,
    // no provider cut), so the sole predictor takes exactly 1 wei — the 5%
    // referral skim of 1 wei rounds to 0, leaving nothing for marketing.
    expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(1n);
    expect(await rewards.unclaimedRewards(await rewards.marketingFeeRecipient())).to.equal(0n);
  });

  it("the freeze holds: a mid-round dial change does not rewrite the current round", async function () {
    await rewards.connect(platform).setOffchainBudget(0);          // gross == the residual
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);                             // freezes the full residual for round R
    await satori.connect(alice).vote(sid, VOTE);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    // mid-round R: crank the dial to two thirds — must NOT touch round R (already frozen).
    await rewards.connect(platform).setOffchainBudget((RESIDUAL * 2n) / 3n);
    await advanceRound(); await registry.setValue(sid, 110);       // R+1 freezes the reduced gross
    await advanceRound(); await registry.setValue(sid, 120);
    await satori.settlePrediction(alice.address, sid);
    const before = await satori.balanceOf(alice.address);
    await satori.connect(alice).claim();
    const claimed = (await satori.balanceOf(alice.address)) - before;
    const marketing = await rewards.unclaimedRewards(await rewards.marketingFeeRecipient());
    // R was frozen at the FULL residual → the whole slice is conserved there,
    // despite the mid-round crank. Under eager referral credit the 5% pool cut is
    // skimmed to marketing, so alice's net claim + marketing == the residual.
    // That the total lands on the residual (and marketing on 5% of it) rather
    // than on the mid-round third IS the freeze.
    expect(claimed + marketing).to.equal(RESIDUAL);
    // The skim is 5% of the full pool; the frozen gross drives it, not the crank.
    expect(marketing).to.be.closeTo(RESIDUAL / 20n, RAW_TOLERANCE);
  });

  it("setOffchainBudget: admin-only and floored strictly below emissionRate − devRate", async function () {
    await expect(rewards.connect(alice).setOffchainBudget(0))
      .to.be.revertedWithCustomError(rewards, "Unauthorized");
    await expect(rewards.connect(platform).setOffchainBudget(RESIDUAL))     // gross would be 0
      .to.be.revertedWithCustomError(rewards, "BadInput");
    await expect(rewards.connect(platform).setOffchainBudget(RESIDUAL - 1n)).to.not.be.reverted;
    expect(await rewards.offchainBudget()).to.equal(RESIDUAL - 1n);
  });
});
