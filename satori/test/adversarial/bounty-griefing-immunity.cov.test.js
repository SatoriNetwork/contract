/**
 * Adversarial regression guard — GRIEFING-IMMUNITY of the re-keyed bounty
 * score-time payout (SatoriBounties.sol).
 *
 * THREAT: a funder spams MANY distinct junk bounty tokens onto one game, on
 * top of one "real" token (USDC). Under the OLD design the score-time loop
 * iterated something keyed off the game's funded-token list, so a funder
 * could inflate every predictor's predict/settle cost or DoS their payout by
 * spamming tokens nobody staked.
 *
 * FIX UNDER TEST: `applyBoost` snapshots ONLY tokens the VICTIM has actually
 * staked AND the game funds, appending each (dedup) to a per-(user, round)
 * set `boostedTokensInRound[user][round]`. `creditBountyForWin` iterates THAT
 * set — bounded by the victim's own stake, never by the funder's spam list.
 *
 * PROPERTIES ASSERTED (all must HOLD → test is GREEN):
 *   1. A victim who stakes only USDC has boostedTokenCountInRound == 1 even
 *      when the funder spammed 25 junk tokens (+ USDC = 26 funded tokens).
 *   2. The victim's predict AND settle both SUCCEED (no DoS) and the victim is
 *      paid their USDC share from the predict-time snapshot.
 *   3. A second predictor who stakes NONE of the funded tokens has
 *      boostedTokenCountInRound == 0 and settles to a clean no-op (no payout,
 *      no revert).
 *   4. The victim's settle GAS does not scale with the number of spam tokens:
 *      settle gas with 2 funded tokens ≈ settle gas with 26 funded tokens for
 *      a 1-token staker (bounded by the victim's set, ~flat).
 *
 * If any assertion fails, that is a REAL griefing bug — report it, do not
 * contort the test to pass.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak , voteFor } = require("../fixtures");

const UP = 1;

async function advanceOneDay() { await time.increase(86400); }

async function deployMockToken(symbol) {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}

// Stream cadence floor: a PUBLIC caller may only create round-length (>= 1440
// minute) streams; sub-round streams are admin-only. This test's subject is bounty
// pool/drip/stake mechanics, not stream rhythm, so it keeps the fast (720-minute,
// sub-round) beat by having the ADMIN (`owner`) create the stream. `authority`
// stays the stream's PROVIDER, so it is still the account that writes values.

// Mint the exact burn budget to the owner through the REAL on-chain rewards
// lane (impersonating the wired rewards child). The lane mints only what
// Rewards reported, so report it first. No freezeRoundGross here: pricing a
// round from outside SatoriRewards would leave its own round budget unset
// (the hub returns 0 for an already-priced round). A pull of the default
// stream (a Sentiment stream, so its first value is written by the pull) prices
// the round through SatoriRewards itself, which makes allowance for this small amount.
async function mintBurnBudget(satori, rewards, owner, n) {
  const registry = await ethers.getContractAt("SatoriRegistry", await satori.satoriRegistry());
  try { await registry.updateValue(1); } catch { /* already pulled this hour */ }
  const need = (await satori.bountyBurn()) * BigInt(n);
  const rewardsAddr = await rewards.getAddress();
  await impersonateAccount(rewardsAddr);
  await setBalance(rewardsAddr, ethers.parseEther("10"));
  const rw = await ethers.getSigner(rewardsAddr);
  await satori.connect(rw).noteIssued(need);
  await satori.connect(rw).rewardMint(owner.address, need);
}
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

// Mint a fresh junk token, approve it to bounties, and fund it onto `game`.
// Returns the token address. `rate` low so the pot drips a little each round.
async function fundJunkToken(satori, bounties, funder, game, idx) {
  // Each junk-token bounty is a first-fund of a non-SATORI (game, token) pair, so
  // it charges an upfront bountyBurn on the funder; fund it from owner first.
  await satori.transfer(funder.address, await satori.bountyBurn());
  const t = await deployMockToken("JNK" + idx);
  const addr = await t.getAddress();
  await t.mint(funder.address, ethers.parseEther("1000"));
  await t.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("1000"));
  await bounties.connect(funder).fundBounty(
    game, addr, ethers.parseEther("1000"), ethers.parseEther("10")
  );
  return addr;
}

describe("adv — bounty griefing-immunity: funder spam must not inflate the victim's set/cost/payout", function () {
  this.timeout(300000);

  let satori, rewards, bounties, registry, owner;
  let victim, ghost, funder, authority;
  let usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, victim, ghost, funder, authority] = fix.signers;

    await satori.transfer(victim.address, ethers.parseEther("100"));
    await satori.transfer(ghost.address, ethers.parseEther("100"));
    // Stream creation charges an escalating spam fee per call; this suite
    // creates up to three streams via `authority`, so over-provision.
    await satori.transfer(authority.address, ethers.parseEther("100"));

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
  });

  it("victim staking ONLY USDC has set==1 and is paid, despite 25 junk tokens spammed; ghost (no stake) is a clean no-op", async function () {
    const game = await createStream(satori, owner, "G", authority.address);
    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1
    await warmUpStreak(satori, registry, authority, [victim, ghost], game);
    await voteFor(satori, victim, game);
    await voteFor(satori, ghost, game);

    // ---- Funder funds the REAL token (USDC) ... ----
    await mintBurnBudget(satori, rewards, owner, 26); // 1 real + 25 junk burns
    await satori.transfer(funder.address, await satori.bountyBurn()); // upfront non-SATORI bounty burn
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await bounties.connect(funder).fundBounty(
      game, usdAddr, ethers.parseEther("1000"), ethers.parseEther("200")
    );

    // ---- ... plus 25 distinct JUNK bounty tokens (the griefing attack) ----
    const SPAM = 25;
    const junk = [];
    for (let i = 0; i < SPAM; i++) {
      junk.push(await fundJunkToken(satori, bounties, funder, game, i));
    }
    expect(await bounties.gameBountyTokenCount(game)).to.equal(BigInt(SPAM + 1),
      "game now carries 26 funded tokens (1 real + 25 junk)");

    // ---- Victim stakes ONLY USDC; ghost stakes NOTHING ----
    await usd.mint(victim.address, ethers.parseEther("100"));
    await usd.connect(victim).approve(await bounties.getAddress(), ethers.parseEther("100"));
    await bounties.connect(victim).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    expect(await bounties.userStakedTokenCount(victim.address)).to.equal(1n,
      "victim has exactly one staked token");
    expect(await bounties.userStakedTokenCount(ghost.address)).to.equal(0n,
      "ghost staked nothing");

    // ---- Round R: both predict UP on the bounty game ----
    await registry.connect(authority).setValue(game, 100);
    await satori.connect(victim).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    await satori.connect(ghost).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    // PROPERTY 1: victim's round set is bounded by THEIR stake (1), NOT by the
    // funder's 26-token spam list.
    expect(await bounties.boostedTokenCountInRound(victim.address, r)).to.equal(1n,
      "GRIEFING: victim's round set must be 1 (their USDC), not the funder's 26");
    // The single snapshotted token is USDC, with a non-zero snapshot.
    expect(await bounties.boostedTokensInRound(victim.address, r, 0)).to.equal(usdAddr);
    expect(await bounties.boostStakeForPrediction(victim.address, game, r, usdAddr)).to.be.gt(0n);

    // PROPERTY 3a: ghost staked none of the funded tokens → empty round set.
    expect(await bounties.boostedTokenCountInRound(ghost.address, r)).to.equal(0n,
      "ghost (no stake) must have an EMPTY round set");

    // ---- Drive to score (UP correct: C > B). Settle both. ----
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(game, 120);

    // PROPERTY 2: victim settle SUCCEEDS (no DoS from 25 junk tokens).
    await expect(satori.settlePrediction(victim.address, game)).to.not.be.reverted;

    // PROPERTY 3b: ghost settle is a clean no-op (no revert, no payout).
    await expect(satori.settlePrediction(ghost.address, game)).to.not.be.reverted;

    // ---- Victim was paid their USDC share from the snapshot. ----
    const victimEarned =
      (await bounties.bountyStake(victim.address, usdAddr)) - ethers.parseEther("100");
    expect(victimEarned, "victim must be paid their USDC share").to.be.gt(0n);

    // The pot that was dripped for round R drains into the sole staker's stake.
    const pot = await bounties.roundBountyPot(game, r, usdAddr);
    expect(pot, "USDC pot dripped for round R").to.be.gt(0n);
    expect(victimEarned,
      "USDC pot fully drains to the sole staker").to.be.closeTo(pot, ethers.parseEther("0.0001"));

    // PROPERTY 3c: ghost received NOTHING in any funded token.
    expect(await bounties.bountyStake(ghost.address, usdAddr)).to.equal(0n);
    for (const j of junk) {
      expect(await bounties.bountyStake(ghost.address, j)).to.equal(0n);
      // Victim staked none of the junk either → no junk payout to the victim.
      expect(await bounties.bountyStake(victim.address, j)).to.equal(0n);
    }
  });

  it("victim settle gas is ~flat: 2 funded tokens vs 26 funded tokens for a 1-token staker", async function () {
    // Helper: run one full predict→settle cycle for a 1-USDC-token staker on a
    // freshly created game funded with USDC + `nJunk` junk tokens. Returns the
    // gasUsed of the settlePrediction tx. A fresh game/round per call keeps the
    // two measurements independent.
    async function measureSettleGas(nJunk, voter) {
      const game = await createStream(satori, owner, "GG" + nJunk, authority.address);
      await voteFor(satori, voter, game);

      // Both measurements pay this same one-day shift, so the comparison is fair.
      await advanceOneDay();
      await mintBurnBudget(satori, rewards, owner, nJunk + 1);
      await satori.transfer(funder.address, await satori.bountyBurn()); // upfront non-SATORI bounty burn
      await usd.mint(funder.address, ethers.parseEther("10000"));
      await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
      await bounties.connect(funder).fundBounty(
        game, usdAddr, ethers.parseEther("1000"), ethers.parseEther("200")
      );
      // Fund nJunk junk tokens.
      for (let i = 0; i < nJunk; i++) {
        await fundJunkToken(satori, bounties, funder, game, 1000 * (nJunk + 1) + i);
      }
      expect(await bounties.gameBountyTokenCount(game)).to.equal(BigInt(nJunk + 1));

      // audit C-2: a bounty boost needs a non-zero multiplier, so the measured
      // prediction must run at streak >= 1. Warm up HERE — after the junk-funding
      // loop (whose per-token SATORI burn scales with elapsed rounds, so warming
      // earlier would price the owner out of 26 fundings) and before the voter
      // stakes (unstaked => applyBoost skips => the warm-up cannot drip a pot and
      // skew the gas measurement).
      await warmUpStreak(satori, registry, authority, voter, game);

      // Voter stakes ONLY USDC (top up + restake each measurement).
      await usd.mint(voter.address, ethers.parseEther("100"));
      await usd.connect(voter).approve(await bounties.getAddress(), ethers.parseEther("100"));
      await bounties.connect(voter).stakeBountyToken(usdAddr, ethers.parseEther("100"));

      await registry.connect(authority).setValue(game, 100);
      await satori.connect(voter).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
      const r = await satori.getCurrentRound();
      expect(await bounties.boostedTokenCountInRound(voter.address, r)).to.equal(1n);

      await advanceOneDay();
      await registry.connect(authority).setValue(game, 110);
      await advanceOneDay();
      await registry.connect(authority).setValue(game, 120);

      const tx = await satori.settlePrediction(voter.address, game);
      const rcpt = await tx.wait();
      return rcpt.gasUsed;
    }

    // Use two distinct voters so each measurement starts from a clean
    // userStakedTokens / bountyStake slate for the gas-sensitive paths.
    const gas2 = await measureSettleGas(1, victim);   // 2 funded tokens total
    const gas26 = await measureSettleGas(25, ghost);  // 26 funded tokens total

    // The victim's settle work is bounded by THEIR 1-token set, so adding 24
    // more spam tokens to the game must NOT meaningfully grow settle gas.
    // Allow generous slack for first-touch storage differences across the two
    // independent games; the point is it does NOT scale ~linearly in spam.
    // Linear-in-spam would be a >10x blowup; we assert well under 1.5x.
    const ratio = Number(gas26) / Number(gas2);
    console.log(`        [gas] 2 funded tokens=${gas2}  26 funded tokens=${gas26}  ratio=${ratio.toFixed(4)}`);
    expect(ratio, `settle gas must not scale with spam: gas2=${gas2} gas26=${gas26} ratio=${ratio}`)
      .to.be.lt(1.5);
  });
});
