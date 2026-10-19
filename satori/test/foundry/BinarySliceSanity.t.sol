// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/// Sanity (non-invariant) test: the handler's split-round scenario really
/// reaches what Rewards.invariant.t.sol INV-R5/INV-R6 and
/// Bounty.invariant.t.sol INV-B4 check, so they test a reachable state rather
/// than an empty set.
contract BinarySliceSanityTest is Test {
    Handler public handler;

    function setUp() public {
        handler = new Handler();
    }

    function test_weightedSplitRoundPaysBothSidesWithinSlice() public {
        handler.splitRoundScenario(0, 1 ether + 1);
        uint32 g = handler.splitGameId();
        uint256 r = handler.lastSplitRound();
        assertEq(handler.ghostBinaryCreditCount(g, r), 2, "both the UP and the DOWN won and were credited");
        assertGt(handler.gameSlice(g, r), 0, "the game had a slice");
        assertLe(handler.ghostBinaryCredited(g, r), handler.gameSlice(g, r), "credited within the slice");
        assertEq(handler.ghostScoredInOwnRound(), 0, "the in-round settles scored nothing");
    }

    function test_unweightedSplitRoundPaysBothBoostersWithinPot() public {
        handler.splitRoundScenario(0, 2); // wins the UP and DOWN a streak, so they boost next time
        address tk = address(handler.bountyToken());
        address up = handler.actors(0);
        address down = handler.actors(1);
        uint256 upBefore = handler.bounties().bountyStake(up, tk);
        uint256 downBefore = handler.bounties().bountyStake(down, tk);
        handler.splitRoundScenario(0, 2);
        uint32 g = handler.bountyGameId();
        uint32 r = uint32(handler.lastSplitRound());
        assertGt(handler.bounties().bountyStake(up, tk), upBefore + 100 ether, "the UP booster was paid on top of its new 100 stake");
        assertGt(handler.bounties().bountyStake(down, tk), downBefore + 100 ether, "the DOWN booster was paid on top of its new 100 stake");
        uint256 pot = handler.bounties().roundBountyPot(g, r, tk);
        uint256 claimed = handler.bounties().roundBountyPotClaimed(g, r, tk);
        assertGt(pot, 0, "the round drew a pot");
        assertLe(claimed, pot, "claimed within the pot");
        assertGe(claimed + 2, pot, "both boosters won and shared the whole pot");
        assertEq(handler.ghostScoredInOwnRound(), 0, "the in-round settles scored nothing");
    }
}
