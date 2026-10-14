/**
 * Adversarial regression guard — NO DOUBLE-PAY / NO MIS-PAY after removing the
 * `_gameTokenSeen` gate from `creditBountyForWin` (SatoriBounties.sol).
 *
 * THREAT: `creditBountyForWin` now iterates the user's per-(user, round)
 * `boostedTokensInRound` set, which is the DEDUPED UNION of every token the
 * user snapshotted across EVERY game they predicted that round. The old
 * `_gameTokenSeen[gameId][tk]` gate inside the loop is gone. So when settling
 * game B, the loop also visits tokens the user only ever snapshotted for game A.
 * If the per-game guard downstream were wrong, a token funded only on A could
 * pay out when settling B (MIS-PAY), or a token funded on both games could be
 * counted more than once per (game,round) (DOUBLE-PAY). The ONLY thing standing
 * between the union-walk and a cross-game leak is the early return in
 * `_accrueBountyForWinToken` when this game's snapshot
 * `boostStakeForPrediction[user][gameId][round][tk] == 0`.
 *
 * SETUP: one stream → gameA (== streamId) + one extra gameB on the same stream.
 *   - Token X (USDC): funded on BOTH gameA and gameB (100/100 each → drains in
 *     one round on each game so cleanup becomes permitted).
 *   - Token Y (DAI):  funded ONLY on gameA (100/100).
 *   Alice and Bob each stake EQUAL real amounts of X (100) and Y (100), and
 *   each predicts BOTH games UP in the same round, correctly.
 *
 * PROPERTIES ASSERTED (all must HOLD → GREEN; any failure is a REAL bug):
 *   (1) MIS-PAY GUARD: token Y is funded only on gameA. Y is in each user's
 *       round union (snapshotted for A), so the gameB credit loop VISITS Y —
 *       but the per-game snapshot for B is zero, so settling gameB must pay
 *       ZERO of Y to anyone. (Y's whole pot is the gameA pot.)
 *   (2) NO DOUBLE-PAY / EQUAL-STAKE-EQUAL-SHARE: Alice and Bob have identical
 *       real stake and identical predictions, so they must earn IDENTICAL
 *       amounts in every token. The multi-game predictor is NOT multiplied:
 *       Alice's X total == her gameA-X share + her gameB-X share, each
 *       computed independently against that game's own pot/totalBoost.
 *   (3) PER-GAME CONSERVATION: for each (game, token), Σ(winner shares + fee)
 *       over correct predictors is <= that game's dripped pot (== pot, modulo
 *       dust). No token is paid more than once per (game, round).
 *   (4) CLEANUP IS INERT: cleaning up token X on gameA mid-sequence (after A is
 *       settled & drained) does NOT change gameB's still-pending X payouts.
 *
 * If any assertion fails, that is a REAL accounting bug — report it; do NOT
 * contort the test to pass.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , voteFor } = require("../fixtures");

const UP = 1;
const E = (n) => ethers.parseEther(String(n));

async function advanceOneDay() { await time.increase(86400); }

async function deployMockToken(sym) {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

// Stream cadence floor: a PUBLIC caller may only create streams with
// round-length (>= 1440 minute) cadence; sub-round streams are admin-only. This
// test's subject is bounty pool/drip/stake mechanics, not stream rhythm, so it
// keeps the fast (720-minute, sub-round) beat by having the ADMIN (`owner`)
// create the stream. `authority` stays the stream's PROVIDER, so
// it is still the account that writes values.
async function createStream(satori, signer, name, authority) {
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 720);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

// Create an EXTRA game on an existing stream; return its gameId (!= streamId).
// GameCreated is emitted by the SatoriGames child, so parse with its interface.
async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}
async function fundOn(bounties, funder, game, tokenAddr, amount, rate) {
  await bounties.connect(funder).fundBounty(game, tokenAddr, amount, rate);
}

// RE-ENABLED 2026-07-30 (skip triage). The prior deferral correctly established
// that BOTH games must be BINARY -- adapter predictions never call
// `SatoriBounties.applyBoost`, so an adapter gameB snapshots zero and no bounty on
// it ever drains -- but concluded the property was unstageable. It considered only
// two binary games on ONE stream (now DuplicateBinaryGame) and binary+adapter on one
// stream (no boost). Two binary games on TWO streams satisfies "both binary" and is
// what this file now uses; the union-walk property never depended on a shared stream.
describe("adv — no-_gameTokenSeen multi-game: union-walk must not mis-pay or double-pay", function () {
  this.timeout(300000);

  let satori, rewards, bounties, registry, games, owner;
  let alice, bob, funder, authority;
  let usd, usdAddr, dai, daiAddr; // X = usd (both games), Y = dai (gameA only)
  let gameA, gameB;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, games, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, E(100));
    await satori.transfer(bob.address, E(100));
    await satori.transfer(funder.address, E(100));
    await satori.transfer(authority.address, E(100));

    // One stream → gameA (gameId == streamId). Plus one extra gameB on it.
    gameA = await createStream(satori, owner, "S", authority.address);
    gameB = await createStream(satori, owner, "S2", authority.address);
    expect(gameB).to.not.equal(gameA);

    // Both games need burnt weight for their predictors to be eligible. Burn
    // voting is per-game and PERMANENT (nothing moves), but keeping one voter
    // per game leaves alice's and bob's remaining balances — and hence their
    // prediction power — identical, which the equal-share assertion needs.
    await voteFor(satori, alice, gameA);
    await voteFor(satori, bob, gameB);

    usd = await deployMockToken("USDC"); usdAddr = await usd.getAddress();
    dai = await deployMockToken("DAI");  daiAddr = await dai.getAddress();
    for (const t of [usd, dai]) {
      await t.mint(funder.address, E(100000));
      await t.connect(funder).approve(await bounties.getAddress(), E(100000));
    }

    // (A dead `feeRecipient = rewards.PLATFORM_FEE_RECIPIENT()` lived here. The
    // platform fee moved onto the immutable SatoriToken in the restructure, so the
    // getter no longer exists on rewards -- and nothing in this file ever read the
    // value. Removed rather than repointed. 2026-07-30, skip triage.)
  });

  // Audit C-2: applyBoost gets multiplier 0 at streak 0 (SatoriEngine.sol), so
  // a first-ever prediction writes NO boost snapshot. Warm one winning round for
  // both predictors before any stake exists, so the measured round runs at
  // streak >= 1 and the warm-up consumes no bounty.
  async function warmStreaks() {
    await registry.connect(authority).setValue(gameA, 100);
    await registry.connect(authority).setValue(gameB, 100);
    for (const u of [alice, bob]) {
      await satori.connect(u).predictMultipleWithPayloads([
        { gameId: gameA, payload: pack1(UP) },
        { gameId: gameB, payload: pack1(UP) },
      ]);
    }
    await advanceOneDay();
    await registry.connect(authority).setValue(gameA, 110);
    await registry.connect(authority).setValue(gameB, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(gameA, 120);
    await registry.connect(authority).setValue(gameB, 120);
    for (const u of [alice, bob]) {
      await satori.settlePrediction(u.address, gameA);
      await satori.settlePrediction(u.address, gameB);
    }
    await advanceOneDay(); // a stream cannot update twice in one round
  }

  it("Y (funded only on A) pays nothing on B; equal stake earns equal share; per-game pot conserved; cleanup inert", async function () {
    await warmStreaks();
    // ---- Fund: X on BOTH games (100/100 each); Y on gameA ONLY (100/100). ----
    await fundOn(bounties, funder, gameA, usdAddr, E(100), E(100)); // X on A
    await fundOn(bounties, funder, gameB, usdAddr, E(100), E(100)); // X on B
    await fundOn(bounties, funder, gameA, daiAddr, E(100), E(100)); // Y on A only

    expect(await bounties.gameBountyTokenCount(gameA)).to.equal(2n); // X + Y
    expect(await bounties.gameBountyTokenCount(gameB)).to.equal(1n); // X only
    // Y is NOT funded on B: applyBoost must not snapshot it for B.
    expect(await bounties.pool(gameB, daiAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(gameB, daiAddr)).to.equal(0n);

    // ---- Equal real stake: each user stakes 100 X and 100 Y. ----
    for (const u of [alice, bob]) {
      await stakeFor(bounties, u, usd, E(100));
      await stakeFor(bounties, u, dai, E(100));
    }

    // ---- Round R: each user predicts BOTH games UP (same round). ----
    await registry.connect(authority).setValue(gameA, 130);
    await registry.connect(authority).setValue(gameB, 130);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
      { gameId: gameB, payload: pack1(UP) },
    ]);
    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
      { gameId: gameB, payload: pack1(UP) },
    ]);
    const r = await satori.getCurrentRound();

    // Each user's round union = {X, Y} (X snapshotted on A&B, Y on A only).
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(2n);
    expect(await bounties.boostedTokenCountInRound(bob.address, r)).to.equal(2n);

    // Per-game snapshots — the load-bearing guard for property (1):
    //   Y has a NON-zero snapshot for gameA but a ZERO snapshot for gameB.
    expect(await bounties.boostStakeForPrediction(alice.address, gameA, r, daiAddr)).to.be.gt(0n);
    expect(await bounties.boostStakeForPrediction(alice.address, gameB, r, daiAddr)).to.equal(0n);
    // X has a non-zero snapshot for BOTH games.
    expect(await bounties.boostStakeForPrediction(alice.address, gameA, r, usdAddr)).to.be.gt(0n);
    expect(await bounties.boostStakeForPrediction(alice.address, gameB, r, usdAddr)).to.be.gt(0n);

    const potAX = E(100); // X pot dripped on A
    const potAY = E(100); // Y pot dripped on A
    const potBX = E(100); // X pot dripped on B

    // ---- Drive both games' R predictions correct (UP: C > B). ----
    await advanceOneDay();
    await registry.connect(authority).setValue(gameA, 140);
    await registry.connect(authority).setValue(gameB, 140);
    await advanceOneDay();
    await registry.connect(authority).setValue(gameA, 150);
    await registry.connect(authority).setValue(gameB, 150);

    // Helpers to read each user's TOTAL credited per token. Bounty winnings
    // auto-compound into bountyStake, which starts at the 100 they staked.
    const STAKED = E(100);
    async function tot(u, tokAddr) {
      const stake = await bounties.bountyStake(u.address, tokAddr);
      const earned = stake - STAKED; // payout re-stakes into bountyStake
      return earned;
    }

    // ============================================================
    // STEP 1 — settle game A fully (both users). Captures potAX, potAY.
    // ============================================================
    await satori.settlePrediction(alice.address, gameA);
    await satori.settlePrediction(bob.address, gameA);

    // Pots captured on A.
    expect(await bounties.roundBountyPot(gameA, r, usdAddr)).to.equal(potAX);
    expect(await bounties.roundBountyPot(gameA, r, daiAddr)).to.equal(potAY);
    // A's X pool drained → cleanup of X on A becomes permitted.
    expect(await bounties.pool(gameA, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(gameA, usdAddr)).to.equal(0n);

    // Record everyone's totals after A but BEFORE touching B.
    const aliceX_afterA = await tot(alice, usdAddr);
    const bobX_afterA   = await tot(bob, usdAddr);
    const aliceY_afterA = await tot(alice, daiAddr);
    const bobY_afterA   = await tot(bob, daiAddr);

    // PROPERTY (2a): equal stake on A → equal A-share, both tokens.
    expect(aliceX_afterA, "A: equal X stake → equal X share").to.equal(bobX_afterA);
    expect(aliceY_afterA, "A: equal Y stake → equal Y share").to.equal(bobY_afterA);
    expect(aliceX_afterA, "A X share must be > 0").to.be.gt(0n);
    expect(aliceY_afterA, "A Y share must be > 0").to.be.gt(0n);

    // PROPERTY (3) for game A: Σ(winner shares) <= dripped pot (== pot, dust).
    const sumAX = aliceX_afterA + bobX_afterA;
    const sumAY = aliceY_afterA + bobY_afterA;
    expect(sumAX, "A: Σ X winner shares must not exceed dripped X pot").to.be.lte(potAX);
    expect(sumAX, "A: X pot fully drains to winners").to.be.closeTo(potAX, 10n);
    expect(sumAY, "A: Σ Y winner shares must not exceed dripped Y pot").to.be.lte(potAY);
    expect(sumAY, "A: Y pot fully drains to winners").to.be.closeTo(potAY, 10n);

    // ============================================================
    // STEP 2 — CLEANUP token X on game A (now drained), MID-SEQUENCE,
    //          before any game-B settle. Must be inert for B.
    // ============================================================
    await bounties.connect(owner).cleanupDrainedBountyToken(gameA, usdAddr);
    // Cleanup of A's X doesn't touch B: B still owes its X pot, and payout is
    // gated per-prediction (boosted bit), not by any game-level flag.
    expect(await bounties.gameBountyTokenCount(gameB)).to.equal(1n);

    // ============================================================
    // STEP 3 — settle game B (both users). Here the credit loop walks each
    //          user's union {X, Y}. Y MUST contribute nothing (B snapshot 0).
    // ============================================================
    await satori.settlePrediction(alice.address, gameB);
    await satori.settlePrediction(bob.address, gameB);

    expect(await bounties.roundBountyPot(gameB, r, usdAddr)).to.equal(potBX);
    // Y was never funded on B → no B pot for Y at all.
    expect(await bounties.roundBountyPot(gameB, r, daiAddr)).to.equal(0n);

    // Deltas attributable to settling game B:
    const aliceX_B = (await tot(alice, usdAddr)) - aliceX_afterA;
    const bobX_B   = (await tot(bob, usdAddr))   - bobX_afterA;
    const aliceY_B = (await tot(alice, daiAddr)) - aliceY_afterA;
    const bobY_B   = (await tot(bob, daiAddr))   - bobY_afterA;

    // PROPERTY (1) MIS-PAY GUARD: settling B paid ZERO of Y to anyone (Y's B
    // snapshot is zero; Y only ever had a pot on A, already fully paid).
    expect(aliceY_B, "MIS-PAY: settling B must pay Alice 0 of Y (Y not funded on B)").to.equal(0n);
    expect(bobY_B,   "MIS-PAY: settling B must pay Bob 0 of Y (Y not funded on B)").to.equal(0n);

    // PROPERTY (2b): equal X stake on B → equal X B-share.
    expect(aliceX_B, "B: equal X stake → equal X share").to.equal(bobX_B);
    expect(aliceX_B, "B X share must be > 0").to.be.gt(0n);

    // PROPERTY (3) for game B: Σ(X winner shares) <= dripped X pot (== pot).
    const sumBX = aliceX_B + bobX_B;
    expect(sumBX, "B: Σ X winner shares must not exceed dripped X pot").to.be.lte(potBX);
    expect(sumBX, "B: X pot fully drains to winners").to.be.closeTo(potBX, 10n);

    // PROPERTY (4) CLEANUP INERT: cleaning X on A did not change B's X share.
    // B's per-user X share is its own pot/totalBoost; equal to A's per-user X
    // share since pots and stakes are symmetric (100/100, equal stakers).
    expect(aliceX_B, "cleanup of X on A must not perturb B's X payout").to.equal(aliceX_afterA);

    // PROPERTY (2c) NO DOUBLE-PAY across the whole sequence: Alice's lifetime X
    // total == A-share + B-share (two independent per-game shares, not a
    // union-walk multiplication). And Alice == Bob in every token.
    const aliceX_total = await tot(alice, usdAddr);
    const bobX_total   = await tot(bob, usdAddr);
    const aliceY_total = await tot(alice, daiAddr);
    const bobY_total   = await tot(bob, daiAddr);

    expect(aliceX_total, "Alice lifetime X == her A-share + B-share (no multiplication)")
      .to.equal(aliceX_afterA + aliceX_B);
    expect(aliceX_total, "equal-stake symmetry: Alice X == Bob X").to.equal(bobX_total);
    expect(aliceY_total, "equal-stake symmetry: Alice Y == Bob Y").to.equal(bobY_total);
    // Y total is purely the A pot share — settling B added nothing.
    expect(aliceY_total, "Alice Y total == her A Y-share only").to.equal(aliceY_afterA);

    // GLOBAL CONSERVATION: total X ever credited across BOTH games
    // == potAX + potBX (each game's pot drains once, no token double-counted).
    const globalX = aliceX_total + bobX_total;
    expect(globalX, "global X conservation: Σ all X credited == potAX + potBX")
      .to.be.closeTo(potAX + potBX, 20n);
    // And global Y == potAY only (Y never paid on B).
    const globalY = aliceY_total + bobY_total;
    expect(globalY, "global Y conservation: Σ all Y credited == potAY only")
      .to.be.closeTo(potAY, 20n);

    console.log(`        [nums] A: X/usr=${aliceX_afterA} Y/usr=${aliceY_afterA}`);
    console.log(`        [nums] B: X/usr=${aliceX_B} (Y/usr=${aliceY_B} must be 0)`);
    console.log(`        [nums] global X=${globalX} (=${potAX + potBX})  global Y=${globalY} (=${potAY})`);
  });
});
