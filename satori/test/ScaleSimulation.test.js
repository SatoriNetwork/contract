const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

function rng(seed) {
  let state = BigInt(seed);
  const a = 1103515245n;
  const c = 12345n;
  const m = 2n ** 31n;
  return () => {
    state = (a * state + c) % m;
    return Number(state);
  };
}

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

// A public caller may only create streams at cadence >= 2 rounds, and
// `createSimpleDataStream(name, provider)` now hands out exactly that. SIM-A and
// SIM-B are refreshed once per simulation step, so a step spans CADENCE_ROUNDS
// protocol rounds — that is the rhythm a real user's stream runs at.
const CADENCE_ROUNDS = 2;

async function advanceCadence() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceToNextRound();
}

describe("Scale Simulation", function () {
  it("handles multi-user mixed behavior over many rounds with core invariants", async function () {
    this.timeout(180000);

    const fix = await deploySatoriFixture();
    const { satori, voting, rewards, registry, games, bounties, owner } = fix;
    const signers = fix.signers;
    const users = signers.slice(1, 13); // 12 users

    // Game/stream id 1 is the protocol's DEFAULT game (created by the fixture's
    // initializeDefaultStream), so the first stream this test creates is id 2.
    // Capture both ids from the creation events rather than hardcoding.
    const streamIdFrom = async (tx) => {
      const rcpt = await (await tx).wait();
      for (const log of rcpt.logs) {
        try {
          const p = satori.interface.parseLog(log);
          if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
        } catch (e) {}
      }
      throw new Error("DataStreamCreated event missing");
    };
    const streamA = await streamIdFrom(satori.createSimpleDataStream("SIM-A", owner.address));
    const streamB = await streamIdFrom(satori.createSimpleDataStream("SIM-B", owner.address));

    const allocation = ethers.parseEther("50");
    for (const user of users) {
      await satori.transfer(user.address, allocation);
    }

    // give both streams weight so they earn
    await voteFor(satori, users[0], streamA);
    await voteFor(satori, users[1], streamB);

    await advanceToNextRound();
    await registry.setValue(streamA, 1000);
    await registry.setValue(streamB, 2000);

    const initialSupply = await satori.totalSupply();
    let observedClaim = false;
    // Voting BURNS, so supply can now fall as well as rise. Track every burn the
    // simulation performs so the supply invariants below stay exact rather than
    // being loosened: minting is still the only thing that can grow the supply.
    let burned = 0n;
    const SIM_VOTE = ethers.parseEther("1");
    const nextRand = rng(1337);

    const roundBudget = await satori.ROUND_REWARD_BUDGET();

    for (let round = 0; round < 15; round++) {
      await advanceCadence();

      await registry.setValue(streamA, 1000 + (round + 1) * 3);
      await registry.setValue(streamB, 2000 - (round + 1) * 2);

      for (const user of users) {
        const action = nextRand() % 5;

        if (action === 0) {
          const dir = (nextRand() % 2) + 1;
          try { await satori.connect(user).predictMultipleWithPayloads([{ gameId: streamA, payload: pack1(dir) }]); } catch {}
        } else if (action === 1) {
          const dir = (nextRand() % 2) + 1;
          try { await satori.connect(user).predictMultipleWithPayloads([{ gameId: streamB, payload: pack1(dir) }]); } catch {}
        } else if (action === 2) {
          nextRand(); // keep the RNG stream identical to the pre-burn version
          const streamId = (nextRand() % 2) === 0 ? streamA : streamB;
          try {
            await satori.connect(user).vote(streamId, SIM_VOTE);
            burned += SIM_VOTE;
          } catch {}
        } else if (action === 3) {
          const delegate = users[nextRand() % users.length];
          try { await satori.connect(user).delegatePredictionPower(delegate.address); } catch {}
        } else {
          try {
            const amount = await satori.connect(user).claim.staticCall();
            if (amount > 0n) observedClaim = true;
            await satori.connect(user).claim();
          } catch {}
        }
      }

      const supplyNow = await satori.totalSupply();
      // Supply moves by (minted - burned); adding the burns back recovers the
      // mint-only figure the invariant is really about.
      const minted = supplyNow + burned - initialSupply;
      expect(minted).to.be.gte(0n);

      // One round's budget per PROTOCOL round, and each simulation step is a
      // whole cadence period (CADENCE_ROUNDS protocol rounds) long.
      const maxMintBound = roundBudget * BigInt((round + 1) * CADENCE_ROUNDS);
      expect(minted).to.be.lte(maxMintBound);
    }

    expect(await registry.streamExists(streamA)).to.equal(true);
    expect(await registry.streamExists(streamB)).to.equal(true);
    expect((await satori.totalSupply()) + burned).to.be.gte(initialSupply);
    // The vote arm is wrapped in try/catch (a voter who predicted last round is
    // still transfer-locked), so pin that it actually fired at least once —
    // otherwise `burned` would stay 0 and the supply invariant above would
    // quietly degrade back into the pre-burn one.
    expect(burned).to.be.gt(0n);

    // Claim attempts may all be zero depending on random action ordering,
    // but attempting claim must never violate supply bounds/invariants above.
    observedClaim;
  });
});
