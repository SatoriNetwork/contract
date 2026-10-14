// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";

/// @notice Minimal adapter that records nothing but the `predictorPower` the
///         engine hands it, so a test can assert what an adapter actually
///         receives. Exists because every real adapter either ignores that
///         argument or folds it into a denominator, leaving no way to observe
///         the raw value.
contract PowerProbeGame is IPredictionGame {
    mapping(address => uint256) public lastPower;
    mapping(address => uint256) public callCount;

    function validateForStream(uint32, bytes calldata) external view override {}

    function record(
        address user,
        uint32,
        uint256 predictorPower,
        uint256,
        bytes calldata
    ) external override {
        lastPower[user] = predictorPower;
        callCount[user] += 1;
    }

    function score(address, uint32)
        external pure override
        returns (bool, uint256, uint256, uint256, uint256, uint64)
    {
        return (false, 0, 0, 0, 0, 0);
    }
}
