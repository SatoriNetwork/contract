/**
 * ADVERSARIAL COVERAGE — the platform-fee recipient surface that the (now
 * deleted) provider-cut round-2 file also carried.
 *
 * WHAT WAS REMOVED WITH THE BURN-VOTING REFACTOR
 *   The VALUE-PROVIDER CUT is gone. Providers are not paid at all any more:
 *   `accrueProviderCut`, `accrueDefaultStreamCut`, `getValueProviderCutBps`,
 *   the `valueProviderCutBps` stream-creation parameter and `predictorShareBps`
 *   no longer exist, and neither does the first-predictor bonus reservation the
 *   old budget arithmetic here subtracted. The two scenarios this file used to
 *   run (COV2-B "the cut is drawn off the fee-free budget" and COV2-C "the fee
 *   credits the immutable recipient; the provider cut is unaffected") therefore
 *   describe behaviour that no longer exists and have been DELETED rather than
 *   rewritten — the full on-chain gross now goes to predictors.
 *
 * WHAT SURVIVES (and is still asserted below)
 *   COV2-A (med): the platform-fee RECIPIENT lives on the immutable
 *   SatoriToken, not on SatoriRewards. Rewards exposes no recipient getter, no
 *   `setPlatformFeeRecipient` and no one-shot `wireFeeRecipient`, so nothing on
 *   this contract can ever redirect the fee; `feeSlot()` is retained purely to
 *   pin the proxied storage layout and reads inert. (The recipient's own
 *   immutability / non-admin authority is pinned in test/next/DevFee.test.js.)
 *
 * Harness: require("../fixtures"); this.timeout(120000); time.increase(86400).
 */

const { expect } = require("chai");
const {
  deploySatoriFixture,
  deploySatoriFixtureNoFee,
  deploySatoriFixtureWithFeeBps,
} = require("../fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Bare stack. The fee recipient is the immutable token's PLATFORM_FEE_RECIPIENT —
// there is no setter anywhere, so it is frozen after deploy.
async function deployStack(platform, deployer, opts = {}) {
  const bps = opts.bps ?? 0;
  const fix =
    bps === 2000
      ? await deploySatoriFixture()
      : bps === 0
        ? await deploySatoriFixtureNoFee()
        : await deploySatoriFixtureWithFeeBps(bps);
  const { satori, voting, rewards, registry, games, lens } = fix;
  return { satori, voting, rewards, registry, games, lens };
}

// ===========================================================================
// COV2-A (med) — the fee recipient moved to the immutable token; there is no
// setter and no wire path on rewards, so no re-point exists.
// ===========================================================================
describe("provider-cut COV2: immutable fee recipient (constructor-set, no re-point path)", function () {
  this.timeout(120000);
  let deployer, platform, splitter, attacker, other;

  beforeEach(async function () {
    [deployer, platform, splitter, attacker, other] = await ethers.getSigners();
    await time.increase(86400);
  });

  it("rewards exposes no fee recipient and no setter or wire path (recipient moved to the immutable token)", async function () {
    const { rewards } = await deployStack(platform, deployer);

    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // recipient is now the token's immutable PLATFORM_FEE_RECIPIENT (set once at
    // deploy, no setter). rewards no longer carries a recipient getter at all, so
    // the old `rewards.PLATFORM_FEE_RECIPIENT()` value assertion is dropped; the
    // recipient's immutability/non-admin-authority is pinned in DevFee.test.js.
    expect(rewards.PLATFORM_FEE_RECIPIENT).to.equal(undefined);

    // No on-chain path can ever redirect the fee: the recipient getter, the
    // legacy setter, and the one-shot wire are all absent from the interface AND
    // the runtime object.
    for (const removed of ["PLATFORM_FEE_RECIPIENT", "setPlatformFeeRecipient", "wireFeeRecipient"]) {
      expect(rewards.interface.fragments.some(
        (f) => f.type === "function" && f.name === removed
      )).to.equal(false);
      expect(rewards[removed]).to.equal(undefined);
    }

    // feeSlot() was removed 2026-08-31 along with the dead storage behind it,
    // so it belongs in the same absence list as the setters above.
    expect(rewards.feeSlot).to.equal(undefined);
  });
});
