// Adversarial COVERAGE — bounty-staking subsystem.
//
// Targets the high/med-priority coverage gaps from the adversarial review
// that are NOT already pinned by a confirmed repro:
//
//   * (high) Conservation: Sigma(credited predictor shares) + Sigma(fees)
//     == dripped roundBountyPot for a round. Q59-Q62. No existing test
//     asserts the global conservation invariant directly; BountyShareStake
//     only checks the 2:1 stake ratio.
//   * (med) stakeLockedUntil monotonic non-decreasing across multi-round
//     predicts (the max() update on line 666-667). A later predict in a
//     higher round must RAISE the lock; a re-predict cannot LOWER it.
//   * (med) Unstake boundary at currentRound == stakeLockedUntil: the guard
//     is `stakeLockedUntil > currentRound`, so unstake must REVERT while
//     currentRound < lock and SUCCEED exactly when currentRound == lock.
//   * (med) Pot residue: a correct-direction staker whose prediction is
//     never settled keeps their boost in the denominator, so a settled
//     co-staker receives only pot*own/total (strictly less than the full
//     pot) and the residue stays in roundBountyPot with no drain path.
//
// The double-credit/two-games-on-one-stream finding (adv_13) is ALREADY
// confirmed with a kept repro — deliberately NOT re-tested here.
//
// All assertions reflect the DOCUMENTED intent (docs/narratives/
// A_bounty_staking.md), not the code's current output. Any failing
// assertion of intended behavior is a NEW bug and gets relocated.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak , voteFor } = require("../fixtures");

const UP = 1;

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

// Stream cadence floor: a PUBLIC caller may only create streams with
// round-length (>= 1440 minute) cadence; sub-round streams are admin-only. This
// test's subject is bounty pool/drip/stake mechanics, not stream rhythm, so it
// keeps the fast (720-minute, sub-round) beat by having the ADMIN (`owner`)
// create the stream. `authority` stays the stream's PROVIDER, so
// it is still the account that writes values.
async function createStream(satori, signer, name, authority) {
  // Fixture's Proxy wrapper auto-creates a paired binary game (gameId==streamId).
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 720);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

describe("COV bounty-staking: conservation, lock monotonicity/boundary, residue", function () {
  this.timeout(120000);

  let satori, bounties, registry, games, owner, rewards, token;
  let alice, bob, carol, funder, authority;
  let streamId, usd, usdAddr;
  let feeRecipient;

  const POT = ethers.parseEther("1000");
  const RATE = ethers.parseEther("200"); // virgin pool -> drip == RATE per scored round
  const TOL = ethers.parseEther("0.01");

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, bounties, registry, games, owner, rewards, token } = fix);
    [, alice, bob, carol, funder, authority] = fix.signers;

    // The platform fee moved to the immutable token (its senior dev fee); its
    // recipient is now token.PLATFORM_FEE_RECIPIENT(). The old bounty payout
    // skim is gone entirely, so no bounty fee accrues to this recipient.
    feeRecipient = await token.PLATFORM_FEE_RECIPIENT();

    for (const s of [alice, bob, carol, funder, authority]) {
      await satori.transfer(s.address, ethers.parseEther("100"));
    }

    streamId = await createStream(satori, owner, "S", authority.address);
    await voteFor(satori, alice, streamId);
    await voteFor(satori, bob, streamId);
    await voteFor(satori, carol, streamId);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, ethers.parseEther("100000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("100000"));
    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1.
    // Warm up BEFORE funding so the warm-up cycle cannot drip the pot.
    await warmUpStreak(satori, registry, authority, [alice, bob, carol], streamId);
    await bounties.connect(funder).fundBounty(streamId, usdAddr, POT, RATE);
  });

  // ----------------------------------------------------------------------
  // CONSERVATION (high): Sigma shares + Sigma fees == dripped pot
  // ----------------------------------------------------------------------
  it("conservation: sum of credited predictor shares + fees == dripped pot (single game, two stakers)", async function () {
    // Two honest stakers, both predict the SAME single game/stream/direction.
    await stakeFor(bounties, alice, usd, ethers.parseEther("300"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(streamId, 100); // anchor A

    const predictRound = Number(await satori.getCurrentRound());

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // Drive A-B-C so UP is correct.
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);

    await satori.settlePrediction(alice.address, streamId);
    await satori.settlePrediction(bob.address, streamId);

    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("300");
    const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - ethers.parseEther("100");

    // The pot that actually dripped for the predict round.
    const dripped = await bounties.roundBountyPot(streamId, predictRound, usdAddr);
    expect(dripped).to.equal(RATE); // virgin pool: rate == RATE, drip == RATE

    // Both stakers earned something.
    expect(aliceEarned).to.be.gt(0n);
    expect(bobEarned).to.be.gt(0n);

    // CONSERVATION: every unit of the dripped pot is accounted for as a
    // predictor share (the payout fee is gone). Nothing is created, nothing
    // vanishes.
    const totalCredited = aliceEarned + bobEarned;
    expect(totalCredited).to.be.closeTo(dripped, TOL);

    // And it must never EXCEED the pot (Q60: Sigma share <= pot).
    expect(totalCredited).to.be.lte(dripped + TOL);
  });

  // ----------------------------------------------------------------------
  // LOCK MONOTONICITY (med): stakeLockedUntil is non-decreasing across rounds
  // ----------------------------------------------------------------------
  // Un-deferred WITHOUT an adapter game, by design. The original used a FRESH
  // second binary game purely to get a multiplier-1 (first-prediction)
  // applyBoost snapshot in a strictly higher round — but a stream now auto-
  // creates its ONE binary game and a duplicate type-0 reverts
  // DuplicateBinaryGame. An adapter (type-1) game can't stand in here either:
  // bounties are deliberately type-0-binary-only (SatoriRewards.
  // _recordAdapterCommit), so an adapter predict never calls applyBoost — it
  // would take NO boost snapshot and could NOT move the per-token lock, which
  // is the exact property under test. So we drive the SAME single binary game
  // instead: build a winning streak so a LATER same-game predict in a strictly
  // higher round carries multiplier > 0, takes a fresh applyBoost snapshot, and
  // moves the per-token lock forward via the max() update (SatoriBounties.sol
  // ~line 770-772). Identical property, identical code path — minus the
  // now-illegal second binary game.
  it("stakeLockedUntil is monotonic non-decreasing across multi-round predicts (max update)", async function () {
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));

    // Round R0: first-ever predict on the game -> multiplier 1 -> applyBoost
    // snapshots and sets the per-token lock to R0+1.
    let v = 100;
    await registry.connect(authority).setValue(streamId, v);
    const r0 = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    expect(await bounties.stakeLockedUntil(alice.address, usdAddr)).to.equal(BigInt(r0 + 1));

    // Build a winning streak across several rounds: each round the stream value
    // rises (UP correct), so settling the prior predict wins and bumps Alice's
    // streak. Once streak >= 2 the streak multiplier is > 0, so the same-game
    // re-predict in that (strictly higher) round takes a fresh applyBoost
    // snapshot — the lock-moving condition the original test reached via a
    // brand-new game. Track the LAST round whose predict actually snapshotted.
    let r1 = 0;
    for (let k = 0; k < 6; k++) {
      await advanceOneDay();
      v += 10;
      await registry.connect(authority).setValue(streamId, v);
      // Settle the prior pending predict (wins -> streak++).
      await satori.settlePrediction(alice.address, streamId);
      const r = Number(await satori.getCurrentRound());
      const prevLock = await bounties.stakeLockedUntil(alice.address, usdAddr);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
      const lockNow = await bounties.stakeLockedUntil(alice.address, usdAddr);
      // Monotonicity holds on EVERY predict: the lock never decreases, whether
      // or not this round's predict snapshotted (multiplier 0 leaves it alone).
      expect(lockNow, `round ${r}: lock must never decrease`).to.be.gte(prevLock);
      // Did this predict snapshot (multiplier > 0)? If so it must have pushed
      // the lock to exactly r+1 via the max() update (r+1 > any prior lock).
      const snap = await bounties.boostStakeForPrediction(alice.address, streamId, r, usdAddr);
      if (snap > 0n) {
        expect(lockNow, `round ${r}: snapshot taken -> lock == r+1 via max()`).to.equal(BigInt(r + 1));
        r1 = r;
      }
    }

    // At least one higher-round predict must have snapshotted and moved the
    // lock forward, or the property was never actually exercised.
    expect(r1, "a higher-round predict must have snapshotted").to.be.greaterThan(r0);

    const lockAfter = await bounties.stakeLockedUntil(alice.address, usdAddr);
    // Intended: lock == max(prevLock, r1+1) == r1+1 here (r1+1 > r0+1).
    expect(lockAfter).to.equal(BigInt(r1 + 1));
    // Monotonicity end-to-end: the final lock is strictly forward of the first.
    expect(lockAfter).to.be.gt(BigInt(r0 + 1));
  });

  // ----------------------------------------------------------------------
  // UNSTAKE BOUNDARY (med): guard is `lock > currentRound`
  //   currentRound <  lock  -> revert StakeLocked
  //   currentRound == lock  -> succeeds
  // ----------------------------------------------------------------------
  it("unstake reverts while currentRound < lock and succeeds exactly when currentRound == lock", async function () {
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(streamId, 100);
    const r0 = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    const lock = await bounties.stakeLockedUntil(alice.address, usdAddr);
    expect(lock).to.equal(BigInt(r0 + 1));

    // currentRound (r0) < lock (r0+1) -> locked.
    expect(Number(await satori.getCurrentRound())).to.be.lessThan(Number(lock));
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.be.revertedWithCustomError(bounties, "StakeLocked");

    // Advance exactly one round so currentRound == lock.
    await advanceOneDay();
    expect(BigInt(await satori.getCurrentRound())).to.equal(lock);

    // currentRound == lock: guard is `lock > currentRound` => false => allowed.
    const balBefore = await usd.balanceOf(alice.address);
    await expect(
      bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address)
    ).to.not.be.reverted;
    expect((await usd.balanceOf(alice.address)) - balBefore).to.equal(ethers.parseEther("100"));
  });

  // ----------------------------------------------------------------------
  // POT RESIDUE (med): an unsettled correct-direction staker leaves their
  // boost in the denominator. The settled staker gets only pot*own/total,
  // strictly less than the full pot, and the residue stays in roundBountyPot
  // with no drain path.
  // ----------------------------------------------------------------------
  it("unsettled correct-direction staker leaves recoverable-free pot residue (settled staker gets only own share)", async function () {
    // Two equal stakers, both correct, both same stream/round/direction.
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(streamId, 100);
    const predictRound = Number(await satori.getCurrentRound());

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);

    // Settle ONLY alice. Bob's correct prediction is never settled, so his
    // boost stays in _totalBoostStakeByDirection (the denominator).
    await satori.settlePrediction(alice.address, streamId);

    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("100");
    const dripped = await bounties.roundBountyPot(streamId, predictRound, usdAddr);
    expect(dripped).to.equal(RATE);

    // Alice's denominator includes Bob's equal boost (total == 2x her boost),
    // so she receives only ~half the pot. The bounty PAYOUT fee is removed, so
    // she now gets the FULL half-pot share (no fee skim).
    // Intended: share = pot * own/total = pot/2; she does NOT collect the
    // whole pot just because Bob hasn't settled.
    const halfPot = dripped / 2n; // no bounty payout fee anymore
    expect(aliceEarned).to.be.closeTo(halfPot, TOL);

    // The residue (Bob's unclaimed half) remains in the round pot and is NOT
    // auto-redistributed to alice: credited-so-far < dripped pot.
    const creditedSoFar = aliceEarned;
    expect(creditedSoFar).to.be.lt(dripped - TOL);

    // The roundBountyPot value itself is never decremented at credit time,
    // so the full RATE is still recorded as the dripped pot (no drain path).
    expect(await bounties.roundBountyPot(streamId, predictRound, usdAddr)).to.equal(RATE);
  });
});
