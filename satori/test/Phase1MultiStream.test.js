const { expect } = require("chai");
const { deploySatoriFixture, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

describe("Phase 1: Multi-Stream Competition", function () {
  let satori, voting, registry;
  let owner, alice, bob, carol, dave;

  async function getStreamIdFromTx(tx, contract) {
    const receipt = await tx.wait();
    const event = receipt.logs.find(
      (log) => {
        try {
          const parsed = contract.interface.parseLog(log);
          return parsed.name === "DataStreamCreated";
        } catch {
          return false;
        }
      }
    );
    const parsed = contract.interface.parseLog(event);
    return parsed.args.streamId;
  }

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, registry } = fix);
    [owner, alice, bob, carol, dave] = fix.signers;
  });

  it("Should handle 10 competing streams with burn-weight dynamics", async function() {
    // Create 10 streams
    const streamNames = [
      "ETH/USD", "BTC/USD", "SOL/USD", "AVAX/USD", "MATIC/USD",
      "LINK/USD", "UNI/USD", "AAVE/USD", "CRV/USD", "SNX/USD"
    ];

    const streams = [];
    for (const name of streamNames) {
      const tx = await satori.createSimpleDataStream(name, owner.address);
      const streamId = await getStreamIdFromTx(tx, satori);
      streams.push(streamId);
    }

    // Verify all 10 streams were created. Stream/game id 1 is the DEFAULT the
    // fixture initializes exactly as production does, so these ten are 2..11 —
    // hence "at least 10" counts the default alongside them.
    expect(streams.length).to.equal(10);
    const allStreams = await registry.getAllDataStreams();
    expect(allStreams.length).to.be.at.least(10);

    // Distribute tokens in 4:3:2:1 ratio derived from INITIAL_MINT (sum = 10U
    // = 10/15 of bootstrap; owner keeps 5U for stream-creation fees etc.).
    const INITIAL_MINT = await satori.INITIAL_MINT();
    const UNIT = INITIAL_MINT / 15n;
    await satori.transfer(alice.address, UNIT * 4n); // 40%
    await satori.transfer(bob.address, UNIT * 3n);   // 30%
    await satori.transfer(carol.address, UNIT * 2n); // 20%
    await satori.transfer(dave.address, UNIT);       // 10%

    // Verify balances
    expect(await satori.balanceOf(alice.address)).to.equal(UNIT * 4n);
    expect(await satori.balanceOf(bob.address)).to.equal(UNIT * 3n);
    expect(await satori.balanceOf(carol.address)).to.equal(UNIT * 2n);
    expect(await satori.balanceOf(dave.address)).to.equal(UNIT);

    // Per-round burn for each voter, in the same 4:3:2:1 ratio. Three rounds of
    // burning must fit inside each wallet, so each burns a fifth of its balance
    // per round (alice 3x40 of 192, dave 3x10 of 48, ...).
    const A = (UNIT * 4n) / 5n;
    const B = (UNIT * 3n) / 5n;
    const C = (UNIT * 2n) / 5n;
    const D = UNIT / 5n;

    const startDate = await satori.getCurrentRound();

    // ========== ROUND 1: Initial burns — spread across four streams ==========
    console.log("\n=== ROUND 1: Initial Burns ===");

    // Voting BURNS: weight is bought outright and is permanent. A voter can back
    // several games over time, and a later burn ADDS to the game's weight
    // instead of moving an earlier one.
    await voteFor(satori, alice, streams[0], A); // ETH/USD
    await voteFor(satori, bob,   streams[1], B); // BTC/USD
    await voteFor(satori, carol, streams[2], C); // SOL/USD
    await voteFor(satori, dave,  streams[3], D); // AVAX/USD

    await advanceToNextRound();
    expect(await satori.getCurrentRound()).to.equal(startDate + 1n);

    // Eligibility after round 1: NO threshold, NO top-N. Every game carrying
    // weight earns in proportion to it; every game with none earns nothing.
    for (let i = 0; i < 4; i++) {
      expect(await voting.isEligible(streams[i])).to.equal(true);
    }
    for (let i = 4; i < 10; i++) {
      expect(await voting.isEligible(streams[i])).to.equal(false);
    }

    expect(await voting.gameWeight(streams[0])).to.equal(A);
    expect(await voting.totalBurnedWeight()).to.equal(A + B + C + D);
    // The default game (id 1) is never burned for — its weight is DERIVED as
    // 1% of a denominator it is itself part of, i.e. total * 100/9900. Here the
    // total (~192e18) is well above the 1e18 floor, so 1% is the live value.
    expect(await voting.defaultDerivedWeight()).to.equal((A + B + C + D) * 100n / 9900n);

    // ========== ROUND 2: Burns shift to new streams ==========
    console.log("\n=== ROUND 2: Burns Shift ===");

    await voteFor(satori, alice, streams[5], A); // LINK/USD
    await voteFor(satori, bob,   streams[0], B); // ETH/USD
    await voteFor(satori, carol, streams[5], C); // LINK/USD
    await voteFor(satori, dave,  streams[1], D); // BTC/USD

    await advanceToNextRound();
    expect(await satori.getCurrentRound()).to.equal(startDate + 2n);

    // Stream 5 was untouched in round 1 and now carries alice's + carol's burns.
    expect(await voting.isEligible(streams[5])).to.equal(true);
    expect(await voting.gameWeight(streams[5])).to.equal(A + C);

    // Weight ACCUMULATES — alice's round-1 burn on stream 0 is still there, on
    // top of bob's new one.
    expect(await voting.gameWeight(streams[0])).to.equal(A + B);

    const stream1Weight = await voting.gameWeight(streams[1]);
    const stream5Weight = await voting.gameWeight(streams[5]);
    expect(stream5Weight).to.be.greaterThan(stream1Weight);

    // ========== ROUND 3: Concentrated burning on one stream ==========
    console.log("\n=== ROUND 3: Concentrated Burning ===");

    await voteFor(satori, alice, streams[0], A);
    await voteFor(satori, bob,   streams[0], B);
    await voteFor(satori, carol, streams[0], C);
    await voteFor(satori, dave,  streams[0], D);

    await advanceToNextRound();
    expect(await satori.getCurrentRound()).to.equal(startDate + 3n);

    // Stream 0 now dominates: two rounds of alice + bob plus a full sweep.
    const finalWeight0 = await voting.gameWeight(streams[0]);
    expect(finalWeight0).to.equal(A + B + (A + B + C + D));
    expect(await voting.isEligible(streams[0])).to.equal(true);

    // Stream 0 outweighs every other game, including the derived default.
    for (let i = 1; i < 10; i++) {
      expect(finalWeight0).to.be.greaterThan(await voting.gameWeight(streams[i]));
    }
    expect(finalWeight0).to.be.greaterThan(await voting.defaultDerivedWeight());

    // Streams nobody ever burned for stay out of the reward set entirely.
    expect(await voting.isEligible(streams[9])).to.equal(false);
    expect(await voting.gameWeight(streams[9])).to.equal(0n);

    // ========== Final Verification ==========
    console.log("\n=== Final Verification ===");

    // 1. All 10 streams still exist
    expect(await registry.streamExists(streams[0])).to.equal(true);
    expect(await registry.streamExists(streams[9])).to.equal(true);
    console.log("All 10 streams still exist");

    // 2. Conservation: the tracked total is exactly what was burned.
    const totalBurned = (A + B + C + D) * 3n;
    expect(await voting.totalBurnedWeight()).to.equal(totalBurned);
    // Derived default = 1% of the denominator (total * 100/9900); total (~576e18)
    // is far above the 1e18 floor, so 1% is the live value.
    expect(await voting.defaultDerivedWeight()).to.equal(totalBurned * 100n / 9900n);

    // 3. The leaderboard read replaces the old eligible-set enumeration: it
    //    lists every game carrying weight, in GAME-ID order (callers sort).
    //    Only the games actually burned for appear — plus the default at id 1,
    //    whose weight is derived.
    const [ids, weights, disabledFlags, , nextOffset] =
      await voting.getGameWeights(1, 100, await satori.getCurrentRound());
    const expectedIds = [1n, ...[0, 1, 2, 3, 5].map((i) => BigInt(streams[i]))].sort((a, b) => (a < b ? -1 : 1));
    expect(ids.map((x) => BigInt(x))).to.deep.equal(expectedIds);
    expect(weights[ids.findIndex((x) => BigInt(x) === BigInt(streams[0]))]).to.equal(finalWeight0);
    // The flag now reads "live" (approved, or the default): all true here.
    expect(disabledFlags.every((d) => d === true)).to.equal(true);
    expect(nextOffset).to.be.greaterThan(0);

    // 4. Verify burnt weights are tracked correctly
    const finalWeight9 = await voting.gameWeight(streams[9]);
    expect(finalWeight0).to.be.greaterThan(0);
    expect(finalWeight0).to.be.greaterThan(finalWeight9);

    console.log("\n=== Test Completed Successfully! ===");
    console.log("- 10 streams created and tracked");
    console.log("- 3 rounds of dynamic burn voting completed");
    console.log("- Weight accumulation and the derived default share verified");
    console.log("- Unvoted streams stay out of the reward set");
  });
});
