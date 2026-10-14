// v5 — predict-time snapshot prevents mid-cycle stake inflation from
// affecting score-time share. The snapshot is `bountyStake[user][T]`
// captured AT predict time and stored in `_boostStakeForPrediction`. The
// `_totalBoostStakeByDirection` accumulator is bumped by the same value.
// At score time the share reads the snapshot, NOT the live stake, so
// later stakes can't break conservation.
//
// Setup: Alice stakes X, predicts on a stream with a USD bounty, then
// stakes another X before scoring. The score-time share for that
// prediction must reflect X (snapshot), not 2X (live stake).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, RAW_TOLERANCE, pack1 , warmUpStreak, VOTE } = require("./fixtures");

const UP = 1;

async function deployMockToken() {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy("USDC", "USDC");
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

const TOKENS_PER_ROUND = ethers.parseEther("720");

// (Removed 2026-07-30, skip triage: `bsqrt` + `normalizedPredictorShare` replicated a
// sqrt-normalised bounty-share model -- pot x (userW + userBoost x sqrt(...)) /
// (totalW + ...) -- that the contracts no longer implement. The bounty share is now
// plainly `pot x userBoost / totalBoost` (SatoriBounties.sol), and the
// `totalRawPowerByDirection` lens view the helper needed exists nowhere. Both were
// dead after the assertions below were rewritten to read the accumulators directly;
// deleted so nobody revives the wrong formula from them.)


async function createStream(satori, signer, name, authority) {
  // Every-round (1440-minute) stream — one value write per 24h round, which is
  // this suite's rhythm. 1440 is the finest PUBLIC cadence SatoriHub allows, so
  // no admin exemption is needed. `authority` stays the provider — it is who
  // may call `registry.setValue`.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("BountyBoostSnapshot — predict-time snapshot is load-bearing", function () {
  let satori, rewards, bounties, registry, owner, alice, bob, funder, authority, lens;
  let stream, usd;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, lens, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    stream = await createStream(satori, owner, "S", authority.address);

    // audit C-2: streak 0 pays flat dust and takes no bounty boost — warm to streak >= 1

    await warmUpStreak(satori, registry, authority, [alice, bob], stream);
    await satori.connect(alice).vote(stream, VOTE);
    await satori.connect(bob).vote(stream, VOTE);

    usd = await deployMockToken();
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await usd.mint(alice.address, ethers.parseEther("10000"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("10000"));

    // (Another gutted `for (const u of [alice, bob]) {}` with an EMPTY body sat here.
    // Bob needs usd of his own to stake — without a second staker the snapshot
    // property below is unobservable. 2026-07-30, skip triage.)
    await usd.mint(bob.address, ethers.parseEther("10000"));
    await usd.connect(bob).approve(await bounties.getAddress(), ethers.parseEther("10000"));
  });

  it("mid-cycle stake increase between predict and score does NOT inflate the score-time share", async function () {
    // Phase 1: Alice AND Bob each stake 100 USD.
    //
    // Bob's stake is load-bearing (2026-07-30, skip triage). The bounty share is
    // `pot × userBoost / totalBoost` (SatoriBounties.sol), so with Alice as the
    // SOLE staker userBoost == totalBoost and her payout is the whole pot no matter
    // what her snapshot says — the property would be unobservable. With a matched
    // second staker, a snapshot of 100 pays her half the pot and a live-stake read
    // of 200 would pay her two thirds, so the two are distinguishable.
    await bounties.connect(alice).stakeBountyToken(await usd.getAddress(), ethers.parseEther("100"));
    await bounties.connect(bob).stakeBountyToken(await usd.getAddress(), ethers.parseEther("100"));

    // Phase 2: Bounty + predict.
    await bounties.connect(funder).fundBounty(
      stream, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("200")
    );
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);

    // Phase 3: BEFORE scoring, Alice stakes ANOTHER 100 USD (live stake = 200).
    // The snapshot taken at predict time was 100 — score-time share must
    // still use 100, not 200.
    await bounties.connect(alice).stakeBountyToken(await usd.getAddress(), ethers.parseEther("100"));
    expect(await bounties.bountyStake(alice.address, await usd.getAddress())).to.equal(ethers.parseEther("200"));

    // Phase 4: Score.
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream);
    await satori.settlePrediction(bob.address, stream);

    // Phase 5: Alice's payout must match the SNAPSHOT (100), not the live stake (200).
    //
    // Asserted by EQUALITY WITH BOB rather than by recomputing the payout. The old
    // version replicated a sqrt-normalised share model (via a
    // `totalRawPowerByDirection` lens view) that no longer exists: the bounty share
    // is now plainly `pot × userBoost / totalBoost`, the multiplier cancels, and
    // neither the view nor its backing storage remains. Comparing the two
    // predictors is both formula-agnostic and fee-agnostic, and is exactly the
    // property in the title. (2026-07-30, skip triage.)
    const usdAddr = await usd.getAddress();

    // The pinned snapshots are EQUAL: both staked 100 at predict time. (The stored
    // value is stake x multiplier, not raw stake, so compare the two rather than a
    // literal -- the multiplier cancels in `pot x userBoost / totalBoost` anyway.)
    // Had Alice's mid-cycle top-up counted, hers would be double Bob's.
    const predRound = (await satori.getCurrentRound()) - 2n;
    const snapAlice = await bounties.boostStakeForPrediction(alice.address, stream, predRound, usdAddr);
    const snapBob   = await bounties.boostStakeForPrediction(bob.address, stream, predRound, usdAddr);
    expect(snapAlice).to.be.gt(0n, "alice has a predict-time snapshot at all");
    expect(snapAlice).to.equal(snapBob, "snapshot pinned at the predict-time stake, not the live 200");
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.be.gte(ethers.parseEther("200"));

    // Auto-compound: earnings land in bountyStake, so subtract each principal.
    const aliceOwed = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("200");
    const bobOwed   = (await bounties.bountyStake(bob.address, usdAddr))   - ethers.parseEther("100");

    expect(aliceOwed).to.be.gt(0n, "alice was actually paid (assertion is not vacuous)");
    expect(bobOwed).to.be.gt(0n, "bob was actually paid");
    // Equal snapshots => equal shares. Had the mid-cycle top-up counted, Alice's
    // 200 against Bob's 100 would have paid her strictly more.
    expect(aliceOwed).to.equal(
      bobOwed,
      "mid-cycle stake increase must NOT inflate the score-time share"
    );
  });

  it("conservation per-token: Σ(predictorAmount) + Σ(fee1+fee2) = pot exactly", async function () {
    // Alice stakes 100, Bob does not. Both predict UP.
    await bounties.connect(alice).stakeBountyToken(await usd.getAddress(), ethers.parseEther("100"));
    await bounties.connect(funder).fundBounty(
      stream, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("200")
    );
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);

    // Mid-cycle stake (must not affect conservation).
    await bounties.connect(alice).stakeBountyToken(await usd.getAddress(), ethers.parseEther("100"));

    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream);
    await satori.settlePrediction(bob.address, stream);

    const usdAddr = await usd.getAddress();
    // Alice has 200 USD staked (100 initial + 100 mid-cycle). Subtract to
    // isolate her earned amount. Bob has no initial stake.
    const aliceOwed = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("200");
    const bobOwed = await bounties.bountyStake(bob.address, usdAddr);

    // Conservation closure tight bound: Σ_winners share_i = pot exactly under
    // unbounded arithmetic. Under integer division, each winner's share is
    // computed as `floor(pot * (userW_i + boost_i) / (totalW + totalBoost))`,
    // so the sum is at most one wei below pot (the two floors share a single
    // denominator; the combined fractional drop is < 1 ⋅ denominator). Per
    // winner the v5 split (predictor + fee1 + fee2 = share) is exact, so the
    // global total predictor+fee buckets equals Σshares — residue ∈ {0, 1}.
    expect(aliceOwed + bobOwed).to.be.closeTo(ethers.parseEther("200"), RAW_TOLERANCE);
  });
});
