// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";

/// @title Streak-curve mirror: concrete S-curve anchors + symbolic below-bar monotonicity.
/// @notice The streak curve in SatoriEngine._streakWeight is private, so we mirror it here.
///         Under the payout curve (design: docs/design/payout-curve-redesign.md) the
///         multiplier is the tunable rational S-curve W(s,h,g,r,b)·SCALE, where h = the floored
///         adaptive bar and g/r/b are the governor dials (above-bar gradient / below-bar
///         gradient / above-bar lift). This file tests _streakWeight as a general function of
///         (s,h,g,r,b):
///           s == 0   → first ? 1 : 0                                        (kept hook — call site)
///           s <  h   → SCALE·h·s / ((r+1)·(h + r·(h − s)))                  (convex dust ramp; W(0)=0)
///           s >= h   → SCALE·h·((s−h)(g²+g+1)+g·h) / ((g+1)(s+h(g−1))) + b·SCALE   (saturating top)
///         Anchors W(0)=0 (any r), W(h)=h/(g+1)+b. This file mirrors `_streakWeight` for the
///         concrete anchor asserts and proves below-bar monotonicity symbolically (via a
///         cross-multiplied, division-free inequality Halmos can discharge). The mirror must
///         stay in sync with SatoriEngine — see test/StreakMultiplier.test.js for the JS
///         equivalent + the monotonicity fuzz that pins both against the live contract.
contract StreakMonotonicityHalmos is Test {
    uint256 internal constant SCALE = 1_000_000; // CURVE_SCALE — cancels in the normalized payout

    /// Mirror of SatoriEngine._streakWeight: the tunable rational S-curve W(s,h,g,r,b)·SCALE.
    /// Only mul/div — no sqrt, so it IS forge-runnable and (below the bar) Halmos-decidable.
    function _streakWeight(uint256 s, uint256 h, uint256 g, uint256 r, uint256 b) internal pure returns (uint256) {
        if (s < h) {
            return (SCALE * h * s) / ((r + 1) * (h + r * (h - s)));
        }
        return (SCALE * h * ((s - h) * (g * g + g + 1) + g * h)) / ((g + 1) * (s + h * (g - 1))) + b * SCALE;
    }

    // ------------------------------------------------------------------
    // Concrete (forge-runnable) anchors + boundary values of the S-curve.
    // ------------------------------------------------------------------

    /// The bar anchor W(h) = h/(g+1) + b holds for arbitrary dials (r >= g).
    function test_anchors() public pure {
        assertEq(_streakWeight(12, 12, 3, 3, 0), SCALE * 12 / 4);              // defaults → 3.0
        assertEq(_streakWeight(12, 12, 3, 3, 2), SCALE * 12 / 4 + 2 * SCALE); // + b=2 → 5.0
        assertEq(_streakWeight(4, 4, 3, 3, 0),  SCALE * 4 / 4);               // 1.0
        assertEq(_streakWeight(8, 8, 2, 5, 1),  SCALE * 8 / 3 + SCALE);       // h/(g+1)+b (g=2,b=1)
        assertEq(_streakWeight(30, 30, 4, 8, 0), SCALE * 30 / 5);             // g=4 → 6.0
    }

    /// Interior boundary values at the defaults (g=3,r=3,b=0), ×SCALE, exercising both branches.
    function test_interiorBoundaries() public pure {
        // below-bar dust (unchanged from the prior curve at r=3): SCALE·h·s/((r+1)(h+r(h−s)))
        assertEq(_streakWeight(3, 12, 3, 3, 0),  230769);    // 0.231
        assertEq(_streakWeight(6, 12, 3, 3, 0),  600000);    // 0.60
        assertEq(_streakWeight(9, 12, 3, 3, 0),  1285714);   // 1.286
        // above-bar saturating top: SCALE·h·((s−h)(g²+g+1)+g·h)/((g+1)(s+h(g−1)))
        assertEq(_streakWeight(18, 12, 3, 3, 0), 8142857);   // 8.143
        assertEq(_streakWeight(24, 12, 3, 3, 0), 12000000);  // 12.0
    }

    /// The S-curve never overruns the 48-bit PR_MULT multiplier field. With g ≤ 8 the max
    /// value is the asymptote h·(g²+g+1)/(g+1)+b, ≈ 16383·73/9 ≈ 132,900·SCALE ≈ 1.3e11 at the
    /// extreme — still ≪ 2⁴⁸. Max-streak/max-dial evaluations stay far under the field.
    function test_fitsMultiplierField() public pure {
        assertLt(_streakWeight(16383, 16383, 8, 8, 64), uint256(1) << 48);
        assertLt(_streakWeight(16383, 4, 8, 8, 64), uint256(1) << 48);
        assertLt(_streakWeight(16383, 2, 8, 64, 64), uint256(1) << 48);
    }

    // ------------------------------------------------------------------
    // Symbolic (Halmos) monotonicity of the below-bar (dust ramp) region.
    // ------------------------------------------------------------------

    /// Halmos: the below-bar dust ramp W_below(s) = SCALE·h·s/((r+1)(h+r(h−s))) is strictly
    /// monotonic in s for any r. Proven division-free by cross-multiplication: for 0 < a < b < h
    /// (so h+r(h−a), h+r(h−b) > 0), W(a) < W(b) ⟺ a·(h+r(h−b)) < b·(h+r(h−a)). The a·r·b and
    /// b·r·a terms cancel, so the claim reduces to a·h(1+r) < b·h(1+r) ⟺ a < b — linear, decidable.
    function check_belowBarMonotonic(uint256 a, uint256 b, uint256 h, uint256 r) public pure {
        vm.assume(0 < a && a < b && b < h && h <= 16383 && r <= 64);
        assert(a * (h + r * (h - b)) < b * (h + r * (h - a)));
    }

    // NOTE — the ABOVE-bar branch's monotonicity is a degree-2 rational inequality; rather
    // than lean on Halmos to discharge that, it (and the below→above stitch, and every
    // integer-truncation edge) is pinned by test/StreakMultiplier.test.js, which asserts the
    // committed multiplier is non-decreasing in streak across many (T, M) against the live
    // SatoriEngine curve. The concrete anchors above nail the exact W(T)/W(M) values.

    // ============================================================
    // Slack-formula symbolic checks. Mirrors the arithmetic shape of
    // Satori.claimSlack — proving the math is sound independent of
    // the cross-contract state that drives it.
    // ============================================================

    /// Standalone version of the slack-amount computation.
    function _slackAmount(uint256 expectedAtSafe, uint256 existing)
        internal pure returns (uint256)
    {
        if (expectedAtSafe <= existing) return 0;
        return expectedAtSafe - existing;
    }

    /// Halmos: when slack > 0, minting exactly `slack` brings existing up
    /// to expectedAtSafe — never above. When slack == 0, existing already
    /// meets or exceeds the schedule (nothing to mint).
    function check_slackPreservesConservation(uint256 e, uint256 x) public pure {
        uint256 s = _slackAmount(e, x);
        if (s > 0) {
            assert(s + x == e);
        } else {
            assert(x >= e);
        }
    }

    /// Halmos: slack is bounded by the gap — it cannot mint more than the
    /// schedule has unspent.
    function check_slackBoundedByGap(uint256 e, uint256 x) public pure {
        uint256 s = _slackAmount(e, x);
        if (e > x) {
            assert(s == e - x);
            assert(s <= e);
        } else {
            assert(s == 0);
        }
    }
}
