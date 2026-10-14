/**
 * Regression guard — unstake-before-settle must still pay from the snapshot
 * (was HIGH finding adv_11).
 *
 * Previously `creditBountyForWin` iterated the user's LIVE `userStakedTokens`
 * list at score time. The 1-round `stakeLockedUntil` lock lifts at R+1, which
 * is also when settlement happens — so a predictor could unstake everything
 * before settling, which popped the token from `userStakedTokens`, and the
 * credit loop then skipped it: their earned share was stranded in the round
 * pot and they got zero.
 *
 * Fixed by paying from the per-(user, round) boosted-token set
 * (`boostedTokensInRound`), captured at predict time and untouched by unstake.
 * Score-time payout reads the predict-time snapshot, so unstaking after the
 * lock no longer strands an earned share.
 *
 * INTENT (docs/narratives/A_bounty_staking.md):
 *   "a prediction made in round R always pays out from its R-time snapshot,
 *    even if the user unstakes everything in R+1"; conservation: the round pot
 *    fully drains to the winners, nothing permanently stranded.
 *
 * These tests ASSERT THE INTENDED BEHAVIOR.
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

describe("adv_11 — unstake-before-score must still pay from the R-time snapshot", function () {
  this.timeout(120000);

  let satori, rewards, bounties, registry, owner;
  let alice, bob, funder, authority;
  let s1, usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, (await satori.streamBurn()) * 2n);

    s1 = await createStream(satori, owner, "S1", authority.address);
    // audit C-2: a bounty boost needs a non-zero multiplier, so streak >= 1
    await warmUpStreak(satori, registry, authority, [alice, bob], s1);
    await voteFor(satori, alice, s1);
    await voteFor(satori, bob, s1);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();

    // Fund the bounty pool on s1 so ratePerRound and pool are non-zero.
    // First-fund of a NON-SATORI (game, token) pair charges bountyBurn in SATORI
    // to the funder; give the funder exactly that (one first-fund of (s1, usd)).
    await satori.transfer(funder.address, await satori.bountyBurn());
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await bounties.connect(funder).fundBounty(
      s1, usdAddr, ethers.parseEther("1000"), ethers.parseEther("200")
    );

    // Alice & Bob each get 100 USDC to stake as boost.
    for (const u of [alice, bob]) {
      await usd.mint(u.address, ethers.parseEther("100"));
      await usd.connect(u).approve(await bounties.getAddress(), ethers.parseEther("100"));
    }
  });

  it("multi-staker: Alice unstakes all at R+1; her R-snapshot share must NOT strand in the pot", async function () {
    // ---- Round R: both stake 100 USDC and predict UP on s1 ----
    await registry.connect(authority).setValue(s1, 100);
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await bounties.connect(bob).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    const r = await satori.getCurrentRound();

    // Both snapshots captured equal (100 × mult); denominator = sum.
    const snapAlice = await bounties.boostStakeForPrediction(alice.address, s1, r, usdAddr);
    const snapBob = await bounties.boostStakeForPrediction(bob.address, s1, r, usdAddr);
    expect(snapAlice).to.be.gt(0n);
    expect(snapBob).to.be.gt(0n);

    // ---- Round R+1: lock (R+1) is NOT > R+1, so Alice can unstake all ----
    await advanceOneDay();
    expect(await satori.getCurrentRound()).to.equal(r + 1n);
    await bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address);
    // Alice fully unstaked: token popped from her live userStakedTokens list.
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);

    // Bob's live bountyStake before scoring is his original 100 stake; his
    // *earned* share is whatever score-time credit adds on top.
    const bobStakeBefore = await bounties.bountyStake(bob.address, usdAddr);

    // ---- Drive both R predictions to score (UP correct: C > B) ----
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120);

    await satori.settlePrediction(bob.address, s1);
    await satori.settlePrediction(alice.address, s1);

    // ---- The pot that was dripped for round R ----
    const pot = await bounties.roundBountyPot(s1, r, usdAddr);

    // Bob's earned (auto-compounded) share = post-score stake minus his
    // original 100 USDC stake; plus Alice's claimable earnings.
    const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - bobStakeBefore;
    // Alice fully unstaked; any credited share re-materializes as a new
    // bountyStake entry (priorStake==0 path).
    const aliceEarned = await bounties.bountyStake(alice.address, usdAddr);
    const aliceTotal = aliceEarned;

    // INTENT 1: Alice's R-time snapshot must pay out even though she unstaked
    // everything at R+1.
    expect(aliceTotal, "Alice must be credited from her R-time snapshot").to.be.gt(0n);

    // INTENT 2: With equal snapshots, Alice and Bob should earn ~the same.
    // (Approximate equality — allow dust.)
    expect(aliceTotal).to.be.closeTo(bobEarned, ethers.parseEther("0.0001"));

    // INTENT 3 (conservation): the round pot fully drains to the winners;
    // no share permanently stranded.
    const totalCredited = bobEarned + aliceTotal;
    expect(totalCredited, "round pot must fully drain to winners (no stranded residue)")
      .to.be.closeTo(pot, ethers.parseEther("0.0001"));
  });

  it("solo: only staker unstakes all at R+1; the snapshot must still pay out", async function () {
    // ---- Round R: Alice alone stakes 100 USDC and predicts UP ----
    await registry.connect(authority).setValue(s1, 100);
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    const r = await satori.getCurrentRound();
    const snap = await bounties.boostStakeForPrediction(alice.address, s1, r, usdAddr);
    expect(snap).to.be.gt(0n);

    // ---- Round R+1: unstake everything ----
    await advanceOneDay();
    await bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("100"), alice.address);
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0n);

    // ---- Score (UP correct) ----
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120);
    await satori.settlePrediction(alice.address, s1);

    // INTENT: snapshot-based payout still arrives.
    const earned = await bounties.bountyStake(alice.address, usdAddr);
    expect(earned, "solo unstaker must still be paid from her R-time snapshot")
      .to.be.gt(0n);
  });
});
