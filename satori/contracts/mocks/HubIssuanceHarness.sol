// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../next/SatoriHub.sol";

/// @dev TEST-ONLY harness. Moves the emission schedule's issuance counter
///      without reporting to the token, so the schedule's step logic (ladder,
///      ratio, clamps, read model) can be driven past thresholds that real
///      issuance — bounded by the token's 1440 x rounds envelope — would take
///      years to reach. Adds NO storage, so it is a valid in-place upgrade of
///      a test hub proxy. The production path (a score reported to the token,
///      issued == the token's accrued total) is covered without it.
///      Not for production.
contract HubIssuanceHarness is SatoriHub {
    constructor(
        address _token, address _engine, address _voting, address _rewards,
        address _registry, address _games, address _bounties
    ) SatoriHub(_token, _engine, _voting, _rewards, _registry, _games, _bounties) {}

    /// The pre-M03 `noteIssued` counter step: `general` grossed up at the live
    /// fee, rounded up as the token rounds its fee, then any steps crossed.
    function testNoteIssued(uint256 general) external {
        uint256 bps = token.devFeeBps();
        uint256 old = emission.issued;
        uint256 n = old + (general * 10000 + (10000 - bps) - 1) / (10000 - bps);
        if (n >= NO_STEP) n = NO_STEP - 1;
        emission.issued = uint128(n);
        emit EmissionIssued(n - old, n);
        _applySteps();
    }
}
