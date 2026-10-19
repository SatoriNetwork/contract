// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/**
 * @title Streak monotonicity invariants
 * @notice Streaks are only mutated inside `_applyScore`:
 *           - correct prediction: `streaks[user][stream]++`
 *           - wrong prediction:   `streaks[user][stream] = 0`
 *         Any other observed mutation (a streak that grew without a
 *         correct-prediction scoring, a streak that decreased to a
 *         non-zero value, etc.) is a bug — most likely a code path
 *         that touches `streaks` outside of `_applyScore`.
 */
contract StreaksInvariantTest is Test {
    Handler public handler;

    // Per-(user, stream) high-water mark observed in the previous invariant check.
    mapping(address => mapping(uint32 => uint256)) public lastStreak;

    function setUp() public {
        handler = new Handler();
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------
    // INV-S1: streak[user][stream] never exceeds the number of rounds
    //         that have elapsed since deployment. Each correct prediction
    //         takes at least one cadence period to settle (A-B-C window),
    //         so the streak can grow by at most one per cadence period.
    //         At cadence=1 (the minimum), max streak == rounds-elapsed.
    // ------------------------------------------------------------------
    function invariant_streakBoundedByElapsedRounds() public view {
        uint256 maxStreak = handler.satori().getCurrentRound() - handler.satori().deploymentRound() + 1;
        uint256 n = handler.touchedAddressesLength();
        uint32 gameCount = uint32(handler.games().gameCount());
        for (uint256 i = 0; i < n; i++) {
            address a = handler.touchedAddresses(i);
            for (uint32 s = 1; s <= gameCount; s++) {
                // `streaks` lives on the ENGINE (the prediction state/logic
                // half of the split), not on the hub facade.
                uint256 streak = handler.engine().streaks(a, s);
                assertLe(
                    streak,
                    maxStreak,
                    "streak cannot exceed rounds-since-deployment"
                );
            }
        }
    }

    // ------------------------------------------------------------------
    // INV-S2: Between invariant checkpoints, streak[user][stream] either
    //         increased (via one or more correct-prediction scorings),
    //         stayed the same (no scoring happened), or reset fully to 0
    //         (a wrong prediction was scored).
    //
    //         A backwards-but-not-to-zero motion (e.g. 5 → 3) means
    //         something other than `_applyScore` is touching `streaks` —
    //         a bug.
    //
    //         We don't enforce "+1 only" because the fuzzer can drive
    //         multiple scorings between checkpoints; legitimate +N
    //         transitions are possible.
    // ------------------------------------------------------------------
    function invariant_streakOnlyForwardOrResetToZero() public {
        uint256 n = handler.touchedAddressesLength();
        uint32 gameCount = uint32(handler.games().gameCount());
        for (uint256 i = 0; i < n; i++) {
            address a = handler.touchedAddresses(i);
            for (uint32 s = 1; s <= gameCount; s++) {
                uint256 cur = handler.engine().streaks(a, s);
                uint256 prev = lastStreak[a][s];
                if (cur != 0) {
                    // Non-zero current: must be >= prev. The only legitimate
                    // backwards motion is the full reset to 0.
                    assertGe(
                        cur,
                        prev,
                        "streak decreased to a non-zero value (only reset-to-zero is legal)"
                    );
                }
                lastStreak[a][s] = cur;
            }
        }
    }
}
