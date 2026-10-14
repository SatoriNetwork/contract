/**
 * ADVERSARIAL COVERAGE — governance-invariants subsystem, ROUND 2 (MED-priority
 * gaps + the remaining un-covered HIGH gap).
 *
 * Source: adversarial-findings/_raw_review.json, system == "governance-invariants".
 *
 * CONTRACT CHANGE — the platform fee moved OUT of the upgradeable SatoriRewards
 * and INTO the immutable SatoriToken as a static, senior, self-accruing "dev
 * fee" (docs/design/immutable-dev-fee.md). As a result:
 *   - rewards.accrueProtocolFee() / applyFeeSchedule() / PLATFORM_FEE_RECIPIENT()
 *     and the auto fee-schedule (FEE_MID_BPS/FEE_FLOOR_BPS/FEE_DROP_ROUND) NO
 *     LONGER EXIST on rewards; feeSlot() is retained but inert (returns (0,0)).
 *   - The dev fee's 20/10/5 step-down schedule and its immutable, non-admin,
 *     no-setter recipient are covered by test/next/DevFee.test.js.
 *
 * What survives here (and is still a real governance invariant): the rewards
 * ADMIN role carries NO authority over any fee recipient — rewards exposes no
 * `setPlatformFeeRecipient`/`wireFeeRecipient` (and never carried a recipient
 * getter after the move). The rate-schedule / quiet-threshold-drop conservation
 * test is dropped wholesale — the behavior it pinned is gone (see below).
 *
 * Every assertion reflects DOCUMENTED INTENT; nothing is weakened to force a pass.
 */

const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");

describe("ADV COV2 governance-invariants", function () {
  this.timeout(120000);

  // =========================================================================
  // GAP (med): applyFeeSchedule_drop_at_quiet_threshold_round_conserves.
  //
  // platform fee moved to immutable token (see test/next/DevFee.test.js): the
  // upgradeable auto fee-schedule is gone — rewards.applyFeeSchedule() /
  // accrueProtocolFee() / feeSlot() rate no longer exist as a live surface, so
  // the "year-1 drop at a quiet threshold round conserves the cap" test is
  // dropped wholesale (there is no schedule left to drop). The dev fee's baked
  // 20/10/5 step-down and its cap-conservation are covered by
  // test/next/DevFee.test.js (devFeeCeiling() closed form + carve-out invariants).
  // =========================================================================

  // =========================================================================
  // GAP (med): the immutable-recipient model. The fee recipient is now the
  // constructor-set immutable on SatoriToken (its PLATFORM_FEE_RECIPIENT). There
  // is NO setter of ANY kind on rewards — no legacy `setPlatformFeeRecipient`,
  // no one-shot `wireFeeRecipient` — so the rewards admin role grants authority
  // over operational knobs only, NEVER over any fee recipient. (The recipient's
  // immutability/non-admin-authority itself is pinned in test/next/DevFee.test.js.)
  // =========================================================================
  it("the rewards admin has no fee-recipient authority: no recipient getter, no setter, no wire path", async function () {
    const { rewards, owner } = await loadFixture(deploySatoriFixture);

    const admin = await rewards.admin();
    expect(admin).to.equal(owner.address);

    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // recipient is the token's immutable PLATFORM_FEE_RECIPIENT — rewards no
    // longer carries a recipient getter at all, so the old
    // `rewards.PLATFORM_FEE_RECIPIENT()` value assertion is dropped.
    expect(rewards.PLATFORM_FEE_RECIPIENT).to.equal(undefined);

    // There is NO setter of any kind on rewards — neither the legacy re-point
    // path nor the one-shot wire exists on the ABI or the runtime object.
    expect(rewards.setPlatformFeeRecipient).to.equal(undefined);
    expect(rewards.wireFeeRecipient).to.equal(undefined);
    const fnNames = rewards.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    expect(fnNames).to.not.include("setPlatformFeeRecipient");
    expect(fnNames).to.not.include("wireFeeRecipient");
    expect(fnNames).to.not.include("PLATFORM_FEE_RECIPIENT");
  });
});
