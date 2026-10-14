// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";
import "../interfaces/ISatoriCore.sol";

/// @dev Adversarial adapter for the score/total model that VARIES `bountyTotal`
///      by SCORER CALL-ORDER to attack the first-scorer bountyTotal PIN.
///
///      Every predictor is scored a WINNER with a fixed positive accuracy
///      (`userScore == ACC`) and a small SATORI multiplier; `total` is folded so
///      the SATORI rail stays well-formed (each winner draws ACC×MULT/total of the
///      game pool, never more than the pool).
///
///      The attack is on the BOUNTY denominator. The contract counts `score()`
///      calls per (game, round). The FIRST scorer of a round is answered a TINY
///      `bountyTotal` (== 1) — far smaller than that scorer's ACC × stake — so a
///      per-call implementation would let the first scorer draw ~the WHOLE pot.
///      Every LATER scorer of the SAME round is answered a HUGE `bountyTotal`, so
///      a per-call implementation would re-run pot × (ACC×stake)/HUGE against a
///      DIFFERENT denominator and pay them a second, independent slice — Σ > one
///      pot (over-mint).
///
///      The protocol PINS the first scorer's `bountyTotal` for the whole round and
///      caps the running paid at it, so every scorer shares ONE denominator and
///      Σ payouts + fee ≤ one pot. This mock makes the pin load-bearing: drop the
///      pin and conservation breaks; keep it and it holds.
contract VaryingBountyGame is IPredictionGame {
    address public immutable core;

    // Fixed positive accuracy per winner and a small SATORI multiplier.
    uint256 public constant ACC = 5;
    uint256 public constant MULT = 1;

    mapping(uint32 => mapping(address => uint64))  public pendingRound;
    // Per (game, round) score()-call counter — increments on each terminal score.
    mapping(uint32 => mapping(uint64 => uint256)) public scoreCalls;
    // Per (game, round) count of recorded predictions — feeds a well-formed SATORI
    // `total` (Σ ACC×MULT over winners), so the SATORI pool is never over-drawn.
    mapping(uint32 => mapping(uint64 => uint256)) public roundPredictors;

    constructor(address _core) { core = _core; }

    function validateForStream(uint32, bytes calldata) external view override {}

    function record(address user, uint32 gameId, uint256, uint256, bytes calldata)
        external override
    {
        uint64 r = uint64(ISatoriCore(core).getCurrentRound());
        pendingRound[gameId][user] = r;
        roundPredictors[gameId][r] += 1;
    }

    function score(address user, uint32 gameId)
        external override returns (bool scored, uint256 userScore, uint256 multiplier, uint256 total, uint256 bountyTotal, uint64 roundIndex)
    {
        uint64 r = pendingRound[gameId][user];
        if (r == 0) return (false, 0, 0, 0, 0, 0);
        uint64 cur = uint64(ISatoriCore(core).getCurrentRound());
        if (cur <= r) return (false, 0, 0, 0, 0, 0);
        delete pendingRound[gameId][user];

        // SATORI rail stays well-formed: total = Σ ACC×MULT over all winners of the
        // round, so each winner's ACC×MULT/total is a true fraction (≤ one pool).
        uint256 winners = roundPredictors[gameId][r];
        total = ACC * MULT * winners;

        // BOUNTY attack: each scorer is answered a SMALL bountyTotal close to its own
        // accuracy×stake, but VARYING by call-order. The FIRST scorer gets the tiniest
        // (== 1) so it takes ~the whole pot (saturating numerator clamps to room == 1);
        // every LATER scorer gets a DIFFERENT small value (== ACC) so a PER-CALL impl
        // would compute room = ACC − paid and let them draw a SECOND ~full slice
        // against their OWN denominator ⇒ Σ payouts > one pot (over-mint). With the
        // PIN, every scorer shares the first scorer's bountyTotal (== 1) and the
        // running paid is capped at it: the first scorer exhausts room == 1 and every
        // later scorer is clamped to 0 ⇒ exactly ONE pot, never N×.
        uint256 n = scoreCalls[gameId][r];
        scoreCalls[gameId][r] = n + 1;
        bountyTotal = (n == 0) ? 1 : ACC;

        return (true, ACC, MULT, total, bountyTotal, r);
    }
}
