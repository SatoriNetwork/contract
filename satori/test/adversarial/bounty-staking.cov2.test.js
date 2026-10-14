// Adversarial COVERAGE (round 2) — bounty-staking subsystem.
//
// Round 1 (bounty-staking.cov.test.js) pinned the high/med gaps around
// conservation, lock monotonicity, the unstake boundary, and pot residue.
// The high-severity double-credit finding (two games on one stream) is
// already CONFIRMED with a kept repro and is deliberately NOT re-tested.
//
// This round covers the remaining MEDIUM-priority surface AND the
// post-audit CONTRACT CHANGE that the bounty fee path now depends on:
//
//   IMMUTABLE platform-fee recipient.
//   * The fee recipient (the splitter) is a constructor-set immutable —
//     `PLATFORM_FEE_RECIPIENT()`. It is fixed at deploy time and has NO
//     setter: there is no on-chain path, ever, that redirects the fee. The
//     shared fixture wires it to a valid non-zero, non-signer address, so no
//     zero-address path is exercised.
//   * `admin` can ONLY reduce the fee RATE (reduce-only) and transfer
//     the admin role. It can NEVER redirect the fee and NEVER raise it.
//
// Why this lives in the bounty-staking coverage set: the bounty win-credit
// path (_accrueBountyForWinToken) reads the immutable PLATFORM_FEE_RECIPIENT
// for the fee recipient AND `feeSlot()` for the rate (bounty fee ==
// platform bps / 2). So the immutability of the recipient and the
// reduce-only rate directly govern where/how much of every bounty pot is
// skimmed as protocol fee. A regression that re-opened recipient
// redirection, or let the rate rise, would silently re-route or inflate the
// skim on every staker's winnings.
//
// All assertions reflect the DOCUMENTED/CURRENT-CODE intent. Any failing
// assertion of intended behavior is a NEW bug and gets relocated to
// adversarial-findings/cov2_bounty-staking.test.js (kept failing).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, deploySatoriFixtureWithFeeBps, pack1 , warmUpStreak , voteFor } = require("../fixtures");
const { TEST_PLATFORM_FEE_RECIPIENT } = require("../next/splitFixture");

const UP = 1;
// The constructor-set immutable platform-fee recipient the shared fixture
// deploys SatoriRewards with (exposed via rewards.PLATFORM_FEE_RECIPIENT()).
const PLACEHOLDER = TEST_PLATFORM_FEE_RECIPIENT;

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

// Stream cadence floor: a PUBLIC caller may only create streams with
// round-length (>= 1440 minute) cadence; sub-round streams are admin-only. This
// test's subject is bounty pool/drip/stake mechanics, not stream rhythm, so it
// keeps the fast (720-minute, sub-round) beat by having the ADMIN (`owner`)
// create the stream. `authority` stays the stream's PROVIDER, so
// it is still the account that writes values.
async function createStream(satori, signer, name, authority) {
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 720);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

describe("COV2 bounty-staking: immutable fee recipient + reduce-only rate -> bounty skim", function () {
  this.timeout(120000);

  let satori, bounties, rewards, registry, games, owner;
  let alice, bob, funder, authority, outsider;
  let streamId, usd, usdAddr;

  const POT = ethers.parseEther("1000");
  const RATE = ethers.parseEther("200"); // virgin pool -> drip == RATE per scored round
  const TOL = ethers.parseEther("0.01");

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, bounties, rewards, registry, games, owner } = fix);
    [, alice, bob, funder, authority, outsider] = fix.signers;

    for (const s of [alice, bob, funder, authority, outsider]) {
      await satori.transfer(s.address, ethers.parseEther("100"));
    }

    streamId = await createStream(satori, owner, "S", authority.address);

    // audit C-2: streak 0 pays flat dust and takes no bounty boost — warm to streak >= 1

    await warmUpStreak(satori, registry, authority, [alice, bob], streamId);
    await voteFor(satori, alice, streamId);
    await voteFor(satori, bob, streamId);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, ethers.parseEther("100000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("100000"));
    await bounties.connect(funder).fundBounty(streamId, usdAddr, POT, RATE);
  });

  // ----------------------------------------------------------------------
  // (1) The recipient is a constructor-set immutable. It is the
  //     fixture-configured recipient (non-zero, non-signer) and there is NO
  //     setter of any kind: no wireFeeRecipient, no setPlatformFeeRecipient.
  //     The only on-chain knobs are rate-down + admin-role transfer — the fee
  //     destination can never be redirected.
  // ----------------------------------------------------------------------
  it("rewards exposes no platform-fee recipient and no redirect selector", async function () {
    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // recipient is now the token's immutable PLATFORM_FEE_RECIPIENT and rewards no
    // longer carries it. rewards still exposes NO fee-redirect selector of any kind.

    // No recipient-redirect selector exists in the ABI, and the contract
    // object exposes no such methods either.
    for (const removed of ["wireFeeRecipient", "setPlatformFeeRecipient"]) {
      const hasFragment = rewards.interface.fragments.some(
        (f) => f.type === "function" && f.name === removed
      );
      expect(hasFragment, removed).to.equal(false);
      expect(rewards[removed], removed).to.equal(undefined);
    }
  });

  // ----------------------------------------------------------------------
  // (3) SUBSYSTEM TIE-IN: the bounty win-credit skim follows the deploy-set
  //     rate and routes to the IMMUTABLE recipient. With the platform fee
  //     deployed at 1000 bps (10%), a sole correct staker's bounty
  //     fee == pot * bps/2 / 10000 == pot * 5% and is credited to the
  //     immutable PLATFORM_FEE_RECIPIENT. The recipient is not a
  //     signer, so we assert the view-side accrual (unclaimedBounty) rather
  //     than having it claim. Conservation still holds: predictor + fee
  //     == dripped pot.
  // ----------------------------------------------------------------------
  it("bounty win-credit skims no platform fee; sole correct staker gets the full dripped pot", async function () {
    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // rewards fee schedule / feeSlot rate is gone, so the bounty win-credit skims
    // nothing regardless of deploy. Re-wire this test's setup off a fresh stack.
    const fix = await deploySatoriFixtureWithFeeBps(1000);
    ({ satori, bounties, rewards, registry, games, owner } = fix);
    [, alice, bob, funder, authority, outsider] = fix.signers;

    for (const s of [alice, bob, funder, authority, outsider]) {
      await satori.transfer(s.address, ethers.parseEther("100"));
    }

    streamId = await createStream(satori, owner, "S", authority.address);

    // audit C-2: streak 0 pays flat dust and takes no bounty boost — warm to streak >= 1

    await warmUpStreak(satori, registry, authority, [alice, bob], streamId);
    await voteFor(satori, alice, streamId);
    await voteFor(satori, bob, streamId);

    usd = await deployMockToken("USDC");
    usdAddr = await usd.getAddress();
    await usd.mint(funder.address, ethers.parseEther("100000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("100000"));
    await bounties.connect(funder).fundBounty(streamId, usdAddr, POT, RATE);

    // platform fee moved to immutable token (see test/next/DevFee.test.js):
    // rewards.feeSlot() is now inert (0,0) and rewards.PLATFORM_FEE_RECIPIENT is
    // gone — the bounty payout no longer skims any protocol fee.

    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(streamId, 100); // anchor A
    const predictRound = Number(await satori.getCurrentRound());

    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: streamId, payload: pack1(UP) }]);

    // Drive A-B-C so UP is correct.
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(streamId, 120);

    await satori.settlePrediction(alice.address, streamId);

    const dripped = await bounties.roundBountyPot(streamId, predictRound, usdAddr);
    expect(dripped).to.equal(RATE); // virgin pool drip == RATE

    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("100");

    // Post-fee-overhaul: the bounty PAYOUT fee (a % of each winner's payout,
    // formerly bps/2 credited to PLATFORM_FEE_RECIPIENT) is REMOVED ENTIRELY.
    // The sole correct staker now receives the FULL dripped pot.
    const expectedPredictor = dripped;
    expect(aliceEarned).to.be.closeTo(expectedPredictor, TOL);

    // Conservation: predictor payout == dripped pot, nothing minted, nothing lost.
    expect(aliceEarned).to.be.closeTo(dripped, TOL);
    expect(aliceEarned).to.be.lte(dripped + TOL);
  });
});
