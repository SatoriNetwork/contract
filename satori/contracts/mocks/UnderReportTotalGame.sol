// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";
import "../interfaces/ISatoriCore.sol";

/// @dev Adversarial / community-grade adapter that UNDER-REPORTS the round's
///      SATORI denominator `total`. Every predictor of a round is scored a
///      WINNER with `userScore == their committed power` and `multiplier == 1`
///      (so each winner's numerator is their own power). But `total` is pinned
///      to the FIRST scorer's OWN power — i.e. `total == numerator_firstScorer`,
///      NOT Σ numerators over all winners.
///
///      Because the protocol PINS the first scorer's `total` for the whole
///      (game, round) and CAPS the running paid numerators at it (room =
///      total − paid), the first settler's numerator (== total) immediately
///      saturates `paid` to `roundTotal`. Every LATER rightful winner then hits
///      `paid >= roundTotal` and is CLAMPED to 0 — a pure SETTLE-ORDER CAPTURE:
///      the first settler takes ~the whole pool, later winners are stranded,
///      yet Σ payouts ≤ one pool (every conservation invariant still holds).
///
///      This documents the ACCEPTED conservation-only adapter trust boundary
///      (see SatoriRewards NatSpec ~L285-298: "the adapter owns ALL scoring
///      semantics but can never multiply the pool"). The protocol guarantees
///      Σ ≤ pool; it guarantees NOTHING about fairness when the adapter
///      mis-reports `total`. Official / admin-vetted adapters are the
///      mitigation; community adapters are caveat-emptor.
///
///      Contrast with the conservation-honest example adapter (YesNoGame), whose
///      `total == Σ winners' numerators`, so payouts are exact and
///      settle-order-independent.
contract UnderReportTotalGame is IPredictionGame {
    address public immutable core;

    mapping(uint32 => mapping(address => uint64))  public pendingRound;
    mapping(uint32 => mapping(address => uint256)) public pendingPower;

    constructor(address _core) { core = _core; }

    function validateForStream(uint32, bytes calldata) external view override {}

    function record(address user, uint32 gameId, uint256 predictionPower, uint256, bytes calldata)
        external override
    {
        uint64 r = uint64(ISatoriCore(core).getCurrentRound());
        pendingRound[gameId][user] = r;
        // Each winner's numerator is their OWN committed power.
        pendingPower[gameId][user] = predictionPower;
    }

    function score(address user, uint32 gameId)
        external override returns (bool scored, uint256 userScore, uint256 multiplier, uint256 total, uint256 bountyTotal, uint64 roundIndex)
    {
        uint64 r = pendingRound[gameId][user];
        if (r == 0) return (false, 0, 0, 0, 0, 0);
        uint64 cur = uint64(ISatoriCore(core).getCurrentRound());
        if (cur <= r) return (false, 0, 0, 0, 0, 0);

        uint256 w = pendingPower[gameId][user];
        delete pendingRound[gameId][user];
        delete pendingPower[gameId][user];

        // UNDER-REPORT: userScore == this winner's own power, multiplier == 1, so
        // the numerator is `w`. But `total == w` too — the FIRST scorer pins
        // total to its OWN numerator, ignoring every other winner. Σ numerators
        // (3×w for three equal winners) FAR exceeds the pinned total (w), so the
        // first settler saturates the cap and strands the rest.
        userScore   = w;
        multiplier  = 1;
        total       = w;          // <-- the lie: total < Σ numerators
        bountyTotal = 0;          // no bounty rail exercised here
        scored      = true;
        roundIndex  = r;
    }
}
