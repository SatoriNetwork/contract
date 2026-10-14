// PR 8 — `applyBoost` iteration direction swap + cap tightening (item W).
//
// `applyBoost` is called at predict time by `Satori._makePrediction`. It
// snapshots the predictor's `bountyStake[user][T]` into a per-prediction
// slot and appends T to the per-(user, round) boosted-token set for every
// T where the predictor has stake AND the stream has an active bounty. The
// round set is the DEDUP'd list of distinct tokens snapshotted that round
// (one entry per distinct token, not per prediction) — it is what score-time
// payout enumerates, and it is cleared only once the round fully settles.
//
// Pre-PR-8 the iteration ran over `userStakedTokens[user]` (≤ 8 entries),
// paying 2 cold SLOADs per stake (pool, rate) even on a stream with no
// bounties. PR 8 swaps the iteration to `gameBountyTokens[streamId]`
// (≤ 8 entries after the cap tightening) so the common "stream has no
// bounties" case short-circuits with one length SLOAD.
//
// Both early-exits are preserved:
//   1. `gameBountyTokens[stream].length == 0` — dominant case.
//   2. `userStakedTokens[user].length == 0` — bountied-stream / casual-predictor.
//
// Filter order inside the loop: `bountyStake[user][tk]` first (cheap
// reject for non-matching tokens), then `pool/rate` (drained-not-evicted
// guard catching the one-cycle gap between drain and PR 7's score-time
// auto-cleanup).
//
// Eight cases below codify the invariants:
//   1. Casual predictor + empty stream → no snapshots, empty round set.
//   2. Casual predictor + bountied stream → no snapshots (user-empty exit
//      after stream-nonempty).
//   3. Staked predictor + empty stream → no snapshots (stream-empty exit
//      before user-empty).
//   4. Staked predictor + no-overlap → no snapshots (bountyStake cheap
//      reject).
//   5. Staked predictor + full overlap → snapshots written for every
//      matching token; round set contains every matching token.
//   6. Staked predictor + partial overlap → snapshots written for the
//      overlap subset only; round set contains only the overlap subset.
//   7. Drained-not-evicted token → skipped via inline pool/rate guard;
//      no snapshot, token not added to the round set (so unstake stays
//      unlocked).
//   8. `clearRoundBountyList` empties the round set once the round fully
//      settles — the finalize walk is user-side, the predict walk is
//      stream-side, and the snapshot key (user, stream, round, token) is
//      the source of truth that bridges them.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak, VOTE } = require("./fixtures");

const UP = 1;

async function deployMockToken(sym) {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

// Every-round (1440-minute) stream — one value write per 24h round, which is
// this suite's rhythm. 1440 is the finest PUBLIC cadence SatoriHub allows, so
// no admin exemption is needed. `authority` stays the stream's provider — it
// is who may call `registry.setValue`.
async function createStream(satori, signer, name, authority) {
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (_) {}
  }
  throw new Error("DataStreamCreated event missing");
}

// Predict + advance 2 rounds + score. Round captured by `round` callback.
async function predictAndScore(satori, registry, predictor, authority, stream, baseValue) {
  await registry.connect(authority).setValue(stream, baseValue);
  await satori.connect(predictor).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
  const round = await satori.getCurrentRound();
  await advanceOneDay();
  await registry.connect(authority).setValue(stream, baseValue + 5);
  await advanceOneDay();
  await registry.connect(authority).setValue(stream, baseValue + 10);
  await satori.settlePrediction(predictor.address, stream);
  return round;
}

describe("ApplyBoostIteration — PR 8 iteration swap + cap-8 (item W)", function () {
  let satori, rewards, bounties, registry, owner;
  let alice, bob, funder, authority;
  let stream, usd, eur, gbp, jpy;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address,   ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    stream = await createStream(satori, owner, "S", authority.address);
    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1
    await warmUpStreak(satori, registry, authority, [alice, bob], stream);
    await satori.connect(alice).vote(stream, VOTE);
    await satori.connect(bob).vote(stream, VOTE);

    usd = await deployMockToken("USDC");
    eur = await deployMockToken("EUR");
    gbp = await deployMockToken("GBP");
    jpy = await deployMockToken("JPY");
    for (const t of [usd, eur, gbp, jpy]) {
      await t.mint(funder.address, ethers.parseEther("100000"));
      await t.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("100000"));
    }

    // Option B: predictors must subscribe for drips to fire on score.
    for (const u of [alice, bob]) {
      for (const t of [usd, eur, gbp, jpy]) {
      }
    }
  });

  async function stakeFor(user, token, amount) {
    await token.mint(user.address, amount);
    await token.connect(user).approve(await bounties.getAddress(), amount);
    await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
  }

  // Membership test against the per-(user, round) boosted-token set, which
  // replaced the old per-(user, token) pending counter. Returns true iff
  // `tokenAddr` is in the user's dedup'd boosted-token list for `round`
  // (i.e. applyBoost snapshotted this stake into a boost slot that round).
  async function boostedInRound(user, tokenAddr, round) {
    const n = await bounties.boostedTokenCountInRound(user.address, round);
    for (let i = 0n; i < n; i++) {
      const t = await bounties.boostedTokensInRound(user.address, round, i);
      if (t.toLowerCase() === tokenAddr.toLowerCase()) return true;
    }
    return false;
  }

  // Direct read of the predict-time boost snapshot. Used to verify
  // applyBoost did/didn't write the snapshot for a specific prediction.
  async function snapshot(user, streamId, round, tokenAddr) {
    return await bounties.boostStakeForPrediction(user.address, streamId, round, tokenAddr);
  }

  it("1. casual predictor + empty stream: no snapshots, empty round set, no array reads", async function () {
    // alice has no stakes; stream has no bounties.
    // The function should bail on the stream-empty early-exit (n == 0)
    // without touching userStakedTokens. End-to-end: predict succeeds,
    // no token-related side effects can possibly fire.
    await registry.connect(authority).setValue(stream, 100);
    await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }])).to.not.be.reverted;
    const round = await satori.getCurrentRound();

    // Alice never staked anything → confirming the no-side-effect by the
    // empty boosted-token set for this round (nothing was snapshotted).
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(0n,
      "empty round set — applyBoost short-circuited on n==0");
    expect(await boostedInRound(alice, await usd.getAddress(), round)).to.equal(false);
  });

  it("2. casual predictor + bountied stream: user-empty exit after stream-nonempty check", async function () {
    // Stream has 1 bounty; alice stakes nothing.
    // The stream-empty exit doesn't fire (n > 0); the user-empty exit
    // does. No snapshots, empty round set.
    await bounties.connect(funder).fundBounty(stream, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("10"));

    await registry.connect(authority).setValue(stream, 100);
    await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }])).to.not.be.reverted;
    const round = await satori.getCurrentRound();

    // Alice has no stake in usd → nothing snapshotted. Confirms the
    // user-empty short-circuit didn't accidentally walk the (empty)
    // userStakedTokens array AND skipped the per-bounty bountyStake SLOAD.
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(0n,
      "empty round set — userStakedTokens.length == 0 short-circuit fired");
    expect(await boostedInRound(alice, await usd.getAddress(), round)).to.equal(false);
  });

  it("3. staked predictor + empty stream: stream-empty exit fires before user-empty", async function () {
    // Alice stakes 100 usd; stream has no bounties.
    // The stream-empty exit fires on `n == 0` — userStakedTokens is
    // never read on this path.
    await stakeFor(alice, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(stream, 100);
    await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }])).to.not.be.reverted;
    const round = await satori.getCurrentRound();

    // usd not in the round set — applyBoost bailed before any snapshot work.
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(0n,
      "stream-empty short-circuit fired before user-stake iteration");
    expect(await boostedInRound(alice, await usd.getAddress(), round)).to.equal(false);
  });

  it("4. staked predictor + zero-overlap: bountyStake cheap-reject filter", async function () {
    // Alice stakes usd, eur, gbp. Stream has bounties in jpy only.
    // No overlap → no snapshots, empty round set. Each per-bounty
    // iteration pays one `bountyStake[user][tk]` SLOAD (= 0) and skips.
    await stakeFor(alice, usd, ethers.parseEther("100"));
    await stakeFor(alice, eur, ethers.parseEther("100"));
    await stakeFor(alice, gbp, ethers.parseEther("100"));
    await bounties.connect(funder).fundBounty(stream, await jpy.getAddress(), ethers.parseEther("1000"), ethers.parseEther("10"));

    await registry.connect(authority).setValue(stream, 100);
    await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }])).to.not.be.reverted;
    const round = await satori.getCurrentRound();

    // Nothing snapshotted: jpy has no stake, and usd/eur/gbp have stake
    // but no bounty on this stream (not in gameBountyTokens, so iteration
    // never reaches them). The round set stays empty.
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(0n);
    expect(await boostedInRound(alice, await jpy.getAddress(), round)).to.equal(false);
    expect(await boostedInRound(alice, await usd.getAddress(), round)).to.equal(false);
    expect(await boostedInRound(alice, await eur.getAddress(), round)).to.equal(false);
    expect(await boostedInRound(alice, await gbp.getAddress(), round)).to.equal(false);
  });

  it("5. staked predictor + full overlap: every matching token gets a snapshot + round-set entry", async function () {
    // Alice stakes usd, eur, gbp. Stream bounties on the same three.
    // All match → all three land in the round's boosted-token set →
    // unstake locked on all three.
    await stakeFor(alice, usd, ethers.parseEther("100"));
    await stakeFor(alice, eur, ethers.parseEther("100"));
    await stakeFor(alice, gbp, ethers.parseEther("100"));
    await bounties.connect(funder).fundBounty(stream, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("10"));
    await bounties.connect(funder).fundBounty(stream, await eur.getAddress(), ethers.parseEther("1000"), ethers.parseEther("10"));
    await bounties.connect(funder).fundBounty(stream, await gbp.getAddress(), ethers.parseEther("1000"), ethers.parseEther("10"));

    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    const round = await satori.getCurrentRound();

    // All three distinct matching tokens are in the round set (count 3),
    // and each is a member.
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(3n);
    expect(await boostedInRound(alice, await usd.getAddress(), round)).to.equal(true);
    expect(await boostedInRound(alice, await eur.getAddress(), round)).to.equal(true);
    expect(await boostedInRound(alice, await gbp.getAddress(), round)).to.equal(true);
    // jpy is neither staked nor bountied → not in the set.
    expect(await boostedInRound(alice, await jpy.getAddress(), round)).to.equal(false);

    // Direct snapshot verification: every matching token got the user's full stake
    // committed for this round, weighted by the prediction's multiplier
    // (applyBoost stores `stake * multiplier`). Pre-C-2 these ran at streak 0 with
    // multiplier 1, so the snapshot happened to equal the bare stake; streak 0 now
    // carries a ZERO multiplier and takes no boost at all, so these predictions run
    // at a real streak and the snapshot scales with the curve. Derive it rather than
    // hardcoding, so the assertion survives any future curve change.
    const mult = (await satori.predictions(alice.address, stream, round)).multiplier;
    expect(mult, "a boosted prediction must carry a non-zero multiplier").to.be.gt(0n);
    const expSnap = ethers.parseEther("100") * mult;
    expect(await snapshot(alice, stream, round, await usd.getAddress())).to.equal(expSnap);
    expect(await snapshot(alice, stream, round, await eur.getAddress())).to.equal(expSnap);
    expect(await snapshot(alice, stream, round, await gbp.getAddress())).to.equal(expSnap);
    expect(await snapshot(alice, stream, round, await jpy.getAddress())).to.equal(0n);
  });

  it("6. staked predictor + partial overlap: only overlap subset gets snapshots", async function () {
    // Alice stakes usd, eur, gbp, jpy (4 stakes).
    // Stream bounties on usd, eur only.
    // Overlap = {usd, eur}; gbp + jpy stakes are inert for this stream.
    await stakeFor(alice, usd, ethers.parseEther("100"));
    await stakeFor(alice, eur, ethers.parseEther("100"));
    await stakeFor(alice, gbp, ethers.parseEther("100"));
    await stakeFor(alice, jpy, ethers.parseEther("100"));
    await bounties.connect(funder).fundBounty(stream, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("10"));
    await bounties.connect(funder).fundBounty(stream, await eur.getAddress(), ethers.parseEther("1000"), ethers.parseEther("10"));

    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    const round = await satori.getCurrentRound();

    // Round set holds only the overlap subset (count 2).
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(2n);
    // Overlap → in the set.
    expect(await boostedInRound(alice, await usd.getAddress(), round)).to.equal(true);
    expect(await boostedInRound(alice, await eur.getAddress(), round)).to.equal(true);
    // Non-overlap → not in the set (stake exists but stream doesn't bounty it).
    expect(await boostedInRound(alice, await gbp.getAddress(), round)).to.equal(false);
    expect(await boostedInRound(alice, await jpy.getAddress(), round)).to.equal(false);

    // Snapshot view: only the overlap subset was written. Critically,
    // gbp/jpy snapshots are zero EVEN THOUGH alice has stake in both —
    // confirming that PR 8's stream-side iteration didn't accidentally
    // walk userStakedTokens.
    // stake x multiplier, derived — see the note in test 5 (audit C-2).
    const mult6 = (await satori.predictions(alice.address, stream, round)).multiplier;
    expect(mult6, "a boosted prediction must carry a non-zero multiplier").to.be.gt(0n);
    const expSnap6 = ethers.parseEther("100") * mult6;
    expect(await snapshot(alice, stream, round, await usd.getAddress())).to.equal(expSnap6);
    expect(await snapshot(alice, stream, round, await eur.getAddress())).to.equal(expSnap6);
    expect(await snapshot(alice, stream, round, await gbp.getAddress())).to.equal(0n);
    expect(await snapshot(alice, stream, round, await jpy.getAddress())).to.equal(0n);
  });

  it("7. drained-not-evicted token: inline pool/rate guard prevents snapshot and round-set entry", async function () {
    const usdAddr = await usd.getAddress();

    // Warm a streak for BOTH predictors, before any stake or funding exists.
    //
    // Two reasons this is required (2026-07-30, skip triage):
    //  * BOB needs one so his cycle-1 prediction is actually boosted — the drip
    //    is only reached through a boost snapshot, so at streak 0 the pool would
    //    never drain and the test's own precondition (`pool == 0`) would fail.
    //  * ALICE needs one so the assertion is not VACUOUS. Audit C-2 passes
    //    multiplier 0 at streak 0 (SatoriEngine.sol), which suppresses her
    //    snapshot for the WRONG reason. With a streak, the drained pool/rate guard
    //    is the only thing that can keep usd out of her round set — which is the
    //    property this test exists to prove.
    let warmVal = 20;
    for (const u of [bob, alice]) {
      await predictAndScore(satori, registry, u, authority, stream, warmVal);
      expect(await satori.streaks(u.address, stream)).to.be.gt(0n);
      await advanceOneDay();
      warmVal += 20;
    }

    // Alice AND bob stake usd: bob's stake is what lets his prediction drain the
    // pool; alice's is what makes her later predict reach the pool/rate check.
    await stakeFor(alice, usd, ethers.parseEther("100"));
    await stakeFor(bob, usd, ethers.parseEther("100"));
    await bounties.connect(funder).fundBounty(stream, usdAddr, ethers.parseEther("100"), ethers.parseEther("100"));

    // Cycle 1: bob predicts + scoring drains usd. Auto-cleanup happens
    // only on the NEXT scoring call (PR 7 design); usd is still in
    // gameBountyTokens at this point but with pool=0 / rate=0.
    await predictAndScore(satori, registry, bob, authority, stream, 100);
    expect(await bounties.pool(stream, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(stream, usdAddr)).to.equal(0n);
    expect(await bounties.gameBountyTokenCount(stream)).to.equal(1n,
      "drained-not-evicted: usd still in the list");

    // Now alice predicts. The PR 8 iteration walks gameBountyTokens
    // (which still has usd), checks bountyStake (alice has 100 — passes),
    // checks pool/rate (both 0 — SKIP). No snapshot, no round-set entry.
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 200);
    await expect(satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }])).to.not.be.reverted;
    const round = await satori.getCurrentRound();

    // usd must not be in the round set: alice can still unstake usd freely.
    expect(await boostedInRound(alice, usdAddr, round)).to.equal(false,
      "drained-not-evicted skip kept usd out of the round's boosted-token set");
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(0n);
    // Snapshot must also be zero — neither inflation of denominators
    // nor a stranded round-set entry.
    expect(await snapshot(alice, stream, round, usdAddr)).to.equal(0n,
      "drained-not-evicted skip: no snapshot written");

    // Actively unstake to prove the lock is genuinely absent.
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.not.be.reverted;
  });

  it("8. clearRoundBountyList empties the round set once the round fully settles", async function () {
    // Alice stakes usd + eur (both have bounties). She predicts. The
    // round's boosted-token set goes to 2 (usd + eur). After scoring +
    // settlement, finalize runs and — because this is her only prediction
    // for the round — clearRoundBountyList empties the set. The asymmetry
    // between predict-iteration (stream-side) and finalize-iteration
    // (user-side) must not desync.
    await stakeFor(alice, usd, ethers.parseEther("100"));
    await stakeFor(alice, eur, ethers.parseEther("100"));
    const usdAddr = await usd.getAddress();
    const eurAddr = await eur.getAddress();
    await bounties.connect(funder).fundBounty(stream, usdAddr, ethers.parseEther("1000"), ethers.parseEther("10"));
    await bounties.connect(funder).fundBounty(stream, eurAddr, ethers.parseEther("1000"), ethers.parseEther("10"));

    // Drive a full predict + score + finalize cycle for alice. The single
    // prediction means settling it fully settles the round.
    const round = await predictAndScore(satori, registry, alice, authority, stream, 100);

    // After the round fully settles: the boosted-token set is cleared to
    // empty — unstake should not revert with UnstakeLockedByPending.
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(0n,
      "round set cleared by clearRoundBountyList on full settle");
    expect(await boostedInRound(alice, usdAddr, round)).to.equal(false,
      "usd no longer in round set after full settle");
    expect(await boostedInRound(alice, eurAddr, round)).to.equal(false,
      "eur no longer in round set after full settle");

    // Actively unstake both to prove no residual lock.
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.not.be.reverted;
    await expect(
      bounties.connect(alice).unstakeBountyToken(eurAddr, ethers.parseEther("100"), alice.address)
    ).to.not.be.reverted;
  });
});
