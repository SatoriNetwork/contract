// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITokenForLens {
    function getCurrentRound() external view returns (uint256);
    function deploymentRound() external view returns (uint256);
    function devFeeBps() external view returns (uint256);
    function generalAccrued() external view returns (uint256);
    function lockUntil(address user, uint8 lane) external view returns (uint24);
    function transferLockedUntil(address user) external view returns (uint24);
}
