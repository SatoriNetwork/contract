/**
 * F28/F29 — the SatoriRewardsLens pending-delegator walk is now BUDGETED and
 * reports completeness. A long-lapse delegator's view previously walked
 * O(rounds-since-claim) cross-contract staticcalls uncapped and could exceed the
 * eth_call gas cap — reverting for exactly the users with the most pending. It now
 * caps the walk and returns (total, complete): complete=true when the whole walk
 * fit the budget, false (with a partial `total`) when it was truncated. The real
 * claim path still pays in full (F6).
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
// The per-stream value-provider cut is gone, so the 3-arg cadence-only
// overload is the whole createSimpleDataStream signature now.
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}
async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

describe("F28/F29 — lens pending walk is budgeted and reports completeness", function () {
  it("full lens reports complete=true; a small-budget harness truncates to (partial, false)", async function () {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const fix = await deploySatoriFixtureNoFee();
    const { satori, rewards, registry, lens } = fix;

    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(bob.address, ethers.parseEther("200"));
    await satori.transfer(carol.address, ethers.parseEther("50"));
    await satori.transfer(dave.address, ethers.parseEther("50"));

    const quickId = await streamIdFrom(await satori[SIMPLE3]("Quick", owner.address, 1440), satori);
    const slowId = await streamIdFrom(await satori[SIMPLE3]("Slow", owner.address, 1440), satori);
    await satori.connect(carol).vote(quickId, VOTE);
    await satori.connect(dave).vote(slowId, VOTE);
    await advanceRound();

    // alice delegates her prediction power to bob; bob wins one round so alice has
    // NONZERO pending, then many rounds pass with no claim so the forward walk
    // spans well past the harness budget.
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);
    await registry.setValue(quickId, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: quickId, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(quickId, 110);
    await advanceRound();
    await registry.setValue(quickId, 120);
    await satori.connect(carol).settlePrediction(bob.address, quickId);
    for (let i = 0; i < 8; i++) await advanceRound(); // long lapse — many forward rounds, no claim

    // Full lens (budget 4096): the whole walk fits -> complete, and it's the real
    // pending.
    const [full, fullComplete] = await lens.pendingDelegatorRewards(alice.address);
    expect(fullComplete).to.equal(true);
    expect(full).to.be.gt(0n);

    // Small-budget harness (same core + rewards as the real lens): the walk is
    // truncated -> complete=false, partial <= full.
    const coreAddr = await lens.satoriCore();
    const Harness = await ethers.getContractFactory("LensCapHarness");
    const harness = await Harness.deploy(coreAddr, await rewards.getAddress(), 2);

    const [partial, partComplete] = await harness.pendingDelegatorRewards(alice.address);
    expect(partComplete).to.equal(false);       // budget exhausted before the walk finished
    expect(partial).to.be.lte(full);            // a subset of the rounds

    // getTotalClaimableRewards returns (total, complete) and propagates the flag.
    const [, totComplete] = await harness.getTotalClaimableRewards(alice.address);
    expect(totComplete).to.equal(false);
    const [fullTot, fullTotComplete] = await lens.getTotalClaimableRewards(alice.address);
    expect(fullTotComplete).to.equal(true);
    expect(fullTot).to.be.gt(0n);
  });

  // REGRESSION (pre-launch review M-1): the walk charges 2 to the budget per
  // open round and per post-lag forward round, but the loop checks used to run
  // BEFORE the charge. With one unit of budget left the check passed, `used`
  // finished at budget + 1, and the caller's `budget -= used` underflowed —
  // Panic(0x11) on the very view whose docs promise "never reverts", for
  // exactly the long-lapse delegators the budget protects. Any ODD budget with
  // an even walk parity (or vice versa) triggered it; budget 3 on this scenario
  // reproduced it deterministically. The checks now charge-then-compare
  // (`used + cost > budget`) and the caller's subtraction saturates.
  it("odd/even budget parity never underflows — truncates cleanly at every tiny cap", async function () {
    const [owner, alice, bob, carol, dave] = await ethers.getSigners();
    const fix = await deploySatoriFixtureNoFee();
    const { satori, rewards, registry, lens } = fix;

    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(bob.address, ethers.parseEther("200"));
    await satori.transfer(carol.address, ethers.parseEther("50"));
    await satori.transfer(dave.address, ethers.parseEther("50"));

    const quickId = await streamIdFrom(await satori[SIMPLE3]("Quick", owner.address, 1440), satori);
    await satori.connect(carol).vote(quickId, VOTE);
    await advanceRound();

    await satori.connect(alice).delegatePredictionPower(bob.address);
    await time.increase(86400);
    await registry.setValue(quickId, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: quickId, payload: pack1(UP) }]);
    await advanceRound();
    await registry.setValue(quickId, 110);
    await advanceRound();
    await registry.setValue(quickId, 120);
    await satori.connect(carol).settlePrediction(bob.address, quickId);
    for (let i = 0; i < 8; i++) await advanceRound();

    const [full] = await lens.pendingDelegatorRewards(alice.address);
    const coreAddr = await lens.satoriCore();
    const Harness = await ethers.getContractFactory("LensCapHarness");

    for (const cap of [1, 2, 3, 4, 5]) {
      const harness = await Harness.deploy(coreAddr, await rewards.getAddress(), cap);
      // The whole point: these calls must TRUNCATE, never revert.
      const [partial, complete] = await harness.pendingDelegatorRewards(alice.address);
      expect(complete, `cap ${cap}`).to.equal(false);
      expect(partial, `cap ${cap}`).to.be.lte(full);
      const [, totComplete] = await harness.getTotalClaimableRewards(alice.address);
      expect(totComplete, `cap ${cap}`).to.equal(false);
    }
  });
});
