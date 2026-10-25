/**
 * gap-minting-moving-cap-catchup.cov.test.js
 *
 * PHASE-CLOSE gap (Minting & conservation): the LIVE-CONTRACT catch-up edge.
 *
 * The on-chain lane mints only what SatoriRewards reported (`noteIssued`),
 * and a report may not pass the allowance of the rounds priced so far.
 * `freezeRoundGross` prices EVERY round since `onChainPricedRound` at the
 * current gross, so after a long dormant stretch the first touch catches the
 * allowance up in one step, and a single report + mint can draw that whole
 * lump; exactly one wei more reverts BudgetExceeded at either step.
 *
 * Existing live unit tests touch ONE round per mint. This test exercises the
 * realistic post-launch scenario: many quiet rounds elapse, then a single
 * report and a single rewardMint draw the FULL accumulated allowance at a
 * LARGE multiple, and both boundaries are exact. It repeats after a second
 * multi-round jump to confirm the catch-up repeats.
 *
 * This file ADDS tests only; it never edits a contract.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");
const { burnedTotal } = require("../helpers/burned");

const ROUND = 86400; // timeUnitSeconds (24h)

async function asRewards(rewards) {
  const addr = await rewards.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("10"));
  return await ethers.getSigner(addr);
}

// What the schedule backstop lets Rewards still report: the priced rounds'
// allowance less the general already reported to the on-chain lane.
async function allowanceRoom(hub, token) {
  return (await hub.onChainAllowance())
    - ((await token.generalAccrued()) - (await hub.merkleReserveCumulative()));
}

describe("[gap] minting — moving-cap catch-up over many quiet rounds", function () {
  this.timeout(600000);

  it("a single report + rewardMint can draw the full accumulated allowance after a long idle gap; +1 reverts at the same instant", async function () {
    const { satori, hub, token, lens, rewards, signers } = await deploySatoriFixture();
    const rewardsSigner = await asRewards(rewards);
    const recipient = signers[5].address;
    const deploymentRound = await satori.deploymentRound();
    const GROSS = await hub.onChainGrossNow();

    // Price the gap, then report and mint the whole catch-up lump in ONE call
    // each, with both boundaries exact. `rounds` is how many rounds the one
    // freeze priced.
    async function catchUp() {
      const cur = await satori.getCurrentRound();
      const rounds = cur - (await hub.onChainPricedRound());
      const onChainBefore = await satori.onChainMinted();
      // Nothing was reported during the gap, so time alone gave no mint room.
      expect(await lens.onChainRewardCeiling()).to.equal(onChainBefore);
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

      const room0 = await allowanceRoom(hub, token);
      await hub.connect(rewardsSigner).freezeRoundGross(cur);
      const lump = await allowanceRoom(hub, token);
      expect(lump - room0).to.equal(GROSS * rounds);

      await expect(
        hub.connect(rewardsSigner).noteIssued(lump + 1n)
      ).to.be.revertedWithCustomError(hub, "BudgetExceeded");
      await hub.connect(rewardsSigner).noteIssued(lump);
      const cap = await lens.onChainRewardCeiling();
      expect(cap).to.equal(onChainBefore + lump);

      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, lump + 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
      await satori.connect(rewardsSigner).rewardMint(recipient, lump);
      expect(await satori.onChainMinted()).to.equal(cap);
      // Three-lane identity: total == devFeeMinted + onChain + merkleMinted (0 here).
      expect(await satori.totalRewardsMinted()).to.equal(
        (await satori.devFeeMinted()) + (await satori.onChainMinted()) + (await satori.merkleMinted())
      );
      // Conservation identity holds at the lump-mint instant too.
      expect((await satori.totalSupply()) + (await burnedTotal(token))).to.equal(await satori.totalRewardsMinted());

      // Now fully saturated: even 1 wei more reverts at either step.
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
      await expect(
        hub.connect(rewardsSigner).noteIssued(1n)
      ).to.be.revertedWithCustomError(hub, "BudgetExceeded");
      return { rounds, lump };
    }

    // Only genesis has been minted, and all of it is the general lane's share
    // plus the fee.
    const initialMint = await satori.INITIAL_MINT();
    expect(await satori.totalRewardsMinted()).to.equal(initialMint);
    expect(await satori.onChainMinted()).to.equal(initialMint - (await satori.devFeeMinted()));

    // -- FIRST big idle gap: jump ~50 rounds with ZERO activity in between. ---
    await time.increase(ROUND * 50);
    const roundsElapsed1 = (await satori.getCurrentRound()) - deploymentRound + 1n;
    // Sanity: this is a LARGE multiple, not the single round the unit tests use.
    expect(roundsElapsed1).to.be.gte(50n);
    const first = await catchUp();
    // Nothing priced the deploy round at bootstrap; the freeze prices all of them.
    expect(first.rounds).to.equal(roundsElapsed1);
    // The lump also carries the deploy round's bootstrap overlap: genesis paid
    // that round and its first touch priced it again.
    expect(first.lump).to.equal(GROSS * roundsElapsed1);

    // -- SECOND big idle gap: jump another ~37 rounds; the catch-up repeats. --
    await time.increase(ROUND * 37);
    const roundsElapsed2 = (await satori.getCurrentRound()) - deploymentRound + 1n;
    const second = await catchUp();
    // The newly-unlocked allowance is exactly the rounds that elapsed during
    // the second idle gap, at the on-chain gross.
    expect(second.rounds).to.equal(roundsElapsed2 - roundsElapsed1);
    expect(second.lump).to.equal(GROSS * (roundsElapsed2 - roundsElapsed1));
  });

  it("draining the catch-up lump in pieces shares one accumulated allowance (cumulative across calls, large multiple)", async function () {
    const { satori, hub, token, lens, rewards, signers } = await deploySatoriFixture();
    const rewardsSigner = await asRewards(rewards);
    const RATE = await satori.emissionRateNow();
    const recipient = signers[6].address;

    // Idle for many rounds, then report and mint the lump in several partial
    // calls and confirm the cumulative running totals — not per-call amounts —
    // are what the allowance and the report bound at a LARGE multiple.
    await time.increase(ROUND * 40);
    await hub.connect(rewardsSigner).freezeRoundGross(await satori.getCurrentRound());

    const lump = await allowanceRoom(hub, token);
    expect(lump).to.be.gt(RATE * 10n); // genuinely a big lump
    const cap = (await satori.onChainMinted()) + lump;

    // Report and mint 3 equal chunks; the running general total must stay
    // <= cap and the final chunk must be capped to the exact remaining room.
    const chunk = lump / 4n;
    let minted = await satori.onChainMinted();
    for (let i = 0; i < 3; i++) {
      await hub.connect(rewardsSigner).noteIssued(chunk);
      await satori.connect(rewardsSigner).rewardMint(recipient, chunk);
      minted += chunk;
      expect(await satori.onChainMinted()).to.equal(minted);
      expect((await satori.totalSupply()) + (await burnedTotal(token))).to.equal(await satori.totalRewardsMinted());
    }

    const remaining = cap - (await satori.onChainMinted());
    expect(await allowanceRoom(hub, token)).to.equal(remaining);
    // One wei over the remaining room reverts at the report (cumulative, not per-call).
    await expect(
      hub.connect(rewardsSigner).noteIssued(remaining + 1n)
    ).to.be.revertedWithCustomError(hub, "BudgetExceeded");
    await hub.connect(rewardsSigner).noteIssued(remaining);

    // One wei past the report reverts at the mint; the exact report
    // saturates the ceiling.
    await expect(
      satori.connect(rewardsSigner).rewardMint(recipient, remaining + 1n)
    ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
    await satori.connect(rewardsSigner).rewardMint(recipient, remaining);
    expect(await satori.onChainMinted()).to.equal(cap);
    expect(await lens.onChainRewardCeiling()).to.equal(cap);
    expect((await satori.totalSupply()) + (await burnedTotal(token))).to.equal(await satori.totalRewardsMinted());

    await expect(
      satori.connect(rewardsSigner).rewardMint(recipient, 1n)
    ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
  });
});
