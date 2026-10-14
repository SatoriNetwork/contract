// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../SatoriRewardsLens.sol";

/// @dev TEST-ONLY harness. Shrinks the delegator pending-walk budget so the
///      F28/F29 cap-and-flag behavior can be exercised without generating
///      thousands of rounds. Not for production.
contract LensCapHarness is SatoriRewardsLens {
    uint256 private immutable _cap;

    constructor(address _satoriCore, address _rewards, uint256 cap)
        SatoriRewardsLens(_satoriCore, _rewards)
    {
        _cap = cap;
    }

    function _maxLensRounds() internal view override returns (uint256) {
        return _cap;
    }
}
