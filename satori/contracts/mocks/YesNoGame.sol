// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";
import "../interfaces/IGameUIDescriptor.sol";
import "../interfaces/ISatoriCore.sol";

/**
 * @title YesNoGame — INSECURE EXAMPLE, TEST-ONLY (do NOT deploy)
 * @notice ⚠️ Deliberately-retained INSECURE example adapter, kept ONLY as a test
 *         vehicle for the protocol's adapter code paths. It is NOT a production
 *         reference and must never be registered on a live network.
 *
 *         WHY UNSAFE (audit F4): it scores a SINGLE stream value against a FIXED
 *         public threshold ("is B > threshold?"). On a pull stream `updateValue`
 *         is permissionless, so a bettor who already placed a bet can wait until
 *         the underlying value is on their side of the threshold and record it
 *         themselves — self-settling their own bet. The built-in binary game
 *         avoids this: in band 2 it scores the movement between two FUTURE
 *         values (ABC), un-cherry-pickable at bet time; in the moment-anchored
 *         band the anchor is a value already standing at bet time, with the
 *         observable slice bounded by cadence/target (the design's accepted
 *         ~4% at hourly/daily). A threshold
 *         game is not trustlessly settleable on a self-recordable oracle; a real
 *         price-target product needs settlement pinned to an external timestamp
 *         (e.g. a Chainlink historical round at expiry). See
 *         docs/design/adapter-scoring-anti-patterns.md and docs/issues.
 *
 * @dev Architecture (per docs/narratives/A_game_adapters.md):
 *      - The protocol owns ALL money-touching state and enforces conservation;
 *        this adapter owns ALL scoring semantics and therefore keeps its own
 *        per-user prediction state (direction + weight) and per-round
 *        per-direction weight totals. (The protocol no longer stores a bucket
 *        or weight — it only pays `pool × userScore / total`, pins the first
 *        scorer's `total`, and caps the round's paid numerators at it.)
 *      - At `record` the adapter decodes the direction, remembers the user's
 *        (round, direction, weight), and accumulates the per-direction total.
 *        Returns nothing.
 *      - At `score` the adapter determines the winning direction (the first
 *        stream value after the bet's round vs the threshold), then returns
 *        `userScore` (ACCURACY: 1 if the user picked the winning direction, else
 *        0), `multiplier` (the user's SATORI weight `w`), and `total` (the total
 *        weight on the winning direction). The protocol pays on
 *        userScore × multiplier = 1 × w = w; the sum over winners == total, so it
 *        mints exactly one pool — SATORI economics unchanged. Splitting accuracy
 *        out of the weight lets bounties be paid by accuracy (step 3).
 *
 *      gameConfig encoding (frozen at createGame time):
 *        abi.encode(int128 threshold)
 *
 *      Outcome: each bet is evaluated against the first stream value after the
 *      bet's `roundMade`. YES wins iff that value > threshold. No fixed end —
 *      predictions can be made in any round the stream is active.
 */
interface IGameRegistryMin {
    function dataStreamId(uint32 gameId) external view returns (uint32);
    function gameConfig(uint32 gameId) external view returns (bytes memory);
}

interface IStreamRegistryMin {
    /// @dev `valueB` MUST be declared `int232` to match the registry's actual
    ///      return type (SatoriRegistry.getFirstValueAfter / int232 storage).
    ///      Declaring it `int128` here makes the ABI return-data decoder REVERT
    ///      for any stored value outside int128 range — and `score` reverting
    ///      bricks both settle and every future score-first predict on the game
    ///      (A_game_adapters.md: "score MUST NOT revert"). Audit adv_2.
    function getFirstValueAfter(uint32 streamId, uint256 afterHour)
        external view returns (int232 valueB, bool found, bool anchorEvicted);
}

contract YesNoGame is IPredictionGame, IGameUIDescriptor {
    address public immutable satoriCore;
    address public immutable satoriGames;
    address public immutable satoriRegistry;

    uint8 internal constant YES = 1;
    uint8 internal constant NO  = 2;

    struct GameConfig {
        int128 threshold;
    }
    mapping(uint32 => GameConfig) public configs;
    mapping(uint32 => bool)       public configFrozen;

    /// @notice Lazy cache: once a game's outcome at round R is determined, it's
    ///         stored here so subsequent `score` calls for that round don't
    ///         re-query the stream. 0 = "not yet resolved" sentinel, 1 = YES, 2 = NO.
    mapping(uint32 => mapping(uint64 => uint8)) public roundOutcome;

    /// @notice Per-user open bet: the round, the chosen direction, and the
    ///         committed weight. Cleared on score. The adapter owns this state
    ///         (the protocol no longer stores per-bet bucket/weight).
    mapping(uint32 => mapping(address => uint64))  public pendingRound;
    mapping(uint32 => mapping(address => uint8))   public pendingDir;
    mapping(uint32 => mapping(address => uint256)) public pendingWeight;

    /// @notice Total committed weight per (gameId, round, direction). The
    ///         winning direction's total is the score/total denominator.
    mapping(uint32 => mapping(uint64 => mapping(uint8 => uint256))) public dirWeight;

    /// @notice Total committed BOUNTY STAKE per (gameId, round, direction). The
    ///         winning direction's total is the bounty denominator `bountyTotal`
    ///         (Σ accuracy × stake; accuracy is 1 for the winning side here).
    mapping(uint32 => mapping(uint64 => mapping(uint8 => uint256))) public dirBountyStake;

    error Unauthorized();
    error InvalidConfig();
    error InvalidDirection();
    error IndexOutOfRange();

    constructor(address core, address gamesReg, address streamRegistry) {
        satoriCore = core;
        satoriGames = gamesReg;
        satoriRegistry = streamRegistry;
    }

    function _onlyCore() private view {
        if (msg.sender != satoriCore) revert Unauthorized();
    }

    // ============================================================
    // IPredictionGame
    // ============================================================

    function validateForStream(uint32 /*streamId*/, bytes calldata gameConfig)
        external pure override
    {
        // Threshold-only config: 32 bytes (one abi-encoded int128).
        if (gameConfig.length != 32) revert InvalidConfig();
    }

    function record(
        address user,
        uint32 gameId,
        uint256 predictionPower,
        uint256 bountyStake,
        bytes calldata payload
    ) external override {
        _onlyCore();
        if (payload.length == 0) revert InvalidDirection();
        uint8 direction = uint8(payload[0]);
        if (direction != YES && direction != NO) revert InvalidDirection();
        _ensureConfig(gameId);

        // Rule 1: no lifecycle gates. Score-first (Rule 2) has already settled
        // any prior pending bet on this game before this call, so it's safe to
        // overwrite the per-user pointer.
        uint64 r = uint64(ISatoriCore(satoriCore).getCurrentRound());
        pendingRound[gameId][user]  = r;
        pendingDir[gameId][user]    = direction;
        pendingWeight[gameId][user] = predictionPower;
        dirWeight[gameId][r][direction] += predictionPower;

        // Bounty side: accumulate the user's stake in the round's active bounty
        // token under the chosen direction. Accuracy is 1 for the side picked, so
        // the winning direction's Σ stake IS `bountyTotal`.
        dirBountyStake[gameId][r][direction] += bountyStake;
    }

    function score(address user, uint32 gameId)
        external override
        returns (bool scored, uint256 userScore, uint256 multiplier, uint256 total, uint256 bountyTotal, uint64 roundIndex)
    {
        _onlyCore();
        uint64 round = pendingRound[gameId][user];
        if (round == 0) return (false, 0, 0, 0, 0, 0);

        // Determine (or recall) the round's outcome (winning direction).
        uint8 outcome = roundOutcome[gameId][round];
        if (outcome == 0) {
            uint32 streamId = IGameRegistryMin(satoriGames).dataStreamId(gameId);
            // The registry ring is HOUR-keyed (phase 6): "the first value
            // after round r" is the first entry after the round's LAST hour.
            (int232 valueB, bool found, bool anchorEvicted) =
                IStreamRegistryMin(satoriRegistry)
                    .getFirstValueAfter(streamId, uint256(round) * 24 + 23);
            if (!found) {
                if (!anchorEvicted) {
                    return (false, 0, 0, 0, 0, 0); // data not ready — still pending
                }
                // The value ring rolled past this prediction's anchor
                // round: the outcome can NEVER be determined. Finalize with no
                // payout (userScore 0, total 0, bountyTotal 0 → the protocol pins
                // total 0 and pays nothing, but the bet reaches a terminal state
                // and the unsettled counter is decremented). Audit adv_3.
                _clearPending(gameId, user);
                return (true, 0, 0, 0, 0, round);
            }
            _ensureConfig(gameId);
            outcome = int256(valueB) > int256(configs[gameId].threshold) ? YES : NO;
            roundOutcome[gameId][round] = outcome;
        }

        uint8   dir = pendingDir[gameId][user];
        uint256 w   = pendingWeight[gameId][user];
        _clearPending(gameId, user);

        // SATORI weight is the MULTIPLIER; ACCURACY is the score. For a binary
        // game accuracy is 1 (called the winning side) or 0. The protocol pays on
        // userScore × multiplier = 1 × w = w, so SATORI economics are unchanged —
        // we've only split the weight effect out of the raw score so bounties can
        // be paid by accuracy alone (step 3). `total` already folds the multiplier:
        // the sum over winners of (1 × w) == sum of w == dirWeight[outcome], the
        // shared denominator (identical for every user → the pin is consistent no
        // matter who scores first). bountyTotal = Σ accuracy × stake over winners,
        // which for this game is Σ stake on the winning direction (accuracy 1) so
        // the protocol pays the bounty pot × (userScore × stake) / bountyTotal.
        total       = dirWeight[gameId][round][outcome];
        userScore   = (dir == outcome) ? 1 : 0;
        multiplier  = w;
        bountyTotal = dirBountyStake[gameId][round][outcome];
        scored      = true;
        roundIndex  = round;
    }

    function _clearPending(uint32 gameId, address user) internal {
        delete pendingRound[gameId][user];
        delete pendingDir[gameId][user];
        delete pendingWeight[gameId][user];
    }

    // ============================================================
    // IGameUIDescriptor (OPTIONAL, view-only, never called by the core)
    // Pure additive UI metadata; the protocol does not reference it.
    // ============================================================

    function uiSchemaVersion() external pure override returns (uint16) {
        return 1;
    }

    function optionCount(uint32 /*gameId*/) external pure override returns (uint256) {
        return 2;
    }

    function optionLabel(uint32 /*gameId*/, uint256 index)
        external pure override returns (string memory)
    {
        if (index == 0) return "Yes";
        if (index == 1) return "No";
        revert IndexOutOfRange();
    }

    /// @notice The exact 1-byte predict payload that selects an option.
    ///         index 0 => 0x01 (YES), index 1 => 0x02 (NO).
    function optionPayload(uint32 /*gameId*/, uint256 index)
        external pure override returns (bytes memory)
    {
        if (index > 1) revert IndexOutOfRange();
        return abi.encodePacked(uint8(index + 1));
    }

    function predictInputSchema(uint32 /*gameId*/)
        external pure override returns (string memory)
    {
        return "";
    }

    function configSchema() external pure override returns (string memory) {
        return '{"version":1,"fields":[{"key":"threshold","label":"Price threshold","type":"int128","help":"YES wins if the stream value is above this."}]}';
    }

    /// @notice Human label for an outcome direction. 1 => "Yes", 2 => "No".
    function bucketLabel(uint32 /*gameId*/, uint96 bucket)
        external pure override returns (string memory)
    {
        if (bucket == YES) return "Yes";
        if (bucket == NO)  return "No";
        return "";
    }

    // ============================================================
    // Internal
    // ============================================================

    function _ensureConfig(uint32 gameId) internal {
        if (configFrozen[gameId]) return;
        bytes memory cfg = IGameRegistryMin(satoriGames).gameConfig(gameId);
        int128 thr = abi.decode(cfg, (int128));
        configs[gameId] = GameConfig({ threshold: thr });
        configFrozen[gameId] = true;
    }
}
