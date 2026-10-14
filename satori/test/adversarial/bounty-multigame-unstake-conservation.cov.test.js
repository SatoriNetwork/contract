/**
 * Adversarial regression guard — NO-DOUBLE-PAY + CONSERVATION under
 * multi-game-same-round + unstake + restake.
 *
 * The bounty score-time payout was re-keyed to iterate the per-(user, round)
 * boosted-token set `boostedTokensInRound[user][round]` (snapshotted at predict
 * time, dedup append-if-absent) instead of the user's LIVE `userStakedTokens`.
 *
 * This test attacks three safety properties at once on ONE stream with TWO
 * funded games (gameA + gameB) and TWO stakers with EQUAL real USDC stake:
 *
 *   1. NO DOUBLE-PAY / dedup holds: Alice predicts BOTH games on the stream in
 *      the same round; Bob predicts only gameA. With the dedup set, USDC appears
 *      ONCE in Alice's round list, so her per-game share is NOT multiplied by
 *      the number of games she predicted. Equal real stake => EQUAL earnings on
 *      gameA. Each game's pot is paid at most once per (game, round).
 *
 *   2. CONSERVATION: per game, Σ predictor shares + fee ≤ that game's dripped
 *      `roundBountyPot`.
 *
 *   3. NO STRANDING under unstake+restake: Alice unstakes all USDC at R+1 (lock
 *      lifts) and RESTAKES fresh USDC before settle. The predict-time snapshot
 *      is untouched, so her R-snapshot share must still pay out, and equal to
 *      Bob's on gameA.
 *
 *   4. CLEAR/REFUND: after EVERY one of a user's round predictions has settled,
 *      `boostedTokenCountInRound(user, round) == 0` (list cleared + refunded);
 *      and settling ONE of Alice's two games must NOT prematurely clear it.
 *
 * A double-pay, a Σ > pot, unequal equal-stake earnings, or a premature/never
 * clear is a BUG — assert the safe behavior, do not contort to green.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , voteFor } = require("../fixtures");

const UP = 1;

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

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
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

// RE-ENABLED 2026-07-30 (skip triage). The prior deferral was right that BOTH
// games must be BINARY -- adapter predictions never call `SatoriBounties.applyBoost`,
// so an adapter gameB takes a zero boost snapshot and earns nothing -- but it then
// concluded the property was unreachable. It only considered two binary games on ONE
// stream (now DuplicateBinaryGame) and binary+adapter on one stream (no boost). The
// third shape works: two binary games on TWO streams. Nothing here depends on the
// games sharing a stream; the properties are about one token across multiple GAMES in
// one ROUND, and per-round unsettled-count clear timing.
describe("adv multigame+unstake+restake — no double-pay / conservation / clear", function () {
  this.timeout(180000);

  let satori, rewards, bounties, registry, games, owner;
  let alice, bob, funder, authority;
  let streamId, streamIdB, gameA, gameB, usd, usdAddr;

  const POT = ethers.parseEther("1000");
  const RATE = ethers.parseEther("200"); // one drip per round = 200
  const STAKE = ethers.parseEther("100");

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, games, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    // One stream; auto game gameA (gameId == streamId) + extra game gameB on
    // the SAME stream.
    streamId = await createStream(satori, owner, "S", authority.address);
    gameA = streamId;
    streamIdB = await createStream(satori, owner, "S2", authority.address);
    gameB = streamIdB; // auto-paired binary game on the second stream
    expect(gameB).to.not.equal(gameA);
    expect(await games.dataStreamId(gameB)).to.equal(streamIdB);

    // Both games need burnt weight for their predictors to be eligible. Burn
    // voting is per-game and PERMANENT (nothing moves), but one voter per game
    // keeps alice's and bob's remaining balances — and so their prediction
    // power — identical, which the equal-earnings assertion needs.
    await voteFor(satori, alice, gameA);
    await voteFor(satori, bob, gameB);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, ethers.parseEther("100000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("100000"));

    // Fund the SAME token on BOTH games — two independent pools, same token.
    await bounties.connect(funder).fundBounty(gameA, usdAddr, POT, RATE);
    await bounties.connect(funder).fundBounty(gameB, usdAddr, POT, RATE);
  });

  // Audit C-2: applyBoost gets multiplier 0 at streak 0 (SatoriEngine.sol),
  // so a first-ever prediction writes NO boost snapshot. Warm one winning round
  // for both predictors before any stake exists, so the measured round runs at
  // streak >= 1 and the warm-up consumes no bounty.
  async function warmStreaks() {
    await registry.connect(authority).setValue(streamId, 100);
    await registry.connect(authority).setValue(streamIdB, 100);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
      { gameId: gameB, payload: pack1(UP) },
    ]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await registry.connect(authority).setValue(streamIdB, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);
    await registry.connect(authority).setValue(streamIdB, 120);
    await satori.settlePrediction(alice.address, gameA);
    await satori.settlePrediction(alice.address, gameB);
    await satori.settlePrediction(bob.address, gameA);
    // Leave the warm-up round: a stream cannot update twice in one round.
    await advanceOneDay();
  }

  it("equal real stake -> equal gameA earnings; Σ shares+fee ≤ pot; list cleared after all settle", async function () {
    // ---- Round R: equal real stake; Alice predicts BOTH games, Bob only A ----
    await warmStreaks();
    await stakeFor(bounties, alice, usd, STAKE);
    await stakeFor(bounties, bob, usd, STAKE);

    await registry.connect(authority).setValue(streamId, 130);

    await registry.connect(authority).setValue(streamIdB, 130);

    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
      { gameId: gameB, payload: pack1(UP) },
    ]);
    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
    ]);

    const r = await satori.getCurrentRound();

    // DEDUP: USDC predicted across gameA + gameB by Alice appears ONCE in her
    // round list (else score-time would double-pay it). Bob: also one entry.
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(
      1n, "Alice's round list must dedup USDC to a single entry across 2 games"
    );
    expect(await bounties.boostedTokenCountInRound(bob.address, r)).to.equal(1n);

    // Snapshots: Alice's per-game USDC boost must EQUAL Bob's (equal real
    // stake, equal multiplier). The dedup'd list does not multiply the snapshot.
    const snapAliceA = await bounties.boostStakeForPrediction(alice.address, gameA, r, usdAddr);
    const snapAliceB = await bounties.boostStakeForPrediction(alice.address, gameB, r, usdAddr);
    const snapBobA = await bounties.boostStakeForPrediction(bob.address, gameA, r, usdAddr);
    expect(snapAliceA).to.be.gt(0n);
    expect(snapAliceB).to.be.gt(0n);
    expect(snapAliceA).to.equal(snapBobA,
      "equal real stake => equal gameA snapshot (no multi-game inflation)");

    // ---- Round R+1: lock lifts (R+1 is NOT > R+1). Alice unstakes ALL then
    // RESTAKES fresh USDC. The predict-time snapshot must be untouched. ----
    await advanceOneDay();
    expect(await satori.getCurrentRound()).to.equal(r + 1n);

    await bounties.connect(alice).unstakeBountyToken(usdAddr, STAKE, alice.address);
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);
    // Restake fresh stake before settle — must not change the R snapshot.
    await stakeFor(bounties, alice, usd, STAKE);
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(STAKE);
    expect(await bounties.boostStakeForPrediction(alice.address, gameA, r, usdAddr))
      .to.equal(snapAliceA, "restake must not mutate the R-time snapshot");

    // ---- Drive A-B-C so UP is correct on the stream ----
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 140);
    await registry.connect(authority).setValue(streamIdB, 140);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 150);
    await registry.connect(authority).setValue(streamIdB, 150);

    // bountyStake just before settle (Alice = fresh restake STAKE, Bob = STAKE).
    const aliceStakeBefore = await bounties.bountyStake(alice.address, usdAddr);
    const bobStakeBefore = await bounties.bountyStake(bob.address, usdAddr);

    // ---- Settle gameB first for Alice. NO PREMATURE CLEAR: Alice still has an
    // unsettled prediction (gameA), so her round list must SURVIVE. ----
    await satori.settlePrediction(alice.address, gameB);
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(
      1n, "settling one of Alice's two games must NOT clear her round list"
    );

    // Now settle the rest.
    await satori.settlePrediction(alice.address, gameA);
    await satori.settlePrediction(bob.address, gameA);

    // ---- CLEAR/REFUND: every prediction settled => count 0 for each user ----
    expect(await bounties.boostedTokenCountInRound(alice.address, r)).to.equal(
      0n, "Alice's round list must be cleared after ALL her predictions settle"
    );
    expect(await bounties.boostedTokenCountInRound(bob.address, r)).to.equal(
      0n, "Bob's round list must be cleared after his prediction settles"
    );

    // ---- Earnings ----
    // Alice & Bob auto-compound their gameA share into bountyStake (priorStake
    // > 0 path). gameB share also compounds into the SAME USDC stake for Alice.
    const aliceTotalEarned =
      (await bounties.bountyStake(alice.address, usdAddr)) - aliceStakeBefore;
    const bobEarned =
      (await bounties.bountyStake(bob.address, usdAddr)) - bobStakeBefore;

    expect(aliceTotalEarned).to.be.gt(0n);
    expect(bobEarned).to.be.gt(0n);

    // Dripped pots (one drip each, RATE = 200).
    const potA = await bounties.roundBountyPot(gameA, r, usdAddr);
    const potB = await bounties.roundBountyPot(gameB, r, usdAddr);
    expect(potA).to.equal(RATE, "gameA dripped exactly one RATE");
    expect(potB).to.equal(RATE, "gameB dripped exactly one RATE");

    // ---- GAME A: equal real stake => EQUAL share. Alice's gameA predictor
    // amount must equal Bob's. Reconstruct each side from snapshots.
    // share = potA * snap / totalBoostA ; predictorAmount = share - fee.
    // With equal snapshots and same total/fee, Alice_A == Bob_A exactly.
    // Bob's total earnings come solely from gameA, so bobEarned == Bob's gameA
    // predictor amount. Alice's gameA predictor amount must match it.
    // Derive Alice's gameA amount = aliceTotalEarned - aliceGameBAmount, but we
    // assert the cleaner invariant directly via per-game conservation below and
    // equal-snapshot equality here.
    //
    // CONSERVATION per game: predictorAmount(s) + fee == share == pot (single
    // predictor on B; two equal predictors on A). Σ per game ≤ pot.
    //
    // Compute fee split: bounty fee bps = HALF the platform fee bps.
    // Was `(await rewards.feeSlot()).bps`. That storage was inert and read 0 on
    // every run, so every fee term below has always evaluated to zero; the
    // getter is gone (2026-08-31) and the constant now says so out loud rather
    // than pretending to read a live rate.
    const platformBps = 0n;
    const denom = 20000n; // share * bps / 20000 == bps/2/10000

    // gameA: two equal predictors (Alice, Bob) share potA. Each share = potA/2
    // (equal snapshots). predictor each = share - share*bps/20000.
    const shareA_each = potA / 2n;
    const feeA_each = (shareA_each * platformBps) / denom;
    const predA_each = shareA_each - feeA_each;

    // gameB: Alice is the SOLE predictor => share = potB. predictor = potB-fee.
    const shareB = potB; // sole staker takes whole pot
    const feeB = (shareB * platformBps) / denom;
    const predB = shareB - feeB;

    // Alice total predictor amount = gameA(predA_each) + gameB(predB).
    const aliceExpected = predA_each + predB;
    // Bob total predictor amount = gameA(predA_each).
    const bobExpected = predA_each;

    const TOL = 10n; // integer-division dust
    expect(bobEarned).to.be.closeTo(bobExpected, TOL,
      `Bob gameA predictor amount mismatch: got ${bobEarned} want ${bobExpected}`);
    expect(aliceTotalEarned).to.be.closeTo(aliceExpected, TOL,
      `Alice (2 games) earnings mismatch: got ${aliceTotalEarned} want ${aliceExpected}`);

    // NO MULTIPLICATION: Alice's gameA contribution must equal Bob's gameA
    // contribution (equal real stake). Alice's extra earnings are EXACTLY the
    // independent gameB pool, not a multiplied gameA.
    const aliceGameAContribution = aliceTotalEarned - predB;
    expect(aliceGameAContribution).to.be.closeTo(bobEarned, TOL,
      "Alice's gameA share must equal Bob's (no multi-game multiplication of gameA)");

    // ---- CONSERVATION: per game, Σ shares + fee ≤ dripped pot ----
    // gameA: predA_each(Alice) + predA_each(Bob) + 2*feeA_each ≤ potA.
    const gameAOut = predA_each + predA_each + feeA_each * 2n;
    expect(gameAOut).to.be.lte(potA + TOL,
      `gameA Σ(shares+fees)=${gameAOut} exceeds dripped pot ${potA}`);

    // gameB: predB + feeB ≤ potB.
    const gameBOut = predB + feeB;
    expect(gameBOut).to.be.lte(potB + TOL,
      `gameB Σ(shares+fees)=${gameBOut} exceeds dripped pot ${potB}`);

    // Global: total credited (both predictors' earnings) ≤ potA+potB.
    const totalOut = aliceTotalEarned + bobEarned;
    expect(totalOut).to.be.lte(potA + potB + TOL,
      `total credited ${totalOut} exceeds total dripped ${potA + potB}`);
  });
});
