// PR5 Item V — quadratic weighting in `fundBounty`.
//
// Replaces the prior linear weighted-average:
//   newRate_linear = (oldPool × oldRate + received × pRate × SCALE) / (oldPool + received)
// with the quadratic form:
//   newRate_quad   = (oldPool² × oldRate + received² × pRate × SCALE) / (oldPool² + received²)
//
// Properties verified here:
//   - Virgin pool: collapses to `pRate × SCALE`.
//   - Equal contribution (received == oldPool): crossover with linear —
//     identical numerical result (plain average of the two rates).
//   - Small contribution (received ≪ oldPool): influence ∝ size².
//   - Large contribution (received > oldPool): dominates faster than linear.
//   - Chained-small griefing asymptotes: 30 floor-edge calls of 10% size
//     keep the rate well above the linear-decay floor.
//   - Conservation across drains is unchanged.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const UP = 1;
async function advanceOneDay() { await time.increase(86400); }

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

async function createStream(satori, signer, name, authority) {
  // Cadence-1440 (every-round) stream: one write per 24h round, which is the
  // rhythm this suite writes at. `authority` stays the provider — it
  // is who may call `registry.setValue`.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("QuadraticWeighting (PR5 Item V)", function () {
  let satori, rewards, bounties, registry, owner, alice, bob, carol, funderA, funderB, authority;
  let stream, usd;
  let SCALE;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, bob, carol, funderA, funderB, authority] = fix.signers;

    SCALE = await bounties.RATE_SCALE();

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));
    await satori.transfer(funderA.address, ethers.parseEther("100"));
    await satori.transfer(funderB.address, ethers.parseEther("100"));

    stream = await createStream(satori, owner, "S", authority.address);
    await voteFor(satori, alice, stream);
    await voteFor(satori, bob, stream);
    await voteFor(satori, carol, stream);

    usd = await deployMockToken();
    for (const f of [funderA, funderB]) {
      await usd.mint(f.address, ethers.parseEther("1000000"));
      await usd.connect(f).approve(await bounties.getAddress(), ethers.parseEther("1000000"));
    }

    // (A vestigial `for (const u of [alice, bob, carol]) {}` with an EMPTY body sat
    // here, labelled "subscribe predictors so drips fire on score". Its call had been
    // gutted, so no predictor was ever staked and nothing could ever drip -- which is
    // why the conservation test below measured 0. Staking is now done inside that test
    // only, so the fundBounty-math tests in this file keep their exact pool values.
    // 2026-07-30, skip triage.)
  });

  // --- 1. Virgin path ---

  it("virgin path: empty pool → ratePerRound == proposedRate × RATE_SCALE", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(funderA).fundBounty(stream, usdAddr, ethers.parseEther("1000"), 5n);
    expect(await bounties.pool(stream, usdAddr)).to.equal(ethers.parseEther("1000"));
    expect(await bounties.ratePerRound(stream, usdAddr)).to.equal(5n * SCALE);
  });

  // --- 2. Small-contribution damping ---

  it("small-contribution damping: pool=1000 rate=10, fund 100 @ rate=1 → newRate ≈ 9.911 (closeTo 1e15)", async function () {
    const usdAddr = await usd.getAddress();
    // A: pool=1000, rate=10. Stored: 10·SCALE.
    await bounties.connect(funderA).fundBounty(stream, usdAddr, 1000n, 10n);
    expect(await bounties.ratePerRound(stream, usdAddr)).to.equal(10n * SCALE);

    // B: 100 at rate=1 (10% floor, passes).
    // Quadratic: newRate = (1000² · 10 + 100² · 1) / (1000² + 100²) · SCALE
    //                    = (10,000,000 + 10,000) / 1,010,000 · SCALE
    //                    = 10,010,000 / 1,010,000 · SCALE
    //                    = 9.91089108... · SCALE
    await bounties.connect(funderB).fundBounty(stream, usdAddr, 100n, 1n);
    const got = await bounties.ratePerRound(stream, usdAddr);

    // Within sub-thousandth of 9.911 · SCALE (1e15 tolerance against ~1e19).
    const expected = (9911n * SCALE) / 1000n; // 9.911 × SCALE
    expect(got).to.be.closeTo(expected, 10n ** 15n);

    // Tighter check: at most 2-wei residue (the implementation sums two
    // mulDiv results, each of which may floor-drop up to 1 wei).
    const exact = (10_010_000n * SCALE) / 1_010_000n;
    expect(got).to.be.closeTo(exact, 2n);
  });

  // --- 3. Crossover at equal contribution ---

  it("crossover at equal contribution: pool=1000 rate=10, fund 1000 @ rate=5 → newRate == 7.5 (plain average)", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(funderA).fundBounty(stream, usdAddr, 1000n, 10n);
    await bounties.connect(funderB).fundBounty(stream, usdAddr, 1000n, 5n);

    // At received == oldPool, oldWeight == newWeight, so newRate is the
    // plain average of the two rates. (10 + 5) / 2 = 7.5.
    const got = await bounties.ratePerRound(stream, usdAddr);
    const expected = (15n * SCALE) / 2n; // 7.5 · SCALE
    // Two mulDiv calls with the same denominator — sum can lose up to
    // 1 wei to integer-division residue per call. Allow ≤ 2 wei.
    expect(got).to.be.closeTo(expected, 2n);
  });

  // --- 4. Large-contribution dominance ---

  it("large-contribution dominance: pool=1000 rate=10, fund 2000 @ rate=5 → newRate == 6 (not 6.667)", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(funderA).fundBounty(stream, usdAddr, 1000n, 10n);
    await bounties.connect(funderB).fundBounty(stream, usdAddr, 2000n, 5n);

    // Quadratic: (1000² · 10 + 2000² · 5) / (1000² + 2000²) · SCALE
    //          = (10⁷ + 2·10⁷) / 5·10⁶ · SCALE
    //          = 3·10⁷ / 5·10⁶ · SCALE
    //          = 6 · SCALE
    // (Linear would have been (1000·10 + 2000·5) / 3000 = 20000/3000 = 6.667;
    //  quadratic gives the larger funder more pull, so closer to B's 5.)
    const got = await bounties.ratePerRound(stream, usdAddr);
    const expected = 6n * SCALE;
    expect(got).to.be.closeTo(expected, 2n);
  });

  // --- 5. Conservation across a drain ---

  it("conservation: drain a quadratic-funded pool → total dripped == original pool exactly", async function () {
    const usdAddr = await usd.getAddress();
    // Build pool = 1000 + 2000 = 3000 with rate ≈ 6·SCALE per case 4 above.
    await bounties.connect(funderA).fundBounty(stream, usdAddr, 1000n, 10n);
    await bounties.connect(funderB).fundBounty(stream, usdAddr, 2000n, 5n);
    const startingPool = 3000n;
    expect(await bounties.pool(stream, usdAddr)).to.equal(startingPool);

    // Drive scoring cycles until the pool drains. actualDrip = floor(rate/SCALE) = 6.
    // 3000 / 6 = 500 rounds — too slow to iterate. Use a smaller fixture:
    // re-fund a fresh stream with pool=12, rate=6 so it drains in 2 cycles.
    const stream2 = await createStream(satori, owner, "S2", authority.address);
    await voteFor(satori, alice, stream2);

    await bounties.connect(funderA).fundBounty(stream2, usdAddr, 6n, 6n);
    await bounties.connect(funderB).fundBounty(stream2, usdAddr, 6n, 6n);
    // Equal weights, both at rate 6 → newRate == 6·SCALE. pool == 12.
    expect(await bounties.pool(stream2, usdAddr)).to.equal(12n);
    expect(await bounties.ratePerRound(stream2, usdAddr)).to.be.closeTo(6n * SCALE, 2n);

    // The drip is reached only through a predictor's boost snapshot, which needs
    // BOTH a bounty stake ("Stake-only eligibility: zero predict-time snapshot →
    // zero payout", SatoriBounties.sol) and a non-zero streak (audit C-2:
    // applyBoost gets multiplier 0 at streak 0, SatoriEngine.sol). Warm the
    // streaks BEFORE staking so the warm-up itself drips nothing.
    let warmVal = 50;
    for (const u of [alice, bob]) {
      await advanceOneDay();
      await registry.connect(authority).setValue(stream2, warmVal);
      await satori.connect(u).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }]);
      await advanceOneDay();
      await registry.connect(authority).setValue(stream2, warmVal + 2);
      await advanceOneDay();
      await registry.connect(authority).setValue(stream2, warmVal + 4);
      await satori.settlePrediction(u.address, stream2);
      expect(await satori.streaks(u.address, stream2)).to.be.gt(0n);
      warmVal += 10;
    }
    // Pool untouched by the warm-up: no stake meant no snapshot, so no drip.
    expect(await bounties.pool(stream2, usdAddr)).to.equal(12n);

    for (const u of [alice, bob]) {
      await usd.mint(u.address, 1000n);
      await usd.connect(u).approve(await bounties.getAddress(), 1000n);
      await bounties.connect(u).stakeBountyToken(usdAddr, 1000n);
    }

    let totalDripped = 0n;
    let priorVal = 100;
    for (let i = 0; i < 4; i++) {
      await advanceOneDay();
      await registry.connect(authority).setValue(stream2, priorVal);
      const predictor = i % 2 === 0 ? alice : bob;
      await satori.connect(predictor).predictMultipleWithPayloads([{ gameId: stream2, payload: pack1(UP) }]);
      const round = await satori.getCurrentRound();
      await advanceOneDay();
      await registry.connect(authority).setValue(stream2, priorVal + 5);
      await advanceOneDay();
      await registry.connect(authority).setValue(stream2, priorVal + 10);
      await satori.settlePrediction(predictor.address, stream2);
      totalDripped += await bounties.roundBountyPot(stream2, round, usdAddr);
      priorVal += 20;
    }
    expect(totalDripped).to.equal(12n);
    expect(await bounties.pool(stream2, usdAddr)).to.equal(0n);
  });

  // --- 6. Chained-small-contribution griefing asymptotes ---

  it("chained griefing: 30 calls of (100, floor) against pool=1000 rate=10 — final rate stays > 9 (asymptote)", async function () {
    const usdAddr = await usd.getAddress();
    await bounties.connect(funderA).fundBounty(stream, usdAddr, 1000n, 10n);

    // Linear weighting baseline: 30 chained dilutions at the floor would
    // converge toward 1 (the floor value). Quadratic damps each call by
    // (chunk/pool)² — each tiny chunk has ~1% pull (since 100/(1000+...
    // accumulating) → 100/1000 at first → ratio² ≈ 1%), so the rate
    // asymptotes near the original 10 rather than near the floor.
    //
    // Cap analysis: each 100-wei chunk contributes newWeight = 10000.
    // After 30 chunks the pool is 1000 + 30·100 = 4000, and pool² = 1.6e7.
    // Each call's incremental influence ≈ 10000 / 1.6e7 ≈ 0.06% on the
    // last call, so the integrated drift over 30 calls stays small.
    //
    // Assert the result is strictly > 9 · SCALE. Linear weighting would
    // have collapsed it to ~5 · SCALE (each 10% call drags rate halfway
    // toward the floor; 30 iterations land near the floor).
    for (let i = 0; i < 30; i++) {
      await bounties.connect(funderB).fundBounty(stream, usdAddr, 100n, 1n);
    }
    const got = await bounties.ratePerRound(stream, usdAddr);
    expect(got).to.be.gt(9n * SCALE);
    // Upper sanity: rate didn't increase past the original 10.
    expect(got).to.be.lt(10n * SCALE);
  });

  // --- 7. Overflow safety ---

  it("overflow safety: oldPool near 2^128 still computes (oldPool² stays under uint256)", async function () {
    // The implementation does `oldPool * oldPool` in plain checked
    // uint256 arithmetic. For pool < 2^128, the square is < 2^256 and
    // succeeds. Build that state by funding a large amount on a fresh
    // virgin (stream, token) pair.
    //
    // Fund 2^120 wei (well under 2^128). Then fund 1 wei more (at the
    // 10% floor of currentRate). The second call's quadratic math must
    // not revert.
    const big = 1n << 120n; // 2^120 ≈ 1.33e36
    const usdAddr2 = await (await deployMockToken("BIG")).getAddress();
    const huge = await ethers.getContractAt("MockERC20", usdAddr2);
    await huge.mint(funderA.address, big + 1000n);
    await huge.connect(funderA).approve(await bounties.getAddress(), big + 1000n);

    // proposedRate <= received required by the ceiling.
    // Use proposedRate = 100 (small, well-below received).
    await bounties.connect(funderA).fundBounty(stream, usdAddr2, big, 100n);
    expect(await bounties.pool(stream, usdAddr2)).to.equal(big);

    // Second fund: 1000 at rate=10 (10% floor of 100 is 10).
    await huge.mint(funderB.address, 1000n);
    await huge.connect(funderB).approve(await bounties.getAddress(), 1000n);
    await expect(
      bounties.connect(funderB).fundBounty(stream, usdAddr2, 1000n, 10n)
    ).to.not.be.reverted;
  });
});
