/**
 * gap-minting-moving-cap-catchup.cov.test.js
 *
 * PHASE-CLOSE gap (Minting & conservation): the LIVE-CONTRACT moving-cap
 * CATCH-UP edge.
 *
 * The rewardMint guard recomputes
 *      roundsElapsed = getCurrentRound() - deploymentRound + 1
 * FRESH on every call. So a long-dormant protocol can legitimately mint a
 * large accumulated lump in a SINGLE call, and exactly one wei more reverts
 * BudgetExceeded at that same instant.
 *
 * With the SENIOR dev fee living in the immutable token, the hub's on-chain
 * reward lane is bounded NET of the token's full dev accrual:
 *      generalCap = token.generalCeilingFor(emissionCeiling())
 * and its running counter is onChainMinted (== totalRewardsMinted - devFeeMinted).
 * The tier-1 per-round general headroom is 720 - 144 = 576; the boundary
 * (headroom vs headroom+1) is exact against onChainMinted, not the total.
 *
 * The arithmetic is proven SYMBOLICALLY (Halmos check_mintCapNeverExceeded),
 * but that is a pure arithmetic mirror, not the live contract. Existing live
 * unit tests advance ONE round per mint (small 2x/3x multiples). This test
 * exercises the realistic post-launch scenario: many quiet rounds elapse,
 * then a single rewardMint draws the FULL accumulated headroom at a LARGE
 * multiple, and the boundary (headroom vs headroom+1) is exact. It repeats
 * after a second multi-round jump to confirm the cap keeps moving.
 *
 * This file ADDS tests only; it never edits a contract.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");

const ROUND = 86400; // timeUnitSeconds (24h)

async function asRewards(rewards) {
  const addr = await rewards.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("10"));
  return await ethers.getSigner(addr);
}

describe("[gap] minting — moving-cap catch-up over many quiet rounds", function () {
  this.timeout(600000);

  it("a single rewardMint can draw the full accumulated headroom after a long idle gap; headroom+1 reverts at the same instant", async function () {
    const { satori, rewards, signers } = await deploySatoriFixture();
    const rewardsSigner = await asRewards(rewards);
    const recipient = signers[5].address;
    const deploymentRound = await satori.deploymentRound();
    // The moving cap is the HUB's: its emission ceiling net of the fee's flat
    // 15%. Was `1440 × rounds − devFeeCeiling`, which held only while emission
    // was a fixed 1440 and the fee accrued on the clock.
    const RATE = await satori.emissionRateNow();
    const BPS = await satori.devFeeBps();
    const genCap = (e) => (RATE * e * (10000n - BPS)) / 10000n;

    // -- FIRST big idle gap: jump ~50 rounds with ZERO minting in between. ----
    await time.increase(ROUND * 50);

    const roundsElapsed1 = (await satori.getCurrentRound()) - deploymentRound + 1n;
    // Sanity: this is a LARGE multiple, not the 2x/3x the unit tests use.
    expect(roundsElapsed1).to.be.gte(50n);

    // General-lane moving cap (net of the fee's carve-out) and its counter.
    const generalCap1 = genCap(roundsElapsed1);
    const onChainBefore1 = await satori.onChainMinted();
    // Only the genesis INITIAL_MINT — one round of the schedule — has been
    // minted so far, and it saturates the deploy round exactly.
    const initialMint = await satori.INITIAL_MINT();
    expect(await satori.totalRewardsMinted()).to.equal(initialMint);
    expect(onChainBefore1).to.equal(initialMint - (await satori.devFeeMinted()));
    expect(onChainBefore1).to.equal(genCap(1n));
    const headroom1 = generalCap1 - onChainBefore1;
    // The lump is every round since the deploy round, in one call.
    expect(headroom1).to.equal(genCap(roundsElapsed1) - genCap(1n));

    // headroom + 1 wei reverts at this exact instant (the `>` cap fires).
    await expect(
      satori.connect(rewardsSigner).rewardMint(recipient, headroom1 + 1n)
    ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // Exactly the full accumulated headroom succeeds in ONE call and lands the
    // general lane exactly on its moving cap.
    await satori.connect(rewardsSigner).rewardMint(recipient, headroom1);
    expect(await satori.onChainMinted()).to.equal(generalCap1);
    // Three-lane identity: total == devFeeMinted + onChain + merkleMinted (0 here).
    expect(await satori.totalRewardsMinted()).to.equal(
      (await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted())
    );
    // Conservation identity holds at the lump-mint instant too.
    expect(await satori.totalSupply()).to.equal(await satori.totalRewardsMinted());

    // Now fully saturated for this round: even 1 wei more reverts.
    await expect(
      satori.connect(rewardsSigner).rewardMint(recipient, 1n)
    ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // -- SECOND big idle gap: jump another ~37 rounds; cap keeps moving. ------
    await time.increase(ROUND * 37);

    const roundsElapsed2 = (await satori.getCurrentRound()) - deploymentRound + 1n;
    expect(roundsElapsed2).to.be.gt(roundsElapsed1);

    const generalCap2 = genCap(roundsElapsed2);
    const onChainBefore2 = await satori.onChainMinted();
    expect(onChainBefore2).to.equal(generalCap1); // unchanged since the last lump
    const headroom2 = generalCap2 - onChainBefore2;
    // The newly-unlocked headroom is exactly the rounds that elapsed during the
    // second idle gap, at the general share of the emission.
    expect(headroom2).to.equal(genCap(roundsElapsed2) - genCap(roundsElapsed1));

    // boundary again exact
    await expect(
      satori.connect(rewardsSigner).rewardMint(recipient, headroom2 + 1n)
    ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

    await satori.connect(rewardsSigner).rewardMint(recipient, headroom2);
    expect(await satori.onChainMinted()).to.equal(generalCap2);
    expect(await satori.totalSupply()).to.equal(await satori.totalRewardsMinted());

    await expect(
      satori.connect(rewardsSigner).rewardMint(recipient, 1n)
    ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
  });

  it("draining the catch-up lump in pieces shares one accumulated headroom (cumulative across calls, large multiple)", async function () {
    const { satori, rewards, signers } = await deploySatoriFixture();
    const rewardsSigner = await asRewards(rewards);
    const RATE = await satori.emissionRateNow();
    const BPS = await satori.devFeeBps();
    const genCap = (e) => (RATE * e * (10000n - BPS)) / 10000n;
    const recipient = signers[6].address;
    const deploymentRound = await satori.deploymentRound();

    // Idle for many rounds, then drain the lump in several partial mints and
    // confirm the cumulative running total — not per-call amount — is what the
    // moving cap bounds at a LARGE multiple.
    await time.increase(ROUND * 40);

    const roundsElapsed = (await satori.getCurrentRound()) - deploymentRound + 1n;
    // General-lane moving cap (net of the fee's carve-out) and its counter.
    const cap = genCap(roundsElapsed);
    let minted = await satori.onChainMinted();
    let headroom = cap - minted;
    expect(headroom).to.be.gt(RATE * 10n); // genuinely a big lump

    // Drain in 4 unequal chunks; the running general total must stay <= cap and
    // the final chunk must be capped to the exact remaining headroom.
    const chunk = headroom / 4n;
    for (let i = 0; i < 3; i++) {
      await satori.connect(rewardsSigner).rewardMint(recipient, chunk);
      minted += chunk;
      expect(await satori.onChainMinted()).to.equal(minted);
      expect(await satori.totalSupply()).to.equal(await satori.totalRewardsMinted());
    }

    const remaining = cap - (await satori.onChainMinted());
    // One wei over the remaining headroom reverts (cumulative cap, not per-call).
    await expect(
      satori.connect(rewardsSigner).rewardMint(recipient, remaining + 1n)
    ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

    // Exactly the remaining headroom saturates the moving general cap.
    await satori.connect(rewardsSigner).rewardMint(recipient, remaining);
    expect(await satori.onChainMinted()).to.equal(cap);
    expect(await satori.totalSupply()).to.equal(await satori.totalRewardsMinted());

    await expect(
      satori.connect(rewardsSigner).rewardMint(recipient, 1n)
    ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
  });
});
