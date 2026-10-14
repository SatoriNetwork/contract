/**
 * Adversarial regression guard — PER-SLOT "boosted" bit independence.
 *
 * The per-game `gameHasBounty` gate is GONE. Bounty score-time credit is now
 * gated PER-PREDICTION by a "boosted" bit packed into the prediction slot
 * header (bit 252 for slot A / 253 for slot B). At predict, `applyBoost`
 * returns true iff it wrote >=1 snapshot; the core records that in the slot's
 * boosted bit. At settle, the core reads THAT slot's bit and passes it as
 * `wasBoosted` to `SatoriRewards.scoreCorrectPrediction`, which cross-calls
 * `creditBountyForWin` ONLY when `wasBoosted`.
 *
 * THREAT this test hunts: cross-contamination of the two header bits. For ONE
 * (user, game) the 2-slot ring can hold a BOOSTED prediction (snapshot taken
 * while the pool was live + the user staked + multiplier>0) and a NON-boosted
 * one (no snapshot — predicted with multiplier 0, or while no pool was funded)
 * simultaneously pending. Each must settle on ITS OWN bit:
 *   - the BOOSTED prediction captures its round pot and PAYS its share (>0),
 *   - the NON-boosted prediction does ZERO bounty work: its round pot stays 0,
 *     it credits 0, and it never reads/drains the other slot's pot.
 * If a non-boosted prediction triggers a payout, or a boosted one pays nothing,
 * the bits are cross-wired — that is a BUG.
 *
 * Both slot orderings are exercised:
 *   CASE 1 (forward): boosted lands in slot A (idx 0, the first-ever predict),
 *                     non-boosted in slot B (idx 1, a later multiplier-0 predict
 *                     made while the pool was STILL LIVE and the user STILL
 *                     staked — so only the missing multiplier, i.e. the missing
 *                     snapshot, keeps it unpaid).
 *   CASE 2 (reverse): non-boosted lands in slot A (predicted before any pool was
 *                     funded), boosted in slot B (predicted after funding+stake
 *                     with a streak>=2 multiplier).
 *
 * NOTE: `settlePrediction` settles BOTH ring slots in one call (its impl==0
 * branch loops twice), so per-slot isolation is asserted on durable state —
 * each round's `roundBountyPot` and the resulting `bountyStake` delta — not on
 * a per-call diff. The non-boosted round's pot staying exactly 0 is the precise
 * proof its bit never fired the credit path.
 *
 * Property HOLDS -> GREEN (permanent guard). A failing assertion here is a real
 * cross-contamination bug; report it, don't contort the test.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak , voteFor } = require("../fixtures");

const UP = 1;
const E = (n) => ethers.parseEther(n);

async function advanceOneDay() { await time.increase(86400); }

async function deployMockToken(sym) {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

// Stream cadence floor: a PUBLIC caller may only create streams with
// round-length (>= 1440 minute) cadence; sub-round streams are admin-only. This
// test's subject is bounty pool/drip/stake mechanics, not stream rhythm, so it
// keeps the fast (720-minute, sub-round) beat by having the ADMIN (`owner`)
// create the stream. `authority` stays the stream's PROVIDER, so
// it is still the account that writes values.
async function createStream(satori, signer, name, authority) {
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 720);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

// One full correct ABC cycle that SETTLES the prediction (used to ratchet a
// streak up between independent predictions). `base` seeds three ascending
// values so an UP prediction wins. Returns nothing; advances time 2 days.
async function predictWinSettle(satori, registry, authority, user, game, base) {
  await registry.connect(authority).setValue(game, base);
  await satori.connect(user).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
  await advanceOneDay();
  await registry.connect(authority).setValue(game, base + 10); // B
  await advanceOneDay();
  await registry.connect(authority).setValue(game, base + 20); // C -> UP correct
  await satori.settlePrediction(user.address, game);
}

describe("adv — per-slot boosted bit: boosted slot pays, non-boosted slot is a no-op (both orderings)", function () {
  this.timeout(300000);

  let satori, rewards, bounties, registry, owner, token;
  let alice, funder, authority;
  let usd, usdAddr, feeRecipient;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner, token } = fix);
    [, alice, funder, authority] = fix.signers;

    await satori.transfer(alice.address, E("100"));
    await satori.transfer(funder.address, E("100"));
    await satori.transfer(authority.address, E("100"));

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, E("1000000"));
    await usd.connect(funder).approve(await bounties.getAddress(), E("1000000"));

    // Platform fee moved to the immutable token (its senior dev fee).
    feeRecipient = await token.PLATFORM_FEE_RECIPIENT();
  });

  it("CASE 1 (forward): boosted slot A pays its pot; non-boosted slot B (live pool, no snapshot) is a clean no-op", async function () {
    const game = await createStream(satori, owner, "FWD", authority.address);
    // audit C-2: streak 0 pays flat dust and takes no bounty boost — warm to streak >= 1
    await warmUpStreak(satori, registry, authority, [alice], game);
    await voteFor(satori, alice, game);

    // Long-lived pool: 1000/round-rate=100 so it drips 100/round across many
    // rounds (does NOT drain in one round). Alice stakes the bounty token.
    await bounties.connect(funder).fundBounty(game, usdAddr, E("1000"), E("100"));
    await stakeFor(bounties, alice, usd, E("100"));

    // ---- BOOSTED prediction -> slot A (idx 0, first-ever => multiplier 1). ----
    await registry.connect(authority).setValue(game, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const rBoost = await satori.getCurrentRound();

    // Snapshot proves applyBoost wrote (=> the slot-A boosted bit is set).
    const snapBoost = await bounties.boostStakeForPrediction(alice.address, game, rBoost, usdAddr);
    expect(snapBoost, "boosted predict must have a non-zero predict-time snapshot").to.be.gt(0n);
    expect(await bounties.boostedTokenCountInRound(alice.address, rBoost)).to.equal(1n);

    // ---- NON-boosted prediction -> slot B (idx 1). Made one round later while
    //      the pool is STILL LIVE, but alice UNSTAKES first so her boost is 0 =>
    //      applyBoost writes no snapshot => the slot-B boosted bit stays 0. Slot A
    //      stays pending (only its B-value exists, no C yet) so both coexist in
    //      the ring.
    //
    //      This used to be produced by predicting at streak 0 as a NON-first
    //      predict, which scored multiplier 0 and made applyBoost early-return.
    //      Audit C-2 made streak-0 dust flat for everyone, so that route is gone
    //      (and the inconsistency it relied on with it). Unstaking is the honest
    //      way to get a live-pool, no-snapshot slot — and it doubles as proof
    //      that slot A's ALREADY-CAPTURED snapshot survives the unstake. ----
    await advanceOneDay();
    await bounties.connect(alice).unstakeBountyToken(usdAddr, await bounties.bountyStake(alice.address, usdAddr), alice.address);
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);
    await registry.connect(authority).setValue(game, 110); // B for the slot-A predict
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const rPlain = await satori.getCurrentRound();
    expect(rPlain).to.not.equal(rBoost);

    // The non-boosted predict took NO snapshot despite a live pool + live stake.
    const snapPlain = await bounties.boostStakeForPrediction(alice.address, game, rPlain, usdAddr);
    expect(snapPlain, "non-boosted predict must have a ZERO snapshot (no boost write)").to.equal(0n);
    expect(await bounties.boostedTokenCountInRound(alice.address, rPlain)).to.equal(0n);

    // Both predictions still pending in the ring (neither scored yet).
    expect((await satori.predictions(alice.address, game, rBoost)).scored).to.equal(false);
    expect((await satori.predictions(alice.address, game, rPlain)).scored).to.equal(false);

    // ---- Drive both to CORRECT (ascending values => UP wins for each). ----
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120); // C for A, B for B
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 130); // C for B

    // ---- Settle. One call settles both ring slots. ----
    const stakeBefore = await bounties.bountyStake(alice.address, usdAddr);
    await expect(satori.settlePrediction(alice.address, game)).to.not.be.reverted;

    // Both now scored.
    expect((await satori.predictions(alice.address, game, rBoost)).scored).to.equal(true);
    expect((await satori.predictions(alice.address, game, rPlain)).scored).to.equal(true);

    const potBoost = await bounties.roundBountyPot(game, rBoost, usdAddr);
    const potPlain = await bounties.roundBountyPot(game, rPlain, usdAddr);

    // PER-SLOT PROOF #1: the boosted round's pot was captured (the boosted bit
    // fired creditBountyForWin -> _dripTokenForRound).
    expect(potBoost, "boosted round pot must have been dripped").to.equal(E("100"));
    // PER-SLOT PROOF #2: the NON-boosted round's pot is EXACTLY 0 — its bit never
    // fired the credit path, so no drip ever captured a pot for that round. This
    // is the precise no-cross-contamination signature.
    expect(potPlain, "non-boosted round pot must stay 0 (its bit never fired)").to.equal(0n);

    // PER-SLOT PROOF #3: alice (sole staker) is paid the boosted pot in full via
    // auto-compounded bountyStake, and NOT a penny more (the non-boosted slot
    // added nothing).
    const earned = (await bounties.bountyStake(alice.address, usdAddr)) - stakeBefore;

    expect(earned, "boosted slot must pay (>0)").to.be.gt(0n);
    // Sole staker => share == full pot. The bounty PAYOUT fee is removed, so the
    // winner receives the ENTIRE pot.
    expect(earned, "boosted payout = full pot (no payout fee)").to.equal(E("100"));
    // Conservation: the whole boosted pot drained to alice.
    expect(earned).to.equal(potBoost);
  });

  it("CASE 2 (reverse): non-boosted slot A (predicted pre-funding) is a no-op; boosted slot B pays its pot", async function () {
    const game = await createStream(satori, owner, "REV", authority.address);
    await voteFor(satori, alice, game);

    // ---- Ratchet alice's streak to >=2 with NO bounty funded (so these
    //      warm-up predicts are unboosted) and SETTLE each so both ring slots
    //      end terminal/free before the real per-slot scenario. ----
    await predictWinSettle(satori, registry, authority, alice, game, 100); // streak 0->1
    await advanceOneDay();
    await predictWinSettle(satori, registry, authority, alice, game, 200); // streak 1->2
    await advanceOneDay();
    await predictWinSettle(satori, registry, authority, alice, game, 300); // streak 2->3
    expect(await satori.streaks(alice.address, game)).to.be.gte(2n);

    // ---- NON-boosted prediction -> slot A. Predicted BEFORE any pool exists,
    //      so applyBoost short-circuits on the empty funded-token list: NO
    //      snapshot, slot-A boosted bit = 0. ----
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 400);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const rPlain = await satori.getCurrentRound();
    const snapPlain = await bounties.boostStakeForPrediction(alice.address, game, rPlain, usdAddr);
    expect(snapPlain, "pre-funding predict must have a ZERO snapshot").to.equal(0n);
    expect(await bounties.boostedTokenCountInRound(alice.address, rPlain)).to.equal(0n);

    // ---- NOW fund the pool + alice stakes. ----
    await bounties.connect(funder).fundBounty(game, usdAddr, E("1000"), E("100"));
    await stakeFor(bounties, alice, usd, E("100"));

    // ---- BOOSTED prediction -> slot B. Predicted with a live pool + stake and
    //      a streak>=2 multiplier => applyBoost writes a snapshot => slot-B
    //      boosted bit = 1. Slot A stays pending (its C value not written yet). ----
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 410); // B for the slot-A predict
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const rBoost = await satori.getCurrentRound();
    expect(rBoost).to.not.equal(rPlain);
    const snapBoost = await bounties.boostStakeForPrediction(alice.address, game, rBoost, usdAddr);
    expect(snapBoost, "boosted predict must have a non-zero snapshot").to.be.gt(0n);
    expect(await bounties.boostedTokenCountInRound(alice.address, rBoost)).to.equal(1n);

    // Both pending in the ring.
    expect((await satori.predictions(alice.address, game, rPlain)).scored).to.equal(false);
    expect((await satori.predictions(alice.address, game, rBoost)).scored).to.equal(false);

    // ---- Drive both to CORRECT. ----
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 420); // C for A, B for B
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 430); // C for B

    const stakeBefore = await bounties.bountyStake(alice.address, usdAddr);
    await expect(satori.settlePrediction(alice.address, game)).to.not.be.reverted;

    expect((await satori.predictions(alice.address, game, rPlain)).scored).to.equal(true);
    expect((await satori.predictions(alice.address, game, rBoost)).scored).to.equal(true);

    const potBoost = await bounties.roundBountyPot(game, rBoost, usdAddr);
    const potPlain = await bounties.roundBountyPot(game, rPlain, usdAddr);

    // PER-SLOT PROOFS, reversed ordering: slot-B boosted bit captured + paid its
    // pot; slot-A non-boosted bit never fired -> its round pot stays exactly 0.
    expect(potBoost, "boosted (slot B) round pot must be dripped").to.equal(E("100"));
    expect(potPlain, "non-boosted (slot A) round pot must stay 0").to.equal(0n);

    const earned = (await bounties.bountyStake(alice.address, usdAddr)) - stakeBefore;

    expect(earned, "boosted slot must pay (>0)").to.be.gt(0n);
    // Payout fee removed: winner gets the full pot.
    expect(earned, "boosted payout = full pot (no payout fee)").to.equal(E("100"));
    expect(earned).to.equal(potBoost);
  });
});
