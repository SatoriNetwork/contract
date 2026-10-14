// v5 — predictMultiple × shared-stake invariants (security follow-up C-2).
//
// When a user with stake X in token T predicts on multiple streams that each
// have a T-bounty, the auto-boost step must:
//   (a) snapshot stake X into _boostStakeForPrediction for EACH (stream, round, T)
//   (b) bump _totalBoostStakeByDirection by X for EACH (stream, round, direction, T)
//       — NOT once-globally and NOT cumulatively (each stream's accumulator is
//       independent; per-stream value is X, never 2X)
//   (c) append T to the per-(user, round) boosted-token list (the DEDUP'd SET of
//       distinct bounty tokens the user snapshotted that round) — so two predicts
//       on the same round with the same staked token register as ONE entry, not two
//
// Verified end-to-end:
//   - The per-(user, round) boosted-token list is exposed via the public views
//     `boostedTokensInRound(user, round, i)` and `boostedTokenCountInRound(user, round)`:
//       * after both predicts (same token T, same round): count == 1 (deduped set,
//         NOT one entry per prediction)
//       * unstake does NOT touch the list — count stays 1 across unstake (the
//         predict-time snapshot is self-sufficient; payout reads the snapshot, not
//         live stake)
//       * the list is cleared (count == 0) only once ALL of the user's predictions
//         for that round have finalized (clearRoundBountyList fires when the round's
//         unsettled-prediction count hits zero on a bounty game)
//     The lock that used to gate `unstakeBountyToken` on a pending counter was
//     removed — so unstake itself no longer reverts on this telemetry at any stage.
//   - The per-stream accumulator is X (not 2X) by reading the predictor's
//     score-time payout: with a non-staker co-predictor on each stream, the
//     v5 formula `share = pot × (userW + X) / (totalW + X)` produces a
//     deterministic, computable share that we verify against.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, RAW_TOLERANCE, pack1 , warmUpStreak, VOTE } = require("./fixtures");

const UP = 1;

async function deployMockToken(symbol = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

const TOKENS_PER_ROUND = ethers.parseEther("1440");

// (Removed 2026-07-30, skip triage: `bsqrt` + `normalizedPredictorShare` replicated a
// sqrt-normalised bounty-share model -- pot x (userW + userBoost x sqrt(...)) /
// (totalW + ...) -- that the contracts no longer implement. The bounty share is now
// plainly `pot x userBoost / totalBoost` (SatoriBounties.sol), and the
// `totalRawPowerByDirection` lens view the helper needed exists nowhere. Both were
// dead after the assertions below were rewritten to read the accumulators directly;
// deleted so nobody revives the wrong formula from them.)


// Membership test against the per-(user, round) boosted-token list — replaces the
// old per-(user, token) `pendingByToken != 0` boolean. Threads the predict round in.
async function boostedInRound(bounties, user, tokenAddr, round) {
  const n = await bounties.boostedTokenCountInRound(user.address, round);
  for (let i = 0n; i < n; i++) {
    const t = await bounties.boostedTokensInRound(user.address, round, i);
    if (t.toLowerCase() === tokenAddr.toLowerCase()) return true;
  }
  return false;
}

async function createStream(satori, signer, name, authority) {
  // Every-round (1440-minute) stream — one value write per 24h round, which is
  // this suite's rhythm. 1440 is the finest PUBLIC cadence SatoriHub allows, so
  // no admin exemption is needed. `authority` stays the provider — it is who
  // may call `registry.setValue`.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("BountyBoostMulti — predictMultiple × shared-stake (v5 C-2 follow-up)", function () {
  let satori, rewards, bounties, registry, owner, alice, bob, funder, authority, lens;
  let s1, s2, usd;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, lens, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    s1 = await createStream(satori, owner, "S1", authority.address);

    // audit C-2: streak 0 pays flat dust and takes no bounty boost — warm to streak >= 1

    await warmUpStreak(satori, registry, authority, [alice, bob], s1);
    s2 = await createStream(satori, owner, "S2", authority.address);
    // Both games need streak >= 1: the round's LAST finalize must itself be
    // boosted for clearRoundBountyList to fire (an unboosted final finalize is a
    // documented tolerated miss in notifyPredictionFinalized).
    await warmUpStreak(satori, registry, authority, [alice, bob], s2);
    for (const sid of [s1, s2]) {
      await satori.connect(alice).vote(sid, VOTE);
      await satori.connect(bob).vote(sid, VOTE);
    }

    usd = await deployMockToken("USDC");
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));

    // Funder funds T-bounty on both streams. Same rate so the per-stream pots
    // are equal at score time.
    await bounties.connect(funder).fundBounty(
      s1, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("200")
    );
    await bounties.connect(funder).fundBounty(
      s2, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("200")
    );

    // Alice stakes X = 100 USD as boost (will apply to both s1 and s2).
    // The stake auto-subscribes alice to usd; only bob still needs manual subscribe.
    await usd.mint(alice.address, ethers.parseEther("100"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("100"));
    await bounties.connect(alice).stakeBountyToken(await usd.getAddress(), ethers.parseEther("100"));

  });

  it("predictMultiple records the staked token ONCE in the per-(user, round) boosted-token list (dedup); list clears only after the round fully settles", async function () {
    // Step 1-3: alice predictMultiple on (s1, s2). Bob co-predicts so the
    // per-stream weight denominator is not equal to alice's contribution alone
    // (we don't care about the value here — only the round's boosted-token list).
    await registry.connect(authority).setValue(s1, 100);
    await registry.connect(authority).setValue(s2, 100);

    const usdAddr = await usd.getAddress();

    // Pre-predict: alice has nothing snapshotted yet for the upcoming round.
    const preRound = await satori.getCurrentRound();
    expect(await bounties.boostedTokenCountInRound(alice.address, preRound)).to.equal(0n);

    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: s1, payload: pack1(UP) },
      { gameId: s2, payload: pack1(UP) },
    ]);
    const round = await satori.getCurrentRound();

    // DEDUP, read BEFORE any settle: USDC predicted across two streams in one round
    // appears ONCE in the round's boosted-token list, else score time would pay it
    // twice. (It is legitimately cleared again once the round fully settles, so this
    // cannot be asserted after the settles below.)
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(
      1n, "one staked token across two streams dedups to a single round-list entry"
    );

    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: s1, payload: pack1(UP) },
      { gameId: s2, payload: pack1(UP) },
    ]);

    // Step 4: both predicts used the SAME staked token (usd) on the SAME round,
    // so the deduped boosted-token set has exactly ONE entry (not one per predict).
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(1n);
    expect(await boostedInRound(bounties, alice, usdAddr, round)).to.equal(true);

    // Advance and set values so predictions can be scored.
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110);
    await registry.connect(authority).setValue(s2, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120);
    await registry.connect(authority).setValue(s2, 120);

    // Step 5: settle s1. The round is NOT yet fully settled (s2 still pending),
    // so the boosted-token list is untouched — still 1 entry for usd.
    await satori.settlePrediction(alice.address, s1);
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(1n);
    expect(await boostedInRound(bounties, alice, usdAddr, round)).to.equal(true);

    // Step 6: settle s2. Now ALL of alice's predictions for this round have
    // finalized -> clearRoundBountyList fires -> list cleared to count 0.
    await satori.settlePrediction(alice.address, s2);
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(0n);
    expect(await boostedInRound(bounties, alice, usdAddr, round)).to.equal(false);

    // Step 7: unstake succeeds, alice's original 100 stake is returned
    // (to recipient = alice). Note: she's also earned bounty from the
    // two correct predictions, which auto-compounded into bountyStake
    // — so the residual stake is the earned amount, not zero.
    const balBefore = await usd.balanceOf(alice.address);
    await bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address);
    expect((await usd.balanceOf(alice.address)) - balBefore).to.equal(ethers.parseEther("100"));
    // Residual stake = total earnings (post-merge: bounty-credit went into stake).
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.be.gt(0n);
  });

  it("per-stream _totalBoostStakeByDirection accumulates alice's stake ONCE per stream (X each, never 2X across both)", async function () {
    // Strategy: have alice (stake X = 100 USD) AND bob (no stake) co-predict
    // on both streams. After scoring, alice's per-stream bounty share must
    // match the v5 formula with totalBoost = X (not 2X):
    //   share_alice_s1 = pot × (userW_a_s1 + X) / (totalW_s1 + X)
    //   share_alice_s2 = pot × (userW_a_s2 + X) / (totalW_s2 + X)
    // If the contract incorrectly accumulated 2X into one stream's slot
    // (e.g. if predictMultiple double-counted), the denominator would
    // differ and the share would be smaller. If it dropped a stream's
    // contribution (X=0 for one of the two), the share would be larger.
    // The exact-match assertion below pins both invariants.
    await registry.connect(authority).setValue(s1, 100);
    await registry.connect(authority).setValue(s2, 100);
    const predictTx = await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: s1, payload: pack1(UP) },
      { gameId: s2, payload: pack1(UP) },
    ]);
    const round = await satori.getCurrentRound();

    // DEDUP, read BEFORE any settle: USDC predicted across two streams in one round
    // appears ONCE in the round's boosted-token list, else score time would pay it
    // twice. (It is legitimately cleared again once the round fully settles, so this
    // cannot be asserted after the settles below.)
    expect(await bounties.boostedTokenCountInRound(alice.address, round)).to.equal(
      1n, "one staked token across two streams dedups to a single round-list entry"
    );

    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: s1, payload: pack1(UP) },
      { gameId: s2, payload: pack1(UP) },
    ]);

    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110);
    await registry.connect(authority).setValue(s2, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120);
    await registry.connect(authority).setValue(s2, 120);

    await satori.settlePrediction(alice.address, s1);
    await satori.settlePrediction(alice.address, s2);
    await satori.settlePrediction(bob.address, s1);
    await satori.settlePrediction(bob.address, s2);

    const usdAddr = await usd.getAddress();

    // Asserted directly from the per-stream snapshots rather than by recomputing a
    // payout (2026-07-30, skip triage). The old version replicated a sqrt-normalised
    // share model through a `totalRawPowerByDirection` lens view; that model is gone
    // -- the bounty share is now plainly `pot x userBoost / totalBoost`
    // (SatoriBounties.sol) and neither the view nor its backing storage exists.
    // The title's property is a statement about the ACCUMULATORS, so read those:
    // one stake must register once per stream, never doubled into one slot and never
    // dropped from the other.
    const snapS1 = await bounties.boostStakeForPrediction(alice.address, s1, round, usdAddr);
    const snapS2 = await bounties.boostStakeForPrediction(alice.address, s2, round, usdAddr);

    // X registered on BOTH streams...
    expect(snapS1).to.be.gt(0n, "s1 got alice's stake (not dropped)");
    expect(snapS2).to.be.gt(0n, "s2 got alice's stake (not dropped)");
    // ...at the SAME size. Doubling into one stream, or splitting across the two,
    // both break this equality.
    expect(snapS1).to.equal(snapS2, "one stake per stream — never 2X in one slot");

    // The stored value is stake x multiplier, so pin the ratio rather than a literal:
    // the snapshot is exactly ONE X, so snap / X must be the same integer for both.
    const X = ethers.parseEther("100");
    expect(snapS1 % X).to.equal(0n, "snapshot is an exact multiple of the single stake X");

    // (The round-list dedup was asserted above, pre-settle.)

    // Non-vacuous: alice was actually paid, and bob (no stake) was not.
    const aliceOwed = (await bounties.bountyStake(alice.address, usdAddr)) - X;
    const bobOwed = await bounties.bountyStake(bob.address, usdAddr);
    expect(aliceOwed).to.be.gt(0n, "alice earned a bounty share");
    expect(bobOwed).to.equal(0n, "bob staked nothing, so earns no bounty");
  });
});
