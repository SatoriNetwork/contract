const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

function rng(seed) {
  let state = BigInt(seed);
  const a = 1664525n;
  const c = 1013904223n;
  const m = 2n ** 32n;
  return () => {
    state = (a * state + c) % m;
    return Number(state);
  };
}

async function advanceToNextRound() {
  const now = await time.latest();
  const nextMidnight = Math.floor(now / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

// A public caller may only create streams at cadence >= 2 rounds, and
// `createSimpleDataStream(name, provider)` now hands out exactly that. S1/S2/S3
// are refreshed once per stress step, so a step spans a whole cadence period.
const CADENCE_ROUNDS = 2;

async function advanceCadence() {
  for (let i = 0; i < CADENCE_ROUNDS; i++) await advanceToNextRound();
}

describe("Stress: SeededScenario20Users", function () {
  it("runs seeded mixed actions over 20 rounds with invariants", async function () {
    this.timeout(240000);

    const fix = await deploySatoriFixture();
    const { satori, voting, rewards, registry, games, bounties, owner } = fix;
    const signers = fix.signers;
    const participants = [owner, ...signers.slice(1, 20)]; // 20 participants total

    // 3 streams for mixed traffic. The fixture initializes the DEFAULT stream
    // at id 1, so these land at 2/3/4 — captured from the events, not assumed.
    const streamIds = [];
    for (const name of ["S1", "S2", "S3"]) {
      const rc = await (await satori.createSimpleDataStream(name, owner.address)).wait();
      streamIds.push(Number(rc.logs
        .map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
        .find((p) => p && p.name === "DataStreamCreated").args.streamId));
    }
    const [s1, s2, s3] = streamIds;

    // fund all non-owner participants
    const funded = participants.slice(1);
    for (const user of funded) {
      await satori.transfer(user.address, ethers.parseEther("30"));
    }

    // bootstrap weight. Each burn is small (2 of a 30-ether balance) so the
    // participants keep almost all their prediction power.
    const BOOTSTRAP_BURN = ethers.parseEther("2");
    let totalBurned = 0n;
    for (let i = 0; i < 3; i++) {
      await voteFor(satori, participants[i + 1], streamIds[i], BOOTSTRAP_BURN);
    }

    await advanceToNextRound();
    await registry.setValue(s1, 1000);
    await registry.setValue(s2, 2000);
    await registry.setValue(s3, 3000);

    const initialSupply = await satori.totalSupply();
    const next = rng(424242);
    const LOOP_BURN = ethers.parseEther("1");

    const roundBudget = await satori.ROUND_REWARD_BUDGET();

    for (let round = 1; round <= 20; round++) {
      await advanceCadence();
      await registry.setValue(s1, 1000 + round * 2);
      await registry.setValue(s2, 2000 - round * 3);
      await registry.setValue(s3, 3000 + round);

      // perform actions for first 10 participants each round for runtime control
      for (const user of participants.slice(0, 10)) {
        const action = next() % 6;

        try {
          if (action === 0) {
            await satori.connect(user).predictMultipleWithPayloads([{ gameId: s1, payload: pack1((next() % 2) + 1) }]);
          } else if (action === 1) {
            await satori.connect(user).predictMultipleWithPayloads([{ gameId: s2, payload: pack1((next() % 2) + 1) }]);
          } else if (action === 2) {
            await satori.connect(user).vote(streamIds[next() % streamIds.length], LOOP_BURN);
            // only reached when the vote succeeded — the burn really happened
            totalBurned += LOOP_BURN;
          } else if (action === 3) {
            const delegate = participants[next() % participants.length];
            await satori.connect(user).delegatePredictionPower(delegate.address);
          } else if (action === 4) {
            const amount = await satori.connect(user).claim.staticCall();
            if (amount > 0n) await satori.connect(user).claim();
          } else {
            // cheap read action to keep action diversity
            await rewards.getPredictionPower(user.address);
          }
        } catch {
          // Intentional: seeded stress includes invalid/blocked paths.
          // We assert global invariants below regardless of local reverts.
        }
      }

      // Voting now BURNS, so total supply is no longer monotonically rising —
      // the invariant is on the MINT side: minted = Δsupply + burned, which must
      // be non-negative and never exceed the per-round budget.
      const supplyNow = await satori.totalSupply();
      const minted = supplyNow - initialSupply + totalBurned;
      expect(minted).to.be.gte(0n);

      // One round's budget per PROTOCOL round, and each stress step is a whole
      // cadence period (CADENCE_ROUNDS protocol rounds) long.
      const maxMintBound = roundBudget * BigInt(round * CADENCE_ROUNDS);
      expect(minted).to.be.lte(maxMintBound);
    }

    for (const id of streamIds) expect(await registry.streamExists(id)).to.equal(true);
  });
});
