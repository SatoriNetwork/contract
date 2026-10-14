// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";
import "../interfaces/ISatoriCore.sol";

interface ISettle {
    function settlePrediction(address user, uint32 gameId) external;
}

/**
 * @title ReentrantGameAdapter
 * @notice MALICIOUS adapter for the adversarial reentrancy repro (score/total
 *         model). Adapter registration is permissionless, so the protocol must
 *         be robust to an adapter that reenters during `score()`.
 *
 *         When armed, on the FIRST `score(user,game)` call it reenters
 *         `SatoriEngine.settlePrediction(user, game)` once before returning, so the
 *         same pending prediction would be finalized twice within one outer
 *         call. The H4 fix (`nonReentrant` on settlePrediction /
 *         predictMultipleWithPayloads) must make the inner call revert.
 */
contract ReentrantGameAdapter is IPredictionGame {
    address public immutable core;
    bool    public reenterArmed;
    bool    public inReenter;

    mapping(uint32 => mapping(address => uint64))  public pendingRound;
    mapping(uint32 => mapping(address => uint256)) public pendingWeight;

    constructor(address _core) { core = _core; }

    function arm() external { reenterArmed = true; }

    function validateForStream(uint32, bytes calldata cfg) external pure override {
        require(cfg.length >= 0, "cfg"); // accept anything
    }

    function record(address user, uint32 gameId, uint256 predictionPower, uint256, bytes calldata)
        external override
    {
        require(msg.sender == core, "only core");
        pendingWeight[gameId][user] = predictionPower;
        pendingRound[gameId][user] = uint64(ISatoriCore(core).getCurrentRound());
    }

    function score(address user, uint32 gameId)
        external override returns (bool scored, uint256 userScore, uint256 multiplier, uint256 total, uint256 bountyTotal, uint64 roundIndex)
    {
        require(msg.sender == core, "only core");
        uint64 r = pendingRound[gameId][user];
        if (r == 0) return (false, 0, 0, 0, 0, 0);

        // First entry: reenter settlePrediction once before announcing. With the
        // H4 nonReentrant guard this reverts and bubbles up through this score().
        if (reenterArmed && !inReenter) {
            inReenter = true;
            ISettle(core).settlePrediction(user, gameId);
            inReenter = false;
        }

        uint256 w = pendingWeight[gameId][user];
        delete pendingRound[gameId][user];
        delete pendingWeight[gameId][user];
        // multiplier 1 → userScore × 1 == w (unchanged); total == w → full pool to
        // the single user; bountyTotal == w (faithful). This mock probes
        // reentrancy, not the multiplier/bounty path.
        return (true, w, 1, w, w, r);
    }
}
