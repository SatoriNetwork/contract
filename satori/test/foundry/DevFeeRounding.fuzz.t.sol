// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/next/SatoriToken.sol";

/**
 * @title Dev-fee rounding, fuzzed on the real token
 * @notice `accrueRewards` books `ceil(general * bps / (10000 - bps))` as the dev
 *         fee. Two properties of that rounding, checked on the deployed token
 *         across every amount the reward ceiling allows:
 *           1. the fee is never short of the dev's exact share of the gross and
 *              is less than one wei over it;
 *           2. splitting a report cannot lower the fee.
 *         ConservationArithmetic.halmos.t.sol states the same two as symbolic
 *         proofs (check_feeNeverShortAndUnderAWeiOver, check_splittingNeverLowersFee);
 *         both time out in Halmos (z3, 180 s, even at 32-bit inputs), so this file
 *         is what covers them.
 */
contract DevFeeRoundingFuzzTest is Test {
    address internal constant DEV = address(0xDE7);

    function _deploy() internal returns (SatoriToken t) {
        t = new SatoriToken(address(this), DEV, block.chainid);
        t.setController(address(this));
    }

    /// Largest general amount whose report (general + fee) fits the ceiling.
    function _room(SatoriToken t) internal view returns (uint256) {
        uint256 bps = t.devFeeBps();
        uint256 left = t.rewardCeiling() - t.generalAccrued() - t.devFeeAccrued();
        return left * (10000 - bps) / 10000 - 2;
    }

    /// forge-config: default.fuzz.runs = 20000
    function testFuzz_feeNeverShortAndUnderAWeiOver(uint256 general) public {
        SatoriToken t = _deploy();
        uint256 bps = t.devFeeBps();
        vm.warp(block.timestamp + 3650 days);
        general = bound(general, 0, _room(t));
        uint256 before = t.devFeeAccrued();
        (, uint256 fee) = t.accrueRewards(general);
        uint256 residual = 10000 - bps;
        assertGe(fee * residual, general * bps, "fee short of the dev's share");
        assertLt(fee * residual, general * bps + residual, "fee a wei or more over the dev's share");
        assertEq(t.devFeeAccrued() - before, fee);
    }

    /// forge-config: default.fuzz.runs = 20000
    /// The reward ceiling is measured from each token's own deployment, so the
    /// two tokens are deployed first and warped together.
    function testFuzz_splittingNeverLowersFee(uint256 a, uint256 b) public {
        SatoriToken split = _deploy();
        SatoriToken whole = _deploy();
        vm.warp(block.timestamp + 3650 days);
        uint256 room = _room(split);
        a = bound(a, 0, room / 2);
        b = bound(b, 0, room / 2);
        (, uint256 feeA) = split.accrueRewards(a);
        (, uint256 feeB) = split.accrueRewards(b);
        (, uint256 feeWhole) = whole.accrueRewards(a + b);
        assertGe(feeA + feeB, feeWhole, "splitting a report lowered the fee");
    }
}
