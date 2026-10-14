// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/**
 * @title Prediction-delegation conservation invariants
 * @notice VOTE DELEGATION IS GONE, along with everything this file used to
 *         check about it. Under burn voting there is no per-holder voting
 *         weight to delegate: weight is bought by DESTROYING tokens and is
 *         permanently welded to the game it was bought for. `voteDelegation`,
 *         `delegatedBalance`, `syncVoteDelegation` and the whole
 *         transfer-side re-weighting apparatus were deleted, because moving
 *         your remaining balance cannot move weight that was paid for with
 *         tokens which no longer exist. The vote-side conservation law they
 *         needed is superseded by Conservation INV-1b
 *         (`totalBurnedWeight == Σ enabled gameWeight`).
 *
 *         PREDICTION delegation survives unchanged and is what this file now
 *         covers. It is a genuine transfer of economic weight: a delegator's
 *         BALANCE is pooled behind their delegate, who predicts with it. That
 *         makes `predictionDelegateInfo[d].power` a live mirror of a sum of
 *         balances, and any drift in it silently creates or destroys prediction
 *         power — the same class of bug the old vote-delegation invariants
 *         guarded against, on the rail that still exists.
 *
 *         Burn voting makes these STRONGER, not weaker. A vote now shrinks the
 *         voter's balance, and `SatoriHub.vote` handles that by undelegating
 *         the voter, burning, and re-delegating them at their new smaller
 *         balance — rather than by inventing a shrink path through the pool
 *         accounting. INV-P1 is exactly the check that this round trip lands
 *         the delegate's power on the post-burn figure.
 */
contract DelegationInvariantTest is Test {
    Handler public handler;

    /// @dev Lane 0 == LANE_A, the prediction/delegation transfer lock. The
    ///      constant is `internal` on the hub, so it is restated here. (Lane 1,
    ///      the old voting lock, is retired — nothing writes it any more.)
    uint8 internal constant LANE_A = 0;

    function setUp() public {
        handler = new Handler();
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------
    // INV-D1 REMOVED: `delegatedBalance[d] == Σ balanceOf(u) where
    //        voteDelegation[u] == d`. Vote delegation no longer exists —
    //        neither mapping, neither event, and no sync path on transfer —
    //        so there is no drift left to detect. There is no direct successor
    //        because the quantity it conserved (delegated VOTING power) is not
    //        a quantity the protocol tracks any more; the weight-side
    //        conservation law is now Conservation INV-1b, and the supply-side
    //        one is Conservation INV-1.
    //
    //        INV-D3's vote half is removed for the same reason: there is no
    //        `voteDelegation[u]` left to canonicalize. Its prediction half
    //        survives as INV-P2 below.
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // INV-P1: For every potential prediction-delegate `d`,
    //         `predictionDelegateInfo[d].power` equals the sum of
    //         `balanceOf(u)` over every `u` where `predictionDelegate[u]
    //         == d`. Catches drift in the lazy sync paths on transfer or
    //         delegate-rotation — and now also in the undelegate/burn/
    //         re-delegate round trip that `SatoriHub.vote` performs, which is
    //         the only path where a delegator's balance can shrink.
    // ------------------------------------------------------------------
    function invariant_predictionDelegatedPowerConservation() public view {
        uint256 n = handler.touchedAddressesLength();
        for (uint256 i = 0; i < n; i++) {
            address d = handler.touchedAddresses(i);
            uint256 expected = 0;
            for (uint256 j = 0; j < n; j++) {
                address u = handler.touchedAddresses(j);
                (address ud, ) = handler.rewards().predictionDelegateInfo(u);
                if (ud == d) {
                    expected += handler.satori().balanceOf(u);
                }
            }
            (, uint96 actualPower) = handler.rewards().predictionDelegateInfo(d);
            assertEq(
                uint256(actualPower),
                expected,
                "delegatedPredictionPower must equal sum of balances of predictors delegating here"
            );
        }
    }

    // ------------------------------------------------------------------
    // INV-P2: Self-delegate canonicalization. The contract stores a
    //         "default / self" delegate as `address(0)`; an explicit
    //         self-delegation (`delegatePredictionPower(msg.sender)`) gets
    //         normalized to zero at write time — in two places, the hub and
    //         again defensively at the top of
    //         `SatoriRewards.delegatePredictionPower`. So for any touched
    //         user `u`, `predictionDelegate[u]` must NEVER equal `u`.
    //
    //         This is what makes `getPredictionPower`'s single branch
    //         ("delegate != 0 means you have no power of your own") correct: a
    //         stored self-delegation would read as delegated-away and zero out
    //         a user's own prediction power.
    // ------------------------------------------------------------------
    function invariant_delegateNeverSelf() public view {
        uint256 n = handler.touchedAddressesLength();
        for (uint256 i = 0; i < n; i++) {
            address u = handler.touchedAddresses(i);
            (address pdU, ) = handler.rewards().predictionDelegateInfo(u);
            assertTrue(
                pdU != u,
                "predictionDelegate[u] must not equal u (self-delegate canonicalizes to zero)"
            );
        }
    }

    // ------------------------------------------------------------------
    // INV-P3: While a user is prediction-delegated to someone else,
    //         their lane-A lock must be the sentinel `LOCK_INDEFINITE`
    //         (= type(uint24).max). Catches a delegate-set path that forgets to
    //         apply the lock, which would let a delegator transfer/spend tokens
    //         that are supposed to be staked behind their delegate. (The
    //         indefinite lock lives on the token and is set via
    //         hub.lockUntilUndelegation -> LANE_A.)
    //
    //         `SatoriHub.vote` lowers this lock for exactly the length of its
    //         burn and restores it in the same transaction, so the gap is never
    //         observable here — which is the point of checking it: a vote that
    //         forgot to restore the lock, or that re-delegated without
    //         re-applying it, would leave a delegator free to move tokens their
    //         delegate is still predicting with.
    // ------------------------------------------------------------------
    function invariant_lockSentinelWhileDelegated() public view {
        uint256 n = handler.touchedAddressesLength();
        uint256 sentinel = uint256(handler.satoriToken().LOCK_INDEFINITE());
        for (uint256 i = 0; i < n; i++) {
            address u = handler.touchedAddresses(i);
            (address d, ) = handler.rewards().predictionDelegateInfo(u);
            if (d != address(0) && d != u) {
                // u is delegated to someone else
                assertEq(
                    uint256(handler.satoriToken().lockUntil(u, LANE_A)),
                    sentinel,
                    "lane-A lock must be the sentinel while prediction-delegated"
                );
            }
        }
    }
}
