// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IPredictionGame.sol";
import "./interfaces/ISatoriRegistry.sol";
import "./interfaces/ISatoriCore.sol";
import "./interfaces/ISatoriGames.sol";
import "./libraries/SatoriTypes.sol";

/**
 * @title SatoriGames
 * @notice Game registry + game-adapter registry. Mirrors `SatoriRegistry`'s
 *         pattern: this contract owns the storage and is gated by `onlyCore`
 *         for registry mutations; the user-facing creation / fee path lives on
 *         `SatoriHub`, which transfers the creation fee (`gameBurn()`) to the
 *         hub sink before forwarding.
 *
 * @dev    Game registry + adapter registry only. Voting and eligibility live
 *         in `SatoriVoting`; reward scoring lives in `SatoriRewards`. This
 *         contract stores game/adapter metadata and answers dispatch queries.
 */
import "./next/SatoriUUPS.sol";

contract SatoriGames is ISatoriGames, SatoriUUPS {
    // ========== Constants ==========

    uint32 public constant DEFAULT_GAME_ID = 1;

    /// Type 0 runs inline on SatoriEngine; it is never resolved to an external
    /// adapter contract, which the dispatch/lookup paths special-case throughout.
    uint32 public constant BUILTIN_BINARY = 0;

    // ========== Core wiring ==========

    address private deployer;

    address public satoriCore;

    address public satoriRegistry;

    // ========== Game registry ==========

    /// `GameMeta` is declared in `ISatoriGames`. Slot 0 packs the fixed-size
    /// fields (authority 20 + gameTypeId 2 + dataStreamId 4 + targetMinutes 3 =
    /// 29 bytes); `name`/`gameConfig` are dynamic. `targetMinutes` is the
    /// ADVERTISED duration; scoring adds the fixed 30-minute allowance.
    /// `gameId == index + 1` (the convention used throughout this contract).
    GameMeta[] public games;

    // ========== Game adapter registry ==========

    /// Type 0 is reserved (built-in inline binary, no adapter); IDs are
    /// immutable once set.
    mapping(uint32 => address) public gameAdapter;

    uint32 public nextGameTypeId = 1;

    /// Not unique — the ID, not the name, is the canonical handle.
    mapping(uint32 => string) public gameAdapterName;

    mapping(uint32 => bool) public isCommunityGameAdapter;

    /// Informational only — nothing on-chain consumes it. Do not gate on it.
    mapping(address => bool) public isRegisteredGameAdapter;

    // ========== Fan-out lookup ==========

    /// Reverse index (stream -> its games), used by `_createGame`'s
    /// duplicate-target guard and exposed via the `gamesByStream` view. No
    /// on-chain consumer outside this contract.
    mapping(uint32 => uint32[]) private _gamesByStream;

    /// A stream's FIRST (default, daily) type-0 binary game. The ladder allows
    /// further type-0 rungs at other targets on the same stream; `_createGame`
    /// refuses only a duplicate at the SAME target.
    mapping(uint32 => uint32) public binaryGameByStream;

    // ========== Events ==========

    event SatoriCoreSet(address indexed newCore);
    /// @notice The whole GameMeta at creation, so a reader rebuilds a game from this
    ///         log alone: `targetMinutes` is the RESOLVED target (the default rule
    ///         applied), not the argument. `authority` is indexed for "games you
    ///         author"; the hub is the authority of every auto-created binary game.
    event GameCreated(
        uint32 indexed gameId,
        uint32 indexed dataStreamId,
        address indexed authority,
        uint32 gameTypeId,
        uint24 targetMinutes,
        string name,
        bytes gameConfig
    );
    event GameNameUpdated(uint32 indexed gameId, string newName);
    event GameAuthorityTransferred(
        uint32 indexed gameId,
        address indexed oldAuthority,
        address indexed newAuthority
    );
    event GameAdapterRegistered(
        uint32 indexed gameTypeId,
        address indexed impl,
        address indexed registrant,
        bool   isCommunity,
        string name
    );

    // ========== Errors ==========

    error OnlySatoriCore();
    error OnlyDeployer();
    error CoreAlreadyInitialized();
    error InvalidCoreAddress();
    error InvalidGameId();
    error InvalidTarget();
    error NotGameAuthority();
    error InvalidAuthority();
    error InvalidDataStream();
    error UnknownGameAdapter();
    error InvalidGameAdapter();
    error GameAdapterIdSpaceExhausted();
    error DuplicateBinaryGame();
    error GameCadenceTooShort();
    error NamedStreamSingleGame();

    // ========== Modifiers ==========

    modifier onlyCore() {
        if (msg.sender != satoriCore) revert OnlySatoriCore();
        _;
    }

    modifier onlyAuthority(uint32 gameId) {
        if (gameId == 0 || gameId > games.length) revert InvalidGameId();
        if (msg.sender != games[gameId - 1].authority) revert NotGameAuthority();
        _;
    }

    // ========== Construction + wiring ==========

    constructor() {
        deployer = msg.sender;
        _initialized = true;
    }

    /// Proxy initializer (PHASE2-PROXY-ALL.md); the constructor path locks the
    /// raw implementation.
    function initialize(address _token) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        deployer = msg.sender;
        _requireGovernorSource(_token);
        satoriToken = _token;
        // Inline state-var initializers run as CONSTRUCTOR code and never
        // reach a proxy's storage — restate them here (kept in sync with the
        // declaration; exercised by test/next/ProxyUpgrades.test.js).
        nextGameTypeId = 1;
    }

    function setSatoriCore(address _satoriCore) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (satoriCore != address(0)) revert CoreAlreadyInitialized();
        if (_satoriCore == address(0)) revert InvalidCoreAddress();
        satoriCore = _satoriCore;
        satoriRegistry = address(ISatoriCore(_satoriCore).satoriRegistry());
        emit SatoriCoreSet(_satoriCore);
    }

    // ========== Game adapter registration ==========

    /// @dev Callers (both `onlyCore`): `SatoriHub.registerGameAdapter`
    ///      (admin-gated via `rewards.admin()`, free) and
    ///      `SatoriHub.registerCommunityGameAdapter` (permissionless, fee-paying).
    function registerGameAdapter(
        address impl,
        address registrant,
        string calldata name,
        bool isCommunity
    ) external onlyCore returns (uint32 gameTypeId) {
        return _registerGameAdapter(impl, registrant, name, isCommunity);
    }

    function _registerGameAdapter(
        address impl,
        address registrant,
        string calldata name,
        bool isCommunity
    ) internal returns (uint32 gameTypeId) {
        if (impl == address(0)) revert InvalidGameAdapter();
        gameTypeId = nextGameTypeId;
        if (gameTypeId == 0) revert GameAdapterIdSpaceExhausted(); // wraparound past 2^32 - 1
        gameAdapter[gameTypeId] = impl;
        isRegisteredGameAdapter[impl] = true;
        if (isCommunity) isCommunityGameAdapter[gameTypeId] = true;
        gameAdapterName[gameTypeId] = name;
        unchecked { nextGameTypeId = gameTypeId + 1; }
        emit GameAdapterRegistered(gameTypeId, impl, registrant, isCommunity, name);
    }

    // ========== Game creation ==========

    /// @dev `onlyCore`. `SatoriHub` transfers `gameBurn()` from the caller to
    ///      the hub sink before forwarding here.
    function createGame(
        address authority,
        uint32 streamId,
        uint32 gameTypeId,
        bytes memory config,
        string memory name
    ) external onlyCore returns (uint32 gameId) {
        return _createGame(authority, streamId, gameTypeId, config, name, 0);
    }

    /// @notice Create a game with an EXPLICIT target (the ladder path,
    ///         question 6): several binary games can share one stream at
    ///         different targets.
    /// @dev `targetMinutes` is the ADVERTISED duration, not always the real
    ///      horizon. On a stream that posts at least once per round, a target
    ///      under 24 cadences resolves on the NEXT TWO samples (the ABC band in
    ///      `SatoriEngine._scorePreviousPrediction`), about 1-2 cadences, so a
    ///      weekly rung on a daily stream asks a 1-2 day question. Longer
    ///      targets are measured from the predictor's own hour plus the
    ///      30-minute allowance. Must be at least one
    ///      round (sub-daily targets are not creatable — phase-6 deferral) and
    ///      at least the stream's cadence (question 2's settlement-liveness
    ///      rule).
    function createGame(
        address authority,
        uint32 streamId,
        uint32 gameTypeId,
        bytes memory config,
        string memory name,
        uint24 targetMinutes_
    ) external onlyCore returns (uint32 gameId) {
        if (targetMinutes_ == 0) revert InvalidTarget();
        return _createGame(authority, streamId, gameTypeId, config, name, targetMinutes_);
    }

    /// @dev `explicitTarget == 0` means "apply the default rule".
    function _createGame(
        address authority,
        uint32 streamId,
        uint32 gameTypeId,
        bytes memory config,
        string memory name,
        uint24 explicitTarget
    ) internal returns (uint32 gameId) {
        if (authority == address(0)) revert InvalidAuthority();
        if (!ISatoriRegistry(satoriRegistry).streamExists(streamId)) {
            revert InvalidDataStream();
        }
        // A named stream's counter is PER GAME (SatoriEngine.namedCounter) and
        // the adapter resolves stream → game via binaryGameByStream, so the
        // auto-created daily game must stay its only one.
        if (_gamesByStream[streamId].length != 0 && ISatoriRegistry(satoriRegistry).isNamedStream(streamId)) {
            revert NamedStreamSingleGame();
        }

        if (gameTypeId != BUILTIN_BINARY) {
            // Adapters require a host cadence strictly above one round: only
            // the type-0 binary game has scoring for an every-round stream.
            if (uint256(ISatoriRegistry(satoriRegistry).streamMinCadenceMinutes(streamId)) * 60
                    <= SatoriTypes.TIME_UNIT_SECONDS) {
                revert GameCadenceTooShort();
            }
            address impl = gameAdapter[gameTypeId];
            if (impl == address(0)) revert UnknownGameAdapter();
            IPredictionGame(impl).validateForStream(streamId, config);
        }

        // Resolve the target. Default rule (design section 3): the stream's
        // cadence when it exceeds a day, else daily. An explicit target must
        // be at least one round (sub-daily targets are not creatable) and at
        // least the stream's cadence (question 2: settlement liveness).
        uint24 cad = ISatoriRegistry(satoriRegistry).streamMinCadenceMinutes(streamId);
        uint24 tgt;
        if (explicitTarget == 0) {
            tgt = cad > 1440 ? cad : 1440;
        } else {
            if (explicitTarget < 1440 || explicitTarget < cad) revert InvalidTarget();
            // A rung longer than the stream's history ring (HISTORY_SIZE entries, one per
            // cadence period) could never find its post sample, so it could never score.
            if (explicitTarget > uint256(SatoriTypes.HISTORY_SIZE) * uint256(cad)) revert InvalidTarget();
            // The hour grid: both clocks (predict spacing, floor tgt/60; the
            // scoring wait, ceil of the allowance-adjusted tgt) agree exactly
            // when the target is whole hours — and off-grid values would also
            // let near-duplicate rungs (1440/1441/...) spam one stream.
            if (explicitTarget % 60 != 0) revert InvalidTarget();
            tgt = explicitTarget;
        }

        if (gameTypeId == BUILTIN_BINARY) {
            // ONE binary game per stream PER TARGET (relaxed for the ladder,
            // question 6): the auto-created daily game and explicit weekly /
            // monthly rungs share a stream, differing only in target. A
            // second binary game at the SAME target is still a duplicate.
            if (_binaryTargetUsed[streamId][tgt]) revert DuplicateBinaryGame();
            _binaryTargetUsed[streamId][tgt] = true;
        }

        games.push(GameMeta({
            authority: authority,
            gameTypeId: gameTypeId,
            dataStreamId: streamId,
            targetMinutes: tgt,
            name: name,
            gameConfig: config
        }));

        gameId = uint32(games.length); // gameId == index + 1
        _gamesByStream[streamId].push(gameId);
        if (gameTypeId == BUILTIN_BINARY && binaryGameByStream[streamId] == 0) {
            binaryGameByStream[streamId] = gameId; // the stream's FIRST (default) binary game
        }

        emit GameCreated(gameId, streamId, authority, gameTypeId, tgt, name, config);
    }

    // ========== Game admin (authority-only) ==========

    function setGameName(uint32 gameId, string memory newName)
        external onlyAuthority(gameId)
    {
        games[gameId - 1].name = newName;
        emit GameNameUpdated(gameId, newName);
    }

    function setGameAuthority(uint32 gameId, address newAuthority)
        external onlyAuthority(gameId)
    {
        if (newAuthority == address(0)) revert InvalidAuthority();
        address oldAuthority = games[gameId - 1].authority;
        games[gameId - 1].authority = newAuthority;
        emit GameAuthorityTransferred(gameId, oldAuthority, newAuthority);
    }

    // Games are permanent — no `deleteGame`, no tombstone. A game's only
    // mutable state is its authority + name (and its SatoriVoting-side weight).

    // ========== Views ==========

    function gameCount() external view returns (uint256) {
        return games.length;
    }

    function gameExists(uint32 gameId) external view returns (bool) {
        return gameId > 0 && gameId <= games.length;
    }

    function gameMeta(uint32 gameId) external view returns (GameMeta memory) {
        if (gameId == 0 || gameId > games.length) revert InvalidGameId();
        return games[gameId - 1];
    }

    /// ADVERTISED minutes (1440 = daily); the scoring lookup applies the fixed
    /// 30-minute allowance internally. Under 24 cadences on a stream posting at
    /// least daily, the game resolves on the next two samples instead (see
    /// `createGame`).
    function targetMinutes(uint32 gameId) external view returns (uint24) {
        if (gameId == 0 || gameId > games.length) revert InvalidGameId();
        return games[gameId - 1].targetMinutes;
    }

    function dataStreamId(uint32 gameId) external view returns (uint32) {
        if (gameId == 0 || gameId > games.length) revert InvalidGameId();
        return games[gameId - 1].dataStreamId;
    }

    function gameConfig(uint32 gameId) external view returns (bytes memory) {
        if (gameId == 0 || gameId > games.length) revert InvalidGameId();
        return games[gameId - 1].gameConfig;
    }

    function gameTypeIdOf(uint32 gameId) external view returns (uint32) {
        if (gameId == 0 || gameId > games.length) revert InvalidGameId();
        return games[gameId - 1].gameTypeId;
    }

    function gameAuthority(uint32 gameId) external view returns (address) {
        if (gameId == 0 || gameId > games.length) revert InvalidGameId();
        return games[gameId - 1].authority;
    }

    /// @dev Returns (0, 0) for an invalid gameId instead of reverting, so the
    ///      caller can throw their own contextual error.
    function gameDispatch(uint32 gameId)
        external view returns (address adapter, uint32 streamId)
    {
        if (gameId == 0 || gameId > games.length) return (address(0), 0);
        GameMeta storage g = games[gameId - 1];
        streamId = g.dataStreamId;
        uint32 typeId = g.gameTypeId;
        if (typeId != 0) adapter = gameAdapter[typeId];
    }

    function gameAdapterAddress(uint32 gameTypeId) external view returns (address) {
        return gameAdapter[gameTypeId];
    }

    function gameAdapterFor(uint32 gameId) external view returns (address) {
        if (gameId == 0 || gameId > games.length) return address(0);
        uint32 typeId = games[gameId - 1].gameTypeId;
        if (typeId == 0) return address(0);
        return gameAdapter[typeId];
    }

    /// Reverse index (stream -> its games) exposed for off-chain consumers; no
    /// on-chain consumer reads it.
    function gamesByStream(uint32 streamId) external view returns (uint32[] memory) {
        return _gamesByStream[streamId];
    }

    function gamesByStreamCount(uint32 streamId) external view returns (uint256) {
        return _gamesByStream[streamId].length;
    }


    /// The upgrade-gate anchor (appended, phase 2).
    address public satoriToken;

    // ========== Phase-2 proxy plumbing (appended — append-only layout) ==========

    /// @dev Set by BOTH init paths: the implementation constructor (locking the
    ///      raw implementation instance) and the proxy `initialize` (making it
    ///      one-shot).
    bool private _initialized;

    /// Binary games per (stream, target): one each, so a rung cannot be duplicated
    /// and the duplicate check stays O(1) however many games a stream has.
    /// Appended after the proxy plumbing: this layout is append-only.
    mapping(uint32 => mapping(uint24 => bool)) private _binaryTargetUsed;

    /// Compile-time identity — pinned by SatoriUUPS.upgradeTo so only another
    /// SatoriGames implementation can ever be installed here.
    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriGames");
    }

    function _upgradeGovernor() internal view override returns (address) {
        return ISatoriUpgradeAuthority(satoriToken).upgradeAuthority();
    }
}
