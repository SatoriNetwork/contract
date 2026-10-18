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

    // This used to carry a MARKETING_FEE_RECIPIENT immutable purely so the impl
    // would pass SatoriRewards._validateNewImplementation, which pinned that
    // value. The recipient is proxy storage now, that pin is gone, and so is the
    // constructor arg — an upgrade cannot re-point the recipient by carrying a
    // different bytecode value, so there is nothing left to satisfy.

    /// Never consulted at install time (the OUTGOING implementation's
    /// `_upgradeGovernor` gates `upgradeTo`); present only to satisfy the base.

    function _upgradeGovernor() internal pure override returns (address) {
        return address(0);
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
    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriVoting");
    }
}

contract RevertingRewardsImpl is RevertingUUPSChild {
    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriRewards");
    }
}
