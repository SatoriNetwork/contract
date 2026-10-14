// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ISatoriVoting.sol";
import "./interfaces/ISatoriCore.sol";
import "./interfaces/ISatoriGames.sol";
import "./next/SatoriUUPS.sol";

interface IHubRewardsSource { function rewards() external view returns (address); }
interface IAdminSource { function admin() external view returns (address); }

/**
 * @title SatoriVoting
 * @notice Burn-backed voting: SATORI is destroyed to buy a game permanent
 *         weight, and a game earns rewards in direct proportion to that weight.
 */
contract SatoriVoting is ISatoriVoting, SatoriUUPS {
    // ========== State Variables ==========

    address private deployer;

    address public satoriCore;

    address public satoriGames;

    address public satoriEngine;

    address public satoriToken;

    bool private _initialized;

    // LAYOUT: this contract sits behind a proxy — new state must be APPENDED
    // below the existing variables, never inserted or reordered.

    // ---------- Global vote state ----------

    /// @dev Game 1 (the default) never has an entry — it cannot be voted on and
    ///      its weight is derived. See `weightOf`.
    mapping(uint32 => uint256) public gameWeight;

    /// @dev The default game never appears here — its weight derives FROM this
    ///      total, so including it would be circular.
    uint256 public totalBurnedWeight;

    mapping(uint32 => bool) public gameApproved;

    // ---------- The default game ----------

    uint32 internal constant DEFAULT_STREAM_ID = 1;

    /// @dev To own `DEFAULT_SHARE_BPS` of a denominator it is itself part of,
    ///      the default's weight must be `d = o * B / (10000 - B)` — what
    ///      `weightOf` computes.
    uint256 public constant DEFAULT_SHARE_BPS = 100; // 1% of the denominator

    /// @dev At launch `totalBurnedWeight == 0` and the default is the only game;
    ///      without a floor its derived weight would be 0 and the first round
    ///      would have a zero denominator.
    uint256 public constant DEFAULT_WEIGHT_FLOOR = 1e18;

    // ---------- Per-round burn deltas ----------

    /// @dev Independent of `gameVotesAtRound`: that freezes a game's TOTAL
    ///      weight when first predicted (the numerator); this accumulates only
    ///      what was newly burned during the round.
    mapping(uint32 => mapping(uint256 => uint256)) public gameBurnAtRound;

    mapping(uint256 => uint256) public totalBurnAtRound;

    // ---------- Per-round participation ----------

    /// @dev Written exactly once per (game, round), by the first predictor of
    ///      that game in that round. Never revised.
    mapping(uint32 => mapping(uint256 => uint256)) public gameVotesAtRound;

    /// @dev INVARIANT: roundVoteTotal[r] == Σ gameVotesAtRound[g][r] — both are
    ///      written in the same branch of `recordGameVotesForRound` and nothing
    ///      else touches either. Final only once the round has ended
    ///      (`roundDenominator` enforces that).
    mapping(uint256 => uint256) public roundVoteTotal;

    /// @dev A game that participated but later lost approval is still in this
    ///      list (audit adv_9).
    mapping(uint256 => uint32[]) internal _eligibleGamesAtRound;

    /// @dev Read and capped by `moveVotes`. From genesis,
    ///      `Σ_voters voterGameWeight[·][g] == gameWeight[g]`
    ///      (see docs/issues/vote-weight-doors.md). `voter` is trustworthy
    ///      because `onlyHub` guards `vote` and the hub burns from `msg.sender`
    ///      before passing that same address. APPENDED per the layout rule above.
    mapping(address => mapping(uint32 => uint256)) public voterGameWeight;

    // ========== Events ==========

    event Voted(
        address indexed voter,
        uint32  indexed gameId,
        uint256 indexed round,
        uint256 amountBurned,
        uint256 weightAdded,
        uint256 newGameWeight
    );

    event GameRecordedForRound(uint32 indexed gameId, uint256 indexed round, uint256 weight, uint256 roundTotal);

    event SatoriCoreSet(address indexed newCore);

    event GameApprovedSet(uint32 indexed gameId, bool approved);

    event VotesMoved(
        address indexed voter,
        uint32 indexed fromGame,
        uint32 indexed toGame,
        uint256 round,
        uint256 amount,
        uint256 newFromWeight,
        uint256 newToWeight
    );

    // ========== Custom Errors ==========

    error OnlySatoriCore();
    error NotAdmin();
    error OnlyDeployer();
    error CoreAlreadySet();
    error InvalidCoreAddress();
    error UnknownGame();
    error GameNotApproved();
    error ZeroVote();
    error CannotSetDefaultApproval();
    /// @notice Only the built-in binary game (type 0) is paid from the round
    /// budget; adapter/off-chain types settle by logic the chain cannot verify,
    /// so weight on one buys nothing.
    error GameNotMintEligible();
    error CannotVoteDefault();

    error SourceStillApproved();

    error InsufficientVoterWeight();

    /// @notice `moveVotes` in the same round the source's weight was frozen into
    ///         would put the same weight into a second numerator of one round.
    error SourceFrozenThisRound();
    error RoundNotFinal();

    // ========== Modifiers ==========

    modifier onlyCore() {
        if (msg.sender != satoriCore && msg.sender != satoriEngine) revert OnlySatoriCore();
        _;
    }

    /// @dev Weight creation must be HUB-ONLY: `vote` mints permanent weight on
    ///      the assumption the caller burned the voter's tokens first, and only
    ///      the hub does that burn (`SatoriHub._vote`). The shared `onlyCore`
    ///      also admits the engine, which never burns — gating `vote` with it
    ///      would leave a second, unbacked weight-minting caller one engine
    ///      upgrade away. The engine keeps `onlyCore` for `recordGameVotesForRound`.
    modifier onlyHub() {
        if (msg.sender != satoriCore) revert OnlySatoriCore();
        _;
    }

    function setSatoriEngine(address _engine) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (satoriEngine != address(0)) revert CoreAlreadySet();
        if (_engine == address(0)) revert InvalidCoreAddress();
        satoriEngine = _engine;
    }

    function setSatoriToken(address _token) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (satoriToken != address(0)) revert CoreAlreadySet();
        if (_token == address(0)) revert InvalidCoreAddress();
        satoriToken = _token;
    }

    // ========== Constructor ==========

    constructor() {
        _init();
        _initialized = true;
    }

    /// @dev Proxy initializer — runs atomically inside SatoriProxy's constructor.
    ///      Takes the token so upgradeTo/renounceUpgrade are governable from
    ///      birth; the direct-deploy path keeps the one-shot setSatoriToken wiring.
    function initialize(address _token) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _init();
        _requireGovernorSource(_token);
        satoriToken = _token;
    }

    function _init() private {
        deployer = msg.sender;
    }

    // ========== Admin Functions ==========

    function setSatoriCore(address _core) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (satoriCore != address(0)) revert CoreAlreadySet();
        if (_core == address(0)) revert InvalidCoreAddress();
        satoriCore = _core;
        satoriGames = ISatoriCore(_core).satoriGames();
        emit SatoriCoreSet(_core);
    }

    /// @dev Rewards admin resolved through the hub (`hub.rewards().admin()`), so
    ///      this contract needs no rewards pointer. Only reached on the
    ///      admin-only `setGameApproved` path.
    function _rewardsAdmin() internal view returns (address) {
        return IAdminSource(IHubRewardsSource(satoriCore).rewards()).admin();
    }

    /**
     * @notice Grant or revoke a game's approval. Rewards-admin only.
     * @dev Revocation stops scoring for ALL rounds including those that predate
     *      it — without that, an operator could farm a manipulated game, wait
     *      for revocation, and still score rounds already predicted. Re-approving
     *      restores the weight exactly (minus whatever `moveVotes` moved off in
     *      between, which is not clawed back).
     */
    function setGameApproved(uint32 gameId, bool approved) external {
        if (msg.sender != _rewardsAdmin()) revert NotAdmin();
        if (gameId == 0) revert UnknownGame();
        if (gameId == DEFAULT_STREAM_ID) revert CannotSetDefaultApproval();
        if (gameApproved[gameId] == approved) return;   // idempotent

        gameApproved[gameId] = approved;
        uint256 w = gameWeight[gameId];
        if (w != 0) {
            if (approved) {
                totalBurnedWeight += w;
            } else {
                totalBurnedWeight -= w;
            }
        }
        emit GameApprovedSet(gameId, approved);
    }

    /// @notice Whether `gameId` may carry weight, be recorded, and score:
    ///         approved, or the default game (live by construction).
    function gameLive(uint32 gameId) public view returns (bool) {
        return gameApproved[gameId] || gameId == DEFAULT_STREAM_ID;
    }

    // ========== Voting ==========

    /**
     * @notice Buy `gameId` permanent weight by burning SATORI.
     * @dev The hub burns the caller's tokens BEFORE calling this; by here the
     *      supply is already reduced. This is the ONLY point weight is created.
     * @param gameId The game to back.
     * @param voter  The account whose tokens were burned (for the event).
     * @param amount SATORI burned.
     * @return weightAdded The weight credited — always exactly `amount`.
     */
    function vote(uint32 gameId, address voter, uint256 amount)
        external override onlyHub
        returns (uint256 weightAdded)
    {
        _requireVotableTarget(gameId);
        if (amount == 0) revert ZeroVote();

        weightAdded = amount;

        uint256 newWeight = gameWeight[gameId] + weightAdded;
        gameWeight[gameId] = newWeight;
        totalBurnedWeight += weightAdded;
        voterGameWeight[voter][gameId] += weightAdded;

        uint256 round = ISatoriCore(satoriCore).getCurrentRound();
        gameBurnAtRound[gameId][round] += weightAdded;
        totalBurnAtRound[round] += weightAdded;

        emit Voted(voter, gameId, round, amount, weightAdded, newWeight);
    }

    /// @dev The one place a game is judged fit to receive weight, shared by
    ///      `vote` and `moveVotes`. Only the built-in binary game earns from the
    ///      mint, so only it can carry weight.
    function _requireVotableTarget(uint32 gameId) internal view {
        if (gameId == 0 || !ISatoriGames(satoriGames).gameExists(gameId)) revert UnknownGame();
        if (gameId == DEFAULT_STREAM_ID) revert CannotVoteDefault();
        if (ISatoriGames(satoriGames).gameTypeIdOf(gameId) != 0) revert GameNotMintEligible();
        if (!gameApproved[gameId]) revert GameNotApproved();
    }

    /**
     * @notice Re-point your own burned weight from an UNAPPROVED game to a live
     *         one. Weight on ENABLED games remains immovable.
     * @dev Direct entry, not `onlyHub`: no tokens move, so `msg.sender` speaks
     *      for itself. An unapproved game's weight is NOT in `totalBurnedWeight`
     *      (the revocation subtracted it), so the amount re-enters the total as
     *      it lands on an enabled game. The `SourceFrozenThisRound` fence stops
     *      the same weight landing in two numerators of one round.
     *      `gameWeight[fromGame] -= amount` cannot underflow: `amount` is capped
     *      by the caller's own `voterGameWeight` entry.
     */
    function moveVotes(uint32 fromGame, uint32 toGame, uint256 amount) external {
        if (gameApproved[fromGame]) revert SourceStillApproved();
        _requireVotableTarget(toGame);
        if (amount == 0) revert ZeroVote();
        uint256 held = voterGameWeight[msg.sender][fromGame];
        if (amount > held) revert InsufficientVoterWeight();

        uint256 round = ISatoriCore(satoriCore).getCurrentRound();
        if (gameVotesAtRound[fromGame][round] != 0) revert SourceFrozenThisRound();

        voterGameWeight[msg.sender][fromGame] = held - amount;
        voterGameWeight[msg.sender][toGame] += amount;
        uint256 newFromWeight = gameWeight[fromGame] - amount;
        gameWeight[fromGame] = newFromWeight;
        uint256 newToWeight = gameWeight[toGame] + amount;
        gameWeight[toGame] = newToWeight;
        totalBurnedWeight += amount;

        emit VotesMoved(msg.sender, fromGame, toGame, round, amount, newFromWeight, newToWeight);
    }

    // ========== Weight reads ==========

    /// @notice A game's current voting weight. Zero for an unapproved game.
    function weightOf(uint32 gameId) public view override returns (uint256) {
        if (!gameLive(gameId)) return 0;
        return _rawWeight(gameId);
    }

    /// @notice The default game's derived weight, floored so genesis is non-zero.
    function defaultDerivedWeight() public view returns (uint256) {
        uint256 d = (totalBurnedWeight * DEFAULT_SHARE_BPS) / (10000 - DEFAULT_SHARE_BPS);
        return d < DEFAULT_WEIGHT_FLOOR ? DEFAULT_WEIGHT_FLOOR : d;
    }

    /// @notice Is `gameId` earning rewards right now? Any enabled game with
    ///         weight qualifies — no threshold, no top-N.
    function isEligible(uint32 gameId) external view override returns (bool) {
        return weightOf(gameId) > 0;
    }

    /**
     * @notice Paginated leaderboard read: every game carrying weight, with its
     *         live flag and how much was burned for it in `round`.
     * @dev Returned in GAME-ID order, not weight order — callers sort. Unapproved
     *      games are INCLUDED (not skipped): `weights[i]` is the RAW weight
     *      (survives an approval revocation); the EARNING weight is
     *      `approved[i] ? weights[i] : 0`. `limit` bounds the ids SCANNED, not
     *      returned, so arrays may be shorter than `limit`; page until
     *      `nextOffset > gameCount()`.
     * @param offset First game id to scan (ids start at 1; pass 1 to begin).
     * @param limit  How many ids to scan this page.
     * @param round  Round to report burn deltas for.
     * @return ids           Game ids carrying weight, ascending.
     * @return weights        Raw weight, parallel to `ids`.
     * @return approved       Whether each game is live.
     * @return burnedInRound  Weight bought for each game during `round`.
     * @return nextOffset     Game id to resume from.
     */
    function getGameWeights(uint32 offset, uint32 limit, uint256 round)
        external view
        returns (
            uint32[]  memory ids,
            uint256[] memory weights,
            bool[]    memory approved,
            uint256[] memory burnedInRound,
            uint32 nextOffset
        )
    {
        uint32 total = uint32(ISatoriGames(satoriGames).gameCount());
        if (offset == 0) offset = 1;
        if (offset > total || limit == 0) {
            return (new uint32[](0), new uint256[](0), new bool[](0), new uint256[](0), total + 1);
        }
        uint32 end = offset + limit;
        if (end > total + 1) end = total + 1;

        uint32 found = 0;
        for (uint32 g = offset; g < end; g++) {
            if (_rawWeight(g) != 0) found++;
        }
        ids           = new uint32[](found);
        weights       = new uint256[](found);
        approved      = new bool[](found);
        burnedInRound = new uint256[](found);

        uint32 k = 0;
        for (uint32 g = offset; g < end; g++) {
            uint256 w = _rawWeight(g);
            if (w == 0) continue;
            ids[k]           = g;
            weights[k]       = w;
            approved[k]      = gameLive(g);
            burnedInRound[k] = gameBurnAtRound[g][round];
            k++;
        }
        nextOffset = end;
    }

    /// @dev A game's weight ignoring the approval flag — what was actually burned
    ///      (or derived, for the default). `weightOf` is this zeroed while unapproved.
    function _rawWeight(uint32 gameId) internal view returns (uint256) {
        if (gameId == DEFAULT_STREAM_ID) return defaultDerivedWeight();
        return gameWeight[gameId];
    }

    // ========== Per-round recording ==========

    /**
     * @notice Freeze `gameId`'s weight into `round` and add it to that round's
     *         denominator. Called by the engine on every prediction; only the
     *         FIRST per (game, round) does work.
     * @dev A non-live game is skipped: the prediction still executes, it simply
     *      leaves no record here, so it can never be scored.
     */
    function recordGameVotesForRound(uint32 gameId, uint256 round) external override onlyCore {
        if (!gameLive(gameId)) return;
        if (gameVotesAtRound[gameId][round] != 0) return;   // already recorded

        uint256 w = weightOf(gameId);
        if (w == 0) return;                                  // nothing to record

        gameVotesAtRound[gameId][round] = w;
        uint256 total = roundVoteTotal[round] + w;
        roundVoteTotal[round] = total;
        _eligibleGamesAtRound[round].push(gameId);

        emit GameRecordedForRound(gameId, round, w, total);
    }

    /**
     * @notice The reward denominator for a FINISHED round.
     * @dev Guarded: the total accumulates as games join over the round, so
     *      reading it mid-round returns a partial sum.
     */
    function roundDenominator(uint256 round) external view override returns (uint256) {
        if (round >= ISatoriCore(satoriCore).getCurrentRound()) revert RoundNotFinal();
        return roundVoteTotal[round];
    }

    /// @notice A game's frozen weight for a round — the reward numerator. Zero
    ///         means it was never predicted that round (or was not live).
    function getGameVotesAtRound(uint32 gameId, uint256 round) external view returns (uint256) {
        return gameVotesAtRound[gameId][round];
    }

    /// @notice Every game that participated in `round`, in first-prediction order.
    function getEligibleGamesAtRound(uint256 round) external view override returns (uint32[] memory) {
        return _eligibleGamesAtRound[round];
    }

    // ========== Internal Helpers ==========

    /// @dev Pinned by SatoriUUPS.upgradeTo so only another SatoriVoting
    ///      implementation can ever be installed here.
    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriVoting");
    }

    function _upgradeGovernor() internal view override returns (address) {
        return ISatoriUpgradeAuthority(satoriToken).upgradeAuthority();
    }
}
