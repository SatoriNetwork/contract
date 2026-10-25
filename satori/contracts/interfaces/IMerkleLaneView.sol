// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// The hub's merkle-lane accounting, as this contract reads it to size a
/// partial claim: `merkleReserveCeiling()` is the lane's accrual-adjusted
/// ceiling and `merkleMinted` what the lane has already minted — their
/// difference is the headroom the hub's merkle branch accepts once it has
/// banked the reserve due by the next round.
interface IMerkleLaneView {
    function merkleReserveCeiling() external view returns (uint256);
    function merkleMinted() external view returns (uint256);
}
