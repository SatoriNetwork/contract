// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./libraries/SatoriTypes.sol";
import "./interfaces/ISatoriCore.sol";
import "./interfaces/ISatoriRewards.sol";
import "./interfaces/IStreamAdapter.sol";
import "./interfaces/INamedStreamAdapter.sol";

/**
 * @title SatoriRegistry
 * @notice Manages DataStream registry for Satori protocol
 * @dev Owns per-stream metadata and a 768-slot circular buffer of value history.
 *      The anchor + first post-anchor entries serve the on-chain A-B-C
 *      scoring walk (getFirstTwoValuesAfter / getFirstValueAfter, which may
 *      look back up to HISTORY_SIZE-2 ticks); the full 768-slot buffer also
 *      serves UI chart rendering.
 */
import "./next/SatoriUUPS.sol";

contract SatoriRegistry is SatoriUUPS {
    // ========== Constants ==========

    /// @notice Size of the per-stream history circular buffer.
    /// @dev Single source of truth lives in `SatoriTypes.HISTORY_SIZE`; this
    ///      public re-export preserves the existing registry-level getter
    ///      that dapps and indexers depend on.
    uint16 public constant HISTORY_SIZE = SatoriTypes.HISTORY_SIZE;

    /// @notice Time unit for round calculations (in seconds) — fixed at 24 hours.
    ///         One round per UTC day, boundary at 00:00 UTC.
    /// @dev Single source of truth lives in SatoriTypes.TIME_UNIT_SECONDS so this
    ///      contract and SatoriToken's round math cannot diverge.
    uint256 public constant timeUnitSeconds = SatoriTypes.TIME_UNIT_SECONDS;

    // ========== Adapter Registry ==========

    /// @notice Adapter contract for a given adapter ID. ID 0 is reserved for
    ///         "no adapter" (Simple-type streams). Once an ID is assigned
    ///         the mapping is immutable for that ID — IDs are monotonically
    ///         auto-assigned at registration time and never reused. Existing
    ///         streams never have their adapter swapped under them.
    /// @dev Read on every `updateValue` for Adapter-type streams.
    mapping(uint16 => address) public adapter;

    /// @notice Caller-supplied human-readable label for the adapter at `id`.
    ///         Not unique, not validated, purely informational; the assigned
    ///         numeric ID is the canonical handle dapps should bind to.
    mapping(uint16 => string) public adapterName;

    /// @notice True if the adapter at `id` was registered via the
    /// permissionless `registerCommunityAdapter` path, false if it was
    /// registered by the protocol admin (`rewards.admin()`) via `registerAdapter`. Lets
    /// dapps and users distinguish official adapters from community-
    /// contributed ones at a glance.
    mapping(uint16 => bool) public isCommunityAdapter;

    /// @notice Next adapter ID to assign. Starts at 1 (ID 0 = "no adapter"
    ///         sentinel for Simple streams). Reverts on wraparound past
    ///         65535, mirroring the game-adapter ID space.
    uint16 public nextAdapterId = 1;

    // ========== Core Reference ==========

    /// @notice Deployer address (authorized one-shot caller for the setSatoriCore and setSatoriEngine wiring)
    address private deployer;

    address public satoriCore;

    /// @notice SatoriRewards address, resolved from the core at wiring time.
    ///         Lets setValue/updateValue report production to rewards
    ///         directly, without an extra hop through the core.
    address public satoriRewards;

    // ========== Registry State ==========

    /// @notice StreamId type (uint32 for gas efficiency)
    /// StreamId 0 is reserved/invalid, IDs start from 1
    uint32 public nextStreamId = 1;

    /// @notice Array of stream metadata (sid = index + 1)
    SatoriTypes.StreamMeta[] public streams;

    /// @notice One tightly-packed entry per ring position (int232 + uint24 = 256 bits, one 32-byte slot exact)
    struct HistoryEntry {
        int232 value;
        uint24 round; // hour number (the ring is hour-keyed; timestamp / 3600)
    }

    /// @notice Circular buffer of history entries per stream
    // MUST equal SatoriTypes.HISTORY_SIZE (768) — solc 0.8.20 cannot size a
    // fixed array with a library constant, so the literal is repeated here;
    // every index computation uses HISTORY_SIZE, and the ring tests assert
    // count caps at exactly 768, so a divergence fails loudly.
    mapping(uint32 => HistoryEntry[768]) private historyData;

    /// @notice Per-stream ring-buffer metadata packed into one slot:
    ///         head (next write index), count (entries stored 0..768), and
    ///         lastUpdateTimestamp (real block.timestamp of most recent
    ///         setValue/updateValue — feeds the cadence-gap check).
    ///         Previously this was three separate mappings; collapsing
    ///         them saves 2 SSTOREs per setValue (one slot written
    ///         instead of three).
    struct RingMeta {
        uint16 head;
        uint16 count;
        uint64 lastUpdateTimestamp;
        // 20 bytes unused — room for additional uint128 of future state.
    }
    mapping(uint32 => RingMeta) private ringMeta;

    // ========== Events ==========

    /// @notice The whole creation record: every StreamMeta field plus who created it, so a
    ///         reader rebuilds a stream from this log alone (`adapterId == 0` is Simple).
    ///         `creator` is the hub's caller and is not stored; `provider` is the key or
    ///         source the stream was given.
    event DataStreamCreated(
        uint32 indexed streamId,
        address indexed creator,
        address indexed provider,
        uint16 adapterId,
        uint24 minCadenceMinutes,
        bytes config,
        string name
    );
    /// @notice One-shot wiring of the named adapter (`setNamedAdapterId`).
    event NamedAdapterSet(uint16 indexed adapterId);
    /// @notice A named stream's Coined id, alongside its `DataStreamCreated`.
    event NamedStreamCreated(uint32 indexed streamId, bytes32 indexed nameKey);
    event StreamValueUpdated(uint32 indexed streamId, int256 oldValue, int256 newValue, uint256 hour);
    /// @notice One per `updateValues` call. `requested` is the batch size, `updated` how many
    ///         actually took a value — the difference is streams skipped (not due, or a
    ///         failed read). Per-stream detail is the `StreamValueUpdated` events above.
    event StreamValuesBatchUpdated(address indexed caller, uint256 requested, uint256 updated);
    /// @notice One per `setValues` call. `written` < `requested` means some streams were not
    ///         due yet; per-stream detail is the `StreamValueUpdated` events above.
    event StreamValuesBatchSet(address indexed provider, uint256 requested, uint256 written);
    event NameUpdated(uint32 indexed streamId, string newName);
    event ProviderChanged(uint32 indexed streamId, address indexed oldProvider, address indexed newProvider);
    event SatoriCoreSet(address indexed newCore);
    event AdapterRegistered(uint16 indexed adapterId, address indexed impl, address indexed registrant, bool community, string name);

    // ========== Custom Errors (Item P) ==========

    /// @notice Caller is neither the wired `satoriCore` (the hub) nor the `satoriEngine` — the two external
    /// gate for permissioned registry mutations).
    error OnlySatoriCore();
    /// @notice `streamId` is out of range (0 or > `streams.length`).
    error InvalidStreamId();
    /// @notice Caller is not the named provider for `streamId`. (For Simple
    /// streams, `provider` is the key-holding publisher; for Adapter
    /// streams, `provider` is the data-source contract — which never holds
    /// a private key — so authority-equivalent paths always revert.)
    error NotStreamProvider();
    /// @notice `setSatoriCore` / `setSatoriEngine` called by someone other than the deployer.
    error OnlyDeployer();
    /// @notice `setSatoriCore` called after it was already wired (one-shot).
    error CoreAlreadyInitialized();
    /// @notice `setSatoriCore` called with `address(0)`.
    error InvalidCoreAddress();
    /// @notice Stream creation called with a zero provider.
    error InvalidProvider();
    /// @notice `setProvider` / `setDataStreamName` called on an Adapter
    /// stream (provider is a data-source contract, not a key-holding
    /// publisher).
    error AdapterStreamImmutable();
    /// @notice `setValue` called on a non-Simple stream type.
    error NotSimpleStream();
    /// @notice `updateValue` called on a Simple stream (use `setValue`).
    error NotPullStream();
    /// @notice `createAdapterDataStream` / `updateValue` referenced an
    ///         `adapterId` that has not been registered (or ID 0).
    error UnknownAdapter();

    /// @dev `setValues` got id and value arrays of different lengths.
    error ArrayLengthMismatch();

    /// @dev Adapter read failed with no revert payload to re-throw (empty returndata,
    ///      a short buffer, or an out-of-int232-range value).
    error AdapterReadFailed();
    /// @notice `registerAdapter` exhausted the uint16 ID space (65535
    ///         adapters registered). Mirrors `GameAdapterIdSpaceExhausted`.
    error AdapterIdSpaceExhausted();
    /// @notice `registerAdapter` called with `impl == address(0)`.
    error InvalidAdapter();
    /// @notice Value write attempted before the stream's cadence round-guard
    /// (round-length-and-above cadences only) has
    ///         elapsed since the previous write. For a 1440-minute (daily)
    ///         stream this reduces to "twice in the same round."
    error CadenceRoundsNotElapsed();
    /// @notice Value write attempted before the wall-clock cadence gap has
    ///         elapsed since the previous write. The gap is
    ///         the cadence period (minus the 30-minute allowance for
    ///         round-length-and-above cadences; exact for sub-round ones).
    ///         A 60-minute stream waits the full 60 minutes (no slack); a
    ///         daily (1440-minute) stream waits 23.5 hours.
    error CadenceGapNotElapsed();
    // (ValueOverflow lives in the adapters, not here: the int232 range check
    // runs where raw oracle data first arrives — ChainlinkV3Adapter /
    // CustomAdapter — and their reverts bubble up through updateValue. The
    // registry never threw it; the dead declaration was removed — review #11.)
    /// @notice Stream creation called with `minCadenceMinutes` below the
    ///         60-minute hour-grid floor (the code reverts on anything < 60).
    error InvalidCadence();
    /// @notice A named stream with this exact name already exists.
    error NameTaken();
    /// @notice A named stream's config is its own id, written by the registry.
    error NamedStreamConfig();
    /// @notice `setValueForRound` was called with a round at or before the ring's
    ///         newest entry. The history ring must stay strictly round-ordered:
    ///         `getFirstTwoValuesAfter` walks it newest-to-oldest and takes the
    ///         first entry at or below the prediction round as the anchor, so an
    ///         out-of-order write would silently mis-score rather than fail loudly
    ///         (audit B-4).
    error NonMonotonicRound();

    // ========== Access Control ==========

    /// @dev On `provider` — what the inline provider checks and `meta.provider` mean:
    ///
    ///      Each `StreamMeta` carries a single `provider` address set at
    ///      creation. The role this address plays depends on the stream type:
    ///
    ///      SIMPLE STREAMS (`streamType == Simple`):
    ///        `provider` is a SCOPED PER-STREAM PUBLISHER ROLE — a key-holding
    ///        address that owns the stream's data path. Powers:
    ///          * `setValue`: push raw values into the ring buffer. The
    ///            provider IS the data oracle for Simple streams.
    ///          * `setDataStreamName`: rename their own stream.
    ///          * `setProvider`: hand the role off to a new address.
    ///
    ///      ADAPTER STREAMS (`streamType == Adapter`):
    ///        `provider` is the DATA-SOURCE CONTRACT the adapter reads from
    ///        (Chainlink feed, Uniswap pool, or a user-deployed `IDataStream`
    ///        contract). It is NOT a key-holding address — so `setValue`,
    ///        `setDataStreamName`, and `setProvider` all revert
    ///        (`AdapterStreamImmutable`). `updateValue` is permissionless and
    ///        unpaid — providers are not compensated by the protocol.
    ///        Adapter streams are set-and-forget; the data path is already
    ///        trust-minimized and no human admin is needed post-creation.
    ///
    ///      The unified `provider` field replaces the prior `authority` +
    ///      `target` pair (which together spanned two storage slots).
    ///      Folding them into one slot saves ~20K gas per stream creation
    ///      and reduces per-stream storage by one slot. See divergence
    ///      audit §3.4.
    ///
    ///      The provider role is NOT a protocol-level owner / admin. They
    ///      do NOT vote on the stream, do NOT control eligibility, do NOT
    ///      earn prediction rewards, do NOT gate games on the stream.

    modifier onlyCore() {
        if (msg.sender != satoriCore && msg.sender != satoriEngine) revert OnlySatoriCore();
        _;
    }

    function setSatoriEngine(address _engine) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (satoriEngine != address(0)) revert CoreAlreadyInitialized();
        if (_engine == address(0)) revert InvalidCoreAddress();
        satoriEngine = _engine;
    }

    // ========== Constructor ==========

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
        // declarations; exercised by test/next/ProxyUpgrades.test.js).
        nextAdapterId = 1;
        nextStreamId = 1;
    }

    // ========== Initialization ==========

    function setSatoriCore(address _satoriCore) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (satoriCore != address(0)) revert CoreAlreadyInitialized();
        if (_satoriCore == address(0)) revert InvalidCoreAddress();
        satoriCore = _satoriCore;
        // Resolve rewards once (the core is constructed with its sub-contracts,
        // so this is set by the time the registry is wired).
        satoriRewards = ISatoriCore(_satoriCore).satoriRewards();
        emit SatoriCoreSet(_satoriCore);
    }

    // ========== Adapter Registration ==========

    /// @notice Bind an adapter implementation to the next free adapter ID.
    /// @dev `onlyCore` — called via `SatoriHub.registerCommunityAdapter` (fee-paying, community=true) or `SatoriHub.registerAdapter` (admin-gated). The
    ///      core pulls any registration fee from `registrant` before
    ///      forwarding here. IDs are monotonically auto-assigned starting at
    ///      1 (ID 0 = "no adapter" sentinel for Simple streams) and never
    ///      reused — caller has no influence over the assignment, mirroring
    ///      games + game adapters. `name` is caller-supplied, not unique,
    ///      informational; the assigned numeric ID is the canonical handle.
    ///      The `community` flag is stored so dapps can distinguish official
    ///      vs community adapters without parsing event history.
    /// @return id The newly assigned adapter ID.
    function registerAdapter(address impl, string calldata name, address registrant, bool community)
        external onlyCore returns (uint16 id)
    {
        if (impl == address(0)) revert InvalidAdapter();
        id = nextAdapterId;
        if (id == 0) revert AdapterIdSpaceExhausted(); // wraparound past 65535
        adapter[id] = impl;
        adapterName[id] = name;
        if (community) isCommunityAdapter[id] = true;
        unchecked { nextAdapterId = id + 1; }
        emit AdapterRegistered(id, impl, registrant, community, name);
    }

    // ========== Stream Creation Functions ==========

    /**
     * @notice Create a Simple datastream in the registry
     * @param creator The hub's caller, logged and not stored
     * @param name Human-readable name for the datastream
     * @param provider Key-holding address that owns the stream's data path
     *                 (can `setValue`, rename, transfer, and receives the
     * @return streamId The newly created StreamId
     * @dev Core-only: Satori.createSimpleDataStream charges the spam fee
     *      (SatoriHub.createSimpleDataStream charges the stream fee via `_chargeStream`) before calling this. Exposing the registry path directly would let
     *      callers skip the fee.
     */
    function createSimpleDataStream(
        address creator,
        string memory name,
        address provider,
        uint24 minCadenceMinutes
    ) external onlyCore returns (uint32 streamId) {
        if (provider == address(0)) revert InvalidProvider();
        // The ring is keyed by HOUR (phase 6): one entry per hour at most, so
        // a cadence finer than the grid could not be represented.
        if (minCadenceMinutes < 60) revert InvalidCadence();

        streamId = nextStreamId++;

        streams.push(SatoriTypes.StreamMeta({
            provider: provider,
            streamType: uint8(SatoriTypes.DataStreamType.Simple),
            minCadenceMinutes: minCadenceMinutes,
            adapterId: 0,
            named: false,
            config: "",
            name: name
        }));

        emit DataStreamCreated(streamId, creator, provider, 0, minCadenceMinutes, "", name);

        return streamId;
    }

    /**
     * @notice Create an Adapter-type datastream backed by a registered adapter.
     * @param creator The hub's caller, logged and not stored
     * @param name Human-readable name for the datastream
     * @param adapterId Index into the adapter registry — the ID assigned via `registerAdapter`
     * @param provider Data-source contract address (feed, pool, or
     *                 user-deployed `IDataStream`) — passed to the adapter on
     *                 every read. For adapter streams this is NOT a
     *                 key-holding address and the stream becomes
     *                 set-and-forget after creation (no rename, no transfer).
     * @param config Adapter-specific extra bytes (e.g. ChainlinkV3 encodes `uint64 maxFeedAge` here; Uniswap and Custom ignore it)
     * @return streamId The newly created StreamId
     * @dev Core-only. The registered adapter's `validate(provider, config)` is
     *      invoked at creation time and reverts on bad config — meaning create
     *      transactions surface adapter-level config errors immediately rather
     *      than later at the first `updateValue`.
     */
    function createAdapterDataStream(
        address creator,
        string memory name,
        uint16 adapterId,
        address provider,
        bytes memory config,
        uint24 minCadenceMinutes
    ) external onlyCore returns (uint32 streamId) {
        if (provider == address(0)) revert InvalidProvider();
        // The ring is keyed by HOUR (phase 6): one entry per hour at most, so
        // a cadence finer than the grid could not be represented.
        if (minCadenceMinutes < 60) revert InvalidCadence();
        address impl = adapter[adapterId];
        if (impl == address(0)) revert UnknownAdapter();
        // Named streams snapshot on the hour grid and their game scores on the
        // 24h moment-anchored path, both of which assume exactly cadence 60.
        bool named = adapterId == namedAdapterId;
        bytes32 k;
        if (named) {
            if (minCadenceMinutes != 60) revert InvalidCadence();
            // The config names the stream being created, so only the registry
            // can know it race-free: a caller reading nextStreamId first loses
            // to any create landing in between.
            if (config.length != 0) revert NamedStreamConfig();
            config = abi.encode(uint32(nextStreamId));
            k = INamedStreamAdapter(impl).nameKey(name);
            if (namedNameTaken[k]) revert NameTaken();
            namedNameTaken[k] = true;
        }

        // Probe + parameter validation lives inside the adapter — reverts here
        // if (provider, config) is unusable for this adapter.
        IStreamAdapter(impl).validate(provider, config);

        streamId = nextStreamId++;

        streams.push(SatoriTypes.StreamMeta({
            provider: provider,
            streamType: uint8(SatoriTypes.DataStreamType.Adapter),
            minCadenceMinutes: minCadenceMinutes,
            adapterId: adapterId,
            named: named,
            config: config,
            name: name
        }));

        emit DataStreamCreated(streamId, creator, provider, adapterId, minCadenceMinutes, config, name);
        if (named) emit NamedStreamCreated(streamId, k);

        return streamId;
    }

    // ========== Stream Management Functions ==========

    /**
     * @notice Update the value of a Simple datastream
     * @dev Provider-gated. Two layered guards before advancing the ring:
     *      (1) a round-level cadence guard (`lastUpdateRound +
     *      cadence-rounds > currentRound`, round-length-and-above band
     *      only), and (2) a timestamp guard
     *      requiring the full cadence period minus a 30-minute slack to have
     *      elapsed in wall-clock time. A sub-round stream (e.g. 60 minutes)
     *      waits its full cadence with no slack; for daily (1440 minutes)
     *      the timestamp guard is 23h30m; for weekly (10080), ~6.979 days;
     *      for monthly (43200), ~29.979 days. In the round-and-above band
     *      the 30-minute slack is cadence-independent
     *      — it's the constant flexibility window for the provider to
     *      post slightly before the cadence anniversary. Identical-value
     *      writes are allowed — a legitimately-unchanged reading is still
     *      worth recording.
     */
    function setValue(uint32 streamId, int232 newValue) external {
        uint256 currentRound = ISatoriCore(satoriCore).getCurrentRound();
        uint8 code = _setValue(streamId, newValue, currentRound);
        if (code == SET_CAD_ROUNDS) revert CadenceRoundsNotElapsed();
        if (code == SET_CAD_GAP)    revert CadenceGapNotElapsed();
    }

    /**
     * @notice Push fresh values for MANY Simple streams in one transaction.
     * @dev The provider-gated sibling of `updateValues`, with DELIBERATELY DIFFERENT
     *      failure semantics, because the caller's relationship to the input differs:
     *
     *        `updateValues` is permissionless — a keeper sweeping a public list it does
     *        not own, which may contain ids that are invalid, not pullable, or not due.
     *        Everything is skipped.
     *
     *        `setValues` is the provider publishing THEIR OWN data. An id they do not
     *        own, a bad id, or a non-Simple stream in the list is a bug
     *        in their posting script, and silently dropping a price they believed they
     *        published is far worse than a reverted transaction they can see and fix. So
     *        those revert LOUDLY and the whole batch rolls back.
     *
     *      The two CADENCE guards are the exception and are skipped, because a provider
     *      sweeping streams of mixed cadence (every-round, daily, weekly) will always
     *      include some that are not due yet — a strict batch would revert on the first
     *      one and burn the transaction. A cadence skip means "the protocol correctly
     *      refused a too-early post", not "your data was lost"; the return value and the
     *      per-stream `StreamValueUpdated` events say exactly which took.
     *
     *      Parallel arrays rather than a struct array: a `struct[]` pays an extra offset
     *      word per element in calldata, which is the dominant cost on an L2.
     *
     *      Measured, 25 steady-state cadence-1 streams:
     *        individual : 136,671 gas/stream
     *        batched    :  68,189 gas/stream   — 50.1% less
     *      Same reason as `updateValues`: warm storage across the loop, plus
     *      `getCurrentRound()` collapsing from N external calls to one.
     *
     *      Size is the caller's job, as with `updateValues` — no on-chain cap.
     * @param streamIds Simple streams owned by `msg.sender`.
     * @param values Positionally matched new values.
     * @return written Count of streams that actually took a value.
     */
    function setValues(uint32[] calldata streamIds, int232[] calldata values)
        external
        returns (uint256 written)
    {
        if (streamIds.length != values.length) revert ArrayLengthMismatch();
        uint256 currentRound = ISatoriCore(satoriCore).getCurrentRound();
        for (uint256 i = 0; i < streamIds.length; i++) {
            if (_setValue(streamIds[i], values[i], currentRound) == SET_OK) written++;
        }
        emit StreamValuesBatchSet(msg.sender, streamIds.length, written);
    }

    // Outcome codes for the push path. Only the two cadence conditions are returned —
    // every caller error reverts inside `_setValue` itself, for both entry points.
    uint8 private constant SET_OK         = 0;
    uint8 private constant SET_CAD_ROUNDS = 1;
    uint8 private constant SET_CAD_GAP    = 2;

    // Shared cadence guard, two branches (design §6 of
    // docs/issues/rolling-24h-scoring.md lays out a three-band table; the
    // third band is a SCORING band, not a guard band — the guard itself
    // only distinguishes sub-round from round-and-above; phase 4):
    //   below a round  — elapsed time only, NO slack, no round anchor: the
    //                    stream may drift. Sub-round games cannot mint, so
    //                    drift costs nothing.
    //   a round & up   — both must hold: a new round has begun (the round
    //                    boundary re-anchors the stream) AND at least the
    //                    cadence minus the fixed 30-minute early allowance
    //                    has elapsed. Exactly today's behaviour,
    //                    minutes-denominated.
    // `lastCheckedTs` is RingMeta.lastUpdateTimestamp, which since 7.1 means
    // "last CHECKED": an unchanged adapter pull advances it without writing,
    // so this guard stops futile re-pulls (see _updateValue).
    uint8 private constant GUARD_OK     = 0;
    uint8 private constant GUARD_ROUNDS = 1;
    uint8 private constant GUARD_GAP    = 2;

    function _cadenceGuard(
        uint24 cadenceMinutes,
        uint24 lastWrittenRound,
        uint64 lastCheckedTs,
        uint256 currentRound
    ) private view returns (uint8) {
        uint256 cadenceSeconds = uint256(cadenceMinutes) * 60;
        if (cadenceSeconds < timeUnitSeconds) {
            return block.timestamp < uint256(lastCheckedTs) + cadenceSeconds
                ? GUARD_GAP : GUARD_OK;
        }
        // Round-equivalent for the boundary check; ceil so a cadence between
        // round multiples still waits for the later round.
        uint256 cadenceRounds = (cadenceSeconds + timeUnitSeconds - 1) / timeUnitSeconds;
        if (uint256(lastWrittenRound) + cadenceRounds > currentRound) return GUARD_ROUNDS;
        if (block.timestamp < uint256(lastCheckedTs) + cadenceSeconds - SatoriTypes.CADENCE_GAP_SLACK_SECONDS) {
            return GUARD_GAP;
        }
        return GUARD_OK;
    }

    /**
     * @dev Shared body of the two push entry points. Reverts on caller errors (shared by
     *      both); returns a code for the cadence guards so `setValues` can skip.
     * @param currentRound Passed in so a batch pays for `getCurrentRound()` once.
     */
    function _setValue(uint32 streamId, int232 newValue, uint256 currentRound)
        internal
        returns (uint8)
    {
        if (streamId == 0 || streamId > streams.length) revert InvalidStreamId();
        SatoriTypes.StreamMeta storage meta = streams[streamId - 1];
        if (msg.sender != meta.provider) revert NotStreamProvider();
        if (meta.streamType != uint8(SatoriTypes.DataStreamType.Simple)) revert NotSimpleStream();

        RingMeta storage sm = ringMeta[streamId];
        uint16 count = sm.count;
        int232 oldValue = count > 0 ? historyData[streamId][_newestSlot(streamId)].value : int232(0);

        if (count > 0) {
            // Ring entries are hour-keyed; the round-band guard wants the last
            // WRITTEN round, which is the entry's hour / 24.
            uint8 g = _cadenceGuard(
                meta.minCadenceMinutes,
                uint24(uint256(historyData[streamId][_newestSlot(streamId)].round) / 24),
                sm.lastUpdateTimestamp,
                currentRound
            );
            if (g == GUARD_ROUNDS) return SET_CAD_ROUNDS;
            if (g == GUARD_GAP)    return SET_CAD_GAP;
        }

        // Single SSTORE for head + count + timestamp (one packed slot).
        // Hour-keyed (phase 6): the entry records the HOUR it landed in. The
        // >= 60-minute cadence floor guarantees strictly increasing hours.
        uint24 hourNow = uint24(block.timestamp / 3600);
        _writeNewEntry(streamId, newValue, hourNow, uint64(block.timestamp));

        emit StreamValueUpdated(streamId, int256(oldValue), int256(newValue), uint256(hourNow));

        // Tell rewards this stream produced. Deduped there to the round's first
        // update. Pays nobody — providers are not compensated — but it freezes
        // the round's gross and ARMS any off-chain game pot on this stream.
        ISatoriRewards(satoriRewards).onStreamProduced(streamId);

        return SET_OK;
    }

    /**
     * @notice Core-only: write a value to the ring buffer for a specific round
     * @dev Used by the default stream flush path, and ONLY by it — the hub seeds
     *      the value at genesis and the engine writes it once per round from
     *      `flushDefaultStream`. Both pass DEFAULT_STREAM_ID. No cadence checks:
     *      the core is trusted to write correct round numbers. Advances the ring
     *      once per call.
     */
    function setValueForRound(uint32 streamId, int232 newValue, uint24 round) external onlyCore {
        if (streamId == 0 || streamId > streams.length) revert InvalidStreamId();

        int232 oldValue;
        if (ringMeta[streamId].count > 0) {
            HistoryEntry storage newest = historyData[streamId][_newestSlot(streamId)];
            oldValue = newest.value;
            // AUDIT B-4. `getFirstTwoValuesAfter` walks the ring newest-to-oldest
            // and stops at the FIRST entry with hour <= afterHour, treating it
            // as the anchor — which is only correct while ring rounds strictly
            // increase. Every writer maintains that (setValue / updateValue via
            // the cadence guard; and this
            // function's caller, SatoriEngine.flushDefaultStream, returns early
            // unless today > defaultStreamLastFlushedRound). But nothing here
            // ENFORCED it, and the core is upgradeable: a future hub writing a
            // round out of order would silently corrupt scoring rather than
            // revert. The newest entry is already loaded for oldValue, so the
            // guarantee costs one comparison.
            // Hour-keyed ring: this round-denominated write lands at the
            // round's FIRST hour, so monotonicity is checked in hours.
            if (uint256(round) * 24 <= uint256(newest.round)) revert NonMonotonicRound();
        }

        _writeNewEntry(streamId, newValue, uint24(uint256(round) * 24), uint64(block.timestamp));

        emit StreamValueUpdated(streamId, int256(oldValue), int256(newValue), uint256(round) * 24);

        // Tell rewards this stream produced. Deduped there to the round's first
        // update, so the once-per-round flush pays for it once.
        ISatoriRewards(satoriRewards).onStreamProduced(streamId);
    }

    /**
     * @notice Pull a fresh value from an external datastream (Custom, Chainlink, Uniswap)
     * @dev Permissionless — anyone can call. Enforces the same two guards
     *      as `setValue`: a round-level cadence guard and a wall-clock
     *      timestamp guard (cadence period − 30 minutes). Without these, a
     *      weekly-cadence stream could be ticked every
     *      round (once a day) by anyone calling `updateValue`, defeating
     *      the cadence promise. Follows
     *      Checks-Effects-Interactions: cadence is validated before any
     *      external call so a malicious target contract cannot observe or
     *      repeat-enter while the window is still open.
     */
    function updateValue(uint32 streamId) external {
        uint256 currentRound = ISatoriCore(satoriCore).getCurrentRound();
        (uint8 code, bytes memory readErr) = _updateValue(streamId, currentRound);
        if (code == UPD_OK) return;
        if (code == UPD_UNCHANGED) return; // checked, unchanged: success, no write
        if (code == UPD_BAD_ID)     revert InvalidStreamId();
        if (code == UPD_NOT_PULL)   revert NotPullStream();
        if (code == UPD_CAD_ROUNDS) revert CadenceRoundsNotElapsed();
        if (code == UPD_CAD_GAP)    revert CadenceGapNotElapsed();
        if (code == UPD_NO_ADAPTER) revert UnknownAdapter();
        // UPD_READ_FAILED. Re-throw the adapter's ORIGINAL revert payload verbatim so this
        // entry point's error surface is unchanged by the batch refactor — callers and the
        // adversarial suite still see e.g. `ChainlinkV3Adapter.Stale()`, not a wrapper.
        if (readErr.length > 0) {
            assembly { revert(add(readErr, 32), mload(readErr)) }
        }
        revert AdapterReadFailed();
    }

    /**
     * @notice Pull fresh values for MANY adapter streams in one transaction.
     * @dev Serves every adapter kind at once — Uniswap, Chainlink and Custom are all
     *      `DataStreamType.Adapter` and dispatch through the same
     *      `adapter[adapterId].readValue`, so this is adapter-agnostic by construction.
     *      Simple (push) streams are not pullable and are skipped; their provider uses
     *      `setValue`.
     *
     *      BEST-EFFORT BY DESIGN. Anything that would make the singular `updateValue`
     *      revert — unknown id, Simple stream, either cadence guard, missing adapter, a
     *      failing external read — is SKIPPED here and the sweep continues. That is not
     *      leniency, it is the only workable semantics: a caller sweeping their whole
     *      stream list will always include streams that are not due yet, so a strict batch
     *      would revert on the first one and burn the entire transaction. Returns the
     *      number actually written so the caller can reconcile.
     *
     *      A skipped stream leaves NO state behind — see `_updateValue` on why the
     *      adapter read now happens before any write.
     *
     *      WHY IT IS WORTH IT (measured, 25 steady-state custom streams):
     *        individual : 150,474 gas/stream
     *        batched    :  77,400 gas/stream   — 48.6% less
     *      Most of that is NOT the 21k base fee. It is warm storage: `satoriCore`,
     *      `satoriRewards`, the `adapter` mapping and the rewards contract's per-round
     *      state are all cold on the first stream and warm for every one after, and
     *      `getCurrentRound()` collapses from N external calls to one. On an L2 the
     *      calldata win compounds it — ~3.9x fewer bytes posted to L1 at 25 streams
     *      (one signed envelope instead of N).
     *
     *      SIZE IS THE CALLER'S JOB. At ~77k gas/stream the practical ceiling is the block
     *      gas limit — order 200-300 streams on Base, fewer on a 30M-limit chain. There is
     *      deliberately no on-chain cap: a cap cannot prevent an out-of-gas revert (which
     *      loses the whole batch anyway), and hard-coding one would age badly against
     *      changing block limits. Chunk on the client.
     * @param streamIds Ids to attempt, in any order. Duplicates are harmless — the second
     *        occurrence simply fails its own cadence guard and is skipped.
     * @return updated Count of streams that actually took a new value.
     */
    function updateValues(uint32[] calldata streamIds) external returns (uint256 updated) {
        // Hoisted out of the loop: the round is a pure function of block.timestamp, so it
        // is constant for the whole transaction. This turns N external calls into one.
        uint256 currentRound = ISatoriCore(satoriCore).getCurrentRound();
        for (uint256 i = 0; i < streamIds.length; i++) {
            (uint8 code, ) = _updateValue(streamIds[i], currentRound);
            if (code == UPD_OK) updated++;
        }
        emit StreamValuesBatchUpdated(msg.sender, streamIds.length, updated);
    }

    // Outcome codes shared by `updateValue` (which maps them back to its specific custom
    // errors) and `updateValues` (which swallows every non-OK code). Constants, so they
    // occupy no storage.
    uint8 private constant UPD_OK          = 0;
    uint8 private constant UPD_BAD_ID      = 1;
    uint8 private constant UPD_NOT_PULL    = 2;
    uint8 private constant UPD_CAD_ROUNDS  = 3;
    uint8 private constant UPD_CAD_GAP     = 4;
    uint8 private constant UPD_NO_ADAPTER  = 5;
    uint8 private constant UPD_READ_FAILED = 6;
    uint8 private constant UPD_UNCHANGED   = 7;

    /**
     * @dev The shared body of the two pull entry points. Returns an outcome code instead of
     *      reverting so the batch can skip; `readErr` carries the adapter's raw revert
     *      payload on UPD_READ_FAILED so the singular path can re-throw it verbatim.
     * @param currentRound Passed in rather than read here so a batch pays for
     *        `getCurrentRound()` once instead of once per stream.
     */
    function _updateValue(uint32 streamId, uint256 currentRound)
        internal
        returns (uint8, bytes memory)
    {
        if (streamId == 0 || streamId > streams.length) return (UPD_BAD_ID, "");
        SatoriTypes.StreamMeta storage meta = streams[streamId - 1];
        if (meta.streamType == uint8(SatoriTypes.DataStreamType.Simple)) return (UPD_NOT_PULL, "");

        // CHECKS: cadence is validated before any external call.
        RingMeta storage sm = ringMeta[streamId];
        uint16 count = sm.count;
        int232 oldValue = count > 0 ? historyData[streamId][_newestSlot(streamId)].value : int232(0);
        bool named = meta.named;

        if (count > 0 && named) {
            // Due iff the CLOCK HOUR advanced. An hour-H entry may only ever be
            // written by the FIRST touch of hour H — i.e. before any prediction
            // made in H, since the engine pulls before it moves the counter —
            // so an anchor can never contain the predictor's own flow.
            if (block.timestamp / 3600 <= uint256(sm.lastUpdateTimestamp) / 3600) {
                return (UPD_CAD_GAP, "");
            }
        } else if (count > 0) {
            // The shared cadence guard; see _cadenceGuard. Entry hours / 24
            // give the last written round for the round-band check.
            uint8 g = _cadenceGuard(
                meta.minCadenceMinutes,
                uint24(uint256(historyData[streamId][_newestSlot(streamId)].round) / 24),
                sm.lastUpdateTimestamp,
                currentRound
            );
            if (g == GUARD_ROUNDS) return (UPD_CAD_ROUNDS, "");
            if (g == GUARD_GAP)    return (UPD_CAD_GAP, "");
        }

        address impl = adapter[meta.adapterId];
        if (impl == address(0)) return (UPD_NO_ADAPTER, "");

        // Pull the fresh value. Explicit STATICCALL, and the ordering changed here versus
        // the pre-batch code, which bumped `lastUpdateTimestamp` BEFORE calling out and
        // leaned on the whole transaction reverting to undo it. A best-effort batch does
        // NOT revert, so that ordering would leave a stream whose read merely failed
        // sitting on a full cadence-period cooldown having never stored a value. Reading
        // first is also strictly better CEI, and it is safe precisely because this is a
        // STATICCALL: the adapter cannot mutate state, so it cannot reenter destructively
        // — a reentrant `updateValue` would itself revert on its first write, surfacing
        // here as an ordinary failed read. `_writeNewEntry` below is what actually records
        // `lastUpdateTimestamp`, so a failure genuinely leaves nothing behind.
        (bool ok, bytes memory ret) =
            impl.staticcall(abi.encodeCall(IStreamAdapter.readValue, (meta.provider, meta.config)));
        if (!ok || ret.length < 32) return (UPD_READ_FAILED, ret);

        // Load the word by hand rather than `abi.decode(ret, (int232))`: decoding a narrow
        // signed type reverts on dirty high bits, which a hostile adapter could use to blow
        // up the whole batch. Range-check instead and treat an out-of-band value as a
        // failed read.
        int256 raw;
        assembly { raw := mload(add(ret, 32)) }
        if (raw < type(int232).min || raw > type(int232).max) return (UPD_READ_FAILED, ret);
        int232 newValue = int232(raw);

        // Named streams ALWAYS write on a due pull: a predictor's own next
        // prediction pulls first, and that pull must land the previous
        // prediction's post sample before the new flow is added — even when
        // nobody else moved the counter in between.
        if (count > 0 && newValue == oldValue && !named) {
            // 7.1, option 3 (owner-decided 2026-09-05): an unchanged pull
            // advances the cadence clock WITHOUT writing a ring entry —
            // `lastUpdateTimestamp` means "last checked", not "last changed",
            // so there are no futile re-pulls and the ring keeps only real
            // movement. No event and no onStreamProduced: nothing was
            // produced. The engine's StaleValue guard reads WRITTEN rounds,
            // so a flat stream also accepts no new predictions — outstanding
            // predictions are capped at one and settle on the first real
            // move (design §7.1 and the corrected note in question 2).
            sm.lastUpdateTimestamp = uint64(block.timestamp);
            return (UPD_UNCHANGED, "");
        }

        // EFFECTS — hour-keyed (phase 6).
        uint24 hourNow = uint24(block.timestamp / 3600);
        _writeNewEntry(streamId, newValue, hourNow, uint64(block.timestamp));

        emit StreamValueUpdated(streamId, int256(oldValue), int256(newValue), uint256(hourNow));

        // Tell rewards this stream produced. Deduped there to the round's first
        // update. Pays nobody — providers are not compensated — but it freezes
        // the round's gross and ARMS any off-chain game pot on this stream.
        ISatoriRewards(satoriRewards).onStreamProduced(streamId);

        return (UPD_OK, "");
    }

    /**
     * @notice Update the name of a datastream
     * @dev Provider-gated. Reverts `AdapterStreamImmutable` on Adapter streams
     *      (their `provider` is a non-key-holding data-source contract that
     *      can never be `msg.sender`). Simple-stream providers can rename
     *      freely.
     */
    function setDataStreamName(uint32 streamId, string memory newName) external {
        if (streamId == 0 || streamId > streams.length) revert InvalidStreamId();
        SatoriTypes.StreamMeta storage meta = streams[streamId - 1];
        if (meta.streamType != uint8(SatoriTypes.DataStreamType.Simple)) revert AdapterStreamImmutable();
        if (msg.sender != meta.provider) revert NotStreamProvider();

        meta.name = newName;

        emit NameUpdated(streamId, newName);
    }

    /**
     * @notice Transfer the provider role of a datastream to a new address.
     * @dev Provider-gated. Reverts `AdapterStreamImmutable` on Adapter
     *      streams (their `provider` is the data-source contract — there
     *      is no role to transfer; create a new stream pointing at a
     *      different source instead).
     */
    function setProvider(uint32 streamId, address newProvider) external {
        if (streamId == 0 || streamId > streams.length) revert InvalidStreamId();
        SatoriTypes.StreamMeta storage meta = streams[streamId - 1];
        if (meta.streamType != uint8(SatoriTypes.DataStreamType.Simple)) revert AdapterStreamImmutable();
        if (msg.sender != meta.provider) revert NotStreamProvider();
        if (newProvider == address(0)) revert InvalidProvider();

        address oldProvider = meta.provider;
        meta.provider = newProvider;

        emit ProviderChanged(streamId, oldProvider, newProvider);
    }

    /**
     * @notice A stream's minimum cadence, in minutes.
     * @dev Fixed at creation and never changes — there is no setter anywhere in
     *      this contract, and `minCadenceMinutes` is written only by the two
     *      create paths. That immutability is what lets the ENGINE read cadence
     *      at settle time instead of snapshotting it into every prediction: a
     *      live read can never disagree with what was true when the prediction
     *      was made.
     *
     *      Deliberately narrower than `getLatestUpdateInfo`, which also touches
     *      `ringMeta` and the newest history entry. Callers that only need the
     *      cadence should pay for one SLOAD, not three.
     *      `streamMinCadenceMinutes` (below) is the strict-reverting twin,
     *      kept for integrator reads.
     */
    function streamScoringInfo(uint32 streamId) external view returns (uint24, bool) {
        if (streamId == 0 || streamId > streams.length) revert InvalidStreamId();
        SatoriTypes.StreamMeta storage meta = streams[streamId - 1];
        return (meta.minCadenceMinutes, meta.named);
    }

    // Streams are permanent — no `deleteStream`, no `StreamDeleted` event. A
    // stream's only mutable state is its ring buffer (values), its name/provider
    // (Simple streams, via setDataStreamName / setProvider), and its
    // SatoriVoting-side eligibility weight.

    // ========== Internal Buffer Helpers ==========

    /// @dev Slot index of the most recently written entry. Valid only when count > 0.
    function _newestSlot(uint32 streamId) internal view returns (uint16) {
        uint16 head = ringMeta[streamId].head;
        return uint16((uint256(head) + HISTORY_SIZE - 1) % HISTORY_SIZE);
    }

    /// @dev Write a new entry at head, advance head, bump count (up to
    ///      HISTORY_SIZE), and stamp the wall-clock timestamp. All three
    ///      ring-buffer-meta fields share one storage slot, so this is
    ///      a single SSTORE for metadata + one SSTORE for the entry itself.
    function _writeNewEntry(uint32 streamId, int232 value, uint24 round, uint64 timestamp) internal {
        RingMeta storage meta = ringMeta[streamId];
        uint16 head = meta.head;
        historyData[streamId][head] = HistoryEntry({ value: value, round: round });
        uint16 newHead = uint16((uint256(head) + 1) % HISTORY_SIZE);
        uint16 count = meta.count;
        meta.head = newHead;
        if (count < HISTORY_SIZE) meta.count = count + 1;
        meta.lastUpdateTimestamp = timestamp;
    }

    // ========== Stream Query Functions ==========

    // NOTE: invalid-streamId (0 or > streams.length) handling is intentionally
    // split between two groups of views:
    //   - Scoring-facing reads (getValue, getLatestUpdateInfo, getValueState /
    //     vstate, getHistory, wasStreamActiveInRound) silently return a benign
    //     zero/empty/false result for nonexistent ids instead of reverting, so
    //     hot-path callers and off-chain scoring can probe ids without try/catch.
    //   - Strict metadata/config reads (getDataStreamInfo, getValueAtHour,
    //     getRecentHistory, streamMinCadenceMinutes) revert InvalidStreamId on
    //     an unknown id.
    // Integrators should not treat a zero ValueState as proof a stream exists.

    function getValue(uint32 streamId) external view returns (int256) {
        if (streamId == 0 || streamId > streams.length) {
            return 0;
        }
        if (ringMeta[streamId].count == 0) return 0;
        return historyData[streamId][_newestSlot(streamId)].value;
    }

    /// @notice Hot-path slim view used by SatoriEngine's `predictMultipleWithPayloads` path /
    ///         `predictMultiple` (per-stream freshness + count + cadence).
    /// @dev Returns just the fields those callers use (count + latest
    ///      round + last-update timestamp + minCadenceMinutes) without
    ///      populating the 3-entry values/rounds arrays. Saves ~3K gas of
    ///      return-data encoding and ~4 internal SLOADs vs `getValueState`
    ///      for the common case. `minCadenceMinutes` and `named` share the
    ///      stream record's first slot and are folded into the same call, so
    ///      neither costs the engine a second external read per predict. NOTE (7.1): `lastUpdateTimestamp`
    ///      means "last CHECKED" — an unchanged adapter pull advances it
    ///      without writing; `latestRound` is the last WRITTEN round.
    function getLatestUpdateInfo(uint32 streamId) external view returns (
        uint16 count, uint64 latestHour, uint64 lastUpdateTimestamp, uint24 minCadenceMinutes, bool named
    ) {
        RingMeta storage sm = ringMeta[streamId];
        count = sm.count;
        lastUpdateTimestamp = sm.lastUpdateTimestamp;
        if (count > 0) {
            latestHour = uint64(historyData[streamId][_newestSlot(streamId)].round);
        }
        if (streamId > 0 && streamId <= streams.length) {
            SatoriTypes.StreamMeta storage meta = streams[streamId - 1];
            minCadenceMinutes = meta.minCadenceMinutes;
            named = meta.named;
        }
    }

    /**
     * @notice Short alias for `getValueState`. Returns the same slim
     *         last-3 view of a stream's value state. Declared on
     *         `ISatoriRegistry` since launch as external ABI surface
     *         (tests; potential UI/indexer reads); implementation forwards
     *         to `getValueState` so the two views can never drift.
     */
    function vstate(uint32 streamId) external view returns (SatoriTypes.ValueState memory) {
        return this.getValueState(streamId);
    }

    /**
     * @notice Get the last-3 view of a stream's value state (for A-B-C scoring)
     * @dev Synthesizes a 3-slot window over the 768-slot ring in the
     *      `ValueState` shape kept as external ABI surface (tests; potential
     *      UI/indexer reads). Newest entry
     *      lands at slot (count-1) in the returned struct; oldest at slot 0.
     */
    function getValueState(uint32 streamId) external view returns (SatoriTypes.ValueState memory vs) {
        uint16 internalCount = ringMeta[streamId].count;
        uint8 viewCount = internalCount > 3 ? 3 : uint8(internalCount);
        vs.count = viewCount;
        vs.lastUpdateTimestamp = ringMeta[streamId].lastUpdateTimestamp;

        if (viewCount == 0) return vs;

        uint256 head = uint256(ringMeta[streamId].head);
        for (uint256 i = 0; i < viewCount; i++) {
            // Walk forward from (newest - (viewCount-1)) to newest:
            // head points to next-write; newest = head-1, so slot for i is
            // (head - viewCount + i) mod HISTORY_SIZE.
            uint256 slot = (head + uint256(HISTORY_SIZE) - uint256(viewCount) + uint256(i)) % uint256(HISTORY_SIZE);
            HistoryEntry storage entry = historyData[streamId][uint16(slot)];
            vs.values[i] = entry.value;
            vs.rounds[i] = entry.round;
        }
        vs.currentIdx = viewCount - 1;
        return vs;
    }

    /**
     * @notice Get complete information about a datastream
     * @dev `exists` in the return tuple is preserved for ABI compatibility.
     *      Under the no-delete design it is always `true` for any valid
     *      `streamId` (the bounds check enforces that), and reverts the call
     *      for invalid IDs.
     */
    function getDataStreamInfo(uint32 streamId) external view returns (
        string memory name,
        address provider,
        uint8 streamType,
        int256 value,
        uint256 valueHour,
        bool exists
    ) {
        if (streamId == 0 || streamId > streams.length) revert InvalidStreamId();
        SatoriTypes.StreamMeta storage meta = streams[streamId - 1];

        int256 currentValue = 0;
        uint256 currentHour = 0;
        if (ringMeta[streamId].count > 0) {
            HistoryEntry storage newest = historyData[streamId][_newestSlot(streamId)];
            currentValue = int256(newest.value);
            currentHour = uint256(newest.round);
        }

        return (
            meta.name,
            meta.provider,
            meta.streamType,
            currentValue,
            currentHour,
            true
        );
    }

    function getDataStreamCount() external view returns (uint256) {
        return streams.length;
    }

    /**
     * @notice Minimum MINUTES that must elapse between successive value
     *         updates on this stream.
     * @dev 60 = hourly; 1440 = daily (every round); 10080 = weekly; 43200 = monthly; etc. Immutable post-creation.
     *      Updates can come slower; they cannot come faster. Per-stream knob
     *      that cadence-aware checks (predict-window staleness, update-gap
     *      floor) key off of.
     */
    function streamMinCadenceMinutes(uint32 streamId) external view returns (uint24) {
        if (streamId == 0 || streamId > streams.length) revert InvalidStreamId();
        return streams[streamId - 1].minCadenceMinutes;
    }

    function getAllDataStreams() external view returns (uint32[] memory) {
        uint256 n = streams.length;
        uint32[] memory result = new uint32[](n);
        for (uint256 i = 0; i < n; i++) {
            result[i] = uint32(i + 1);
        }
        return result;
    }

    /**
     * @notice Get a paginated slice of datastream IDs.
     * @dev Streams are permanent, so the result length always equals
     *      `min(limit, total - offset)` and `nextOffset` is the natural
     *      `offset + result.length`.
     */
    function getDataStreams(uint256 offset, uint256 limit)
        external view
        returns (uint32[] memory ids, uint256 nextOffset)
    {
        uint256 total = streams.length;
        if (offset >= total || limit == 0) {
            return (new uint32[](0), offset > total ? total : offset);
        }
        uint256 take = total - offset;
        if (take > limit) take = limit;
        ids = new uint32[](take);
        for (uint256 i = 0; i < take; i++) {
            ids[i] = uint32(offset + i + 1);
        }
        nextOffset = offset + take;
    }

    function streamExists(uint32 streamId) external view returns (bool) {
        return streamId > 0 && streamId <= streams.length;
    }

    /**
     * @notice Get value at a specific round
     * @dev Fall-back rules:
     *      - exact match → that value
     *      - newer than newest stored → newest value
     *      - between two stored rounds → older of the two
     *      - older than all stored rounds → 0
     */
    function getValueAtHour(uint32 streamId, uint256 hour) external view returns (int256) {
        if (streamId == 0 || streamId > streams.length) revert InvalidStreamId();

        uint256 count = uint256(ringMeta[streamId].count);
        if (count == 0) return 0;
        uint256 head = uint256(ringMeta[streamId].head);

        // Anchor semantics: the last entry at or before `hour` (exact match
        // or straddle both resolve to it); 0 when the hour predates
        // everything stored, and the newest value when it postdates it.
        uint256 p = _firstIndexAfter(streamId, hour, head, count);
        if (p == 0) return 0;
        return int256(historyData[streamId][_slotOf(head, count, p - 1)].value);
    }

    // ---- Bracketed boundary search (phase 3 of the rolling-scoring
    // redesign, docs/issues/rolling-24h-scoring.md section 9.5). ----
    //
    // Ring entries are STRICTLY INCREASING in `round` — every writer
    // guarantees it (the cadence guards on setValue/updateValue; the
    // NonMonotonicRound check on setValueForRound) — and a stream writes at
    // most one entry per round. Those two facts give a computed two-sided
    // bracket for any round query: between two entries, index distance is at
    // most round distance, so the first entry with round > afterRound lies in
    // [count-1-(newestRound-afterRound-1), afterRound+1-oldestRound], clamped
    // to [0, count]. A recent anchor — the common scoring case — brackets to
    // a couple of slots before the binary search even starts; a stale one
    // falls back to log2(count) probes instead of the old walk's linear cost.
    // The bound survives the hour-keyed ring of the later phases unchanged:
    // at the minimum one-hour cadence there is still at most one entry per
    // key, which is the only fact the bracket uses.

    /// @dev Physical slot of logical index `i` (0 = oldest, count-1 = newest).
    function _slotOf(uint256 head, uint256 count, uint256 i) private pure returns (uint16) {
        return uint16((head + uint256(HISTORY_SIZE) - count + i) % uint256(HISTORY_SIZE));
    }

    /// @dev First logical index whose entry has round STRICTLY greater than
    ///      `afterRound`; `count` when none qualifies (query at or past the
    ///      newest), 0 when even the oldest qualifies (anchor evicted, for
    ///      callers that need an anchor). Requires `count >= 1`.
    function _firstIndexAfter(uint32 streamId, uint256 afterRound, uint256 head, uint256 count)
        private view returns (uint256)
    {
        uint256 newestRound = uint256(historyData[streamId][_slotOf(head, count, count - 1)].round);
        if (afterRound >= newestRound) return count;
        uint256 oldestRound = uint256(historyData[streamId][_slotOf(head, count, 0)].round);
        if (afterRound < oldestRound) return 0;
        // oldestRound <= afterRound < newestRound: tighten both sides with the
        // round arithmetic above, then binary-search the bracket.
        uint256 hi = afterRound + 1 - oldestRound;          // boundary <= hi
        if (hi > count) hi = count;
        uint256 span = newestRound - afterRound - 1;        // entries certainly above
        uint256 lo = span >= count - 1 ? 0 : count - 1 - span; // boundary >= lo
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (uint256(historyData[streamId][_slotOf(head, count, mid)].round) > afterRound) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        return lo;
    }


    /**
     * @notice Anchor and target for MOMENT-ANCHORED scoring (phase 6, design
     *         9.5): `anchor` is the last entry at or before `anchorHour`;
     *         `post` is the first entry STRICTLY AFTER `targetAfterHour`.
     *         Band 3 (round-length-and-above cadences) passes
     *         `targetAfterHour == anchorHour` — the next sample; band 1 passes
     *         `anchorHour + waitHours - 1` so the target is the first sample at
     *         least the game's target after the prediction's hour.
     * @dev Same tri-state contract as `getFirstTwoValuesAfter`:
     *      found=false + anchorEvicted=false is recoverable (wait for data);
     *      anchorEvicted=true means the ring rolled past the anchor —
     *      force-finalize.
     */
    function getAnchorFirstAfter(uint32 streamId, uint256 anchorHour, uint256 targetAfterHour)
        external view
        returns (int232 anchor, int232 post, bool found, bool anchorEvicted)
    {
        RingMeta storage sm = ringMeta[streamId];
        uint256 count = uint256(sm.count);
        if (count < 2) return (0, 0, false, false);
        uint256 head = uint256(sm.head);
        uint256 pa = _firstIndexAfter(streamId, anchorHour, head, count);
        if (pa == 0) return (0, 0, false, true); // anchor rolled out of the ring
        uint256 pt = _firstIndexAfter(streamId, targetAfterHour, head, count);
        if (pt == count) return (0, 0, false, false); // target not landed yet
        return (
            historyData[streamId][_slotOf(head, count, pa - 1)].value,
            historyData[streamId][_slotOf(head, count, pt)].value,
            true,
            false
        );
    }

    /**
     * @notice Find the first two stream updates with hour strictly > afterHour
     * @dev Bracketed binary search over the ring (see `_firstIndexAfter`).
     *      Scoring uses this to locate the B (first post-prediction tick) and
     *      C (second post-prediction tick) values for a prediction made at
     *      `afterHour`. Tolerating up to HISTORY_SIZE − 2 = 766 stream updates
     *      between prediction and scoring is what enables intermittent
     *      prediction without the outcome drifting.
     *
     *      `anchorEvicted` distinguishes the two failure modes for callers
     *      that need to know whether to retry later or give up:
     *      - found=false, anchorEvicted=false → recoverable. Either the
     *        stream hasn't ticked twice past `afterHour` yet, or only B
     *        exists and C is still pending. Caller should leave the slot
     *        unscored and check again later.
     *      - found=false, anchorEvicted=true → irrecoverable. The 768-slot
     *        ring has rolled past the prediction's anchor; the anchor and
     *        any post-prediction ticks that depended on it are gone. The
     *        caller should force-finalize the slot rather than waiting.
     * @return valueB First post-prediction value (oldest qualifying)
     * @return valueC Second post-prediction value (next-oldest qualifying)
     * @return found True iff both B and C were located in the buffer
     * @return anchorEvicted True iff the prediction's anchor (an entry with
     *         hour <= afterHour) is no longer present in the ring buffer
     */
    function getFirstTwoValuesAfter(uint32 streamId, uint256 afterHour)
        external view
        returns (int232 valueB, int232 valueC, bool found, bool anchorEvicted)
    {
        RingMeta storage sm = ringMeta[streamId];
        uint256 count = uint256(sm.count);
        if (count < 2) {
            // Either no history yet or only one entry — not enough for ABC.
            // Recoverable: the caller waits for more posts.
            return (0, 0, false, false);
        }
        uint256 head = uint256(sm.head);
        uint256 p = _firstIndexAfter(streamId, afterHour, head, count);
        if (p == 0) {
            // Even the oldest entry postdates the anchor: the ring has rolled
            // past the prediction. Irrecoverable — force-finalize (the
            // predictor's own inaction stranded the slot).
            return (0, 0, false, true);
        }
        if (count - p < 2) {
            // Anchor exists but fewer than 2 post-anchor entries — B (and
            // maybe C) still pending. Recoverable: wait for more posts.
            return (0, 0, false, false);
        }
        return (
            historyData[streamId][_slotOf(head, count, p)].value,
            historyData[streamId][_slotOf(head, count, p + 1)].value,
            true,
            false
        );
    }

    /**
     * @notice Find the first stream update with hour strictly > afterHour.
     * @dev Companion to `getFirstTwoValuesAfter`, used by the AB scoring path
     *      for streams that don't update every round (cadence >= 2). Same
     *      boundary-search semantics — just takes the first post-anchor tick
     *      instead of waiting for a second one.
     *
     *      The three observable outcomes mirror the ABC variant:
     *      - found=true, anchorEvicted=false: `valueB` is the first
     *        post-anchor tick (callers wanting the anchor too should use
     *        `getAnchorFirstAfter`, which returns both sides consistently).
     *      - found=false, anchorEvicted=false: recoverable. The stream
     *        hasn't ticked past `afterHour` yet (or has fewer than two
     *        history entries). Leave the slot unscored and check again
     *        later.
     *      - found=false, anchorEvicted=true: irrecoverable. The ring
     *        rolled past the prediction's anchor — force-finalize the slot.
     */
    function getFirstValueAfter(uint32 streamId, uint256 afterHour)
        external view
        returns (int232 valueB, bool found, bool anchorEvicted)
    {
        RingMeta storage sm = ringMeta[streamId];
        uint256 count = uint256(sm.count);
        if (count < 2) {
            // Need at least one anchor + one post-anchor entry to score AB.
            // Recoverable: wait for more posts.
            return (0, false, false);
        }
        uint256 head = uint256(sm.head);
        uint256 p = _firstIndexAfter(streamId, afterHour, head, count);
        if (p == 0) {
            // Anchor evicted — force-finalize (predictor's inaction).
            return (0, false, true);
        }
        if (p == count) {
            // Anchor exists but no post-anchor tick yet — recoverable.
            return (0, false, false);
        }
        return (historyData[streamId][_slotOf(head, count, p)].value, true, false);
    }

    /**
     * @notice Get recent history for a stream (last 3 values). External ABI
     *         surface (tests; potential UI/indexer reads).
     * @return values Array of up to 3 historical values (oldest to newest)
     * @return updateHours Array of corresponding hour numbers (the ring is
     *         hour-keyed; `hours` itself is a reserved Solidity denomination)
     */
    function getRecentHistory(uint32 streamId) external view returns (
        int256[] memory values,
        uint256[] memory updateHours
    ) {
        if (streamId == 0 || streamId > streams.length) revert InvalidStreamId();

        uint16 internalCount = ringMeta[streamId].count;
        uint8 viewCount = internalCount > 3 ? 3 : uint8(internalCount);

        values = new int256[](viewCount);
        updateHours = new uint256[](viewCount);

        if (viewCount == 0) return (values, updateHours);

        uint256 head = uint256(ringMeta[streamId].head);
        for (uint256 i = 0; i < viewCount; i++) {
            uint256 slot = (head + uint256(HISTORY_SIZE) - uint256(viewCount) + uint256(i)) % uint256(HISTORY_SIZE);
            HistoryEntry storage entry = historyData[streamId][uint16(slot)];
            values[i] = int256(entry.value);
            updateHours[i] = uint256(entry.round);
        }

        return (values, updateHours);
    }

    /**
     * @notice Full 768-slot history (oldest → newest) for UI chart rendering
     * @return values Array of stored values (oldest to newest)
     * @return rounds Array of corresponding round numbers
     * @return count Number of entries stored (0-768)
     */
    function getHistory(uint32 streamId) external view returns (
        int232[] memory values,
        uint24[] memory rounds,
        uint16 count
    ) {
        count = ringMeta[streamId].count;
        values = new int232[](count);
        rounds = new uint24[](count);

        if (count == 0) return (values, rounds, count);

        uint256 head = uint256(ringMeta[streamId].head);
        // Oldest slot = (head - count) mod SIZE
        for (uint256 i = 0; i < count; i++) {
            uint256 slot = (head + uint256(HISTORY_SIZE) - uint256(count) + uint256(i)) % uint256(HISTORY_SIZE);
            HistoryEntry storage entry = historyData[streamId][uint16(slot)];
            values[i] = entry.value;
            rounds[i] = entry.round;
        }

        return (values, rounds, count);
    }

    /**
     * @notice Paged slice of the history ring, oldest -> newest within the
     *         requested window. `offset` counts back from the NEWEST entry
     *         (0 = the window ending at the newest), `limit` caps the entries
     *         returned. The full-ring `getHistory` stays for completeness, but
     *         at 768 hourly entries it is a 24x payload — chart readers should
     *         page.
     * @return values Values, oldest -> newest within the window
     * @return entryHours Matching entry hours
     * @return total  Total entries currently stored (for pagers)
     */
    function getHistoryPage(uint32 streamId, uint256 offset, uint256 limit)
        external view returns (int232[] memory values, uint24[] memory entryHours, uint16 total)
    {
        total = ringMeta[streamId].count;
        if (limit == 0 || offset >= total) return (values, entryHours, total);
        uint256 take = uint256(total) - offset;      // entries older than the offset window's end
        if (take > limit) take = limit;
        values = new int232[](take);
        entryHours = new uint24[](take);
        uint256 head = uint256(ringMeta[streamId].head);
        // Window's newest logical index = total-1-offset; oldest = that-take+1.
        uint256 start = uint256(total) - offset - take; // logical index of the window's oldest
        for (uint256 i = 0; i < take; i++) {
            uint256 slot = (head + uint256(HISTORY_SIZE) - uint256(total) + start + i) % uint256(HISTORY_SIZE);
            HistoryEntry storage entry = historyData[streamId][uint16(slot)];
            values[i] = entry.value;
            entryHours[i] = entry.round;
        }
    }

    /// @notice The SatoriEngine, a second authorized caller of onlyCore methods
    ///         (setValueForRound via flushDefaultStream).
    address public satoriEngine;

    /// @notice The SatoriToken — upgrade-gate pointer (appended, phase 2).
    address public satoriToken;

    // ========== Phase-2 proxy plumbing (appended — append-only layout) ==========

    /// @dev Set by BOTH init paths: the implementation constructor (locking the
    ///      raw implementation instance) and the proxy `initialize` (making it
    ///      one-shot).
    bool private _initialized;

    /// @notice The adapter whose streams are NAMED streams: value = the engine's
    ///         per-game prediction-flow counter, snapshotted on the hour grid.
    uint16 public namedAdapterId;

    /// @notice Coined id (the named adapter's `nameKey`) of every named stream
    ///         created: names are unique among named streams as Coined terms
    ///         (ends trimmed, case kept; Simple streams are unaffected).
    mapping(bytes32 => bool) public namedNameTaken;

    /// nextStreamId == 1: a stream created before wiring would silently be an
    /// ordinary adapter stream.
    function setNamedAdapterId(uint16 id) external {
        if (msg.sender != deployer) revert OnlyDeployer();
        if (namedAdapterId != 0 || nextStreamId != 1) revert CoreAlreadyInitialized();
        if (id == 0 || adapter[id] == address(0)) revert UnknownAdapter();
        namedAdapterId = id;
        emit NamedAdapterSet(id);
    }

    /// @notice Set once, at creation: a later change of `namedAdapterId` cannot
    ///         turn an existing named stream into an ordinary one mid-game.
    function isNamedStream(uint32 streamId) external view returns (bool) {
        return streamId != 0 && streamId <= streams.length && streams[streamId - 1].named;
    }

    /// Upgrade authority = the token's `upgradeAuthority` (same key as the engine).
    /// Compile-time identity — pinned by SatoriUUPS.upgradeTo so only another
    /// SatoriRegistry implementation can ever be installed here.
    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriRegistry");
    }

    function _upgradeGovernor() internal view override returns (address) {
        return ISatoriUpgradeAuthority(satoriToken).upgradeAuthority();
    }
}
