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
 *     (onChainMinted + amt <= globalCap − merkleReserveCumulative).
 *   - COMBINED across BOTH lanes we can NEVER mint more than the global cap
 *     `1440 × roundsElapsed` — even by racing the dial up after the on-chain
 *     lane already consumed early-round headroom while the reserve was 0.
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

// The per-round emission is the HUB's now, not the token's 1440, and the dev fee
// is a flat 15% of it. Both are READ FROM THE HUB rather than written out: the
// old literals (1440 / 288 / 1152) were the tier-1 step-down arithmetic, and
// rewriting them as new literals would just move the staleness forward a version.
// No test here issues anywhere near the hub's first step threshold, so the
// rate is constant across the handful of rounds any one test advances.
let RATE;  // emission per round
let DEV1;  // the fee's slice of it
let GEN1;  // the general residual = RATE - DEV1; the reserve-rate ceiling (exclusive)

// The general lanes' shared cap after `e` elapsed rounds. Mirrors the hub's
// `emissionCeiling() * 8500 / 10000` — ONE floor over the whole product, which
// is not the same as `e` copies of a floored per-round share.
const genCap = (e) => (RATE * e * 8500n) / 10000n;

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
  const { satori, rewards, voting, registry, games, bounties } = fix;
  const core = await satori.getAddress(); // hub address (the mint authority)

  const merkle = await deployMerkleProxied(publisher.address, fix.token.target);
  await satori.connect(admin).setSatoriMerkle(await merkle.getAddress()); // governor wires, write-once
  await merkle.setSatoriCore(core);                                       // proxy deployer wires core (hub), write-once
  return { satori, rewards, merkle, voting, registry, games, bounties, coreAddr: core };
}

// Impersonate the REAL rewards proxy so we can drive the hub's authorized
// rewards-child paths directly (rewardMint / setMerkleReserveRate) to arbitrary
// amounts — simulating an over-issuing rewards path — while the real rewards
// child stays wired. Returns the hub bound to the rewards signer.
async function asRewards(rewards, coreAddr) {
  const rewardsAddr = await rewards.getAddress();
  await impersonateAccount(rewardsAddr);
  await setBalance(rewardsAddr, ethers.parseEther("10"));
  const rewardsSigner = await ethers.getSigner(rewardsAddr);
  const hub = await ethers.getContractAt("SatoriHub", coreAddr);
  return { hub, rewardsSigner };
}

describe("ADVERSARIAL: off-chain dial + Merkle lanes", function () {
  let satori, rewards, merkle, coreAddr;
  let owner, alice, bob, publisher, stranger;

  beforeEach(async function () {
    [owner, alice, bob, publisher, stranger] = await ethers.getSigners();
    ({ satori, rewards, merkle, coreAddr } = await deployStack(owner, publisher));
    RATE = await satori.emissionRateNow();
    DEV1 = await satori.devRateNow();
    GEN1 = RATE - DEV1;
  });

  // ------------------------------------------------------------------
  // HEADLINE: the combined cap is inviolable across BOTH lanes.
  // ------------------------------------------------------------------

  it("ATTACK: cannot exceed the global cap by racing the dial up after the on-chain lane consumed early headroom", async function () {
    // Deploy round: the genesis mint is exactly ONE ROUND of the hub's emission,
    // split 15/85 — so the hub's general lane starts exactly saturated at
    // genCap(1), with reserve = 0. (The token's own 1440 envelope has slack
    // left; the hub's schedule is the binding wall.)
    // Give the on-chain lane a real over-issuing minter and let it eat every wei
    // of headroom each round while the reserve is still 0.
    const { hub, rewardsSigner } = await asRewards(rewards, coreAddr);

    await advanceRounds(1); // round +1: general cap genCap(2)
    let onChainCeil = await satori.onChainRewardCeiling();
    let headroom = onChainCeil - (await satori.onChainMinted());
    // Each round adds RATE to the cap, 15% of it reserved for the senior fee;
    // the genesis round's general lane already holds its full genCap(1), so the
    // remaining headroom is exactly the second round's share.
    expect(headroom).to.equal(genCap(2n) - genCap(1n));
    await hub.connect(rewardsSigner).rewardMint(stranger.address, headroom); // general lane now == its cap, reserve still 0
    expect(await satori.onChainMinted()).to.equal(genCap(2n));
    expect(await satori.totalRewardsMinted()).to.equal((await satori.devFeeMinted()) + genCap(2n));

    // NOW the adversary dials the off-chain budget to the max and lets the
    // reserve balloon. The already-minted on-chain lane is NOT clawed back.
    // If the reserve could hand the Merkle lane fresh budget on TOP of an
    // already-maxed general lane, we'd breach the combined cap. We drive the
    // reserve rate AS the authorized rewards child (impersonated).
    await hub.connect(rewardsSigner).setMerkleReserveRate(GEN1 - 1n); // max legal rate via the rewards child
    // Dial is effective NEXT round now, so advance one extra round for it to
    // actually accrue: rate begins the round after it was set.
    await advanceRounds(2); // reserve accrues (GEN1 - ε) for this gap

    const deploymentRound = await satori.deploymentRound();
    const roundsElapsed = (await satori.getCurrentRound()) - deploymentRound + 1n;
    const globalCap = ROUND_BUDGET * roundsElapsed;
    // The general lanes (on-chain + merkle) share the cap NET of the dev accrual.
    const generalCap = genCap(roundsElapsed); // 85% of the hub's emission ceiling

    // Merkle lane ceiling is the accrued reserve; try to claim ALL of it.
    const reserve = await satori.merkleReserveCeiling();
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));

    // The backstop must catch any attempt that would push the general lanes past
    // generalCap, regardless of the per-lane arithmetic. onChainMinted + reserve
    // may or may not exceed generalCap; whichever the case, totalRewardsMinted
    // after any successful claim must stay <= globalCap.
    const onChain = await satori.onChainMinted();
    if (onChain + reserve > generalCap) {
      await expect(merkle.connect(alice).claimMerkle(reserve, []))
        .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    } else {
      await merkle.connect(alice).claimMerkle(reserve, []);
    }

    // INVARIANT (the whole point): no matter what, the sum of ALL THREE lanes is
    // never above the global cap, and the three-lane ledger identity holds.
    expect(await satori.totalRewardsMinted()).to.be.lte(globalCap);
    expect(await satori.totalRewardsMinted()).to.equal(
      (await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted())
    );
  });

  it("ATTACK: fill BOTH lanes to their exact ceilings, then one wei on either side reverts (combined == cap, not over)", async function () {
    // Dial a moderate reserve, impersonate the rewards child so we can drive the
    // on-chain lane precisely, then top BOTH lanes to their exact ceilings and probe +1 wei.
    const { hub, rewardsSigner } = await asRewards(rewards, coreAddr);
    await hub.connect(rewardsSigner).setMerkleReserveRate(E(200)); // reserve rate 200/round
    // Dial effective next round: advance 4 so 3 full rounds bank at rate 200.
    await advanceRounds(4); // reserve = 200*3 = 600

    const deploymentRound = await satori.deploymentRound();
    const roundsElapsed = (await satori.getCurrentRound()) - deploymentRound + 1n;
    const globalCap = ROUND_BUDGET * roundsElapsed;
    // The general lanes tile the cap NET of the senior dev accrual.
    const generalCap = genCap(roundsElapsed); // 85% of the hub's emission ceiling
    const reserve = await satori.merkleReserveCeiling();
    expect(reserve).to.equal(E(600));

    // Fill the on-chain lane EXACTLY to its ceiling (the general residual minus reserve).
    const onChainCeil = await satori.onChainRewardCeiling();
    expect(onChainCeil).to.equal(generalCap - reserve);
    const onHeadroom = onChainCeil - (await satori.onChainMinted());
    await hub.connect(rewardsSigner).rewardMint(stranger.address, onHeadroom);
    expect(await satori.onChainMinted()).to.equal(onChainCeil);

    // Fill the Merkle lane EXACTLY to its ceiling.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));
    await merkle.connect(alice).claimMerkle(reserve, []);
    expect(await satori.merkleMinted()).to.equal(reserve);

    // Now BOTH general lanes are full; combined == generalCap exactly (the dev
    // slice is carved off-budget on the token, so total == devFeeMinted + generalCap).
    expect((await satori.onChainMinted()) + (await satori.merkleMinted())).to.equal(generalCap);
    expect(await satori.totalRewardsMinted()).to.equal((await satori.devFeeMinted()) + generalCap);

    // One wei more on the on-chain side -> revert (its lane is full).
    await expect(hub.connect(rewardsSigner).rewardMint(stranger.address, 1n))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    // One wei more on the Merkle side -> revert (its lane is full).
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve + 1n));
    await expect(merkle.connect(alice).claimMerkle(reserve + 1n, []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // Ledgers still reconcile and nothing leaked over the cap.
    expect((await satori.onChainMinted()) + (await satori.merkleMinted())).to.equal(generalCap);
    expect(await satori.totalRewardsMinted()).to.equal(
      (await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted())
    );
  });

  it("INVARIANT: through an interleaved dial/mint/claim sequence, totalRewardsMinted == onChain + merkle <= globalCap at every step", async function () {
    const { hub, rewardsSigner } = await asRewards(rewards, coreAddr);
    const check = async () => {
      const dr = await satori.deploymentRound();
      const cap = ROUND_BUDGET * ((await satori.getCurrentRound()) - dr + 1n);
      const tot = await satori.totalRewardsMinted();
      // Three-lane identity: dev lane (token) + on-chain + merkle == total minted.
      expect(tot).to.equal((await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted()));
      expect(tot).to.be.lte(cap);
      expect(await satori.merkleMinted()).to.be.lte(await satori.merkleReserveCeiling());
      expect(await satori.onChainMinted()).to.be.lte(await satori.onChainRewardCeiling());
    };

    let cursor = 0n;
    for (const [rate, adv, mintOn, claimTo] of [
      [E(100), 2, E(300), E(150)],
      [E(400), 1, E(50), E(500)],
      [E(0), 3, E(900), E(600)],
      // ~95% of the general residual, as the 550 above was of 576. Written as a
      // fraction of GEN1 rather than a literal, so it tracks the hub's rate.
      [(GEN1 * 95n) / 100n, 2, E(10), E(1200)],
    ]) {
      await hub.connect(rewardsSigner).setMerkleReserveRate(rate);
      await advanceRounds(adv);
      await check();
      // best-effort on-chain mint (skip if it would exceed the lane)
      const onRoom = (await satori.onChainRewardCeiling()) - (await satori.onChainMinted());
      const doOn = mintOn <= onRoom ? mintOn : onRoom;
      if (doOn > 0n) await hub.connect(rewardsSigner).rewardMint(stranger.address, doOn);
      await check();
      // best-effort merkle claim to a growing cursor
      if (claimTo > cursor) {
        const ceil = await satori.merkleReserveCeiling();
        if (claimTo <= ceil) {
          await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, claimTo));
          await merkle.connect(alice).claimMerkle(claimTo, []);
          cursor = claimTo;
        }
      }
      await check();
    }
  });

  // ------------------------------------------------------------------
  // Per-lane walls (strict, use-it-or-lose-it).
  // ------------------------------------------------------------------

  it("WALL: the Merkle lane cannot borrow on-chain headroom even when the global cap is nearly empty", async function () {
    await rewards.connect(owner).setOffchainBudget(E(10)); // tiny reserve rate
    // Dial effective next round: advance 3 so 2 full rounds bank at rate 10.
    await advanceRounds(3); // reserve = 20; globalCap = 1440*4 = 5760 (tons of on-chain headroom)
    expect(await satori.merkleReserveCeiling()).to.equal(E(20));
    // On-chain headroom is enormous but the Merkle lane is walled at 20: under
    // partial pay (pre-launch review) the over-sized claim mints EXACTLY the
    // walled reserve — not a wei of the on-chain complement — and the cursor
    // advances only by what was paid, so the remainder stays claimable.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(2000)));
    await merkle.connect(alice).claimMerkle(E(2000), []);
    expect(await satori.merkleMinted()).to.equal(E(20));                  // the wall held
    expect(await satori.balanceOf(alice.address)).to.equal(E(20));
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(20));  // cursor == paid, not entitlement
    // With the lane now EXACTLY full, a re-claim has zero headroom to clamp to
    // and falls through to the core's loud refusal — no borrowing, ever.
    await expect(merkle.connect(alice).claimMerkle(E(2000), []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(20)); // cursor not corrupted
  });

  it("WALL: the on-chain lane cannot borrow the Merkle reserve; the walled-off reserve stays claimable", async function () {
    await rewards.connect(owner).setOffchainBudget(E(200));
    await advanceRounds(2); // reserve = 400
    const reserve = await satori.merkleReserveCeiling();
    // The real rewards child stays wired (rate 200 accrues unchanged); impersonate
    // it to drive the on-chain lane directly.
    const { hub, rewardsSigner } = await asRewards(rewards, coreAddr);

    const onChainCeil = await satori.onChainRewardCeiling();
    const laneHeadroom = onChainCeil - (await satori.onChainMinted());
    await hub.connect(rewardsSigner).rewardMint(stranger.address, laneHeadroom); // fill on-chain lane exactly
    await expect(hub.connect(rewardsSigner).rewardMint(stranger.address, 1n))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // The reserve is real and still belongs to Merkle.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));
    await merkle.connect(alice).claimMerkle(reserve, []);
    expect(await satori.merkleMinted()).to.equal(reserve);
  });

  // ------------------------------------------------------------------
  // dial=0 dormant, byte-for-byte.
  // ------------------------------------------------------------------

  it("DORMANT: a never-dialed protocol writes NO reserve state; on-chain lane is the whole cap across many rounds", async function () {
    // Never touch the dial. Reserve state must stay pristine at 0.
    for (const n of [1, 5, 20]) {
      await advanceRounds(n);
      expect(await satori.merkleReserveCumulative()).to.equal(0n);
      expect(await satori.merkleReserveCeiling()).to.equal(0n);
      expect(await satori.merkleMinted()).to.equal(0n);
      const dr = await satori.deploymentRound();
      const e = (await satori.getCurrentRound()) - dr + 1n;
      const cap = ROUND_BUDGET * e;
      // Whole GENERAL cap on-chain (the fee's 15% carved off the top): with the
      // dial dormant the merkle reserve is 0, so on-chain gets all of genCap(e).
      expect(await satori.onChainRewardCeiling()).to.equal(genCap(e));
    }
    // Any positive Merkle claim is refused while dormant.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, 1n));
    await expect(merkle.connect(alice).claimMerkle(1n, []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
  });

  it("DORMANT: rewardMint on a never-dialed protocol never writes merkleReserveCumulative", async function () {
    const { hub, rewardsSigner } = await asRewards(rewards, coreAddr);
    await advanceRounds(3);
    // Many on-chain mints, dial never touched.
    await hub.connect(rewardsSigner).rewardMint(stranger.address, E(500));
    await hub.connect(rewardsSigner).rewardMint(stranger.address, E(700));
    expect(await satori.merkleReserveCumulative()).to.equal(0n); // still pristine
  });

  // ------------------------------------------------------------------
  // The 1-wei floor: budget / rate can never reach the GEN1 residual.
  // ------------------------------------------------------------------

  it("FLOOR: setOffchainBudget(GEN1) reverts; (GEN1 - 1) succeeds and leaves on-chain gross >= 1 wei", async function () {
    // The reserve dial is capped at the general residual (emission - the fee's
    // 15%): the senior dev fee is carved first, so the merkle reserve can never
    // claim the whole per-round budget. (setOffchainBudget also caps at
    // TOKENS_PER_ROUND on the rewards side, but the hub's GEN1 wall binds first.)
    await expect(rewards.connect(owner).setOffchainBudget(ROUND_BUDGET))
      .to.be.revertedWithCustomError(rewards, "BadInput");
    await expect(rewards.connect(owner).setOffchainBudget(GEN1))
      .to.be.revertedWithCustomError(rewards, "BadInput");
    // exactly one wei under the general residual is allowed
    await rewards.connect(owner).setOffchainBudget(GEN1 - 1n);
    expect(await rewards.offchainBudget()).to.equal(GEN1 - 1n);
    // core mirrored the rate; on-chain ceiling still non-negative (never underflows)
    await advanceRounds(1);
    expect(await satori.onChainRewardCeiling()).to.be.gte(0n);
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
    const rate = GEN1 - 1n; // 1151.999999999999999999 — the max legal reserve rate
    await rewards.connect(owner).setOffchainBudget(rate);
    await advanceRounds(1); // reserve = GEN1 - 1 for this round
    const dr = await satori.deploymentRound();
    const e = (await satori.getCurrentRound()) - dr + 1n;
    const cap = ROUND_BUDGET * e;
    const merkleCeil = await satori.merkleReserveCeiling();
    const onCeil = await satori.onChainRewardCeiling();
    // conservation: the two general lanes tile the cap NET of the senior dev slice
    expect(merkleCeil + onCeil).to.equal(genCap(e)); // the two general lanes tile 85% of emission
    expect(onCeil).to.be.gte(1n);                          // never underflows / never hits 0-across-cap
  });

  // ------------------------------------------------------------------
  // Reserve/credit desync when the dial MOVES mid-round.
  // ------------------------------------------------------------------

  it("PIECEWISE: a mid-round dial move is never retroactive — accrual banks the OLD rate, then applies the new", async function () {
    await rewards.connect(owner).setOffchainBudget(E(100)); // rate 100
    await advanceRounds(2);                                 // 200 pending at next touch
    await rewards.connect(owner).setOffchainBudget(E(300)); // banks 200, then rate 300
    await advanceRounds(4);                                 // rate 300 effective next round → 3 rounds banked = +900
    expect(await satori.merkleReserveCeiling()).to.equal(E(1100)); // 200 + 900 (NOT 300*5=1500)
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
    // Dial effective next round: advance 3 so 2 full rounds bank at rate 10.
    await advanceRounds(3); // reserve 20
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

  it("NO-UNDERFLOW: at the max legal rate, onChainRewardCeiling stays >= 0 and equals cap - devFee - reserve every round", async function () {
    await rewards.connect(owner).setOffchainBudget(GEN1 - 1n); // near-max legal rate
    for (let i = 0; i < 6; i++) {
      await advanceRounds(1);
      const dr = await satori.deploymentRound();
      const e = (await satori.getCurrentRound()) - dr + 1n;
      const cap = ROUND_BUDGET * e;
      const merkleCeil = await satori.merkleReserveCeiling();
      const onCeil = await satori.onChainRewardCeiling();
      expect(merkleCeil).to.be.lte(cap);                    // reserve never exceeds the cap
      expect(onCeil).to.equal(genCap(e) - merkleCeil); // exact complement net of the fee, no underflow revert
      expect(onCeil).to.be.gte(0n);
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
    expect(reserve).to.be.lt(cap); // strictly under — the +1 genesis round + the carved dev slice are the slack
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
