// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IRegistryForLens {
    function streamExists(uint32 streamId) external view returns (bool);
    function getValueAtHour(uint32 streamId, uint256 hour) external view returns (int256);
}
