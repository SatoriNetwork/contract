const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// KNOWN: this file's first test ("Should correctly track and claim rewards
// across multiple rounds") fails when run in `--grep` isolation. The root
// cause is the manual `beforeEach` deployment + the registry's 23-hour
// minWaitTime gate on `setValue` — when run as part of the full suite the
// EVM clock has advanced past genesis from prior tests, but in isolation
// the first `setValue` inside the test body lands within 23 hours of the
// seed `setValue` in `beforeEach`. Migrating to `loadFixture` doesn't fix
// this (loadFixture snapshots state but doesn't change the relative
// timestamp arithmetic). Full-suite runs reliably pass. If a `--grep`
// regression surfaces in CI, the proper fix is to advance time inside
// `beforeEach` to a fresh day boundary BEFORE seeding values.

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return Number(satori.interface.parseLog(ev).args.streamId);
}

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

describe("Multi-Round Claiming Tests", function () {
  let satori, rewards, bounties, lens;
  let registry;
  let owner, user1, user2, user3;
  // Game id 1 is the protocol's DEFAULT game (created by the fixture), so the
  // two streams created here land at ids 2 and 3. Captured from the events.
  let btcId, ethId;
  // USER_BALANCE derived from INITIAL_MINT in beforeEach so the test scales
  // with the bootstrap. 3 × INITIAL_MINT/4 = 3/4 of bootstrap distributed.
  let USER_BALANCE;

  beforeEach(async function () {
    [owner, user1, user2, user3] = await ethers.getSigners();

    const fix = await deploySatoriFixture();
    ;({ satori, rewards, registry, bounties, lens } = fix);

    // Enable test mode

    // Transfer tokens to test users from owner (USER_BALANCE = INITIAL_MINT/4).
    const INITIAL_MINT = await satori.INITIAL_MINT();
    USER_BALANCE = INITIAL_MINT / 4n;
    await satori.transfer(user1.address, USER_BALANCE);
    await satori.transfer(user2.address, USER_BALANCE);
    await satori.transfer(user3.address, USER_BALANCE);

    // Create two datastreams (Simple = offchain/manual updates). Cadence 1440
    // minutes (every round): the rounds this file walks are CLAIM windows and
    // reward-accrual rounds, not stream write windows, so the every-round
    // rhythm is kept — one write per 24h round.
    btcId = await streamIdFrom(await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440), satori);
    ethId = await streamIdFrom(await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440), satori);

    // Advance to a fresh round boundary BEFORE seeding values so the first
    // in-test `setValue` clears the registry's per-cadence wall-clock gap
    // regardless of the genesis timestamp (see header note). This affects only
    // harness timing, not any behavioral assertion.
    await advanceToNextRound();

    // Set initial values (setValue for Simple streams)
    await registry.setValue(btcId, ethers.parseEther("50000"));
    await registry.setValue(ethId, ethers.parseEther("3000"));

    // All three users burn 10 SATORI each for the BTC game. That weight is
    // PERMANENT — nothing below has to re-cast a vote to keep it earning.
    await satori.connect(user1).vote(btcId, VOTE);
    await satori.connect(user2).vote(btcId, VOTE);
    await satori.connect(user3).vote(btcId, VOTE);
  });

  it("Should correctly track and claim rewards across multiple rounds", async function () {
    // Advance to new day so we can set fresh values
    await advanceToNextRound();

    console.log("\n=== ROUND 1 ===");

    // Set fresh values for this test
    await registry.setValue(btcId, ethers.parseEther("51000"));

    // Round 1: User1 predicts UP, User2 predicts DOWN
    // (no re-vote: burned weight is permanent)
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);  // UP on BTC
    await satori.connect(user2).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(2) }]); // DOWN on BTC

    // End Round 1 and advance to Round 2
    await advanceToNextRound();

    console.log("\n=== ROUND 2 ===");

    // BTC goes UP (User1 wins Round 1) - value B
    await registry.setValue(btcId, ethers.parseEther("52000"));

    // Round 2: User1 predicts UP again, User2 predicts DOWN again
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);  // UP on BTC
    await satori.connect(user2).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(2) }]); // DOWN on BTC

    // End Round 2 and advance to Round 3
    await advanceToNextRound();

    // BTC goes UP again (User1 wins Round 2 too) - value C
    await registry.setValue(btcId, ethers.parseEther("54000"));

    // Make trigger prediction to score previous predictions
    await advanceToNextRound();
    await registry.setValue(btcId, ethers.parseEther("55000"));
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);

    // Round-4 refactor: per-(stream, round) finality gate. Finalize User2's
    // predictions on Round 1 & 2 as well so User1's claim cursor releases.
    await satori.settlePrediction(user2.address, btcId);
    await satori.settlePrediction(user2.address, btcId);
    await satori.settlePrediction(user1.address, btcId);

    // Advance more rounds to accumulate rewards
    await advanceToNextRound();
    await advanceToNextRound();

    // Check unclaimed rewards after both rounds
    const totalUnclaimedBefore = (await lens.getTotalClaimableRewards(user1.address))[0];
    console.log(`User1 unclaimed after 2 rounds: ${ethers.formatEther(totalUnclaimedBefore)} SATORI`);
    expect(totalUnclaimedBefore).to.be.gt(0n, "User1 should have unclaimed rewards from 2 rounds");
    console.log(`Total unclaimed from 2 rounds: ${ethers.formatEther(totalUnclaimedBefore)} SATORI`);

    // Record balance before claiming
    const balanceBefore = await satori.balanceOf(user1.address);
    console.log(`\n=== CLAIMING ===`);
    console.log(`Balance before claim: ${ethers.formatEther(balanceBefore)} SATORI`);
    console.log(`Unclaimed before claim: ${ethers.formatEther(totalUnclaimedBefore)} SATORI`);

    // Claim all rewards at once
    const tx = await satori.connect(user1).claim();
    const receipt = await tx.wait();

    // Find RewardsClaimed event to see actual amount claimed (now declared and
    // emitted only on SatoriRewards under PR 4 item Z; parse via rewards.interface).
    const claimEvent = receipt.logs.find(log => {
      try {
        const parsed = rewards.interface.parseLog(log);
        return parsed && (parsed.name === 'RewardsClaimed' || parsed.name === 'RewardClaimed');
      } catch {
        return false;
      }
    });

    if (claimEvent) {
      try {
        const parsed = rewards.interface.parseLog(claimEvent);
        const actualClaimed = parsed.args.amount || parsed.args[0];
        if (actualClaimed) {
          console.log(`Amount claimed (from event): ${ethers.formatEther(actualClaimed)} SATORI`);
        }
      } catch (e) {
        console.log(`Could not parse claim event: ${e.message}`);
      }
    }

    // Check balance after claiming
    const balanceAfter = await satori.balanceOf(user1.address);
    const balanceIncrease = balanceAfter - balanceBefore;
    console.log(`Balance after claim: ${ethers.formatEther(balanceAfter)} SATORI`);
    console.log(`Balance increase: ${ethers.formatEther(balanceIncrease)} SATORI`);

    // CRITICAL CHECK: Balance increase should equal total unclaimed
    expect(balanceIncrease).to.equal(
      totalUnclaimedBefore,
      "Balance increase should equal total unclaimed rewards"
    );

    // CRITICAL CHECK: Unclaimed rewards should now be ZERO
    const unclaimedAfter = (await lens.getTotalClaimableRewards(user1.address))[0];
    console.log(`Unclaimed after claim: ${ethers.formatEther(unclaimedAfter)} SATORI`);
    expect(unclaimedAfter).to.equal(0n, "Unclaimed rewards should be ZERO after claiming");

    // Claim again on the now-empty bucket.
    //
    // WHY THIS CHANGED (P5 — swallowed assertion): this block used to sit
    // inside `try { ... } catch (error) { console.log("Second claim reverted
    // (expected)"); }`. The catch swallowed EVERY throw, chai's AssertionError
    // included, so a second claim that re-minted (the exact double-spend
    // A_claim_delegation.md:29/45 forbids — "unclaimedRewards is zeroed before
    // any mint") logged a line and left the test green. The catch also encoded
    // a revert as acceptable, which A_rewards.md:132 rules out: "A claim with
    // totalRewards == 0 is a silent no-op (still fires RewardsClaimed with
    // totalAmount = 0)". Both halves are now asserted directly, outside any try.
    console.log(`\n=== ATTEMPTING SECOND CLAIM ===`);
    const balanceBeforeSecond = await satori.balanceOf(user1.address);
    const mintedBeforeSecond = await satori.totalRewardsMinted();

    // Must NOT revert — a zero bucket is a silent no-op.
    const tx2 = await satori.connect(user1).claim();
    const receipt2 = await tx2.wait();

    const balanceAfterSecond = await satori.balanceOf(user1.address);
    const secondIncrease = balanceAfterSecond - balanceBeforeSecond;
    console.log(`Second claim balance increase: ${ethers.formatEther(secondIncrease)} SATORI`);

    expect(secondIncrease).to.equal(0n, "Second claim must mint nothing (bucket was zeroed by the first claim)");
    // Nothing was minted protocol-wide either — not just "nothing to user1".
    expect(await satori.totalRewardsMinted()).to.equal(
      mintedBeforeSecond,
      "Second claim must not increase totalRewardsMinted"
    );

    // …and it still emitted RewardsClaimed with totalAmount == 0 (silent no-op,
    // not a revert), per A_rewards.md:132.
    const secondClaimEvents = receipt2.logs
      .map((log) => { try { return rewards.interface.parseLog(log); } catch { return null; } })
      .filter((p) => p && p.name === "RewardsClaimed");
    expect(secondClaimEvents.length).to.equal(1, "Zero-value claim must still emit RewardsClaimed");
    expect(secondClaimEvents[0].args.owner).to.equal(user1.address);
    expect(secondClaimEvents[0].args.totalAmount).to.equal(0n, "RewardsClaimed must report a zero total");
  });

  it("Should handle claiming with rewards from 3+ rounds", async function () {
    console.log("\n=== TESTING 3 ROUNDS ===");

    const rewardsPerRound = [];

    // Play 3 rounds
    // Initial value already set in beforeEach
    for (let round = 1; round <= 3; round++) {
      console.log(`\n--- Round ${round} ---`);

      await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);  // UP
      await satori.connect(user2).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(2) }]); // DOWN

      await advanceToNextRound();

      // BTC goes UP (User1 wins) - set value in new round
      const newPrice = ethers.parseEther((50000 + round * 2000).toString());
      await registry.setValue(btcId, newPrice);

      const unclaimed = (await lens.getTotalClaimableRewards(user1.address))[0];
      console.log(`Unclaimed after Round ${round}: ${ethers.formatEther(unclaimed)} SATORI`);

      rewardsPerRound.push(unclaimed);
    }

    const totalUnclaimed = rewardsPerRound[rewardsPerRound.length - 1];
    console.log(`\nTotal unclaimed from 3 rounds: ${ethers.formatEther(totalUnclaimed)} SATORI`);

    // Claim all at once
    const balanceBefore = await satori.balanceOf(user1.address);
    await satori.connect(user1).claim();
    const balanceAfter = await satori.balanceOf(user1.address);

    const balanceIncrease = balanceAfter - balanceBefore;
    console.log(`Balance increase: ${ethers.formatEther(balanceIncrease)} SATORI`);

    expect(balanceIncrease).to.equal(totalUnclaimed, "Should claim all 3 rounds of rewards");

    const unclaimedAfter = (await lens.getTotalClaimableRewards(user1.address))[0];
    expect(unclaimedAfter).to.equal(0n, "No unclaimed rewards should remain");
  });

  it("Batch claim: claim aggregates rewards accrued across multiple rounds", async function () {
    // v5 eager credit: per-round attribution is no longer queryable on-chain;
    // off-chain consumers reconstruct per-round breakdown from `RewardSplit`
    // events. This test verifies the claim-side aggregate invariant only.

    // Round 1 (initial value already set in beforeEach)
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);
    await satori.connect(user2).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(2) }]);
    await advanceToNextRound();
    await registry.setValue(btcId, ethers.parseEther("52000"));

    // Round 2
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);
    await satori.connect(user2).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(2) }]);
    await advanceToNextRound();
    await registry.setValue(btcId, ethers.parseEther("54000"));

    // Drive a third round so the round-2 prediction can be scored (needs C).
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);
    await advanceToNextRound();
    await registry.setValue(btcId, ethers.parseEther("56000"));
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId: btcId, payload: pack1(1) }]);

    // After eager credit on each scoring step, totalClaimable == unclaimedRewards.
    const totalUnclaimedBefore = (await lens.getTotalClaimableRewards(user1.address))[0];
    const unclaimedDirect = await rewards.unclaimedRewards(user1.address);
    expect(totalUnclaimedBefore).to.equal(unclaimedDirect);
    expect(totalUnclaimedBefore).to.be.gt(0n);

    // Batch claim mints exactly the unclaimed-rewards balance to the user
    // (no referral → no 1% cut).
    const balanceBefore = await satori.balanceOf(user1.address);
    await satori.connect(user1).claim();
    const balanceAfter = await satori.balanceOf(user1.address);
    expect(balanceAfter - balanceBefore).to.equal(totalUnclaimedBefore);

    // Post-claim: unclaimed bucket drained.
    expect(await rewards.unclaimedRewards(user1.address)).to.equal(0n);
    expect((await lens.getTotalClaimableRewards(user1.address))[0]).to.equal(0n);
  });
});
