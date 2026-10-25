// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IHubForLens {
    function emissionCeiling() external view returns (uint256);
    function token() external view returns (address);
    function registry() external view returns (address);
    function voting() external view returns (address);
    function rewards() external view returns (address);
    function bounties() external view returns (address);
    function games() external view returns (address);
    function merkle() external view returns (address);
    function merkleReserveCeiling() external view returns (uint256);
    function merkleReserveCumulative() external view returns (uint256);
    function emission() external view returns (
        uint128 issued, uint128 nextStepAt, uint128 rate, uint128 prevRate,
        uint64 from, uint64 ratioWad, uint32 stepsTaken, uint256 banked
    );
    function emissionRateNext() external view returns (uint256);
    function residualNext() external view returns (uint256);
    function emissionHolder() external view returns (address);
}
