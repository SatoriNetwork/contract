const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

describe("Six Round Claiming Test", function () {
  let satori, rewards, bounties, lens;
  let registry;
  let owner, user1;
  // The fixture initializes the DEFAULT stream at id 1, so the stream created
  // below lands at id 2. Captured from the event rather than hardcoded.
  let gameId;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ;({ satori, rewards, bounties, registry, owner, lens } = fix);
    user1 = fix.signers[1];

    // Transfer most of the bootstrap to user1 — keyed off INITIAL_MINT so
    // any future change to the constant doesn't break this setup. Leave
    // a small remainder with the deployer for stream-creation fees.
    const INITIAL_MINT = await satori.INITIAL_MINT();
    await satori.transfer(user1.address, (INITIAL_MINT * 9n) / 10n);

    // Create datastream (Simple = offchain/manual updates). Admin-created with
    // an explicit cadence of 1 (every round): the subject is claiming six
    // consecutive rounds of rewards, so the stream must remain writable every
    // round. A public caller may only create cadence >= 2.
    const receipt = await (await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("BTC/USD", owner.address, 1440)).wait();
    gameId = Number(receipt.logs
      .map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "DataStreamCreated").args.streamId);

    // User burns SATORI to buy the game weight, so it earns a share of each round
    await voteFor(satori, user1, gameId);

    // Advance to a fresh round boundary BEFORE the test seeds baseline values
    // so the first in-test `setValue` clears the registry's per-cadence
    // wall-clock gap regardless of the genesis timestamp (the fixture deploy
    // advances the EVM clock further than the old inline deploy). This affects
    // only harness timing, not any behavioral assertion.
    await advanceToNextRound();
  });

  it("Should handle 6 rounds of correct predictions and claim all rewards", async function () {
    console.log("\n=== STARTING 6 ROUND TEST ===\n");

    // Get initial balance
    const initialBalance = await satori.balanceOf(user1.address);
    console.log(`Initial balance: ${ethers.formatEther(initialBalance)} SATORI\n`);

    // Set initial baseline value
    await registry.setValue(gameId, ethers.parseEther("0"));
    await advanceToNextRound(); // Move to round 2

    // Round 2: set price to 1, predict up, end round
    console.log("=== ROUND 2 ===");
    await registry.setValue(gameId, ethers.parseEther("1"));
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);  // UP
    await advanceToNextRound();
    console.log("Price set to 1, predicted UP, round ended");

    // Round 3: set price to 2, predict up, end round
    console.log("\n=== ROUND 3 ===");
    await registry.setValue(gameId, ethers.parseEther("2"));
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);  // UP
    await advanceToNextRound();
    console.log("Price set to 2, predicted UP, round ended");

    // Round 4: set price to 3, predict up, end round
    console.log("\n=== ROUND 4 ===");
    await registry.setValue(gameId, ethers.parseEther("3"));
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);  // UP
    await advanceToNextRound();
    console.log("Price set to 3, predicted UP, round ended");

    // Round 5: set price to 4, predict up, end round
    console.log("\n=== ROUND 5 ===");
    await registry.setValue(gameId, ethers.parseEther("4"));
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);  // UP
    await advanceToNextRound();
    console.log("Price set to 4, predicted UP, round ended");

    // Round 6: set price to 5, predict up, end round
    console.log("\n=== ROUND 6 ===");
    await registry.setValue(gameId, ethers.parseEther("5"));
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);  // UP
    await advanceToNextRound();
    console.log("Price set to 5, predicted UP, round ended");

    // Round 7: set price to 6, predict up, end round
    console.log("\n=== ROUND 7 ===");
    await registry.setValue(gameId, ethers.parseEther("6"));
    await satori.connect(user1).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);  // UP
    await advanceToNextRound();
    console.log("Price set to 6, predicted UP, round ended");

    // Check unclaimed balance
    console.log("\n=== CHECKING UNCLAIMED REWARDS ===");
    const unclaimedBalance = (await lens.getTotalClaimableRewards(user1.address))[0];
    console.log(`Unclaimed balance: ${ethers.formatEther(unclaimedBalance)} SATORI`);

    // Under the new streak curve, predictions with streak <= 1 (other than
    // the very first on the stream) commit weight=0 and don't accrue. In this
    // 6-round-correct sequence, that zeros out the middle rounds; only the
    // first prediction (bypass) and the rounds with streak >= 2 actually pay.
    // Loose lower bound — we just verify rewards accumulated, not the exact
    // shape. Threshold keyed off ROUND_REWARD_BUDGET so it scales with any
    // future change to the per-round mint.
    const oneRound = await satori.ROUND_REWARD_BUDGET();
    expect(unclaimedBalance).to.be.gt(oneRound, "Unclaimed should be > one round's budget");
    console.log(`✓ Unclaimed balance exceeds one round's mint`);

    // Attempt to claim rewards
    console.log("\n=== CLAIMING REWARDS ===");
    const balanceBeforeClaim = await satori.balanceOf(user1.address);
    console.log(`Balance before claim: ${ethers.formatEther(balanceBeforeClaim)} SATORI`);

    const tx = await satori.connect(user1).claim();
    await tx.wait();
    console.log("Claim transaction completed");

    const balanceAfterClaim = await satori.balanceOf(user1.address);
    console.log(`Balance after claim: ${ethers.formatEther(balanceAfterClaim)} SATORI`);

    const balanceIncrease = balanceAfterClaim - balanceBeforeClaim;
    console.log(`Balance increase: ${ethers.formatEther(balanceIncrease)} SATORI`);

    // Verify balance increased by unclaimed amount
    console.log("\n=== VERIFICATION ===");
    expect(balanceIncrease).to.equal(unclaimedBalance, "Balance should increase by unclaimed amount");
    console.log(`✓ Balance increased by exactly ${ethers.formatEther(unclaimedBalance)} SATORI`);

    // Check that unclaimed is now 0
    const unclaimedAfter = (await lens.getTotalClaimableRewards(user1.address))[0];
    console.log(`Unclaimed after claim: ${ethers.formatEther(unclaimedAfter)} SATORI`);
    expect(unclaimedAfter).to.equal(0n, "Unclaimed should be 0 after claiming");
    console.log("✓ Unclaimed rewards is now 0");

    console.log("\n=== TEST PASSED ===");
  });
});
