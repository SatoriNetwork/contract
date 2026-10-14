// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/**
 * @title Cursor monotonicity invariants
 * @notice The protocol has several forward-only cursors / counters. A bug
 *         that lets one retreat would either skip rewards (cursor moved
 *         past unclaimed state) or double-credit (cursor moved back).
 */
contract CursorsInvariantTest is Test {
    Handler public handler;

    // Track the previous-observation high-water mark of each cursor we care about.
    uint32 public lastNextStreamId;

    function setUp() public {
        handler = new Handler();
        targetContract(address(handler));
        lastNextStreamId = handler.registry().nextStreamId();
    }

    // ------------------------------------------------------------------
    // INV-6: nextStreamId monotonically non-decreasing. Streams are
    //        permanent — IDs never recycle.
    // ------------------------------------------------------------------
    function invariant_nextStreamIdMonotonic() public {
        uint32 cur = handler.registry().nextStreamId();
        assertGe(cur, lastNextStreamId, "nextStreamId must never decrease");
        lastNextStreamId = cur;
    }

    // ------------------------------------------------------------------
    // INV-7 REMOVED: lastClaimUndelegationRound monotonicity.
    //
    // The capability this invariant guarded no longer exists. Claim
    // delegation was reworked into a pure authorization mapping
    // (`SatoriRewards.claimDelegateInfo` is now `mapping(address => address)`,
    // returning only the delegate). The contract comment is explicit: claim
    // delegation now has "no cooldown, no economic weight transfer — pure
    // authorization." There is no `lastClaimUndelegationRound` field/cursor
    // anymore, so there is nothing to assert monotonic on. Removed rather
    // than re-pointed because no current state encodes a claim-undelegation
    // cooldown round.
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // INV-8: deploymentRound is immutable. Set once at deploy, never
    //        mutated. (Sanity check; if a refactor accidentally exposes
    //        a setter, this catches it immediately.)
    // ------------------------------------------------------------------
    uint256 public initialDeploymentRound;
    bool public initialDeploymentRoundSet;

    function invariant_deploymentRoundImmutable() public {
        uint256 cur = handler.satori().deploymentRound();
        if (!initialDeploymentRoundSet) {
            initialDeploymentRound = cur;
            initialDeploymentRoundSet = true;
        }
        assertEq(cur, initialDeploymentRound, "deploymentRound must be immutable");
    }

    // ------------------------------------------------------------------
    // INV-9: pendingRoundsCount accurately reflects rounds with
    //        non-zero globalPendingCount. The slack reservation depends
    //        on this; drift would over- or under-reserve.
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // INV-10: `lastProtocolAccrualRound` on SatoriRewards is monotone
    //         non-decreasing. Backward motion would re-accrue an already
    //         credited window, double-counting fees. Becomes load-bearing
    //         after the slack fix that now calls `accrueProtocolFee` from
    //         `claimSlack`.
    // ------------------------------------------------------------------
    uint256 public lastProtocolAccrualHighWater;

    // (Removed 2026-08-31: invariant_lastProtocolAccrualMonotonic.
    //
    //  It read the accrual cursor out of `feeSlot()`. That slot went inert when
    //  the platform fee moved to the immutable SatoriToken, so the cursor has
    //  been 0 on every run since — the assertion was assertGe(0, 0), passing
    //  vacuously while appearing to guard a monotonic cursor. Deleted with the
    //  storage it watched rather than re-pointed: the protocol fee is now the
    //  token's senior carve-out, pulled by `token.mintDevFee()`, and has no
    //  cursor in this contract to be monotonic about.)

    // ------------------------------------------------------------------
    // INV-11: `nextStreamId` and `getDataStreamCount` agree. The first
    //         is the next-id-to-issue counter; the second is the count
    //         of created streams. They differ by exactly 1 because IDs
    //         are 1-indexed.
    // ------------------------------------------------------------------
    function invariant_streamCountAgreesWithNextId() public view {
        uint256 count = handler.registry().getDataStreamCount();
        uint256 nextId = uint256(handler.registry().nextStreamId());
        assertEq(count + 1, nextId, "getDataStreamCount + 1 must equal nextStreamId");
    }
}
