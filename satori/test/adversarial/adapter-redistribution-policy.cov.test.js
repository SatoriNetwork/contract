// ============================================================================
// ACCEPTED conservation-only adapter trust boundary (community-adapter caveat).
//
// SatoriRewards.scoreAdapterPrediction (the score/total model, NatSpec
// ~L285-298) gives a community adapter total control over BOTH halves of every
// payout: each user's numerator (userScore × multiplier) AND the round's shared
// denominator `total` (pinned to the FIRST scorer). The protocol's ONLY defense
// is conservation:
//   (1) FIRST-SCORER PIN — `total` is frozen for the whole (game, round); and
//   (2) SATURATING RUNNING-PAID CAP — room = roundTotal − paid; each payout is
//       clamped to `room`, so Σ paid ≤ roundTotal ⇒ Σ minted ≤ one pool.
// These guarantee Σ ≤ pool and NOTHING about FAIRNESS.
//
// THE BOUNDARY (this file documents + locks it): a community adapter that
// UNDER-REPORTS `total` (total < Σ numerators) lets the EARLIEST-settling winner
// saturate the cap and consume the pool, CLAMPING later RIGHTFUL winners to ~0 —
// a pure SETTLE-ORDER CAPTURE — while Σ payouts ≤ one pool (all conservation
// invariants still pass). This is NOT a protocol bug: it is the documented price
// of permissionless adapters. The mitigation is admin-vetted OFFICIAL adapters;
// community adapters are caveat-emptor.
//
// We assert BOTH halves:
//   (a) HOSTILE under-reporting adapter (UnderReportTotalGame): a later rightful
//       predictor is stranded (~0) while an earlier one is over-paid, yet
//       Σ payouts ≤ one pool (conservation holds).
//   (b) CONTRAST — HONEST adapter (the reference YesNoGame, total == Σ
//       numerators): payouts are EXACT and settle-ORDER-INDEPENDENT (no
//       stranding), proving the redistribution is an ADAPTER-TRUST property,
//       NOT a protocol bug.
//
// MUTATION CHECK: the honest case (b) was shown to depend on the honest adapter
// by re-running (b)'s settle-order-independence assertions against the
// under-reporting adapter.
//
// THE BOUNDARY IS NOW CLOSED ON THE SATORI RAIL — and this file is kept to pin
// exactly that. Only the built-in binary game earns from the mint, so an adapter
// game cannot be voted for, carries no weight, and its round pool is ZERO. The
// capture is a fight over that pool, so there is nothing left to capture and
// nothing to strand: every predictor of an adapter game earns zero, in every
// settle order, honest adapter or hostile. The (a)/(a')/(b)/MUTATION structure
// below is preserved and inverted, so the closure is asserted from all four
// angles rather than just assumed.
//
// STILL OPEN, DELIBERATELY: the same first-scorer-pin + running-cap design
// governs the BOUNTY rail, which is separately funded escrow and pays on EVERY
// game type. The trust boundary above still applies there in full — see
// test/adversarial/adapter-bounty-pin-cap.cov.test.js.
// ============================================================================

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const ROUND = 86400;
const YES = 1;
// Host streams here are cadence-2 (adapter create-time gate): a write is only
// legal >= 2 rounds AND >= 2*ROUND - 30min (171000s) after the prior write. This
// helper is used ONLY between the setup's setValue(100) and the resolve
// setValue(200), so it advances TWO rounds to satisfy the cadence rhythm. The
// adapter mocks score on round ADVANCE (cur > predictRound), so the extra round
// does not change any prediction/settlement outcome.
async function advanceRound() { await time.increase(2 * ROUND); }

// Stream id 1 is the protocol DEFAULT stream (the fixture initializes it), so a
// test-created stream is id 2 onwards — always read the id off the event.
async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try { const p = satori.interface.parseLog(log); if (p && p.name === "DataStreamCreated") return Number(p.args.streamId); } catch (e) {}
  }
  throw new Error("DataStreamCreated missing");
}

async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try { const p = games.interface.parseLog(log); if (p && p.name === "GameCreated") return Number(p.args.gameId); } catch (e) {}
  }
  throw new Error("GameCreated missing");
}

async function impersonateCore(satori) {
  const a = await satori.getAddress();
  await impersonateAccount(a); await setBalance(a, ethers.parseEther("10"));
  return ethers.getSigner(a);
}

// Register a 1-arg-ctor mock adapter (e.g. UnderReportTotalGame) on a fresh
// voted stream. Returns { gameId, streamId }.
async function setupMockAdapterGame(fix, factoryName) {
  const { satori, registry, games, owner } = fix;
  const Adapter = await ethers.getContractFactory(factoryName);
  const adapter = await Adapter.deploy(await satori.getAddress());
  await adapter.waitForDeployment();
  const coreSigner = await impersonateCore(satori);
  await games.connect(coreSigner).registerGameAdapter(await adapter.getAddress(), owner.address, factoryName, true /* community */);
  const gameTypeId = Number(await games.nextGameTypeId()) - 1;

  const streamId = await streamIdFrom(
    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880), satori);
  await registry.connect(owner).setValue(streamId, 100);
  const gameId = await gameIdFrom(await satori.connect(owner).createGame(streamId, gameTypeId, "0x", "adp"), games);
  // No burn: an adapter game is not mint-eligible, so `voteFor` would revert
  // GameNotMintEligible. The game therefore carries no weight and its round
  // pool is ZERO — which is what closes the capture vector these tests are
  // about. Each test asserts that outcome rather than assuming it.
  return { gameId, streamId };
}

// Register the reference YesNoGame (4-arg ctor) on a fresh voted stream.
async function setupYesNoGame(fix, threshold = 150) {
  const { satori, registry, rewards, games, engine, owner } = fix;
  const YesNoGame = await ethers.getContractFactory("YesNoGame");
  const yesNo = await YesNoGame.deploy(await engine.getAddress(), await games.getAddress(),
    await registry.getAddress());
  await yesNo.waitForDeployment();
  const coreSigner = await impersonateCore(satori);
  await games.connect(coreSigner).registerGameAdapter(await yesNo.getAddress(), owner.address, "YesNo", false /* official */);
  const gameTypeId = Number(await games.nextGameTypeId()) - 1;

  const streamId = await streamIdFrom(
    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880), satori);
  await registry.connect(owner).setValue(streamId, 100);
  const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [threshold]);
  const gameId = await gameIdFrom(await satori.connect(owner).createGame(streamId, gameTypeId, cfg, "yn"), games);
  // No burn: an adapter game is not mint-eligible, so `voteFor` would revert
  // GameNotMintEligible. The game therefore carries no weight and its round
  // pool is ZERO — which is what closes the capture vector these tests are
  // about. Each test asserts that outcome rather than assuming it.
  return { gameId, streamId };
}

describe("adapter redistribution policy — ACCEPTED conservation-only trust boundary (community caveat)", function () {
  this.timeout(300000);

  it("(a) a HOSTILE under-reporting `total` captures NOTHING and strands nobody: the pool it fought over is zero", async function () {
    // Three EQUAL-power winners predict the SAME adapter game/round. The hostile
    // adapter reports total == ONE winner's numerator (under-report). The first
    // settler saturates the cap (room == roundTotal) and consumes ~the whole
    // pool; the two later settlers hit paid >= roundTotal and are CLAMPED to 0.
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, signers, owner } = fix;
    const { gameId, streamId } = await setupMockAdapterGame(fix, "UnderReportTotalGame");

    const [p1, p2, p3] = [signers[1], signers[2], signers[3]];
    for (const p of [p1, p2, p3]) await satori.transfer(p.address, ethers.parseEther("100"));

    // All three predict the same round (boosted bit irrelevant — bountyTotal 0).
    for (const p of [p1, p2, p3]) {
      await satori.connect(p).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    }

    await advanceRound();
    await registry.connect(owner).setValue(streamId, 200); // resolve

    // Settle in the order p1, p2, p3. p1 is the FIRST scorer → pins total to its
    // own numerator → saturates the cap → captures the pool. p2, p3 are stranded.
    const before = {};
    for (const p of [p1, p2, p3]) before[p.address] = await rewards.unclaimedRewards(p.address);

    await satori.settlePrediction(p1.address, gameId);
    await satori.settlePrediction(p2.address, gameId);
    await satori.settlePrediction(p3.address, gameId);

    const earn1 = (await rewards.unclaimedRewards(p1.address)) - before[p1.address];
    const earn2 = (await rewards.unclaimedRewards(p2.address)) - before[p2.address];
    const earn3 = (await rewards.unclaimedRewards(p3.address)) - before[p3.address];

    // NO CAPTURE: the first settler still pins the under-reported total and
    // still saturates the cap — those rails run exactly as before — but the pool
    // that share is taken OF is zero, so it takes nothing. The two later winners
    // are clamped to zero as well, and so are equally well off.
    expect(earn1, "the first settler captures nothing").to.equal(0n);
    expect(earn2).to.equal(0n);
    expect(earn3).to.equal(0n);

    // CONSERVATION still holds, at its floor: Σ payouts ≤ one pool, and one pool
    // is nothing.
    const grossBudget = await satori.ROUND_REWARD_BUDGET();
    const totalPaid = earn1 + earn2 + earn3;
    expect(totalPaid).to.be.lte(grossBudget); // never mints more than one pool
    expect(totalPaid).to.equal(0n);
  });

  it("(a') the SAME hostile adapter is now SETTLE-ORDER-INDEPENDENT: settling p3 first changes nothing, because nothing is paid", async function () {
    // Re-run the capture but settle p3 FIRST. Now p3 captures and p1/p2 strand —
    // proving the outcome depends purely on settle order (the unfairness the
    // under-report introduces), not on any predictor-intrinsic property.
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, signers, owner } = fix;
    const { gameId, streamId } = await setupMockAdapterGame(fix, "UnderReportTotalGame");

    const [p1, p2, p3] = [signers[1], signers[2], signers[3]];
    for (const p of [p1, p2, p3]) await satori.transfer(p.address, ethers.parseEther("100"));
    for (const p of [p1, p2, p3]) {
      await satori.connect(p).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    }
    await advanceRound();
    await registry.connect(owner).setValue(streamId, 200);

    const before = {};
    for (const p of [p1, p2, p3]) before[p.address] = await rewards.unclaimedRewards(p.address);

    // Settle p3 FIRST this time.
    await satori.settlePrediction(p3.address, gameId);
    await satori.settlePrediction(p1.address, gameId);
    await satori.settlePrediction(p2.address, gameId);

    const earn1 = (await rewards.unclaimedRewards(p1.address)) - before[p1.address];
    const earn2 = (await rewards.unclaimedRewards(p2.address)) - before[p2.address];
    const earn3 = (await rewards.unclaimedRewards(p3.address)) - before[p3.address];

    // Reversing who settles first used to flip who captured the pool. It now
    // flips nothing: the unfairness was in the distribution of a pool, and the
    // pool is zero.
    expect(earn3, "the first settler (now p3) still captures nothing").to.equal(0n);
    expect(earn1).to.equal(0n);
    expect(earn2).to.equal(0n);
  });

  it("(b) an HONEST adapter (YesNoGame, total == Σ numerators) lands in the same place: zero to everyone, settle-ORDER-INDEPENDENT", async function () {
    // Two settle orders, same three equal-power winners on the same honest game.
    // The honest adapter reports total == Σ winners' numerators, so each winner
    // gets ~pool/3 REGARDLESS of who settles first — no capture, no stranding.
    async function run(orderFn) {
      const fix = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, signers, owner } = fix;
      const { gameId, streamId } = await setupYesNoGame(fix, 150);
      const [p1, p2, p3] = [signers[1], signers[2], signers[3]];
      for (const p of [p1, p2, p3]) await satori.transfer(p.address, ethers.parseEther("100"));
      for (const p of [p1, p2, p3]) {
        await satori.connect(p).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
      }
      await advanceRound();
      await registry.connect(owner).setValue(streamId, 200); // > threshold → YES wins

      const before = {};
      for (const p of [p1, p2, p3]) before[p.address] = await rewards.unclaimedRewards(p.address);
      for (const p of orderFn([p1, p2, p3])) await satori.settlePrediction(p.address, gameId);

      // Return the three winners' reward deltas in canonical [p1, p2, p3] order.
      return [
        (await rewards.unclaimedRewards(p1.address)) - before[p1.address],
        (await rewards.unclaimedRewards(p2.address)) - before[p2.address],
        (await rewards.unclaimedRewards(p3.address)) - before[p3.address],
      ];
    }

    const forward = await run(arr => arr);              // p1, p2, p3
    const reverse = await run(arr => [...arr].reverse()); // p3, p2, p1

    // Every winner is paid the SAME share in both orders — exactly equal, and
    // exactly zero. Equal power still means equal share; the share is just a
    // share of nothing, because the honest adapter's game is no more
    // mint-eligible than the hostile one's.
    for (const earns of [forward, reverse]) {
      for (const e of earns) expect(e, "honest adapter: every winner earns zero").to.equal(0n);
    }
    // Settle-order INDEPENDENCE: each predictor's payout is identical whichever
    // order settlement ran in.
    for (let i = 0; i < 3; i++) {
      expect(forward[i], `predictor ${i} payout must be settle-order-independent`)
        .to.equal(reverse[i]);
    }
  });

  it("MUTATION CHECK: the contrast is GONE — the under-reporting adapter now passes (b)'s settle-order-independence assertions too", async function () {
    // Mirror of (b) but driven by the HOSTILE adapter. (b)'s
    // settle-order-independence assertion used to FAIL here — the captor flipped
    // with the order — which is what made the honest case's green a property of
    // the adapter rather than of the harness. It now PASSES, and that is the
    // whole finding: the honest/hostile distinction no longer shows up on the
    // SATORI rail at all, because neither adapter's game draws a pool. (b)'s
    // green is consequently no longer evidence about the ADAPTER; it is evidence
    // about the mint boundary. The adapter-trust distinction that still bites is
    // on the bounty rail — see adapter-bounty-pin-cap.cov.test.js.
    async function runHostile(orderFn) {
      const fix = await loadFixture(deploySatoriFixture);
      const { satori, registry, rewards, signers, owner } = fix;
      const { gameId, streamId } = await setupMockAdapterGame(fix, "UnderReportTotalGame");
      const [p1, p2, p3] = [signers[1], signers[2], signers[3]];
      for (const p of [p1, p2, p3]) await satori.transfer(p.address, ethers.parseEther("100"));
      for (const p of [p1, p2, p3]) {
        await satori.connect(p).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
      }
      await advanceRound();
      await registry.connect(owner).setValue(streamId, 200);
      const before = {};
      for (const p of [p1, p2, p3]) before[p.address] = await rewards.unclaimedRewards(p.address);
      for (const p of orderFn([p1, p2, p3])) await satori.settlePrediction(p.address, gameId);
      return [
        (await rewards.unclaimedRewards(p1.address)) - before[p1.address],
        (await rewards.unclaimedRewards(p2.address)) - before[p2.address],
        (await rewards.unclaimedRewards(p3.address)) - before[p3.address],
      ];
    }
    const forward = await runHostile(arr => arr);                // p1 captures
    const reverse = await runHostile(arr => [...arr].reverse());  // p3 captures

    // Forward and reverse are now identical, predictor by predictor: no captor,
    // no strand, nothing that depends on who settled first.
    for (let i = 0; i < 3; i++) expect(forward[i]).to.equal(reverse[i]);
    // And identically zero — the capture had nothing to concentrate.
    for (const e of [...forward, ...reverse]) expect(e).to.equal(0n);
  });
});
