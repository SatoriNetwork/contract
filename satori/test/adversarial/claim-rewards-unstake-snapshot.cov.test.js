/**
 * Regression guard — bounty payout survives a full unstake before settlement
 * (was HIGH finding adv_10, claim-rewards).
 *
 * Previously a winning bounty payout was silently dropped (and the round pot
 * under-distributed) when a predictor fully unstaked the bounty token before
 * settlement: the score-time credit loop iterated the user's live
 * `userStakedTokens`, which the unstake had emptied. Fixed by paying from the
 * per-(user, round) boosted-token set captured at predict time
 * (`boostedTokensInRound`), reading the predict-time snapshot — so the share
 * still materialises after a full unstake.
 *
 * INTENT:
 *   - predictor bounty earnings auto-compound into bountyStake[user][T].
 *   - the predict-time snapshot is load-bearing for payout, not the live stake;
 *     the 1-round lock only prevents the underlying tokens from being recycled.
 *
 * Asserts the INTENDED behavior, plus a multi-staker conservation check
 * (Alice unstakes, Bob keeps his stake) that Σ earnings == dripped pot.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak , voteFor } = require("../fixtures");

const UP = 1;

async function deployMockToken(symbol = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

// `signer` must be the protocol ADMIN (the fixture's owner): the stream is
// scaffolding for the claim/bounty-snapshot assertions below, so it stays on the
// fast sub-round (720-minute) beat and only the admin may create such a stream. `authority` — the
// PROVIDER that writes the values — is unchanged.
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

describe("ADV-10 claim-rewards: snapshot payout after full unstake before settlement", function () {
  this.timeout(120000);

  let satori, rewards, bounties, registry;
  let alice, bob, funder, authority;
  let s1, usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, (await satori.streamBurn()) * 2n);

    s1 = await createStream(satori, fix.owner, "S1", authority.address);
    // audit C-2: streak 0 pays a FLAT dust identical for every holder, so
    // proportionality-by-holdings only exists at streak >= 1. Warm up first.
    await warmUpStreak(satori, registry, authority, [alice, bob], s1);
    await voteFor(satori, alice, s1);
    await voteFor(satori, bob, s1);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();

    // Funder funds the bounty pool on s1. The bounty token is NOT SATORI, so the
    // first fund of this (game, token) pair charges bountyBurn in SATORI upfront.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await bounties.connect(funder).fundBounty(
      s1, usdAddr, ethers.parseEther("1000"), ethers.parseEther("200")
    );
  });

  it("solo: full unstake at R+1 then score still pays out from the predict-time snapshot", async function () {
    // Round R: alice stakes 100 USD and predicts s1 UP. applyBoost snapshots her
    // 100*mult into boostStakeForPrediction and sets stakeLockedUntil = R+1.
    await usd.mint(alice.address, ethers.parseEther("100"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("100"));
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));

    await registry.connect(authority).setValue(s1, 100); // anchor A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    const snap = await bounties.boostStakeForPrediction(alice.address, s1, r, usdAddr);
    expect(snap).to.be.gt(0n); // snapshot exists

    // Round R+1: lock released, alice fully unstakes her 100 USD BEFORE settlement.
    await advanceOneDay();
    await bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address);
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);

    // The predict-time snapshot is captured-in-storage, independent of live stake.
    expect(await bounties.boostStakeForPrediction(alice.address, s1, r, usdAddr)).to.equal(snap);

    // Drive the prediction to score (UP correct: C > B).
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110); // B
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120); // C
    await satori.settlePrediction(alice.address, s1);

    // INTENDED: snapshot-based payout still arrives — bountyStake rematerializes
    // from 0 to alice's earned share of the pot.
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.be.gt(0n);
  });

  it("multi-staker: unstaker still earns and Sigma payouts == dripped pot (conservation)", async function () {
    // Alice and Bob each stake 100 USD and predict s1 UP in round R.
    await usd.mint(alice.address, ethers.parseEther("100"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("100"));
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));

    await usd.mint(bob.address, ethers.parseEther("100"));
    await usd.connect(bob).approve(await bounties.getAddress(), ethers.parseEther("100"));
    await bounties.connect(bob).stakeBountyToken(usdAddr, ethers.parseEther("100"));

    await registry.connect(authority).setValue(s1, 100); // anchor A
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    // Round R+1: Alice fully unstakes (lock released). Bob keeps his stake.
    await advanceOneDay();
    await bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address);
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);

    // Drive both predictions to score correct.
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110); // B
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120); // C
    await satori.settlePrediction(bob.address, s1);
    await satori.settlePrediction(alice.address, s1);

    // Earnings = current stake minus retained principal. Earnings auto-compound
    // into bountyStake, so we must net out each predictor's un-unstaked
    // principal: Alice unstaked her full 100 before settling (baseline 0), Bob
    // kept his 100. Comparing raw stake would wrongly count Bob's principal.
    const aliceEarned = await bounties.bountyStake(alice.address, usdAddr);
    const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - ethers.parseEther("100");

    // dripped pot for round R = ratePerRound / RATE_SCALE. fundBounty rate arg was
    // 200e18; compute the pot the same way the contract does (drip captured once).
    const pot = await bounties.roundBountyPot(s1, r, usdAddr);
    expect(pot).to.be.gt(0n);

    // INTENDED: Alice (the unstaker) still earns her snapshot share.
    expect(aliceEarned).to.be.gt(0n);

    // INTENDED: equal real stake -> equal payout (within dust).
    const diff = aliceEarned > bobEarned ? aliceEarned - bobEarned : bobEarned - aliceEarned;
    expect(diff).to.be.lte(2n);

    // INTENDED CONSERVATION: Sigma earnings == dripped pot (within dust).
    const distributed = aliceEarned + bobEarned;
    const gap = pot > distributed ? pot - distributed : distributed - pot;
    expect(gap).to.be.lte(2n);
  });
});
