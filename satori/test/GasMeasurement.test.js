const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { createCustomStream , deploySatoriFixture, VOTE, voteFor } = require("./fixtures");

const ROUND_SECONDS = 86400;                                  // 24h
// Every stream here is built through the plain 2-arg overload, i.e. the public
// path, which now yields cadence 2 (daily — the finest a public stream may be).
// The value-update measurements below therefore walk the series at that cadence,
// which is the rhythm whose gas a real provider actually pays.
const CADENCE_ROUNDS = 2;
const CADENCE_SECONDS = ROUND_SECONDS * CADENCE_ROUNDS;       // 24h

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

describe("Gas Measurements After uint32 Refactor", function () {
  let satori;
  let registry;
  let voting;
  let owner;
  let alice;
  let bob;
  let carol;
  let authority;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ;({ satori, voting, registry } = fix);
    owner = fix.owner;
    [, alice, bob, carol, authority] = await ethers.getSigners();

    // Transfer tokens for testing
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("200"));
    await satori.transfer(carol.address, ethers.parseEther("50"));
  });

  describe("Stream Creation Gas", function () {
    it("Should measure createSimpleDataStream gas", async function () {
      const tx = await satori.createSimpleDataStream(
        "Test Stream",
        authority.address
      );
      const receipt = await tx.wait();

      console.log("\n=== Stream Creation ===");
      console.log("createSimpleDataStream:", receipt.gasUsed.toString(), "gas");
    });

    it("Should measure createAdapterDataStream(Custom) gas", async function () {
      const MockDS = await ethers.getContractFactory("MockDataStream");
      const mock = await MockDS.deploy();
      await mock.waitForDeployment();

      const tx = await createCustomStream(
        satori, "Custom Stream", await mock.getAddress(), authority.address
      );
      const receipt = await tx.wait();

      console.log("createAdapterDataStream(Custom):", receipt.gasUsed.toString(), "gas");
    });
  });

  describe("Value Update Gas", function () {
    let streamId;

    beforeEach(async function () {
      const tx = await satori.createSimpleDataStream(
        "Test Stream",
        authority.address
      );
      streamId = await getStreamIdFromTx(tx, satori);
    });

    it("Should measure setValue gas", async function () {
      const tx = await registry.connect(authority).setValue(streamId, 12345);
      const receipt = await tx.wait();

      console.log("\n=== Value Updates ===");
      console.log("setValue (first time):", receipt.gasUsed.toString(), "gas");
    });

    it("Should measure setValue gas (subsequent)", async function () {
      // First update
      await registry.connect(authority).setValue(streamId, 100);

      // Advance time to next day — one cadence period on a cadence-2 stream
      await time.increase(CADENCE_SECONDS);

      // Second update (new day)
      const tx = await registry.connect(authority).setValue(streamId, 200);
      const receipt = await tx.wait();

      console.log("setValue (subsequent):", receipt.gasUsed.toString(), "gas");
    });

    it("Should measure setValue gas (new round)", async function () {
      // First update
      await registry.connect(authority).setValue(streamId, 100);

      // Move to the START of a new round that is at least one whole cadence
      // period away. Landing on the boundary of round r0+CADENCE_ROUNDS alone
      // would clear the round guard but could still trip the wall-clock guard
      // (a write late in r0 leaves under 23h30m); going one further round out
      // guarantees both, whatever the offset of the first write inside r0.
      const currentTime = await time.latest();
      const roundStart = Math.floor(currentTime / ROUND_SECONDS) * ROUND_SECONDS;
      await time.increaseTo(roundStart + ROUND_SECONDS * (CADENCE_ROUNDS + 1) + 1);

      // Update in new round
      const tx = await registry.connect(authority).setValue(streamId, 200);
      const receipt = await tx.wait();

      console.log("setValue (new round):", receipt.gasUsed.toString(), "gas");
    });
  });

  describe("Voting Gas", function () {
    let stream1, stream2;

    beforeEach(async function () {
      let tx;

      tx = await satori.createSimpleDataStream("Stream 1", authority.address);
      stream1 = await getStreamIdFromTx(tx, satori);

      tx = await satori.createSimpleDataStream("Stream 2", authority.address);
      stream2 = await getStreamIdFromTx(tx, satori);
    });

    it("Should measure vote gas (first burn for a game)", async function () {
      const tx = await satori.connect(alice).vote(stream1, VOTE);
      const receipt = await tx.wait();

      console.log("\n=== Voting Operations ===");
      console.log("vote (first burn for a game):", receipt.gasUsed.toString(), "gas");
    });

    it("Should measure vote gas (same voter, second game)", async function () {
      // Burn for one game...
      await voteFor(satori, alice, stream1);

      // ...then for another. A burn is never "moved": the first game keeps the
      // weight it bought, this buys stream2 its own.
      const tx = await satori.connect(alice).vote(stream2, VOTE);
      const receipt = await tx.wait();

      console.log("vote (same voter, second game):", receipt.gasUsed.toString(), "gas");
    });

    it("Should measure vote gas (top up the same game)", async function () {
      // First burn cold-writes the game's weight slot.
      await voteFor(satori, alice, stream1);

      // Second burn for the same game hits warm slots — the cheap repeat path.
      const tx = await satori.connect(alice).vote(stream1, VOTE);
      const receipt = await tx.wait();

      console.log("vote (top up same game):", receipt.gasUsed.toString(), "gas");
    });
  });

  // The token's transfer hook no longer touches voting at all (weight came from
  // tokens that were destroyed, so a balance move cannot affect it) — these
  // numbers should now track the plain non-voter transfer.
  describe("Transfer Gas (voters vs non-voters)", function () {
    let streamId;

    beforeEach(async function () {
      const tx = await satori.createSimpleDataStream("Stream", authority.address);
      streamId = await getStreamIdFromTx(tx, satori);
    });

    it("Should measure transfer between non-voters", async function () {
      const tx = await satori.connect(bob).transfer(carol.address, ethers.parseEther("100"));
      const receipt = await tx.wait();

      console.log("\n=== Token Transfers ===");
      console.log("transfer (non-voters):", receipt.gasUsed.toString(), "gas");
    });

    it("Should measure transfer to voter", async function () {
      // Alice burns for the stream
      await voteFor(satori, alice, streamId);

      // Owner transfers to Alice
      const tx = await satori.connect(owner).transfer(alice.address, ethers.parseEther("100"));
      const receipt = await tx.wait();

      console.log("transfer (to voter):", receipt.gasUsed.toString(), "gas");
    });

    it("Should measure transfer from voter", async function () {
      // Alice burns for the stream
      await voteFor(satori, alice, streamId);

      // Alice transfers to Carol (she has 100 - VOTE left after the burn)
      const tx = await satori.connect(alice).transfer(carol.address, ethers.parseEther("50"));
      const receipt = await tx.wait();

      console.log("transfer (from voter):", receipt.gasUsed.toString(), "gas");
    });

    it("Should measure transfer between voters", async function () {
      // Both burn for the same stream
      await voteFor(satori, alice, streamId);
      await voteFor(satori, bob, streamId);

      // Alice transfers to Bob (she has 100 - VOTE left after the burn)
      const tx = await satori.connect(alice).transfer(bob.address, ethers.parseEther("50"));
      const receipt = await tx.wait();

      console.log("transfer (between voters, same stream):", receipt.gasUsed.toString(), "gas");
    });
  });

  describe("Eligibility Operations", function () {
    let streams = [];

    beforeEach(async function () {
      // Create 5 streams
      for (let i = 0; i < 5; i++) {
        const tx = await satori.createSimpleDataStream(
          `Stream ${i}`,
          authority.address
        );
        const sid = await getStreamIdFromTx(tx, satori);
        streams.push(sid);
      }

      // Alice and Bob burn to give two of them weight
      await voteFor(satori, alice, streams[0]);
      await voteFor(satori, bob, streams[1]);
    });

    it("Should measure isEligible gas", async function () {
      // Warm up the state
      await voting.isEligible(streams[0]);

      // Measure
      const tx = await voting.isEligible.staticCall(streams[0]);

      console.log("\n=== Eligibility Checks ===");
      console.log("isEligible: view function (staticCall)");
    });

    it("Should measure the weighted-games leaderboard read", async function () {
      // The dual heap (and getEligibleGames with it) is gone: every enabled game
      // with weight earns, so the leaderboard is a paginated scan.
      const round = await satori.getCurrentRound();
      const [ids] = await voting.getGameWeights.staticCall(1, 100, round);
      expect(ids.length).to.be.greaterThan(0);

      console.log("getGameWeights:", "view function (staticCall)");
    });
  });

  describe("Query Operations", function () {
    let streamId;

    beforeEach(async function () {
      const tx = await satori.createSimpleDataStream("Test Stream", authority.address);
      streamId = await getStreamIdFromTx(tx, satori);
      await registry.connect(authority).setValue(streamId, 12345);
    });

    it("Should measure getValue gas", async function () {
      console.log("\n=== Query Operations ===");
      console.log("getValue: view function (staticCall)");
    });

    it("Should measure getDataStreamInfo gas", async function () {
      console.log("getDataStreamInfo: view function (staticCall)");
    });
  });
});
