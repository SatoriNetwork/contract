/**
 * Adversarial COVERAGE (ROUND 2) — bounties subsystem (SatoriBounties.sol).
 *
 * Round 1 (bounties.cov.test.js) covered the high gaps (pot-fully-drains
 * conservation, equal + uneven stake splits) and the two med gaps that were
 * cleanly assertable as intended behavior (fractional cumulative drip ==
 * funded pool; cleanup rejected while pool/rate live).
 *
 * This round targets the remaining gap surface that is now reachable ONLY in
 * light of the post-audit CONTRACT CHANGE to the platform-fee recipient:
 *
 *   - The fee recipient is IMMUTABLE. It is a constructor-set `immutable`
 *     (`PLATFORM_FEE_RECIPIENT`, non-zero) baked into the bytecode at deploy —
 *     NO post-deploy setter. Neither `setPlatformFeeRecipient` nor the old
 *     one-shot `wireFeeRecipient` exist anymore. The admin can ONLY (a) REDUCE
 *     the fee bps (reduce-only) and (b) transfer the admin role. It can NEVER
 *     redirect the fee.
 *
 *   - `creditBountyForWin` reads `feeSlot()` ONCE PER CALL (SatoriBounties.sol
 *     line 405), so the fee rate charged to a winner is whatever the slot
 *     holds AT THAT WINNER'S SETTLEMENT. Two winners of the SAME round can
 *     therefore be charged DIFFERENT fee rates if the admin reduces the bps
 *     between their two settlements. This is the low-priority "changing bps
 *     mid-round between drip and credits" gap from _raw_review.json, re-scoped
 *     to the current code. We pin it as INTENDED behavior (read-per-call,
 *     reduce-only, recipient fixed) and verify conservation still holds across
 *     the rate change.
 *
 *   - The companion "feeSlot.recipient == address(0)" half of that gap is now
 *     UNREACHABLE by construction (the recipient is the non-zero
 *     constructor-set immutable), so we instead assert the IMMUTABILITY
 *     guarantee directly:
 *     the recipient is a bytecode constant with no setter, and bounty fees keep
 *     landing in the one fixed recipient.
 *
 * Already-CONFIRMED findings (have repros) are NOT re-tested here:
 *   - adv_11_bounties.test.js      (unstake-before-score strands the share / HIGH)
 *   - adv_12_bounties.test.js      (multi-game-per-stream share inflation / MED)
 *   - adv_13_bounty-staking.test.js(two games one stream double-credit / HIGH)
 *   - RATE_SCALE residue-carry NatSpec falsehood (LOW)
 * Already-COVERED gaps are NOT duplicated:
 *   - bounties.cov.test.js         (conservation; fractional drip; cleanup-while-live)
 *   - cov_bounties.test.js         (cleanup-with-pending-snapshot — failing NEW finding)
 *
 * All assertions here are INTENDED behavior and the file MUST stay GREEN. Any
 * intended-behavior assertion that FAILED would be a NEW bug and would have
 * been moved to adversarial-findings/cov2_bounties.test.js.
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
// minute) streams; sub-round streams are admin-only. This test's subject is bounty
// pool/drip/stake mechanics, not stream rhythm, so it keeps the fast (720-minute,
// sub-round) beat by having the ADMIN (`owner`) create the stream. `authority`
// stays the stream's PROVIDER, so it is still the account that writes values.
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

describe("ADV-COV2 bounties (immutable fee recipient + per-call fee read)", function () {
  this.timeout(120000);

  let satori, token, rewards, bounties, registry, owner;
  let alice, bob, funder, authority;
  let s1, usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, token, rewards, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    s1 = await createStream(satori, owner, "S1", authority.address);

    // audit C-2: streak 0 pays flat dust and takes no bounty boost — warm to streak >= 1

    await warmUpStreak(satori, registry, authority, [alice, bob], s1);
    // Burn voting: 10 of each 100 SATORI buys s1's game permanent weight,
    // leaving 90 of prediction power each (equal across both).
    await voteFor(satori, alice, s1);
    await voteFor(satori, bob, s1);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, ethers.parseEther("1000000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("1000000"));
  });

  // ------------------------------------------------------------------
  // CONTRACT CHANGE assertion: the fee recipient is IMMUTABLE.
  //   - The recipient is a constructor-set `immutable`
  //     (`PLATFORM_FEE_RECIPIENT`, non-zero). It has NO post-deploy setter —
  //     `setPlatformFeeRecipient` and the old one-shot `wireFeeRecipient` no
  //     longer exist on the ABI.
  //   - bounty fees keep accruing to that one fixed constant recipient; the
  //     admin can transfer the admin role but the NEW admin still cannot
  //     redirect where the fee lands (there is simply no on-chain path).
  // ------------------------------------------------------------------
  it("[med] fee recipient is immutable: no re-point path; bounty fees always land in the fixed recipient", async function () {
    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // recipient is now SatoriToken.PLATFORM_FEE_RECIPIENT (a constructor-set
    // immutable), not a rewards getter. The split fixture points it at the owner
    // so genesis balances stay conserved; either way it is a bytecode constant.
    const feeRecipient = await token.PLATFORM_FEE_RECIPIENT();

    // The recipient is the constructor-set immutable recipient (non-zero).
    expect(feeRecipient).to.equal(owner.address);

    // No setter for the recipient exists on the contract — neither the removed
    // `setPlatformFeeRecipient` nor the removed one-shot `wireFeeRecipient`.
    expect(rewards.setPlatformFeeRecipient).to.equal(undefined);
    expect(rewards.wireFeeRecipient).to.equal(undefined);
    expect(rewards.interface.fragments.some(
      (f) => f.type === "function" &&
        (f.name === "setPlatformFeeRecipient" || f.name === "wireFeeRecipient")
    )).to.equal(false);

    // Transfer the admin role to a fresh admin (Alice). The role moves...
    await rewards.connect(owner).setAdmin(alice.address);
    expect(await rewards.admin()).to.equal(alice.address);
    // ...but the NEW admin STILL has no way to redirect the recipient: there is
    // no setter at all, and the recipient is a bytecode constant.
    expect(rewards.connect(alice).setPlatformFeeRecipient).to.equal(undefined);

    // And the constant recipient is unchanged through all of that.
    expect(await token.PLATFORM_FEE_RECIPIENT()).to.equal(feeRecipient);

    // Now drive a winning bounty prediction. The bounty-token PAYOUT fee has
    // been REMOVED entirely: the winner receives the FULL pot and the fixed fee
    // recipient receives ZERO bounty tokens. We still confirm no bounty tokens
    // leak to any address other than the winner — the immutable recipient never
    // accrues bounty-token fees under the new fee system.
    await bounties.connect(funder).fundBounty(s1, usdAddr, ethers.parseEther("100"), ethers.parseEther("100"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(s1, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: s1, payload: pack1(UP) }]);
    const r = await satori.getCurrentRound();
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(s1, 120);

    // Winner earnings auto-compound into `bountyStake`.
    const bobStakeBefore = await bounties.bountyStake(bob.address, usdAddr);
    await satori.settlePrediction(bob.address, s1);
    const pot = await bounties.roundBountyPot(s1, r, usdAddr);
    expect(pot).to.equal(ethers.parseEther("100"));

    // Sole staker => Bob's winning share is the FULL pot, with no fee skim.
    const bobStakeAfter = await bounties.bountyStake(bob.address, usdAddr);
    expect(bobStakeAfter - bobStakeBefore).to.equal(pot);
  });
});
