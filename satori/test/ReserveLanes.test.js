/**
 * STRICT PER-LANE RESERVATION (Phase 2b) — the shared reward cap is split into
 * two hard-walled lanes so the on-chain reward path and the off-chain Merkle
 * channel can never spend into each other's budget.
 *
 *   general cap           = 85% of the hub's emissionCeiling  (the fee's carve-out)
 *   merkle lane ceiling   = merkleReserveCumulative           (accrues at the dial)
 *   on-chain lane ceiling = generalCap − merkleReserveCumulative
 *
 * (The senior dev fee lives in the immutable SatoriToken — a flat 15% carved off
 * the top before the two general lanes split what remains; see
 * test/next/DevFee.test.js. The token's `1440 × rounds` is still the outer
 * constitutional envelope; the hub's per-round rate is clamped inside it.)
 *
 * The reserve accrues at `offchainBudget` per round, mirrored into core from
 * SatoriRewards.setOffchainBudget (core owns the authoritative accumulator; the
 * Merkle contract never reads rewards). Invariants proven here:
 *   - totalRewardsMinted == devFeeMinted + onChainMinted + merkleMinted  (every mint)
 *   - merkleReserveCeiling + onChainRewardCeiling == generalCap  (conservation)
 *   - each lane is STRICT: neither can mint into the other's reserve even when
 *     the global cap still has headroom (D2 = use-it-or-lose-it).
 *   - default dial (0) ⇒ reserve 0, on-chain lane == whole cap (pre-2b behaviour).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee } = require("./fixtures");
const { deployMerkleProxied } = require("./next/splitFixture");
const { generalReaching } = require("./next/emissionHelpers");

const E = (n) => ethers.parseEther(String(n));
const ROUND_BUDGET = E(1440); // the token's outer envelope, not the emission

// The hub's per-round emission and the fee's flat 15% of it, read from the hub.
// Every budget figure here derives from them; the file used to be written in
// terms of 1440 / 288 / 1152, which the hub's schedule made stale.
let RATE, DEV_RATE, RESIDUAL;
// The general lanes' shared cap after `e` rounds: the hub's own arithmetic, ONE
// floor over the whole product.
const genCap = (e) => (RATE * e * 8500n) / 10000n;

async function advanceRounds(n) {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 * n + 1);
}

// OZ StandardMerkleTree leaf: double-hashed abi.encode(account, amount).
function leafOf(addr, amount) {
  const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount]));
  return ethers.keccak256(inner);
}

async function deployStack(admin, publisher) {
  // Restructured stack (SatoriToken + SatoriEngine + SatoriHub + children)
  // behind the monolith-shaped shim. `satori.getAddress()` is the HUB — the
  // core identity that owns the reserve-lane accounting and the merkle wiring.
  const fix = await deploySatoriFixtureNoFee();
  const satori = fix.satori;
  const rewards = fix.rewards;
  const core = await satori.getAddress();

  const merkle = await deployMerkleProxied(publisher.address, fix.token.target);
  await satori.connect(admin).setSatoriMerkle(await merkle.getAddress());
  await merkle.setSatoriCore(core);
  return { satori, rewards, merkle, token: fix.token, coreAddr: core };
}

// Inject calls AS the real, still-wired rewards child. The hub authorizes
// rewardMint / setMerkleReserveRate on msg.sender == address(rewards); we
// impersonate that proxy address instead of repointing the child (setChild is
// gone). Returns the hub bound to a signer for the rewards address.
async function asRewards(rewards, coreAddr) {
  const rewardsAddr = await rewards.getAddress();
  await impersonateAccount(rewardsAddr);
  await setBalance(rewardsAddr, ethers.parseEther("10"));
  const rewardsSigner = await ethers.getSigner(rewardsAddr);
  const hub = await ethers.getContractAt("SatoriHub", coreAddr);
  return hub.connect(rewardsSigner);
}

describe("Reserve lanes (Phase 2b) — strict per-lane reservation of the reward cap", function () {
  let satori, rewards, merkle, token, coreAddr;
  let owner, alice, publisher, stranger;

  beforeEach(async function () {
    [owner, alice, publisher, stranger] = await ethers.getSigners();
    ({ satori, rewards, merkle, token, coreAddr } = await deployStack(owner, publisher)); // owner = admin+deployer
    RATE = await satori.emissionRateNow();
    DEV_RATE = await satori.devRateNow();
    RESIDUAL = RATE - DEV_RATE;
    await advanceRounds(3); // headroom past the saturated genesis round
  });

  it("genesis: the bootstrap mint splits into the senior dev lane and the on-chain lane; ledgers sum to the total", async function () {
    // INITIAL_MINT is exactly ONE ROUND of the hub's emission. Its general 85%
    // seeds the on-chain lane; the fee's 15% is carved off the top into the
    // token's immutable dev lane (see test/next/DevFee.test.js).
    const initial = await satori.INITIAL_MINT();
    expect(initial).to.equal(RATE); // the genesis mint IS one round of emission
    expect(await satori.onChainMinted()).to.equal(genCap(1n));
    expect(await satori.merkleMinted()).to.equal(0n);
    // The general share is floored onto the cap and the dev takes the REMAINDER,
    // so the dev's genesis slice can sit a wei above a flat 15%.
    expect(await satori.devFeeMinted()).to.equal(initial - genCap(1n));
    expect(await satori.totalRewardsMinted()).to.equal(initial);
    // three-lane identity: total == devFee + onChain + merkle
    expect(await satori.totalRewardsMinted()).to.equal(
      (await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted()));
  });

  it("the dial mirrors into core and the reserve accrues at offchainBudget per round", async function () {
    await rewards.connect(owner).setOffchainBudget(E(100)); // mirrors rate=100 into core; effective NEXT round
    expect(await satori.merkleReserveCeiling()).to.equal(0n); // same round: nothing accrued yet
    await advanceRounds(2);                                    // dial live from cur+1; one such round now banked
    expect(await satori.merkleReserveCeiling()).to.equal(E(100)); // 1 round × 100
    await advanceRounds(4);
    expect(await satori.merkleReserveCeiling()).to.equal(E(500)); // 5 rounds × 100
  });

  it("conservation: merkleReserveCeiling + onChainRewardCeiling == 85% of the emission ceiling", async function () {
    await rewards.connect(owner).setOffchainBudget(E(240));
    await advanceRounds(2);
    const deploymentRound = await satori.deploymentRound();
    const roundsElapsed = (await satori.getCurrentRound()) - deploymentRound + 1n;
    // The fee's flat 15% is carved off the top before the two general lanes
    // split what remains, so the two lane ceilings conserve that 85%. Stated
    // against the CARVE-OUT, not against `devFeeCeiling`: the latter is a ratio
    // of what was actually minted now and lags whenever the lanes run cold.
    expect((await satori.merkleReserveCeiling()) + (await satori.onChainRewardCeiling()))
      .to.equal(genCap(roundsElapsed));
    // ...and the emission ceiling itself stays inside the token's 1440 envelope.
    expect(await satori.emissionCeiling()).to.be.lte(ROUND_BUDGET * roundsElapsed);
  });

  it("conservation holds across an emission step under a standing dial", async function () {
    await rewards.connect(owner).setOffchainBudget(E(240));
    await advanceRounds(2);
    const hub = await asRewards(rewards, coreAddr);
    const conserved = async (label) => {
      const cap = await token.generalCeilingFor(await satori.emissionCeiling());
      expect((await satori.merkleReserveCeiling()) + (await satori.onChainRewardCeiling()), label).to.equal(cap);
    };
    await conserved("before the step");

    const e = await hub.emission();
    await hub.noteIssued(generalReaching(e.nextStepAt - e.issued, await token.devFeeBps()));
    expect((await hub.emission()).stepsTaken).to.equal(1n);
    expect(await hub.emissionRateNext()).to.be.lt(RATE);
    expect(await satori.emissionRateNow()).to.equal(RATE); // the crossing round keeps its rate
    await conserved("crossing round");

    for (let i = 1; i <= 3; i++) {
      await advanceRounds(1);
      await conserved(`${i} round(s) after the step`);
    }
    expect(await satori.emissionRateNow()).to.equal(await hub.emissionRateNext());
  });

  it("STRICT Merkle lane: a claim can never exceed the accrued reserve, even with global headroom", async function () {
    await rewards.connect(owner).setOffchainBudget(E(10)); // rate 10/round, effective next round
    await advanceRounds(3);                                 // reserve = 20 (dial live from cur+1, so one extra round)
    expect(await satori.merkleReserveCeiling()).to.equal(E(20));

    // Global cap has thousands of headroom, but the Merkle lane is walled at
    // 20 — under partial pay (pre-launch review) the over-sized claim mints
    // exactly the accrued reserve, and the cursor advances by what was PAID.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(50)));
    await merkle.connect(alice).claimMerkle(E(50), []);
    expect(await satori.merkleMinted()).to.equal(E(20));
    expect(await satori.balanceOf(alice.address)).to.equal(E(20));
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(20));

    // More reserve accrues over time → the SAME root and proof collect the
    // remainder (entitlement 50, 20 already paid, 30 newly affordable).
    await advanceRounds(3); // +30 reserve → ceiling 50
    await merkle.connect(alice).claimMerkle(E(50), []); // remainder, no republish needed
    expect(await satori.merkleMinted()).to.equal(E(50));
    expect(await satori.balanceOf(alice.address)).to.equal(E(50));
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(50));
  });

  it("STRICT on-chain lane: an over-issue cannot spend the Merkle reserve — the reserve stays claimable", async function () {
    // Reserve some budget for the off-chain side, then simulate an on-chain
    // over-issue by injecting rewardMint calls AS the real, authorized rewards
    // child (impersonated — setChild is gone).
    await rewards.connect(owner).setOffchainBudget(E(200)); // effective next round
    await advanceRounds(3); // reserve = 400 (dial live from cur+1, so one extra round)
    const reserve = await satori.merkleReserveCeiling();
    expect(reserve).to.equal(E(400));

    const hubAsRewards = await asRewards(rewards, coreAddr); // inject as the on-chain minter

    const onChainCeil = await satori.onChainRewardCeiling();
    const laneHeadroom = onChainCeil - (await satori.onChainMinted());

    // Fill the on-chain lane EXACTLY — fine.
    await hubAsRewards.rewardMint(stranger.address, laneHeadroom);
    expect(await satori.onChainMinted()).to.equal(onChainCeil);

    // One wei more reverts — and it is the LANE, not the global cap: the global
    // cap still has `reserve` of headroom (proven right below by the Merkle claim).
    await expect(hubAsRewards.rewardMint(stranger.address, 1n))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // The walled-off reserve is real and still belongs to the Merkle lane:
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));
    await merkle.connect(alice).claimMerkle(reserve, []);
    expect(await satori.merkleMinted()).to.equal(reserve);

    // Realize the senior dev lane too, so all three lanes together saturate the
    // emission ceiling (see test/next/DevFee.test.js).
    await satori.mintDevFee();

    // Everything now sits at the emission ceiling, to within the floors: the
    // general cap floors 85% of it, and the fee then floors its 3/17 of THAT.
    // Two floors, so up to a few wei stay unmintable — stranded, never created.
    const deploymentRound = await satori.deploymentRound();
    const elapsed = (await satori.getCurrentRound()) - deploymentRound + 1n;
    const emissionCeil = await satori.emissionCeiling();
    const total = await satori.totalRewardsMinted();
    expect(total).to.be.lte(emissionCeil);
    expect(total).to.be.gte(emissionCeil - 4n);
    // ...and well inside the token's outer 1440-per-round envelope.
    expect(total).to.be.lt(ROUND_BUDGET * elapsed);
    // three-lane identity: total == devFee + onChain + merkle
    expect(await satori.totalRewardsMinted()).to.equal(
      (await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted()));
  });

  it("rate changes are piecewise, never retroactive", async function () {
    await rewards.connect(owner).setOffchainBudget(E(100)); // rate 100, effective next round
    await advanceRounds(2);                                 // rounds cur+1..cur+2 accrue at 100
    await rewards.connect(owner).setOffchainBudget(E(300)); // banks 200 @100 (2 rounds), then rate 300 from next round
    await advanceRounds(4);                                 // +900 (3 rounds at 300, live one round later)
    expect(await satori.merkleReserveCeiling()).to.equal(E(1100)); // 200 + 900, not 300×5
  });

  it("a rate change emits the cumulative it banked, as of the round the new rate starts", async function () {
    const hub = await ethers.getContractAt("SatoriHub", coreAddr);
    await rewards.connect(owner).setOffchainBudget(E(100));
    await advanceRounds(2);
    await rewards.connect(owner).setOffchainBudget(E(300));
    const logs = await hub.queryFilter(hub.filters.MerkleReserveRateSet(), 0);
    const last = logs[logs.length - 1].args;
    expect(last.newRate).to.equal(E(300));
    expect(last.fromRound).to.equal((await satori.getCurrentRound()) + 1n);
    expect(last.cumulativeAtFromRound).to.equal(await satori.merkleReserveCumulative());
    expect(last.cumulativeAtFromRound).to.equal(E(200));
  });

  it("setMerkleReserveRate is rewards-only and rejects a rate >= the cap", async function () {
    await expect(satori.connect(stranger).setMerkleReserveRate(E(1)))
      .to.be.revertedWithCustomError(satori, "Unauthorized");
    await expect(satori.connect(owner).setMerkleReserveRate(E(1))) // even admin/EOA can't — only the contract
      .to.be.revertedWithCustomError(satori, "Unauthorized");

    // Defense-in-depth: core rejects a rate >= the general residual (emission
    // net of the fee's 15%) even if rewards passed a bad value.
    // Exercise AS the real, authorized rewards child (impersonated).
    const hubAsRewards = await asRewards(rewards, coreAddr);
    await expect(hubAsRewards.setMerkleReserveRate(RESIDUAL))
      .to.be.revertedWithCustomError(satori, "BadInput");
  });

  it("default dial (0): reserve stays 0 and the on-chain lane is the whole general cap (pre-2b behaviour)", async function () {
    expect(await satori.merkleReserveCeiling()).to.equal(0n);
    const deploymentRound = await satori.deploymentRound();
    const elapsed = (await satori.getCurrentRound()) - deploymentRound + 1n;
    // With no merkle reserve, the on-chain lane is the whole general budget: the
    // emission ceiling net of only the fee's 15% carve-out.
    expect(await satori.onChainRewardCeiling()).to.equal(genCap(elapsed));
    // With no reserve, a Merkle claim of any positive amount is refused.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(1)));
    await expect(merkle.connect(alice).claimMerkle(E(1), []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
  });
});
