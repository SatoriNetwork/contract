// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";
import "../interfaces/ISatoriCore.sol";

/// @dev Test helper (audit F51): a winning adapter bet that reports multiplier
///      ZERO. Proves the SATORI rail no longer floors a 0 multiplier at 1 — a
///      multiplier-0 bet now earns 0 (consistent with the binary path), instead
///      of a phantom accuracy share. Otherwise identical to PartialCreditGame.
contract ZeroMultiplierGame is IPredictionGame {
    address public immutable core;
    mapping(uint32 => mapping(address => uint64)) public pendingRound;
    mapping(uint32 => mapping(address => uint256)) public pendingAcc;
    mapping(uint32 => mapping(uint64 => uint256)) public total;

    error InvalidAccuracy();

    constructor(address _core) { core = _core; }

    function validateForStream(uint32, bytes calldata) external view override {}

    function record(address user, uint32 gameId, uint256, uint256, bytes calldata payload) external override {
        if (payload.length == 0) revert InvalidAccuracy();
        uint256 acc = uint256(uint8(payload[0]));
        if (acc == 0) revert InvalidAccuracy();
        uint64 r = uint64(ISatoriCore(core).getCurrentRound());
        pendingRound[gameId][user] = r;
        pendingAcc[gameId][user] = acc;
        total[gameId][r] += acc;
    }

    function score(address user, uint32 gameId)
        external override
        returns (bool scored, uint256 userScore, uint256 multiplier, uint256 total_, uint256 bountyTotal, uint64 roundIndex)
    {
        uint64 r = pendingRound[gameId][user];
        if (r == 0) return (false, 0, 0, 0, 0, 0);
        uint64 cur = uint64(ISatoriCore(core).getCurrentRound());
        if (cur <= r) return (false, 0, 0, 0, 0, 0);
        uint256 acc = pendingAcc[gameId][user];
        delete pendingRound[gameId][user];
        delete pendingAcc[gameId][user];
        // multiplier ZERO: post-F51, numerator = acc × 0 = 0 -> earns nothing.
        return (true, acc, 0, total[gameId][r], 0, r);
    }
}
