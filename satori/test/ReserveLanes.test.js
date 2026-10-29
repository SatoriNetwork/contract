/**
 * STRICT PER-LANE RESERVATION (Phase 2b) — the general rewards reported to the
 * token are split into two hard-walled lanes so the on-chain reward path and
 * the off-chain Merkle channel can never spend into each other's budget.
 *
 *   merkle lane ceiling   = merkleReserveCumulative                (banked at the share)
 *   on-chain lane ceiling = token.generalAccrued − merkleReserveCumulative
 *
 * The reserve is banked at `offchainShareBps` of each round's residual, mirrored
 * into core from SatoriRewards.setOffchainShareBps (core owns the authoritative accumulator; the
 * Merkle contract never reads rewards), and is reported to the token like any
 * credit, so the dev fee on it is booked at the bank. Invariants proven here:
 *   - everything reported, less the reserve, fits the on-chain allowance priced
 *     so far, and the on-chain room the lens shows is exactly what the hub's
 *     rewardMint accepts
 *   - onChainMinted + merkleMinted == token.generalMinted
 *   - each lane is STRICT: neither can mint into the other's room even when
 *     the other still holds reported, unminted room.
 *   - default share (0) ⇒ reserve 0, on-chain lane == everything reported.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee } = require("./fixtures");
const { deployMerkleProxied } = require("./next/splitFixture");
const { issueTo } = require("./next/emissionHelpers");

const E = (n) => ethers.parseEther(String(n));
// The token's fee on one report, rounded up as `accrueRewards` books it.
const feeOn = (g, bps) => (g * bps + (10000n - bps) - 1n) / (10000n - bps);

let RATE, DEV_RATE, RESIDUAL, RESIDUAL0;
// The reserve a share banks per round at the residual live since the last
// `setShare` (beforeEach's until then). The rate steps every round's worth
// issued, and a share change's own banking can take a step, so each change
// re-reads the residual the rounds after it run at.
const per = (bps) => (RESIDUAL * BigInt(bps)) / 10000n;

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
  return { satori, rewards, merkle, token: fix.token, hub: fix.hub, coreAddr: core };
}

// Inject calls AS the real, still-wired rewards child. The hub authorizes
// rewardMint / noteIssued / freezeRoundGross / setMerkleReserveBps on
// msg.sender == address(rewards); we impersonate that proxy address instead of
// repointing the child (setChild is gone). Returns the hub bound to a signer
// for the rewards address.
async function asRewards(rewards, coreAddr) {
  const rewardsAddr = await rewards.getAddress();
  await impersonateAccount(rewardsAddr);
  await setBalance(rewardsAddr, ethers.parseEther("10"));
  const rewardsSigner = await ethers.getSigner(rewardsAddr);
  const hub = await ethers.getContractAt("SatoriHub", coreAddr);
  return hub.connect(rewardsSigner);
}

// A credit only becomes on-chain room once its round is priced and reported.
async function reportOnChain(hubAsRewards, token, amount) {
  await hubAsRewards.freezeRoundGross(await token.getCurrentRound());
  await hubAsRewards.noteIssued(amount);
}

describe("Reserve lanes (Phase 2b) — strict per-lane reservation of the reported rewards", function () {
  let satori, rewards, merkle, token, hub, coreAddr;
  let owner, alice, publisher, stranger;

  // The lens derives its ceiling from generalAccrued and the reserve, so summing
  // it back with the reserve proves nothing: probe the hub's rewardMint instead.
  async function conserved(label) {
    const accrued = await token.generalAccrued();
    const reserve = await hub.merkleReserveCumulative();
    const onChainMinted = await hub.onChainMinted();
    const merkleMinted = await hub.merkleMinted();
    expect(accrued - reserve, label).to.be.lte(await hub.onChainAllowance());
    expect(onChainMinted + reserve, label).to.be.lte(accrued);
    expect(merkleMinted, label).to.be.lte(reserve);
    expect(onChainMinted + merkleMinted, label).to.equal(await token.generalMinted());
    expect(accrued + (await token.devFeeAccrued()), label).to.be.lte(await token.rewardCeiling());
    const room = (await satori.onChainRewardCeiling()) - onChainMinted;
    const rw = await asRewards(rewards, coreAddr);
    await rw.rewardMint.staticCall(stranger.address, room);
    await expect(rw.rewardMint.staticCall(stranger.address, room + 1n), label)
      .to.be.revertedWithCustomError(hub, "BudgetExceeded");
  }

  beforeEach(async function () {
    [owner, alice, publisher, stranger] = await ethers.getSigners();
    ({ satori, rewards, merkle, token, hub, coreAddr } = await deployStack(owner, publisher)); // owner = admin+deployer
    RATE = await satori.emissionRateNow();
    DEV_RATE = await satori.devRateNow();
    RESIDUAL = RATE - DEV_RATE;
    RESIDUAL0 = RESIDUAL;
    await advanceRounds(3); // headroom past the saturated genesis round
  });

  /** Sets the share; returns the round it was set in. Rounds after it run at residualNext. */
  async function setShare(bps) {
    await rewards.connect(owner).setOffchainShareBps(bps);
    RESIDUAL = await hub.residualNext();
    return token.getCurrentRound();
  }

  it("genesis: the bootstrap mint splits into the senior dev lane and the on-chain lane; ledgers sum to the total", async function () {
    // INITIAL_MINT is exactly ONE ROUND of the hub's emission, booked as earned
    // and minted at once: nothing is left for mintDevFee to pull.
    const initial = await satori.INITIAL_MINT();
    expect(initial).to.equal(RATE); // the genesis mint IS one round of emission
    // The general share is floored and the dev takes the REMAINDER, so the
    // dev's genesis slice can sit a wei above a flat 15%.
    const generalGenesis = (initial * (10000n - (await token.devFeeBps()))) / 10000n;
    expect(await satori.onChainMinted()).to.equal(generalGenesis);
    expect(await satori.merkleMinted()).to.equal(0n);
    expect(await satori.devFeeMinted()).to.equal(initial - generalGenesis);
    expect(await satori.totalRewardsMinted()).to.equal(initial);
    expect(await token.generalAccrued()).to.equal(await token.generalMinted());
    expect(await token.devFeeAccrued()).to.equal(await token.devFeeMinted());
    // three-lane identity: total == devFee + onChain + merkle
    expect(await satori.totalRewardsMinted()).to.equal(
      (await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted()));
    await conserved("genesis");
  });

  it("the share mirrors into core and the reserve accrues at offchainShareBps of each round", async function () {
    await setShare(1000); // mirrors 10% into core; effective NEXT round
    expect(await satori.merkleReserveCeiling()).to.equal(0n); // the in-flight round keeps the old share (0)
    await advanceRounds(1);                                    // a round's reserve counts from its start
    expect(await satori.merkleReserveCeiling()).to.equal(per(1000));
    await advanceRounds(4);
    expect(await satori.merkleReserveCeiling()).to.equal(5n * per(1000)); // 5 rounds
    // The ceiling a claim reads is exactly what the next touch banks.
    await satori.syncEmission();
    expect(await satori.merkleReserveCumulative()).to.equal(5n * per(1000));
  });

  it("a bank reports exactly the reserve, with its fee, and leaves the on-chain ceiling unchanged", async function () {
    await setShare(3000);
    const bps = await token.devFeeBps();
    const general0 = await token.generalAccrued();
    const fee0 = await token.devFeeAccrued();
    const onChain0 = await satori.onChainRewardCeiling();
    await advanceRounds(2);
    const due = await satori.merkleReserveCeiling();
    expect(due).to.equal(2n * per(3000));
    // Not reported until a touch banks it.
    expect(await token.generalAccrued()).to.equal(general0);

    await satori.syncEmission(); // permissionless
    expect(await satori.merkleReserveCumulative()).to.equal(due);
    expect(await satori.merkleReserveCeiling()).to.equal(due);
    // The banked reserve is reported as earned, its fee booked with it...
    expect(await token.generalAccrued()).to.equal(general0 + due);
    expect(await token.devFeeAccrued()).to.equal(fee0 + feeOn(due, bps));
    // ...and gives the on-chain lane nothing.
    expect(await satori.onChainRewardCeiling()).to.equal(onChain0);
    await conserved("after the bank");
  });

  it("conservation holds across an emission step under a standing share", async function () {
    const setRound = await setShare(3000);
    await advanceRounds(2);
    const rw = await asRewards(rewards, coreAddr);
    const bps = await token.devFeeBps();
    const residualOf = (rate) => rate - (rate * bps) / 10000n;
    // Every priced round's residual, split between the on-chain allowance and
    // the reserve; genesis's general share seeds the allowance on top.
    const lanes = async () => (await hub.onChainAllowance()) + (await hub.merkleReserveCumulative());
    const priceNow = async () => rw.freezeRoundGross(await token.getCurrentRound());

    await priceNow();
    // Rounds through the share's own round ran at the genesis residual; the two
    // after it at the residual the share change left.
    const before = setRound - (await satori.deploymentRound()) + 1n;
    const after = (await satori.getCurrentRound()) - setRound;
    const generalGenesis = ((await satori.INITIAL_MINT()) * (10000n - bps)) / 10000n;
    let expected = generalGenesis + RESIDUAL0 * before + RESIDUAL * after;
    expect(await lanes(), "before the step").to.equal(expected);
    await conserved("before the step");

    const e = await hub.emission();
    const rateNow = await satori.emissionRateNow();
    await issueTo(hub, token, rw, e.nextStepAt);
    expect((await hub.emission()).stepsTaken).to.equal(e.stepsTaken + 1n);
    expect(await hub.emissionRateNext()).to.be.lt(rateNow);
    expect(await satori.emissionRateNow()).to.equal(rateNow); // the crossing round keeps its rate
    expect(await lanes(), "crossing round").to.equal(expected);
    await conserved("crossing round");

    // After the step the share splits the NEW residual: the reserve per round follows it.
    const perAfter = (residualOf(await hub.emissionRateNext()) * 3000n) / 10000n;
    expect(perAfter).to.be.lt(per(3000));
    let reserve = 2n * per(3000);
    for (let i = 1; i <= 3; i++) {
      await advanceRounds(1);
      if (i === 1) expect((residualOf(await satori.emissionRateNow()) * 3000n) / 10000n).to.equal(perAfter);
      await priceNow();
      expected += residualOf(await satori.emissionRateNow());
      reserve += (residualOf(await satori.emissionRateNow()) * 3000n) / 10000n;
      expect(await hub.merkleReserveCumulative()).to.equal(reserve);
      expect(await lanes(), `${i} round(s) after the step`).to.equal(expected);
      await conserved(`${i} round(s) after the step`);
    }
  });

  it("STRICT Merkle lane: a claim can never exceed the banked reserve, even with on-chain room reported", async function () {
    await setShare(100); // 1% a round, effective next round
    await advanceRounds(2);                                 // reserve = 2 rounds
    const P = per(100);
    expect(await satori.merkleReserveCeiling()).to.equal(2n * P);
    expect(5n * P).to.be.lt(E(100));                        // the claims below stay under the on-chain room

    // Reported, unminted room the Merkle lane must not touch: an on-chain
    // credit the token would itself let the controller mint.
    const rw = await asRewards(rewards, coreAddr);
    await reportOnChain(rw, token, E(100));
    const onChainRoom = async () => (await satori.onChainRewardCeiling()) - (await satori.onChainMinted());
    expect(await onChainRoom()).to.equal(E(100));

    // Under partial pay (pre-launch review) the over-sized claim mints exactly
    // the banked reserve, and the cursor advances by what was PAID. The
    // entitlement is 4 rounds' worth, not 5: later rounds run at a slightly
    // lower rate (it steps every round's worth issued), so 5 rounds bank a
    // little under 5P.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, 4n * P));
    await merkle.connect(alice).claimMerkle(4n * P, []);
    expect(await satori.merkleMinted()).to.equal(2n * P);
    expect(await satori.balanceOf(alice.address)).to.equal(2n * P);
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(2n * P);

    // With the reserve spent, the rest is refused by the LANE: the token still
    // holds the on-chain credit as reported-but-unminted.
    expect((await token.generalAccrued()) - (await token.generalMinted())).to.equal(E(100));
    await expect(merkle.connect(alice).claimMerkle(4n * P, []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    expect(await onChainRoom()).to.equal(E(100));

    // More reserve banks over time → the SAME root and proof collect the
    // remainder (entitlement 4 rounds, 2 already paid, 3 more banked).
    await advanceRounds(3); // +3 rounds of reserve
    await merkle.connect(alice).claimMerkle(4n * P, []); // remainder, no republish needed
    expect(await satori.merkleMinted()).to.equal(4n * P);
    expect(await satori.balanceOf(alice.address)).to.equal(4n * P);
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(4n * P);
    expect(await onChainRoom()).to.equal(E(100));
    await conserved("after the claims");
  });

  it("STRICT on-chain lane: an over-issue cannot spend the Merkle reserve — the reserve stays claimable", async function () {
    // Reserve some budget for the off-chain side, then simulate an on-chain
    // over-issue by injecting calls AS the real, authorized rewards child
    // (impersonated — setChild is gone).
    const setRound = await setShare(2500); // effective next round
    await advanceRounds(2);
    const hubAsRewards = await asRewards(rewards, coreAddr);
    await hubAsRewards.freezeRoundGross(await token.getCurrentRound()); // prices the rounds, banks their reserve
    const reserve = await satori.merkleReserveCumulative();
    expect(reserve).to.equal(2n * per(2500));

    // Report the on-chain lane's whole allowance.
    const left = (await hub.onChainAllowance()) - ((await token.generalAccrued()) - reserve);
    await hubAsRewards.noteIssued(left);
    await expect(hubAsRewards.noteIssued(1n)) // beyond the priced rounds: fails closed at the report
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");

    const onChainCeil = await satori.onChainRewardCeiling();
    const laneHeadroom = onChainCeil - (await satori.onChainMinted());
    expect(laneHeadroom).to.equal(left);

    // Fill the on-chain lane EXACTLY — fine.
    await hubAsRewards.rewardMint(stranger.address, laneHeadroom);
    expect(await satori.onChainMinted()).to.equal(onChainCeil);

    // One wei more reverts — and it is the LANE, not the token: the token still
    // holds `reserve` reported and unminted (paid out right below by the Merkle claim).
    expect((await token.generalAccrued()) - (await token.generalMinted())).to.equal(reserve);
    await expect(hubAsRewards.rewardMint(stranger.address, 1n))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // The walled-off reserve is real and still belongs to the Merkle lane:
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));
    await merkle.connect(alice).claimMerkle(reserve, []);
    expect(await satori.merkleMinted()).to.equal(reserve);

    // Realize the senior dev lane too (see test/next/DevFee.test.js).
    await satori.mintDevFee();

    // Everything reported is minted, and nothing else. Each priced round's
    // residual went to exactly one lane; genesis paid the deploy round too.
    const before = setRound - (await satori.deploymentRound()) + 1n;
    const after = (await satori.getCurrentRound()) - setRound;
    const bps = await token.devFeeBps();
    const generalGenesis = ((await satori.INITIAL_MINT()) * (10000n - bps)) / 10000n;
    const general = await token.generalAccrued();
    expect(general).to.equal(generalGenesis + RESIDUAL0 * before + RESIDUAL * after);
    expect(await token.generalMinted()).to.equal(general);
    expect(await token.devFeeMinted()).to.equal(await token.devFeeAccrued());
    const total = await satori.totalRewardsMinted();
    expect(total).to.equal(general + (await token.devFeeAccrued()));
    expect(total).to.be.lte(await token.rewardCeiling());
    // three-lane identity: total == devFee + onChain + merkle
    expect(total).to.equal(
      (await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted()));
    await conserved("saturated");
  });

  it("share changes are piecewise, never retroactive", async function () {
    await setShare(1000);                                   // 10%, effective next round
    await advanceRounds(2);                                 // two rounds at 10%
    const at10 = 2n * per(1000);
    await setShare(3000);                                   // banks those two, then 30% from next round
    await advanceRounds(3);                                 // 3 rounds at 30%
    expect(await satori.merkleReserveCeiling()).to.equal(at10 + 3n * per(3000)); // not 5 at 30%
  });

  it("a share change emits the cumulative it banked, as of the round the new share starts", async function () {
    const hub = await ethers.getContractAt("SatoriHub", coreAddr);
    await setShare(1000);
    await advanceRounds(2);
    const at10 = 2n * per(1000);
    await setShare(3000);
    const logs = await hub.queryFilter(hub.filters.MerkleReserveShareSet(), 0);
    const last = logs[logs.length - 1].args;
    expect(last.bps).to.equal(3000n);
    expect(last.fromRound).to.equal((await satori.getCurrentRound()) + 1n);
    expect(last.cumulativeAtFromRound).to.equal(await satori.merkleReserveCumulative());
    expect(last.cumulativeAtFromRound).to.equal(at10);
  });

  it("setMerkleReserveBps is rewards-only and rejects a share >= 10000", async function () {
    await expect(satori.connect(stranger).setMerkleReserveBps(1))
      .to.be.revertedWithCustomError(satori, "Unauthorized");
    await expect(satori.connect(owner).setMerkleReserveBps(1)) // even admin/EOA can't — only the contract
      .to.be.revertedWithCustomError(satori, "Unauthorized");

    // Defense-in-depth: core rejects a whole-residual share even if rewards
    // passed a bad value. Exercise AS the real, authorized rewards child (impersonated).
    const hubAsRewards = await asRewards(rewards, coreAddr);
    await expect(hubAsRewards.setMerkleReserveBps(10000))
      .to.be.revertedWithCustomError(satori, "BadInput");
    await expect(hubAsRewards.setMerkleReserveBps(9999)).to.not.be.reverted;
  });

  it("default share (0): reserve stays 0 and the on-chain lane is everything reported (pre-2b behaviour)", async function () {
    expect(await satori.merkleReserveCeiling()).to.equal(0n);
    const ceil0 = await satori.onChainRewardCeiling();
    expect(ceil0).to.equal(await token.generalAccrued());
    // Time alone grows neither lane.
    await advanceRounds(5);
    await satori.syncEmission();
    expect(await satori.onChainRewardCeiling()).to.equal(ceil0);
    expect(await satori.merkleReserveCumulative()).to.equal(0n);

    // A reported credit is the on-chain lane's, whole.
    const rw = await asRewards(rewards, coreAddr);
    await reportOnChain(rw, token, E(100));
    expect(await satori.onChainRewardCeiling()).to.equal(ceil0 + E(100));
    expect(await satori.merkleReserveCumulative()).to.equal(0n);
    await rw.rewardMint(stranger.address, E(100));
    await conserved("after the on-chain mint");

    // With no reserve, a Merkle claim of any positive amount is refused.
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(1)));
    await expect(merkle.connect(alice).claimMerkle(E(1), []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
  });
});
