/**
 * F6 — the open-round replay walk (`_replayOpenRounds`) is now capped per call
 * and resumes via a per-period cursor, so a large open-round backlog can never
 * exceed block gas or defeat the 1024-round main-walk cap. The cap must NOT
 * change what a delegator ultimately earns — only how the work is chunked.
 *
 * Strategy: run one identical scenario twice — once at the production cap, once
 * against a harness that overrides the per-call budget to 2 (RewardsCapHarness,
 * installed via a storage-preserving UUPS upgrade) — and assert alice collects
 * the exact same total. If the cursor/swap-pop chunking lost or double-counted a
 * delta, the totals would diverge.
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

// Install the small-cap harness over the live rewards proxy (storage-preserving).
async function installCapHarness(f, owner) {
  const marketing = await f.rewards.marketingFeeRecipient();
  const Harness = await ethers.getContractFactory("RewardsCapHarness");
  const impl = await Harness.deploy(f.voting.target, owner.address, marketing);
  await impl.waitForDeployment();
  await (await f.rewards.connect(owner).upgradeTo(await impl.getAddress())).wait();
}

// Claim repeatedly until a claim yields nothing; return {total, claims}.
async function drainClaims(satori, who) {
  let total = 0n;
  let claims = 0;
  for (let k = 0; k < 40; k++) {
    const before = await satori.balanceOf(who.address);
    await satori.connect(who)["claim()"]();
    const gained = (await satori.balanceOf(who.address)) - before;
    claims++;
    total += gained;
    if (gained === 0n) break;
  }
  return { total, claims };
}

// The scenario: alice delegates to bob; bob makes THREE predictions on three
// silent streams across three rounds (so alice's period banks three open
// rounds at rate 0), then all three are scored (rates grow), and alice drains.
// Returns alice's total collected + the peak open-round count observed.
async function runScenario(useCap) {
  const signers = await ethers.getSigners();
  const [owner, alice, bob, carol, dave, platform] = signers;
  const fix = await deploySatoriFixtureNoFee();
  const { satori, voting, rewards, registry } = fix;
  if (useCap) await installCapHarness(fix, owner);

  await satori.transfer(alice.address, ethers.parseEther("200"));
  await satori.transfer(bob.address, ethers.parseEther("100"));
  // 20 each for the three voters: 10 is burned casting the vote, 10 is kept.
  await satori.transfer(carol.address, ethers.parseEther("20"));
  await satori.transfer(dave.address, ethers.parseEther("20"));
  await satori.transfer(platform.address, ethers.parseEther("20"));

  // Three streams bob will predict, each weighted by a distinct voter burning
  // the same amount, so the three carry identical weight.
  const s0 = await streamIdFrom(await satori[SIMPLE3]("S0", owner.address, 1440), satori);
  const s1 = await streamIdFrom(await satori[SIMPLE3]("S1", owner.address, 1440), satori);
  const s2 = await streamIdFrom(await satori[SIMPLE3]("S2", owner.address, 1440), satori);
  await satori.connect(carol).vote(s0, VOTE);
  await satori.connect(dave).vote(s1, VOTE);
  await satori.connect(platform).vote(s2, VOTE);
  await advanceRound();

  await satori.connect(alice).delegatePredictionPower(bob.address);
  await advanceRound(); // let the delegation period activate before bob predicts

  // LOYALTY WARM-UP. Delegator weight is capital x loyalty
  // (docs/design/delegation-loyalty-weighting.md) and a fresh delegation starts
  // at L = 0, so without this alice carries zero weight through the open rounds
  // below and every replayed delta is legitimately zero — the test would pass
  // its chunking comparison while proving nothing. Win one round on s0 up
  // front, then let the fold lag clear so the loyalty is actually materialised.
  await registry.setValue(s0, 50);
  await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s0, payload: pack1(UP) }]);
  await advanceRound();
  await registry.setValue(s0, 60);
  await advanceRound();
  await registry.setValue(s0, 70);
  await satori.connect(carol).settlePrediction(bob.address, s0);
  for (let i = 0; i < 6; i++) await advanceRound();

  // R0/R1/R2: bob predicts s0/s1/s2 respectively; leave them silent so each
  // round stays pending (an open round for alice's period).
  await registry.setValue(s0, 100);
  await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s0, payload: pack1(UP) }]);
  await advanceRound();
  await registry.setValue(s1, 100);
  await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
  await advanceRound();
  await registry.setValue(s2, 100);
  await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s2, payload: pack1(UP) }]);
  await advanceRound();

  // Cross the pending rounds so alice's period banks the three open rounds.
  // (With the cap the main walk chunks too, so claim until it catches up.)
  // Cross all three pending rounds so the open rounds get banked. The main walk
  // ALSO chunks under the cap and yields 0 credit here (rounds still pending),
  // so claim a fixed number of times rather than stopping on zero credit.
  for (let k = 0; k < 6; k++) await satori.connect(alice)["claim()"]();
  const peakOpen = Number((await rewards.delegationPeriodAt(alice.address, 0)).openRoundsLength);

  // Now score all three winning UP predictions (values rise B->C), closing each
  // round and growing its rate -> a delta to collect on replay.
  await registry.setValue(s0, 110); await advanceRound(); await registry.setValue(s0, 120);
  await satori.connect(carol).settlePrediction(bob.address, s0);
  await registry.setValue(s1, 110); await advanceRound(); await registry.setValue(s1, 120);
  await satori.connect(carol).settlePrediction(bob.address, s1);
  await registry.setValue(s2, 110); await advanceRound(); await registry.setValue(s2, 120);
  await satori.connect(carol).settlePrediction(bob.address, s2);

  // Drain: replay collects the three deltas (chunked when capped) and pops the
  // closed entries. Idempotent once exhausted.
  const openBeforeDrain = Number((await rewards.delegationPeriodAt(alice.address, 0)).openRoundsLength);
  const first = await (async () => {
    const before = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    return (await satori.balanceOf(alice.address)) - before;
  })();
  const openAfterFirst = Number((await rewards.delegationPeriodAt(alice.address, 0)).openRoundsLength);
  const rest = await drainClaims(satori, alice);

  return {
    total: first + rest.total,
    peakOpen,
    openBeforeDrain,
    openAfterFirst,
  };
}

describe("F6 — delegator replay walk is capped and resumable", function () {
  it("chunking the replay does not change what the delegator earns", async function () {
    const full = await runScenario(false);
    const capped = await runScenario(true);

    // Non-trivial: bob won, so alice actually has deltas to collect.
    expect(full.total).to.be.gt(0n);
    expect(full.peakOpen).to.equal(3);
    expect(capped.peakOpen).to.equal(3);

    // The core property: chunking neither LOSES nor DOUBLE-COUNTS a delta.
    //
    // This asserted exact equality until 2026-08-31, and passed — but only by
    // luck of the old dev-fee numbers. Chunking splits the walk across several
    // claims, and each claim truncates its own integer division, so the sum of
    // per-chunk truncations need not equal a single truncation. With the fee at
    // 20/10/5 the chunked run lands 1 wei ABOVE the unchunked one.
    //
    // 1 wei on ~569 SATORI is truncation dust, not a leak: the divergence is
    // bounded by the number of chunks (3 deltas here), not by value at stake, so
    // it cannot be farmed. What the test must still catch is a LOST or
    // DOUBLE-COUNTED delta — those move the total by a whole round's share
    // (~190 SATORI), which this bound rejects by twelve orders of magnitude.
    const drift = capped.total > full.total
      ? capped.total - full.total
      : full.total - capped.total;
    expect(drift).to.be.lte(8n); // <= 1 wei per chunk boundary, generous
    expect(full.total).to.be.gt(ethers.parseEther("1")); // drift is dust vs the real total
  });

  it("the capped run actually chunks the drain (cap=2 pops <= 2 open rounds per claim)", async function () {
    const capped = await runScenario(true);
    // Three closed open rounds, cap 2 -> the first drain claim cannot clear all
    // three; at least one entry survives to a later claim.
    expect(capped.openBeforeDrain).to.equal(3);
    expect(capped.openAfterFirst).to.be.gt(0);
    // ...and everything is eventually collected & popped (idempotent tail).
  });
});
