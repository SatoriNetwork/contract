/**
 * ADVERSARIAL — OFF-CHAIN DIAL + MERKLE LANES
 * ============================================
 * Target: the Phase 2b strict per-lane reservation of the shared reward cap, plus the SatoriMerkle cumulative drop and the SatoriRewards
 * `offchainBudget` dial that feeds `core._merkleReserveRate`.
 *
 * We play a genuine adversary against the walls:
 *   - Merkle lane can NEVER spend on-chain headroom
 *     (merkleMinted + amt <= merkleReserveCumulative).
 *   - On-chain lane can NEVER spend Merkle's reserve
 *     (onChainMinted + amt + merkleReserveCumulative <= token.generalAccrued()).
 *   - Nothing mints that was not reported, and everything reported (general +
 *     fee) stays under the token's `1440 × roundsElapsed` — even by racing the
 *     dial up after the on-chain lane already spent all it was allowed.
 *   - dial=0 is byte-for-byte DORMANT (no reserve state written).
 *   - the 1-wei floor: offchainBudget / reserve rate can never reach the
 *     general residual (emission net of the fee's 15%).
 *   - dial move mid-round lands NEXT round (flush-at-old-rate, never retroactive).
 *   - Merkle idempotent / monotonic / forever-claimable / no underflow.
 *   - write-once wiring; the second-minter gate (a 3rd caller reverts).
 *   - on-chain ceiling never underflows at the extreme dial.
 *
 * Conventions mirror test/ReserveLanes.test.js and test/SatoriMerkle.test.js —
 * a hand-rolled stack (NOT the games fixture) so we control the dial directly.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureOpts } = require("../fixtures");
const { deployMerkleProxied } = require("../next/splitFixture");

const E = (n) => ethers.parseEther(String(n));
const ROUND_BUDGET = E(1440); // ROUND_REWARD_BUDGET — the token's OUTER envelope

// Read, never written out: the rate steps on the hub and the fee bps lives on the token.
// No test here issues anywhere near the hub's first step threshold, so the
// rate is constant across the handful of rounds any one test advances.
let RATE;  // emission per round
let DEV1;  // the fee's slice of it
let GEN1;  // the general residual = RATE - DEV1; the reserve-rate ceiling (exclusive)

async function advanceRounds(n) {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 * n + 1);
}

// OZ StandardMerkleTree leaf: double-hashed abi.encode(account, amount).
function leafOf(addr, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount])
  );
  return ethers.keccak256(inner);
}
function hashPair(a, b) {
  return a.toLowerCase() < b.toLowerCase()
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

async function deployStack(admin, publisher) {
  // Restructured stack: immutable SatoriToken + UUPS SatoriEngine + SatoriHub
  // + children, behind the monolith-shaped `satori` shim (getAddress()/target ==
  // HUB). The merkle/on-chain reserve-split policy (rewardMint,
  // setMerkleReserveRate, merkleReserveCeiling, onChainMinted/merkleMinted, …)
  // all live on the HUB now, so the "core" the merkle channel binds to is the hub.
  // feeBps == 0 mirrors the old inline SatoriRewards.deploy(voting, admin, 0);
  // the rewards admin defaults to the deployer/governor (== admin here). (Burn
  // voting has no top-N cap, so the old `votingCap` fixture knob is gone.)
  const fix = await deploySatoriFixtureOpts(0);
  const { satori, token, rewards, voting, registry, games, bounties } = fix;
  const core = await satori.getAddress(); // hub address (the mint authority)

  const merkle = await deployMerkleProxied(publisher.address, fix.token.target);
  await satori.connect(admin).setSatoriMerkle(await merkle.getAddress()); // governor wires, write-once
  await merkle.setSatoriCore(core);                                       // proxy deployer wires core (hub), write-once
  return { satori, token, rewards, merkle, voting, registry, games, bounties, coreAddr: core };
}

// Impersonate the REAL rewards proxy so we can drive the hub's authorized
// rewards-child paths directly (freezeRoundGross / noteIssued / rewardMint /
// setMerkleReserveRate) to arbitrary amounts — simulating an over-issuing
// rewards path — while the real rewards child stays wired.
async function asRewards(rewards, coreAddr) {
  const rewardsAddr = await rewards.getAddress();
  await impersonateAccount(rewardsAddr);
  await setBalance(rewardsAddr, ethers.parseEther("10"));
  const rewardsSigner = await ethers.getSigner(rewardsAddr);
  const hub = await ethers.getContractAt("SatoriHub", coreAddr);
  return { hub, rewardsSigner };
}

// What Rewards may still report before noteIssued's schedule backstop refuses.
async function allowanceRoom(hub, token) {
  return (await hub.onChainAllowance()) - ((await token.generalAccrued()) - (await hub.merkleReserveCumulative()));
}

// Prices the current round, then reports `amount` (default: the whole room).
async function priceAndReport(hub, rw, token, amount) {
  await hub.connect(rw).freezeRoundGross(await token.getCurrentRound());
  const amt = amount === undefined ? await allowanceRoom(hub, token) : amount;
  if (amt > 0n) await hub.connect(rw).noteIssued(amt);
  return amt;
}

// What every step must keep, whatever the dial did.
async function expectLedgers(satori, token) {
  const e = (await token.getCurrentRound()) - (await token.deploymentRound()) + 1n;
  const gA = await token.generalAccrued();
  const cum = await satori.merkleReserveCumulative();
  expect(gA + (await token.devFeeAccrued())).to.be.lte(ROUND_BUDGET * e);
  expect(gA - cum, "on-chain reports inside the priced allowance").to.be.lte(await satori.onChainAllowance());
  expect((await satori.onChainMinted()) + cum, "on-chain lane never spends the reserve").to.be.lte(gA);
  expect(await satori.merkleMinted(), "merkle lane inside the banked reserve").to.be.lte(cum);
  expect((await satori.onChainMinted()) + (await satori.merkleMinted())).to.equal(await token.generalMinted());
  expect(await token.generalMinted()).to.be.lte(gA);
  expect(await token.totalRewardsMinted()).to.equal(
    (await token.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted())
  );
}

describe("ADVERSARIAL: off-chain dial + Merkle lanes", function () {
  let satori, token, rewards, merkle, coreAddr;
  let owner, alice, bob, publisher, stranger;

  beforeEach(async function () {
    [owner, alice, bob, publisher, stranger] = await ethers.getSigners();
    ({ satori, token, rewards, merkle, coreAddr } = await deployStack(owner, publisher));
    RATE = await satori.emissionRateNow();
    DEV1 = await satori.devRateNow();
    GEN1 = RATE - DEV1;
  });

  // ------------------------------------------------------------------
  // HEADLINE: the combined cap is inviolable across BOTH lanes.
  // ------------------------------------------------------------------

  it("ATTACK: cannot exceed the global cap by racing the dial up after the on-chain lane consumed early headroom", async function () {
    const { hub, rewardsSigner: rw } = await asRewards(rewards, coreAddr);

    // The on-chain lane eats every wei it was allowed while the reserve is 0.
    await advanceRounds(1);
    await hub.connect(rw).freezeRoundGross(await token.getCurrentRound());
    const room = await allowanceRoom(hub, token);
    // Two rounds priced (the deploy round on its first touch, then this one).
    expect(room).to.equal(GEN1 * 2n);
    await expect(hub.connect(rw).noteIssued(room + 1n)).to.be.revertedWithCustomError(satori, "BudgetExceeded");
    await hub.connect(rw).noteIssued(room);
    const headroom = (await satori.onChainRewardCeiling()) - (await satori.onChainMinted());
    expect(headroom).to.equal(room);
    await hub.connect(rw).rewardMint(stranger.address, headroom);
    await expect(hub.connect(rw).rewardMint(stranger.address, 1n)).to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // NOW the adversary dials the reserve to the max and lets it balloon. If the
    // reserve handed the on-chain lane room, or banked past the token envelope,
    // the combined cap would break.
    await hub.connect(rw).setMerkleReserveRate(GEN1 - 1n);
    await advanceRounds(2);
    await hub.connect(rw).freezeRoundGross(await token.getCurrentRound());
    const reserve = await satori.merkleReserveCumulative();
    expect(reserve).to.equal((GEN1 - 1n) * 2n);
    expect(await satori.merkleReserveCeiling()).to.equal(reserve);
    // The on-chain lane gained only its own gross for the two rounds: 1 wei each.
    expect(await allowanceRoom(hub, token)).to.equal(2n);
    await expect(hub.connect(rw).noteIssued(3n)).to.be.revertedWithCustomError(satori, "BudgetExceeded");
    await hub.connect(rw).noteIssued(2n);
    await hub.connect(rw).rewardMint(stranger.address, 2n);
    await expect(hub.connect(rw).rewardMint(stranger.address, 1n)).to.be.revertedWithCustomError(satori, "BudgetExceeded");

    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));
    await merkle.connect(alice).claimMerkle(reserve, []);
    expect(await satori.merkleMinted()).to.equal(reserve);

    // Every reported wei is minted (fee included) and the sum is under 1440 x rounds.
    await token.mintDevFee();
    const e = (await token.getCurrentRound()) - (await token.deploymentRound()) + 1n;
    const accrued = (await token.generalAccrued()) + (await token.devFeeAccrued());
    expect(await token.totalRewardsMinted()).to.equal(accrued);
    expect(accrued).to.be.lte(ROUND_BUDGET * e);
    await expectLedgers(satori, token);
  });

  it("ATTACK: fill BOTH lanes to their exact ceilings, then one wei on either side reverts (combined == everything reported, not over)", async function () {
    const { hub, rewardsSigner: rw } = await asRewards(rewards, coreAddr);
    await hub.connect(rw).setMerkleReserveRate(E(200));
    const room0 = await allowanceRoom(hub, token);
    const priced0 = await hub.onChainPricedRound();
    const gA0 = await token.generalAccrued();
    expect(await satori.merkleReserveCumulative()).to.equal(0n);
    await advanceRounds(3); // the dial lands next round: 3 rounds x 200
    expect(await satori.merkleReserveCeiling()).to.equal(E(600));

    // Price (banks the reserve) and report the on-chain lane's whole allowance.
    const reported = await priceAndReport(hub, rw, token);
    const reserve = await satori.merkleReserveCumulative();
    expect(reserve).to.equal(E(600));
    // Every round not yet priced is priced at the residual less the dial.
    expect(reported).to.equal(room0 + (GEN1 - E(200)) * ((await token.getCurrentRound()) - priced0));

    // Fill the on-chain lane EXACTLY: everything reported, less the reserve.
    const onChainCeil = await satori.onChainRewardCeiling();
    expect(await token.generalAccrued()).to.equal(gA0 + reported + reserve);
    expect(onChainCeil).to.equal(gA0 + reported);
    await hub.connect(rw).rewardMint(stranger.address, onChainCeil - (await satori.onChainMinted()));
    expect(await satori.onChainMinted()).to.equal(onChainCeil);

    // Fill the Merkle lane EXACTLY to its ceiling.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));
    await merkle.connect(alice).claimMerkle(reserve, []);
    expect(await satori.merkleMinted()).to.equal(reserve);

    // Both general lanes full: together they minted exactly what was reported.
    const generalAccrued = await token.generalAccrued();
    expect((await satori.onChainMinted()) + (await satori.merkleMinted())).to.equal(generalAccrued);

    // One wei more on the on-chain side -> revert, as a mint (its lane is full)
    // and as a report (the priced allowance is spent).
    await expect(hub.connect(rw).rewardMint(stranger.address, 1n))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    await expect(hub.connect(rw).noteIssued(1n))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    // One wei more on the Merkle side -> revert (its lane is full).
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve + 1n));
    await expect(merkle.connect(alice).claimMerkle(reserve + 1n, []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");

    expect(await token.generalAccrued()).to.equal(generalAccrued);
    expect(await token.generalMinted()).to.equal(generalAccrued);
    await expectLedgers(satori, token);
  });

  it("INVARIANT: through an interleaved dial/report/mint/claim sequence, both lanes stay inside what was reported and the total under 1440 x rounds", async function () {
    const { hub, rewardsSigner: rw } = await asRewards(rewards, coreAddr);
    const check = async () => {
      await expectLedgers(satori, token);
      expect(await satori.merkleMinted()).to.be.lte(await satori.merkleReserveCeiling());
      expect(await satori.onChainMinted()).to.be.lte(await satori.onChainRewardCeiling());
    };

    let onMinted = 0n;
    for (const [rate, adv, mintOn, claimTo] of [
      [E(100), 2, E(300), E(150)],
      [E(400), 1, E(50), E(500)],
      [E(0), 3, E(900), E(600)],
      // ~95% of the general residual, as a fraction of GEN1 so it tracks the rate.
      [(GEN1 * 95n) / 100n, 2, E(10), E(1200)],
    ]) {
      await hub.connect(rw).setMerkleReserveRate(rate);
      await advanceRounds(adv);
      await check();
      // best-effort on-chain report + mint, capped at the priced allowance
      await hub.connect(rw).freezeRoundGross(await token.getCurrentRound());
      const room = await allowanceRoom(hub, token);
      const doOn = mintOn <= room ? mintOn : room;
      if (doOn > 0n) {
        await hub.connect(rw).noteIssued(doOn);
        await hub.connect(rw).rewardMint(stranger.address, doOn);
        onMinted += doOn;
      }
      await check();
      expect(claimTo, "the claim fits the banked reserve").to.be.lte(await satori.merkleReserveCeiling());
      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, claimTo));
      await merkle.connect(alice).claimMerkle(claimTo, []);
      expect(await satori.merkleMinted(), "the merkle lane paid the whole claim").to.equal(claimTo);
      await check();
    }
    // Each doOn is capped at its mintOn, so the sum matches only if every step minted in full.
    expect(onMinted).to.equal(E(300) + E(50) + E(900) + E(10));
  });

  // ------------------------------------------------------------------
  // Per-lane walls (strict, use-it-or-lose-it).
  // ------------------------------------------------------------------

  it("WALL: the Merkle lane cannot borrow on-chain headroom even when the global cap is nearly empty", async function () {
    await rewards.connect(owner).setOffchainBudget(E(10)); // tiny reserve rate
    await advanceRounds(2); // the dial lands next round: reserve = 2 x 10
    // Give the on-chain lane real, unminted headroom for the claim to try to borrow.
    const { hub, rewardsSigner: rw } = await asRewards(rewards, coreAddr);
    await priceAndReport(hub, rw, token);
    const onRoom = (await satori.onChainRewardCeiling()) - (await satori.onChainMinted());
    expect(onRoom).to.be.gt(E(2000));
    expect(await satori.merkleReserveCeiling()).to.equal(E(20));
    // Partial pay: the over-sized claim mints EXACTLY the walled reserve — not a
    // wei of the on-chain room — and the cursor advances only by what was paid.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(2000)));
    await merkle.connect(alice).claimMerkle(E(2000), []);
    expect(await satori.merkleMinted()).to.equal(E(20));                  // the wall held
    expect(await satori.balanceOf(alice.address)).to.equal(E(20));
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(20));  // cursor == paid, not entitlement
    expect((await satori.onChainRewardCeiling()) - (await satori.onChainMinted())).to.equal(onRoom);
    // With the lane now EXACTLY full, a re-claim has zero headroom to clamp to
    // and falls through to the core's loud refusal — no borrowing, ever.
    await expect(merkle.connect(alice).claimMerkle(E(2000), []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(20)); // cursor not corrupted
  });

  it("WALL: the on-chain lane cannot borrow the Merkle reserve; the walled-off reserve stays claimable", async function () {
    await rewards.connect(owner).setOffchainBudget(E(200));
    await advanceRounds(2); // reserve = 400
    // The real rewards child stays wired (rate 200 accrues unchanged); impersonate
    // it to drive the on-chain lane directly.
    const { hub, rewardsSigner: rw } = await asRewards(rewards, coreAddr);
    await priceAndReport(hub, rw, token); // banks the reserve too
    const reserve = await satori.merkleReserveCumulative();
    expect(reserve).to.equal(E(400));

    const laneHeadroom = (await satori.onChainRewardCeiling()) - (await satori.onChainMinted());
    expect(laneHeadroom).to.be.gt(0n);
    await hub.connect(rw).rewardMint(stranger.address, laneHeadroom); // fill on-chain lane exactly
    // The reserve's 400 is in generalAccrued, yet not a wei of it is on-chain room.
    await expect(hub.connect(rw).rewardMint(stranger.address, 1n))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // The reserve is real and still belongs to Merkle.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));
    await merkle.connect(alice).claimMerkle(reserve, []);
    expect(await satori.merkleMinted()).to.equal(reserve);
    expect(await token.generalMinted()).to.equal(await token.generalAccrued());
  });

  // ------------------------------------------------------------------
  // dial=0 dormant, byte-for-byte.
  // ------------------------------------------------------------------

  it("DORMANT: a never-dialed protocol writes NO reserve state; on-chain lane is the whole schedule across many rounds", async function () {
    const { hub, rewardsSigner: rw } = await asRewards(rewards, coreAddr);
    const genesisGeneral = await token.generalAccrued();
    // Never touch the dial. Reserve state must stay pristine at 0.
    for (const n of [1, 5, 20]) {
      const before = await satori.onChainRewardCeiling();
      await advanceRounds(n);
      expect(await satori.onChainRewardCeiling()).to.equal(before); // time alone adds nothing
      await priceAndReport(hub, rw, token);
      expect(await satori.merkleReserveCumulative()).to.equal(0n);
      expect(await satori.merkleReserveCeiling()).to.equal(0n);
      expect(await satori.merkleMinted()).to.equal(0n);
      const e = (await token.getCurrentRound()) - (await token.deploymentRound()) + 1n;
      // Every priced round's whole residual is on-chain room.
      expect(await satori.onChainRewardCeiling()).to.equal(genesisGeneral + GEN1 * e);
      expect(await satori.onChainRewardCeiling()).to.equal(await token.generalAccrued());
    }
    // Any positive Merkle claim is refused while dormant.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, 1n));
    await expect(merkle.connect(alice).claimMerkle(1n, []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
  });

  it("DORMANT: rewardMint on a never-dialed protocol never writes merkleReserveCumulative", async function () {
    const { hub, rewardsSigner: rw } = await asRewards(rewards, coreAddr);
    await advanceRounds(3);
    // Many on-chain reports and mints, dial never touched.
    await priceAndReport(hub, rw, token, E(500));
    await hub.connect(rw).rewardMint(stranger.address, E(500));
    await hub.connect(rw).noteIssued(E(700));
    await hub.connect(rw).rewardMint(stranger.address, E(700));
    expect(await satori.merkleReserveCumulative()).to.equal(0n); // still pristine
  });

  // ------------------------------------------------------------------
  // The 1-wei floor: budget / rate can never reach the GEN1 residual.
  // ------------------------------------------------------------------

  it("FLOOR: setOffchainBudget(GEN1) reverts; (GEN1 - 1) succeeds and leaves on-chain gross >= 1 wei", async function () {
    // The reserve dial is capped at the general residual (emission - the fee's
    // 15%): the senior dev fee is carved first, so the merkle reserve can never
    // claim the whole per-round budget.
    await expect(rewards.connect(owner).setOffchainBudget(ROUND_BUDGET))
      .to.be.revertedWithCustomError(rewards, "BadInput");
    await expect(rewards.connect(owner).setOffchainBudget(GEN1))
      .to.be.revertedWithCustomError(rewards, "BadInput");
    // exactly one wei under the general residual is allowed
    await rewards.connect(owner).setOffchainBudget(GEN1 - 1n);
    expect(await rewards.offchainBudget()).to.equal(GEN1 - 1n);
    await advanceRounds(1);
    expect(await satori.onChainGrossNow()).to.equal(1n);
  });

  it("FLOOR: core.setMerkleReserveRate(GEN1) reverts even from the rewards child", async function () {
    const { hub, rewardsSigner } = await asRewards(rewards, coreAddr);
    // The hub caps the reserve rate at the general residual GEN1: the
    // dev fee is senior, so even the rewards child can't dial past it.
    await expect(hub.connect(rewardsSigner).setMerkleReserveRate(ROUND_BUDGET))
      .to.be.revertedWithCustomError(satori, "BadInput");
    await expect(hub.connect(rewardsSigner).setMerkleReserveRate(GEN1))
      .to.be.revertedWithCustomError(satori, "BadInput");
    // one wei under the general residual is fine
    await hub.connect(rewardsSigner).setMerkleReserveRate(GEN1 - 1n);
  });

  it("FLOOR: even at rate GEN1-ε, one full round of reserve leaves >=1 wei of on-chain ceiling", async function () {
    const rate = GEN1 - 1n; // the max legal reserve rate
    await rewards.connect(owner).setOffchainBudget(rate); // prices this round at the old dial
    await advanceRounds(1);
    const { hub, rewardsSigner: rw } = await asRewards(rewards, coreAddr);
    const allowance0 = await satori.onChainAllowance();
    await hub.connect(rw).freezeRoundGross(await token.getCurrentRound()); // banks the round's reserve
    const gross = (await satori.onChainAllowance()) - allowance0;
    expect(await satori.merkleReserveCumulative()).to.equal(rate);
    // The two general lanes tile the round's residual, and the on-chain one keeps a wei.
    expect(gross + rate).to.equal(GEN1);
    expect(gross).to.be.gte(1n);
    // ... which it can actually report and mint.
    const room = await allowanceRoom(hub, token);
    await hub.connect(rw).noteIssued(room);
    await hub.connect(rw).rewardMint(stranger.address, room);
    await expectLedgers(satori, token);
  });

  // ------------------------------------------------------------------
  // Reserve/credit desync when the dial MOVES mid-round.
  // ------------------------------------------------------------------

  it("PIECEWISE: a mid-round dial move is never retroactive — accrual banks the OLD rate, then applies the new", async function () {
    await rewards.connect(owner).setOffchainBudget(E(100)); // rate 100 from next round
    await advanceRounds(2);
    await rewards.connect(owner).setOffchainBudget(E(300)); // banks 2 x 100 through this round, then rate 300
    expect(await satori.merkleReserveCeiling()).to.equal(E(200));
    await advanceRounds(4);
    expect(await satori.merkleReserveCeiling()).to.equal(E(1400)); // 200 + 4 x 300 (NOT 300 x 6 = 1800)
  });

  it("PIECEWISE: dialing UP mid-round does not let the Merkle lane retroactively claim the higher rate for elapsed rounds", async function () {
    await rewards.connect(owner).setOffchainBudget(E(50)); // rate 50
    await advanceRounds(4);                                // reserve accrues 200 (banked at next touch)
    // Attacker dials up (to a legal high rate) hoping elapsed rounds get re-priced.
    await rewards.connect(owner).setOffchainBudget(E(550)); // banks 200 first, then rate 550 (under the GEN1 cap)
    // Immediately (same round as the dial): only the 200 banked is claimable.
    expect(await satori.merkleReserveCeiling()).to.equal(E(200));
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(201)));
    // Partial pay: the 201-entitlement collects EXACTLY the 200 banked — the
    // elapsed rounds are NOT re-priced at the new rate, not by a single wei.
    await merkle.connect(alice).claimMerkle(E(201), []);
    expect(await satori.merkleMinted()).to.equal(E(200));
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(200));
  });

  it("PIECEWISE: dialing DOWN to 0 mid-stream freezes the ceiling; already-banked reserve is untouched, no new accrual", async function () {
    await rewards.connect(owner).setOffchainBudget(E(120));
    await advanceRounds(3); // banks 360 at next touch
    await rewards.connect(owner).setOffchainBudget(0); // banks 360, then rate 0
    const frozen = await satori.merkleReserveCeiling();
    expect(frozen).to.equal(E(360));
    await advanceRounds(10);
    expect(await satori.merkleReserveCeiling()).to.equal(frozen); // no growth after 0
    // The banked 360 is still claimable, but not a wei more.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(360)));
    await merkle.connect(alice).claimMerkle(E(360), []);
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(361)));
    await expect(merkle.connect(alice).claimMerkle(E(361), []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
  });

  // ------------------------------------------------------------------
  // Merkle drop mechanics: idempotent / monotonic / forever-claimable.
  // ------------------------------------------------------------------

  it("MERKLE: idempotent re-claim reverts NothingToClaim; a higher root mints only the delta", async function () {
    await rewards.connect(owner).setOffchainBudget(E(360));
    await advanceRounds(3); // reserve 1080
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(100)));
    await merkle.connect(alice).claimMerkle(E(100), []);
    await expect(merkle.connect(alice).claimMerkle(E(100), []))
      .to.be.revertedWithCustomError(merkle, "NothingToClaim"); // idempotent
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(250)));
    await merkle.connect(alice).claimMerkle(E(250), []);
    expect(await satori.balanceOf(alice.address)).to.equal(E(250)); // 100 + delta 150
  });

  it("MERKLE: a lowered entitlement reverts (monotonic), never underflows the cursor", async function () {
    await rewards.connect(owner).setOffchainBudget(E(360));
    await advanceRounds(3);
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(200)));
    await merkle.connect(alice).claimMerkle(E(200), []);
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(50)));
    await expect(merkle.connect(alice).claimMerkle(E(50), []))
      .to.be.revertedWithCustomError(merkle, "NothingToClaim");
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(200)); // cursor intact
  });

  it("MERKLE: forever-claimable — a claim skipped for many rounds still mints the full accrued delta later", async function () {
    await rewards.connect(owner).setOffchainBudget(E(100));
    await advanceRounds(2); // reserve 200
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(200)));
    // do not claim now; let rounds pass
    await advanceRounds(50);
    await merkle.connect(alice).claimMerkle(E(200), []); // still fully claimable
    expect(await satori.balanceOf(alice.address)).to.equal(E(200));
  });

  it("MERKLE: an over-reserve claim pays exactly the reserve (partial pay); a full lane's refusal leaves the cursor intact (CEI)", async function () {
    await rewards.connect(owner).setOffchainBudget(E(10));
    await advanceRounds(2); // the dial lands next round: reserve = 2 x 10
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(5000)));
    // Partial pay drains exactly the 20 accrued; cursor == paid.
    await merkle.connect(alice).claimMerkle(E(5000), []);
    expect(await satori.merkleMinted()).to.equal(E(20));
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(20));
    // Lane now exactly full → zero headroom, the core refuses, and the CEI
    // rollback leaves the cursor exactly where the partial pay put it.
    await expect(merkle.connect(alice).claimMerkle(E(5000), []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(20));
  });

  it("MERKLE: two-leaf root, both recipients draw from the shared reserve; combined never exceeds it", async function () {
    await rewards.connect(owner).setOffchainBudget(E(300));
    await advanceRounds(3); // reserve 900
    const la = leafOf(alice.address, E(100));
    const lb = leafOf(bob.address, E(200));
    await merkle.connect(publisher).setMerkleRoot(hashPair(la, lb));
    await merkle.connect(alice).claimMerkle(E(100), [lb]);
    await merkle.connect(bob).claimMerkle(E(200), [la]);
    expect(await satori.merkleMinted()).to.equal(E(300));
    expect(await satori.merkleMinted()).to.be.lte(await satori.merkleReserveCeiling());
  });

  // ------------------------------------------------------------------
  // Write-once wiring + second-minter gate.
  // ------------------------------------------------------------------

  it("WIRE: setSatoriMerkle is write-once (2nd call reverts AlreadySet) and non-deployer reverts Unauthorized", async function () {
    // already wired in beforeEach; a second wiring must revert
    const other = await deployMerkleProxied(publisher.address, await satori.satoriToken());
    await expect(satori.connect(owner).setSatoriMerkle(await other.getAddress()))
      .to.be.revertedWithCustomError(satori, "AlreadySet");
    // and a non-deployer can never wire (fresh stack so the slot is empty)
    const fresh = await deployFreshUnwired();
    await expect(fresh.satori.connect(stranger).setSatoriMerkle(await other.getAddress()))
      .to.be.revertedWithCustomError(fresh.satori, "Unauthorized");
  });

  it("WIRE: setSatoriMerkle rejects the zero address", async function () {
    const fresh = await deployFreshUnwired();
    await expect(fresh.satori.connect(fresh.deployer).setSatoriMerkle(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(fresh.satori, "BadInput");
  });

  it("GATE: only satoriRewards and satoriMerkle may rewardMint — a 3rd caller reverts Unauthorized", async function () {
    // stranger (EOA) calling rewardMint directly -> Unauthorized
    await expect(satori.connect(stranger).rewardMint(stranger.address, 1n))
      .to.be.revertedWithCustomError(satori, "Unauthorized");
    // a random contract that is neither rewards nor merkle -> Unauthorized
    const mock = await (await ethers.getContractFactory("MockRewardsMinter")).deploy();
    await expect(mock.mint(coreAddr, stranger.address, 1n))
      .to.be.revertedWithCustomError(satori, "Unauthorized"); // not wired as a child
  });

  it("GATE: SatoriMerkle.setSatoriCore is write-once and deployer-only", async function () {
    // merkle.setSatoriCore already called in beforeEach; a second call reverts
    await expect(merkle.setSatoriCore(coreAddr))
      .to.be.revertedWithCustomError(merkle, "AlreadySet");
    // a fresh merkle: non-deployer cannot bind the core
    const m2 = await deployMerkleProxied(publisher.address, await satori.satoriToken());
    await expect(m2.connect(stranger).setSatoriCore(coreAddr))
      .to.be.revertedWithCustomError(m2, "Unauthorized");
  });

  it("GATE: only the rootPublisher may set the root / rotate the publisher", async function () {
    await expect(merkle.connect(stranger).setMerkleRoot(ethers.ZeroHash))
      .to.be.revertedWithCustomError(merkle, "Unauthorized");
    await expect(merkle.connect(stranger).setRootPublisher(stranger.address))
      .to.be.revertedWithCustomError(merkle, "Unauthorized");
    // publisher can rotate (two-step, audit LA-1); the old publisher then loses power
    await merkle.connect(publisher).setRootPublisher(bob.address);
    await merkle.connect(bob).acceptRootPublisher();
    await expect(merkle.connect(publisher).setMerkleRoot(ethers.ZeroHash))
      .to.be.revertedWithCustomError(merkle, "Unauthorized");
    await merkle.connect(bob).setMerkleRoot(ethers.ZeroHash); // new publisher works
  });

  // ------------------------------------------------------------------
  // On-chain ceiling never underflows at the extreme dial.
  // ------------------------------------------------------------------

  it("NO-UNDERFLOW: at the max legal rate, each round banks GEN1-1 to the reserve and prices exactly 1 wei of on-chain gross, and onChainRewardCeiling never underflows", async function () {
    await rewards.connect(owner).setOffchainBudget(GEN1 - 1n); // prices this round at the old dial
    expect(await satori.merkleReserveCumulative()).to.equal(0n);
    const allow0 = await satori.onChainAllowance();
    const gA0 = await token.generalAccrued();
    expect(allow0 - gA0, "the deploy round priced at the old dial").to.equal(GEN1);
    const { hub, rewardsSigner: rw } = await asRewards(rewards, coreAddr);
    for (let i = 1n; i <= 6n; i++) {
      await advanceRounds(1);
      const reported = await priceAndReport(hub, rw, token); // banks the reserve, reports the on-chain room
      const cum = await satori.merkleReserveCumulative();
      expect(cum, "GEN1-1 banked per round").to.equal((GEN1 - 1n) * i);
      expect(await satori.merkleReserveCeiling()).to.equal(cum);
      expect(await satori.onChainAllowance(), "1 wei of gross priced per round").to.equal(allow0 + i);
      expect(reported, "the whole round's 1 wei reported").to.equal(i === 1n ? allow0 - gA0 + 1n : 1n);
      expect(await satori.onChainRewardCeiling()).to.equal(allow0 + i);
      await expectLedgers(satori, token);
    }
  });

  it("NO-UNDERFLOW: reserve (rate*rounds) is always strictly under the cap because rate < GEN1/round and the genesis round already counts", async function () {
    // rate GEN1-ε for many rounds; reserve = rate*rounds, always under the cap.
    await rewards.connect(owner).setOffchainBudget(GEN1 - 1n);
    await advanceRounds(100);
    const dr = await satori.deploymentRound();
    const roundsElapsed = (await satori.getCurrentRound()) - dr + 1n;
    const cap = ROUND_BUDGET * roundsElapsed;
    const reserve = await satori.merkleReserveCeiling();
    expect(reserve).to.be.lt(cap);
    // Banking all 100 rounds at once reports them, fee included, inside the envelope.
    await satori.syncEmission();
    expect(await satori.merkleReserveCumulative()).to.equal(reserve);
    expect((await token.generalAccrued()) + (await token.devFeeAccrued())).to.be.lte(cap);
  });

  // helper: a fully-wired stack EXCEPT satoriMerkle (left unwired) so wiring
  // negative-paths can be exercised.
  async function deployFreshUnwired() {
    // A fully-wired restructured stack EXCEPT satoriMerkle (the fixture never
    // wires merkle), so the setSatoriMerkle wiring negative-paths can be
    // exercised. `deployer` == fixture owner == token governor (signers[0]).
    const [deployer] = await ethers.getSigners();
    const fix = await deploySatoriFixtureOpts(0);
    return { satori: fix.satori, rewards: fix.rewards, deployer, coreAddr: await fix.satori.getAddress() };
  }
});
