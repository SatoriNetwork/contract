// Regression guard — LOW#6 bounties: RATE_SCALE drip semantics.
//
// ORIGINAL FINDING (low_6): the RATE_SCALE NatSpec promised a per-round
// residue-CARRY ("residue accumulates in scaled units and carries across rounds
// so the long-run average drip equals actualRate exactly — no dust"), but no
// such carry was ever implemented; _dripTokenForRound floors `r / RATE_SCALE`
// each round. The finding also claimed "no zero-drip lock" — which turned out to
// be WRONG (see below).
//
// RESOLUTION (decided by the owner): do NOT build the residue-carry. The
// discarded fraction is < 1 base unit/round (sub-wei for an 18-decimal token),
// so carrying it would add permanent state + gas for no economic benefit. The
// floored fraction is not LOST — it stays in `pool` and drains via the
// min(rate, pool) tail, so the FULL pool is always paid out (only the per-round
// amount is floored). The NatSpec was rewritten to describe this honestly.
//
// PLUS a real bug uncovered while verifying "no funds lost": the quadratic-
// weighted merge in fundBounty floors each averaged term, so two minimum-rate
// funds can store a rate of RATE_SCALE-1 (< 1 base unit). `r / RATE_SCALE`
// alone is then 0 every round → the pool would be STRANDED forever. Fixed with
// a forward-progress floor in _dripTokenForRound: when rate>0 and pool>0, drip
// at least 1 base unit. The pool then always fully drains.
//
// This file pins the FIXED behavior:
//   1. per-round drip is floor(rate) (no residue-carry),
//   2. the full pool always drains — even the RATE_SCALE-1 degenerate case
//      (no zero-drip lock, no stranded funds),
//   3. fractional-token rates drip fine-grained base-unit amounts (not whole
//      tokens, not zero).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");

const UP = 1;

async function advanceToNextRound() {
  const currentTime = await time.latest();
  const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

async function deployMockToken(name = "MockUSD", sym = "mUSD") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(name, sym);
  await t.waitForDeployment();
  return t;
}

// Stream cadence floor: a PUBLIC caller may only create round-length (>= 1440
// minute) streams; sub-round streams are admin-only. This test's subject is bounty
// pool/drip/stake mechanics, not stream rhythm, so it keeps the fast (720-minute,
// sub-round) beat by having the ADMIN (`owner`) create the stream. `authority`
// stays the stream's PROVIDER, so it is still the account that writes values.
async function createSimpleStream(satori, signer, name, authority) {
  const fee = await satori.streamBurn();
  const sigBal = await satori.balanceOf(signer.address);
  if (sigBal < fee) {
    await satori.transfer(signer.address, fee - sigBal);
  }
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 720);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const parsed = satori.interface.parseLog(log);
      if (parsed && parsed.name === "DataStreamCreated") return parsed.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("[adversarial][low] LOW#6 bounties — drip floors, never strands, supports fractional rates", function () {
  this.timeout(180000);

  let satori, rewards, bounties, registry, owner, alice, funder, authority;
  let stream, usd, usdAddr, SCALE;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, , funder, authority] = fix.signers;
    // The fixture already calls initializeDefaultStream() (matching deploy.js),
    // so the default stream/game occupies id 1 and `stream` below is id 2.

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("50"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    stream = await createSimpleStream(satori, owner, "USD/JPY", authority.address);

    usd = await deployMockToken("USDC", "USDC");
    usdAddr = await usd.getAddress();
    SCALE = await bounties.RATE_SCALE();

    // Funding a NON-SATORI bounty charges an upfront bountyBurn SATORI fee on the
    // first fund of each (game, token) pair (top-ups are free). Each test does
    // exactly one such first-fund of (stream, usdAddr), so give the funder one
    // bountyBurn worth of SATORI.
    await satori.transfer(funder.address, await satori.bountyBurn());

    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));

    // Alice stakes the bounty token so her wins capture the round's drip.
    await usd.mint(alice.address, ethers.parseEther("1"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("1"));
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("1"));
  });

  // Predict UP in the current round (increasing value => UP wins on A-B-C).
  async function predictThisRound(val) {
    await advanceToNextRound();
    await registry.connect(authority).setValue(stream, val);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: stream, payload: pack1(UP) },
    ]);
    const pred = await satori.getLatestPrediction(alice.address, stream);
    return Number(pred.roundMade);
  }

  // Drive `n` predicted rounds (+1 trailing so the last gets scored). The pot is
  // reserved at each round's prediction, so all n+1 rounds drip. Returns
  // { cumulativeDrip, firedRounds }.
  async function driveAndMeasure(n) {
    const poolBefore = await bounties.pool(stream, usdAddr);
    const roundsMade = [];
    let val = 100;
    for (let i = 0; i < n + 1; i++) {
      const r = await predictThisRound(val);
      roundsMade.push(r);
      val += 1;
    }
    for (let i = 0; i < 3; i++) {
      try { await satori.settlePrediction(alice.address, stream); } catch (e) {}
    }
    const poolAfter = await bounties.pool(stream, usdAddr);
    let firedRounds = 0n;
    for (const r of roundsMade) {
      if ((await bounties.roundBountyPot(stream, r, usdAddr)) > 0n) firedRounds += 1n;
    }
    return { cumulativeDrip: poolBefore - poolAfter, firedRounds, poolAfter };
  }

  it("drips floor(rate) per round — NO residue-carry (the simple, documented behavior)", async function () {
    // Two funds whose quadratic-weighted merge yields a fractional rate (3.2).
    await bounties.connect(funder).fundBounty(stream, usdAddr, 100n, 3n); // virgin: 3e18
    await bounties.connect(funder).fundBounty(stream, usdAddr, 50n, 4n);  // merge:  3.2e18

    const storedRate = await bounties.ratePerRound(stream, usdAddr);
    const wholePart = storedRate / SCALE;     // floor(actualRate) = 3
    const frac = storedRate % SCALE;          // 0.2e18
    expect(frac).to.not.equal(0n, "setup: merged rate must be fractional");

    const { cumulativeDrip, firedRounds } = await driveAndMeasure(12);

    const withCarry = (firedRounds * storedRate) / SCALE; // floor(N*3.2)
    const noCarry = firedRounds * wholePart;              // N*3
    // The window must be long enough that carry vs no-carry actually diverge,
    // otherwise the assertion is vacuous.
    expect(firedRounds).to.be.gte(5n, "setup: need >=5 fired rounds for residue to cross a unit");
    expect(withCarry).to.be.gt(noCarry, "setup: carry and no-carry must diverge");

    // What we actually do: floor per round (no carry).
    expect(cumulativeDrip).to.equal(noCarry,
      "per-round drip must be floor(rate); residue is NOT carried");
  });

  it("never strands the pool: a RATE_SCALE-1 merged rate still fully drains (zero-drip-lock fix)", async function () {
    // Degenerate merge: two minimum-rate (1 base unit) funds. Weights 4 and 9
    // over 13 floor to 999999999999999999 = RATE_SCALE-1. Pre-fix this dripped
    // 0 every round and locked the 5-base-unit pool forever.
    await bounties.connect(funder).fundBounty(stream, usdAddr, 2n, 1n);
    await bounties.connect(funder).fundBounty(stream, usdAddr, 3n, 1n);

    const rate = await bounties.ratePerRound(stream, usdAddr);
    expect(rate).to.be.lt(SCALE, "setup: merged rate must floor below RATE_SCALE");
    expect(rate / SCALE).to.equal(0n, "setup: naive r/RATE_SCALE would be 0 (the lock)");

    const { cumulativeDrip, poolAfter } = await driveAndMeasure(12);

    // FIXED: forward-progress floor drips >=1 base unit/round, so the full
    // 5-base-unit pool drains — nothing stranded.
    expect(poolAfter).to.equal(0n, "pool must fully drain — no stranded funds");
    expect(cumulativeDrip).to.equal(5n, "every funded base unit must be paid out");
  });

  it("supports fine-grained fractional-token rates (drips a fraction of a token, not whole tokens)", async function () {
    // Half a token per round of an 18-decimal token: rate = 0.5e18 base units.
    const halfToken = ethers.parseEther("0.5"); // 5e17 base units/round
    await bounties.connect(funder).fundBounty(
      stream, usdAddr, ethers.parseEther("100"), halfToken
    );

    const storedRate = await bounties.ratePerRound(stream, usdAddr);
    const perRound = storedRate / SCALE;
    // Sub-token granularity: each round drips exactly 0.5 token (5e17 base
    // units) — proof the system does NOT round to whole tokens and is not
    // limited to integer token amounts.
    expect(perRound).to.equal(halfToken);
    expect(perRound).to.be.gt(0n);
    expect(perRound).to.be.lt(ethers.parseEther("1"));

    const { cumulativeDrip, firedRounds } = await driveAndMeasure(8);
    expect(firedRounds).to.be.gte(2n);
    // Each fired round drips exactly the fine-grained 0.5-token amount.
    expect(cumulativeDrip).to.equal(firedRounds * halfToken);
  });
});
