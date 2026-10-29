// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/// Drives organic scoring through the handler's own actions, with no issuance
/// bump, so the `issued` ghost and its RewardSplit cross-check are shown to see
/// real commits rather than only the fuzz-only `bumpIssued`.
contract EmissionGhostTest is Test {
    Handler public handler;

    function setUp() public {
        handler = new Handler();
    }

    function _issued() internal view returns (uint256 issued) {
        (issued, , , , , , , ) = handler.satori().emission();
    }

    /// Actors 0 and 2 predict opposite directions on the adapter stream's binary
    /// game each cycle, so one side wins; actors 1 and 3 delegate to them.
    function _play(uint256 cycles) internal {
        for (uint256 a = 0; a < 4; a++) handler.voteAdapterStreamGame(a, 1 ether);
        handler.delegatePrediction(1, 0);
        handler.delegatePrediction(3, 2);
        int128 v = 100;
        for (uint256 i = 0; i < cycles; i++) {
            handler.advanceTime(49 hours);
            handler.updateAdapterValue(v);
            handler.predict(0, 1, 0);
            handler.predict(2, 1, 1);
            handler.advanceTime(49 hours);
            handler.updateAdapterValue(v + 10);
            handler.advanceTime(49 hours);
            handler.updateAdapterValue(v + 20);
            handler.settlePrediction(0, 1);
            handler.settlePrediction(2, 1);
            v += 30;
        }
    }

    function test_organicScoringIsGhosted() public {
        _play(8);
        assertEq(handler.callCount_bumpIssued(), 0);
        assertGt(handler.ghostNoteIssuedCalls(), 0, "a winning score must reach noteIssued");
        assertGt(handler.ghostSplitsMatched(), 0, "a delegated win must emit a RewardSplit matched to noteIssued");
        assertEq(handler.ghostSplitMismatch(), 0);
        assertGt(_issued(), handler.satoriToken().INITIAL_MINT(), "organic issuance must move the counter");
        assertEq(_issued(), handler.ghostIssued());
    }

    function test_committedDelegatorShareIsGhosted() public {
        _play(12);
        assertGt(handler.ghostSplitsWithDelegatorShare(), 0, "a W != 0 round must commit the delegator share");
        assertEq(handler.ghostSplitMismatch(), 0);
        assertEq(_issued(), handler.ghostIssued());
    }

    function test_reserveBankIsGhosted() public {
        handler.setOffchainShare(5000);
        handler.advanceTime(3 days);
        handler.syncEmission();
        handler.merkleMint(0, 1);
        assertGt(handler.ghostReserveBanks(), 0, "the share must bank reserve");
        assertGt(handler.callCount_merkleMint(), 0);
        assertEq(_issued(), handler.ghostIssued());
    }
}
