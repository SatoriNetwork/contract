// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";
import "../interfaces/ISatoriCore.sol";

/// @dev Partial-credit adapter for the score/total model (capability B7).
///
///      Every predictor is a WINNER with a per-user ACCURACY in [1, 255],
///      supplied as the first payload byte. Unlike YesNoGame (accuracy is a
///      flat 0/1), this adapter returns the FULL accuracy as `userScore`, so:
///        - the SATORI rail uses multiplier 1 and accumulates
///          `total = Σ accuracy` over the round (score/total: each winner draws
///          accuracy/total of the game pool, Σ == one pool);
///        - the BOUNTY rail accumulates `bountyTotal = Σ accuracy × stake` over
///          the round, so the protocol pays pot × (accuracy × stake)/bountyTotal.
///
///      This makes the bounty split ACCURACY × STAKE weighted: with equal stakes
///      but accuracy 3 vs 1 the two winners split the pot 3:1 — NOT the 1:1 that
///      a pure stake split (numerator == stake) would give. The mock exists to
///      prove `creditAdapterBounty` uses `userScore × stake` as the numerator.
contract PartialCreditGame is IPredictionGame {
    address public immutable core;

    // Per (game, user) open bet: the round it was made in and the accuracy.
    mapping(uint32 => mapping(address => uint64)) public pendingRound;
    mapping(uint32 => mapping(address => uint256)) public pendingAcc;

    // Per (game, round) running denominators.
    mapping(uint32 => mapping(uint64 => uint256)) public total;        // Σ accuracy (SATORI)
    mapping(uint32 => mapping(uint64 => uint256)) public bountyTotalR; // Σ accuracy × stake

    error InvalidAccuracy();

    constructor(address _core) { core = _core; }

    function validateForStream(uint32, bytes calldata) external view override {}

    function record(
        address user,
        uint32 gameId,
        uint256 /*predictorPower*/,
        uint256 bountyStake,
        bytes calldata payload
    ) external override {
        if (payload.length == 0) revert InvalidAccuracy();
        uint256 acc = uint256(uint8(payload[0]));
        if (acc == 0) revert InvalidAccuracy(); // accuracy in [1, 255]

        uint64 r = uint64(ISatoriCore(core).getCurrentRound());
        pendingRound[gameId][user] = r;
        pendingAcc[gameId][user] = acc;

        // SATORI rail: multiplier 1, so the user's numerator is `acc`.
        total[gameId][r] += acc;
        // Bounty rail: accuracy × stake.
        bountyTotalR[gameId][r] += acc * bountyStake;
    }

    function score(address user, uint32 gameId)
        external override
        returns (bool scored, uint256 userScore, uint256 multiplier, uint256 total_, uint256 bountyTotal, uint64 roundIndex)
    {
        uint64 r = pendingRound[gameId][user];
        if (r == 0) return (false, 0, 0, 0, 0, 0);
        uint64 cur = uint64(ISatoriCore(core).getCurrentRound());
        if (cur <= r) return (false, 0, 0, 0, 0, 0); // not ready — still pending

        uint256 acc = pendingAcc[gameId][user];
        delete pendingRound[gameId][user];
        delete pendingAcc[gameId][user];

        // Everyone wins with their own accuracy; multiplier 1 (so the protocol
        // pays on userScore × 1 == acc). `total` already folds the multiplier
        // (Σ acc), so each winner draws acc/total of the pool. bountyTotal is
        // Σ acc × stake — the protocol pays pot × (acc × stake)/bountyTotal.
        return (true, acc, 1, total[gameId][r], bountyTotalR[gameId][r], r);
    }
}
