// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../next/SatoriUUPS.sol";

/// TEST-ONLY. A UUPS-installable child implementation whose delegation-sync
/// hooks REVERT in-body. Installed on a child's own proxy via `upgradeTo` to
/// exercise SatoriHub.onTokenTransfer's per-child try/catch resilience
/// (ChildSyncFailed) — proving a child upgraded to an implementation whose sync
/// reverts with a reason cannot brick token transfers. A reasonless failure is
/// not swallowed: it reverts the transfer (DelegationSyncGas.test.js).
/// Replaces the old `setChild(0/1, RevertingChild)` wholesale-swap mechanism
/// (removed with setChild, audit F3): the realistic failure mode is now a bad
/// in-place upgrade, which this reproduces exactly (same proxy, same address).
abstract contract RevertingUUPSChild is SatoriUUPS {
    error ChildBroken();

    /// `upgradeTo` asks the NEW code who may upgrade (G05), so the candidate has
    /// to name the real governor; baked in as an immutable because a bare
    /// implementation has no token pointer in the proxy's storage layout.
    address private immutable GOVERNOR;

    constructor(address governor_) {
        GOVERNOR = governor_;
    }

    function _upgradeGovernor() internal view override returns (address) {
        return GOVERNOR;
    }

    function syncPredictionDelegation(address, address, uint256) external pure {
        revert ChildBroken();
    }
}

/// SatoriUUPS.upgradeTo now pins the candidate's compile-time identity, so a
/// broken implementation can only be installed onto the proxy it genuinely is.
/// That is the point of the pin — a Rewards proxy accepts only a Rewards impl —
/// so the mock is specialised per target rather than being universally
/// installable, which is exactly the property that is no longer allowed.
contract RevertingVotingImpl is RevertingUUPSChild {
    constructor(address governor_) RevertingUUPSChild(governor_) {}

    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriVoting");
    }
}

contract RevertingRewardsImpl is RevertingUUPSChild {
    constructor(address governor_) RevertingUUPSChild(governor_) {}

    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriRewards");
    }
}
