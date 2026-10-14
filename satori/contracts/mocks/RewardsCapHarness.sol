// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../SatoriRewards.sol";

/// @dev TEST-ONLY harness. Overrides the delegator per-call round budget to a
///      tiny value so the F6 replay cap + cursor resumption can be exercised
///      without generating thousands of rounds. Adds NO storage (same layout as
///      SatoriRewards), so it is a valid storage-preserving UUPS upgrade target.
///      Not for production.
contract RewardsCapHarness is SatoriRewards {
    constructor(address _voting, address _admin, address _marketingFeeRecipient)
        SatoriRewards(_voting, _admin, _marketingFeeRecipient)
    {}

    function _maxDelegatorRoundsPerCall() internal view override returns (uint256) {
        return 2;
    }
}
