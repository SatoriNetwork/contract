// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";
import "../interfaces/ISatoriCore.sol";

/// @dev Adversarial adapter for the score/total model. Each user announces
///      `total == their OWN userScore` AND `multiplier == uint256.max`, trying to
///      claim `pool × w/w == the FULL pool` for EVERY predictor and to overflow
///      the `userScore × multiplier` numerator (the analogue of the old
///      singleton-bucket attack, now also stressing the step-2 multiplier). The
///      protocol's first-scorer total-pin + SATURATING multiply + running-sum cap
///      defeat it: the first scorer pins `total = w1`, the saturating numerator is
///      clamped to the pinned total, the running sum immediately reaches `total`,
///      and every later predictor is clamped to 0 — so exactly ONE pool is minted,
///      not N, with no overflow revert. Used to prove conservation holds.
contract EveryoneWinsGame is IPredictionGame {
    address public immutable core;
    mapping(uint32 => mapping(address => uint64))  public pendingRound;
    mapping(uint32 => mapping(address => uint256)) public pendingWeight;

    constructor(address _core) { core = _core; }

    function validateForStream(uint32, bytes calldata) external view override {}

    function record(address user, uint32 gameId, uint256 predictionPower, uint256, bytes calldata)
        external override
    {
        pendingWeight[gameId][user] = predictionPower;
        pendingRound[gameId][user] = uint64(ISatoriCore(core).getCurrentRound());
    }

    function score(address user, uint32 gameId)
        external override returns (bool scored, uint256 userScore, uint256 multiplier, uint256 total, uint256 bountyTotal, uint64 roundIndex)
    {
        uint64 r = pendingRound[gameId][user];
        if (r == 0) return (false, 0, 0, 0, 0, 0);
        uint64 cur = uint64(ISatoriCore(core).getCurrentRound());
        if (cur <= r) return (false, 0, 0, 0, 0, 0);
        uint256 w = pendingWeight[gameId][user];
        delete pendingRound[gameId][user];
        delete pendingWeight[gameId][user];
        // ATTACK (3 vectors at once): total == own score → pool × w/w == full pool
        // per user; multiplier == uint256.max → userScore × multiplier overflows,
        // trying to inflate the SATORI share past the pool; AND bountyTotal == 1
        // while userScore (== w) × stake can be huge → tries to over-pay the bounty
        // pot per user. The protocol pins the FIRST scorer's total/bountyTotal,
        // computes both numerators SATURATING, and caps the running paid — so
        // exactly ONE SATORI pool and ONE bounty pot pay, no overflow revert.
        return (true, w, type(uint256).max, w, 1, r);
    }
}
