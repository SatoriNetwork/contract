const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Helper function to extract streamId from DataStreamCreated event
async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find(log => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === 'DataStreamCreated';
    } catch {
      return false;
    }
  });

  if (!event) throw new Error("DataStreamCreated event not found");
  const parsed = satoriContract.interface.parseLog(event);
  return parsed.args.streamId;
}

describe("Satori Contract", function () {
  let satori;
  let registry;
  let voting;
  let owner;
  let addr1;
  let addr2;
  let addr3;
  let addr4;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, registry } = fix);
    owner = fix.owner;
    [, addr1, addr2, addr3, addr4] = fix.signers;
  });

  describe("Deployment", function () {
    it("Should set the correct name and symbol", async function () {
      expect(await satori.name()).to.equal("Satori");
      expect(await satori.symbol()).to.equal("SATORI");
    });

    it("Should start with current date based on block timestamp", async function () {
      const currentDate = await satori.getCurrentRound();
      const blockTime = await time.latest();
      const expectedDate = Math.floor(blockTime / 86400);
      expect(currentDate).to.equal(expectedDate);
    });
  });

  describe("Round System", function () {
    it("Should calculate round correctly at deployment", async function () {
      const currentTime = await time.latest();
      const expectedDate = Math.floor(currentTime / 86400);
      const actualDate = await satori.getCurrentRound();
      expect(actualDate).to.equal(expectedDate);
    });

    it("Should return correct round after advancing time", async function () {
      // Get current state
      const startDate = await satori.getCurrentRound();

      // Advance 1 day
      await time.increase(86400);

      // Round should increment by 1
      const newDate = await satori.getCurrentRound();
      expect(newDate).to.equal(startDate + 1n);
    });

    it("Should return same round within the same day", async function () {
      // Snap to just after a round boundary FIRST. Without this the test asks
      // "does +1h stay inside the round" from wherever the chain happens to
      // sit, so it fails whenever the deploy lands within an hour of midnight
      // UTC — i.e. it depended on the wall-clock time of day the suite was run.
      // It only looked stable because the chain clock inherited drift from
      // whichever files ran before it.
      const now = await time.latest();
      await time.increaseTo(Math.floor(now / 86400) * 86400 + 86400 + 1);

      const dateBefore = await satori.getCurrentRound();
      await time.increase(3600);           // 1 hour, well inside the 24h round
      const dateAfter = await satori.getCurrentRound();
      expect(dateAfter).to.equal(dateBefore);
    });

    it("Should advance round after crossing midnight", async function () {
      const currentTime = await time.latest();
      const currentDate = await satori.getCurrentRound();

      // Calculate time until next midnight + 1 second
      const timeInDay = currentTime % 86400;
      const timeToMidnight = 86400 - timeInDay + 1;

      // Advance past midnight
      await time.increase(timeToMidnight);

      const newDate = await satori.getCurrentRound();
      expect(newDate).to.be.greaterThan(currentDate);
    });

    it("Should handle round calculations across multiple days", async function () {
      const startDate = await satori.getCurrentRound();

      // Advance 3 days
      await time.increase(86400 * 3);

      const endDate = await satori.getCurrentRound();
      expect(endDate).to.equal(startDate + 3n);
    });
  });

  describe("Phase 2: Transfer Storm", function() {
    it("Should handle 50 token transfers correctly across 3 rounds", async function() {
      this.timeout(120000); // Increase timeout to 2 minutes

      const [alice, bob, carol, dave] = [addr1, addr2, addr3, addr4];

      // Setup: Enable test mode, create stream

      const tx = await satori.createSimpleDataStream("ETH/USD", owner.address);
      const streamId = await getStreamIdFromTx(tx, satori);

      console.log(`\n=== Transfer Storm Test: Created stream ${streamId} ===`);

      // Distribute initial tokens as a fixed fraction of the bootstrap.
      // Keyed off INITIAL_MINT so this scales with any future change to
      // the bootstrap amount — no hardcoded magic numbers tied to its
      // current value.
      const INITIAL_MINT = await satori.INITIAL_MINT();
      const PER_ACTOR = INITIAL_MINT / 6n; // 4 actors × 1/6 = 2/3 of bootstrap distributed
      await satori.transfer(alice.address, PER_ACTOR);
      await satori.transfer(bob.address, PER_ACTOR);
      await satori.transfer(carol.address, PER_ACTOR);
      await satori.transfer(dave.address, PER_ACTOR);

      console.log("Initial tokens distributed to 4 users");

      // Make the stream eligible for predictions. Voting BURNS, so each voter
      // is down VOTE (10) from PER_ACTOR from here on.
      await voteFor(satori, alice, streamId);
      await voteFor(satori, bob, streamId);

      let transferCount = 0;

      // Round 0: 20 transfers (no predictions yet, should all succeed)
      console.log("\n=== Round 0: 20 transfers (no locks) ===");
      for (let i = 0; i < 20; i++) {
        const sender = [alice, bob, carol, dave][i % 4];
        const receiver = [bob, carol, dave, alice][(i + 1) % 4];
        const amount = ethers.parseEther("1"); // Fixed small amount

        await satori.connect(sender).transfer(receiver.address, amount);
        transferCount++;
      }
      console.log(`Completed ${transferCount} transfers`);

      // Make predictions (locks balances)
      console.log("\n=== Making predictions (locks balances) ===");
      await registry.setValue(streamId, 1000);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(1) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(2) }]);
      console.log("Alice and Bob have made predictions - balances locked");

      // Attempt transfers from locked users (should fail)
      console.log("\n=== Testing locked balance transfers (should fail) ===");
      await expect(
        satori.connect(alice).transfer(carol.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(satori, "Locked");
      console.log("✓ Locked user (Alice) transfer correctly rejected");

      await expect(
        satori.connect(bob).transfer(dave.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(satori, "Locked");
      console.log("✓ Locked user (Bob) transfer correctly rejected");

      // Transfers from unlocked users (should succeed)
      console.log("\n=== Testing unlocked balance transfers (should succeed) ===");
      await satori.connect(carol).transfer(dave.address, ethers.parseEther("5"));
      transferCount++;
      console.log(`✓ Unlocked user (Carol) transfer succeeded. Total transfers: ${transferCount}`);

      // End round 0 -> 1
      await time.increase(86400);
      console.log("\n=== Round 0 → 1 ===");

      // Round 1: 20 more transfers (Alice & Bob still locked, only Carol & Dave can transfer)
      console.log("\n=== Round 1: 20 transfers (only Carol & Dave can transfer) ===");
      for (let i = 0; i < 20; i++) {
        const sender = [dave, carol][i % 2]; // Only unlocked users
        const receiver = [alice, bob, carol, dave][i % 4];
        const amount = ethers.parseEther("0.5"); // Fixed small amount

        await satori.connect(sender).transfer(receiver.address, amount);
        transferCount++;
      }
      console.log(`Completed ${transferCount} transfers`);

      // End round 1 -> 2
      await time.increase(86400);
      console.log("\n=== Round 1 → 2 ===");

      // Round 2: a large transfer INTO a still-locked account.
      // (The old "transfers while vote-delegated" leg is gone — vote delegation
      // no longer exists; burnt vote weight cannot follow a balance.)
      console.log("\n=== Round 2: Large transfer into a locked account ===");
      const aliceBefore = await satori.balanceOf(alice.address);

      // Carol transfers TO Alice. The prediction lock only blocks the SENDER,
      // so a locked account can still receive.
      await satori.connect(carol).transfer(alice.address, ethers.parseEther("100"));
      transferCount++;

      const aliceAfter = await satori.balanceOf(alice.address);
      expect(aliceAfter).to.equal(aliceBefore + ethers.parseEther("100"));
      console.log(`✓ Locked account received correctly. Total transfers: ${transferCount}`);

      // Remaining transfers to reach 50
      console.log("\n=== Completing remaining transfers to reach 50 ===");
      while (transferCount < 50) {
        await satori.connect(dave).transfer(alice.address, ethers.parseEther("0.1"));
        transferCount++;
      }
      console.log(`✓ All 50 transfers completed`);

      // Verify all 50 transfers processed
      expect(transferCount).to.equal(50);

      // Verify no state corruption - balances should be consistent
      console.log("\n=== Verifying state consistency ===");
      const aliceBalance = await satori.balanceOf(alice.address);
      const bobBalance = await satori.balanceOf(bob.address);
      const carolBalance = await satori.balanceOf(carol.address);
      const daveBalance = await satori.balanceOf(dave.address);

      console.log(`Alice balance: ${ethers.formatEther(aliceBalance)}`);
      console.log(`Bob balance: ${ethers.formatEther(bobBalance)}`);
      console.log(`Carol balance: ${ethers.formatEther(carolBalance)}`);
      console.log(`Dave balance: ${ethers.formatEther(daveBalance)}`);

      // All balances should be positive and add up correctly
      expect(aliceBalance).to.be.greaterThan(0);
      expect(bobBalance).to.be.greaterThan(0);
      expect(carolBalance).to.be.greaterThan(0);
      expect(daveBalance).to.be.greaterThan(0);

      // Total balance across the four actors should equal what was
      // distributed at setup (4 × PER_ACTOR) MINUS the two vote burns
      // (alice and bob each burnt VOTE to make the stream eligible).
      // Transfers between them preserve the remainder.
      const totalBalance = aliceBalance + bobBalance + carolBalance + daveBalance;
      expect(totalBalance).to.equal(PER_ACTOR * 4n - VOTE * 2n);
      console.log(`✓ Total balance preserved: ${ethers.formatEther(totalBalance)}`);

      console.log("\n=== TRANSFER STORM TEST COMPLETE ===");
      console.log("Summary:");
      console.log(`- 50 transfers completed across 3 rounds`);
      console.log(`- Locked balance transfers correctly rejected (2)`);
      console.log(`- Unlocked transfers succeeded (48)`);
      console.log(`- Vote burns correctly removed from circulating balances`);
      console.log(`- No state corruption detected`);
      console.log(`- All balances consistent`);
    });
  });
});