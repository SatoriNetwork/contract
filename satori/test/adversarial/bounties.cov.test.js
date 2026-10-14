/**
 * Adversarial COVERAGE — bounties subsystem (SatoriBounties.sol).
 *
 * Targets the high/med-priority coverage gaps from
 *   adversarial-findings/_raw_review.json -> systems[system=="bounties"].
 *
 * Each test asserts DOCUMENTED INTENT from
 *   docs/narratives/A_bounty_staking.md and docs/narratives/A_bounties.md (cumulative drip == funded pool).
 *
 * Already-CONFIRMED findings are NOT re-tested here — their repros live in:
 *   - adv_11_bounties.test.js     (unstake-before-score strands the share / HIGH)
 *   - adv_12_bounties.test.js     (multi-game-per-stream share inflation / MED)
 *   - adv_13_bounty-staking.test.js (two games one stream double-credit / HIGH)
 *   - the RATE_SCALE residue-carry NatSpec falsehood (LOW) — we assert the TRUE
 *     conservation intent (cumulative drip == funded pool), not the false
 *     per-round-exactness NatSpec promise.
 *
 * The genuinely-NEW bug found while building this coverage
 * (cleanupDrainedBountyToken while a snapshot is still pending -> the pending
 *  staker's share is silently dropped and stranded) is kept as a FAILING repro
 * in adversarial-findings/cov_bounties.test.js and recorded in new_findings.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak, voteFor } = require("../fixtures");

const UP = 1;

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

// Stream cadence floor: a PUBLIC caller may only create round-length (>= 1440
// minute) streams; sub-round streams are admin-only. These bounty tests care
// about pool/drip/stake mechanics, not stream rhythm, so they keep the fast
// (720-minute, sub-round) beat by having the ADMIN (`owner`) create the
// stream. `authority` stays the PROVIDER, so it still writes the values.
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

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

describe("ADV-COV bounties", function () {
  this.timeout(120000);

  let satori, rewards, bounties, registry, owner;
  let alice, bob, carol, funder, authority;
  let s1, usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, bob, carol, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    s1 = await createStream(satori, owner, "S1", authority.address);

    // audit C-2: streak 0 takes no bounty boost — warm ALL three to streak >= 1.
    // One shared cycle, so their streaks stay equal (unequal streaks would mean
    // unequal multipliers, and the bounty share is stake x multiplier).
    await warmUpStreak(satori, registry, authority, [alice, bob, carol], s1);
    // Burn voting: each burns 10 of their 100 SATORI to give s1's game weight,
    // leaving 90 of prediction power each (still equal across the three).
    await voteFor(satori, alice, s1);
    await voteFor(satori, bob, s1);
    await voteFor(satori, carol, s1);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, ethers.parseEther("1000000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("1000000"));
  });

  // ------------------------------------------------------------------
  // GAP (high): "Conservation when pot fully drains to the winners."
  //   Design (bounty-staking.md conservation, lines 187-194):
  //     Σ stakers' (predictorAmount + fee) == share-sum, and within dust the
  //     round pot is fully accounted for when EVERY staker is credited.
  //   Baseline (GREEN): three equal stakers all settle -> the captured round
  //   pot is fully distributed (predictor stakes + fee), zero stranded residue.
  // ------------------------------------------------------------------
  it("[high] full happy path: round pot fully drains to winners, nothing stranded", async function () {
    // pool=100 rate=100 -> the round's first scoring drips exactly 100.
    await bounties.connect(funder).fundBounty(s1, usdAddr, ethers.parseEther("100"), ethers.parseEther("100"));
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));
    await stakeFor(bounties, carol, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(s1, 100);
    for (const u of [alice, bob, carol]) {
      await satori.connect(u).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    }
    const r = await satori.getCurrentRound();

    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120);

    for (const u of [alice, bob, carol]) {
      await satori.settlePrediction(u.address, s1);
    }

    const pot = await bounties.roundBountyPot(s1, r, usdAddr);
    expect(pot).to.equal(ethers.parseEther("100"));

    // Earned = post-score stake minus the 100 they each staked.
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("100");
    const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - ethers.parseEther("100");
    const carolEarned = (await bounties.bountyStake(carol.address, usdAddr)) - ethers.parseEther("100");

    // Equal stake -> equal share.
    const TOL = 10n;
    expect(aliceEarned).to.be.closeTo(bobEarned, TOL);
    expect(bobEarned).to.be.closeTo(carolEarned, TOL);

    // Conservation: every base unit of the dripped pot is accounted for
    // (predictor stakes), within (N-1)-wei integer-division dust.
    const totalCredited = aliceEarned + bobEarned + carolEarned;
    expect(totalCredited).to.be.closeTo(pot, 3n);
    expect(totalCredited).to.be.lte(pot);
  });

  // ------------------------------------------------------------------
  // GAP (med): "Fractional / non-multiple-of-RATE_SCALE drip rates over many
  //   rounds." The authoritative conservation guarantee (A_bounties): the
  //   sum of per-round drips over the bounty's lifetime equals the funded pool
  //   exactly (the min(rate,pool) tail-cap drains the residual). We assert
  //   that TRUE intent. (The separate NatSpec claim of exact per-round rate
  //   via residue-carry is the already-confirmed LOW finding; not asserted.)
  // ------------------------------------------------------------------
  it("[med] fractional merged rate: cumulative drip equals the funded pool (no loss)", async function () {
    // Quadratic merge of (100 wei @ rate 3) + (50 wei @ rate 4) -> stored rate
    // 3.2e18 scaled: floor per round = 3 base units, with 0.2 base unit GENUINELY
    // dropped each round (rate % RATE_SCALE != 0). Conservation must still hold
    // via the min(rate, pool) tail-cap.
    await bounties.connect(funder).fundBounty(s1, usdAddr, 100n, 3n);
    await bounties.connect(funder).fundBounty(s1, usdAddr, 50n, 4n);
    const SCALE = await bounties.RATE_SCALE();
    const rate = await bounties.ratePerRound(s1, usdAddr);
    // Sanity: the merge produced a genuinely fractional per-round rate.
    expect(rate % SCALE).to.not.equal(0n);
    expect(rate / SCALE).to.equal(3n); // floors to 3 base units/round
    const fundedPool = 150n;

    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));

    // Pipelined predict-then-settle: every round set a fresh rising value,
    // (re)predict, and settle the in-flight prediction (which drips that
    // round's pot once B and C exist). Continue until the pool is empty.
    let val = 100;
    for (let i = 0; i < 120; i++) {
      if ((await bounties.pool(s1, usdAddr)) === 0n) break;
      await registry.connect(authority).setValue(s1, val);
      val += 5;
      try {
        await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
      } catch (e) { /* already predicted this round */ }
      try { await satori.settlePrediction(alice.address, s1); } catch (e) { /* not yet settleable */ }
      await advanceOneDay();
    }
    // Flush any last in-flight prediction.
    for (let k = 0; k < 4; k++) {
      try { await satori.settlePrediction(alice.address, s1); } catch (e) {}
      await advanceOneDay();
    }

    // Sum every BountyDripped(amount) for (s1, *, usd) — total realized drip.
    const evts = await bounties.queryFilter(bounties.filters.BountyDripped(s1, null, usdAddr));
    let sumDripped = 0n;
    for (const e of evts) sumDripped += e.args.amount;

    // Conservation: cumulative drip == funded pool exactly (tail-cap drains
    // the residual); the pool empties to zero with no token left behind.
    expect(sumDripped).to.equal(fundedPool);
    expect(await bounties.pool(s1, usdAddr)).to.equal(0n);
  });

  // ------------------------------------------------------------------
  // GAP (med): cleanup-timing guard. Intended invariant: a (stream, token)
  //   can ONLY be cleaned once it is fully DRAINED (pool == 0 AND rate == 0).
  //   While a snapshot is pending and the pool/rate is still live, cleanup
  //   must revert. This pins the guard that is SUPPOSED to keep a pending
  //   staker's token from being evicted mid-flight.
  // ------------------------------------------------------------------
  it("[med] cleanup is rejected while the pool/rate is still live (snapshot pending)", async function () {
    await bounties.connect(funder).fundBounty(s1, usdAddr, ethers.parseEther("1000"), ethers.parseEther("1"));
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(s1, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);

    // Pool (1000) and rate (1) are live -> cleanup must revert NotDrained
    // even though alice has a pending snapshot.
    await expect(
      bounties.connect(owner).cleanupDrainedBountyToken(s1, usdAddr)
    ).to.be.revertedWithCustomError(bounties, "NotDrained");

    // Token still funded; alice's snapshot still intact.
    expect(await bounties.gameBountyTokenCount(s1)).to.equal(1n);
    const r = await satori.getCurrentRound();
    expect(await bounties.boostStakeForPrediction(alice.address, s1, r, usdAddr)).to.be.gt(0n);
  });

  // ------------------------------------------------------------------
  // GAP (high, partial): conservation cross-check — when EVERY snapshotted
  //   staker IS credited (the well-behaved case), Σ credited == captured pot.
  //   Two stakers with a 3:1 stake ratio split the pot 3:1, sum == pot.
  //   This guards the "pot fully drains to the winners" intent for the
  //   uneven-stake case (complements the equal-stake baseline above).
  // ------------------------------------------------------------------
  it("[high] uneven stakes: 3:1 split, full pot accounted for", async function () {
    await bounties.connect(funder).fundBounty(s1, usdAddr, ethers.parseEther("100"), ethers.parseEther("100"));
    await stakeFor(bounties, alice, usd, ethers.parseEther("300"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(s1, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();

    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120);

    await satori.settlePrediction(alice.address, s1);
    await satori.settlePrediction(bob.address, s1);

    const pot = await bounties.roundBountyPot(s1, r, usdAddr);
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("300");
    const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - ethers.parseEther("100");

    // 3:1 stake ratio -> 3:1 earned ratio (within dust).
    expect(aliceEarned).to.be.closeTo(bobEarned * 3n, 1000n);

    // Conservation: full pot accounted for, no stranded residue.
    const totalCredited = aliceEarned + bobEarned;
    expect(totalCredited).to.be.closeTo(pot, 2n);
    expect(totalCredited).to.be.lte(pot);
  });
});
