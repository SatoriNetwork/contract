// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IRegistryForBounties.sol";
import "./IRegistryForLens.sol";

import "../libraries/SatoriTypes.sol";

interface ISatoriRegistry is IRegistryForBounties, IRegistryForLens {
    // ========== Initialization ==========

    function setSatoriCore(address _satoriCore) external;

    // ========== Stream Creation ==========

    function createSimpleDataStream(
        address creator,
        string memory name,
        address provider,
        uint24 minCadenceMinutes
    ) external returns (uint32);

    function createAdapterDataStream(
        address creator,
        string memory name,
        uint32 adapterId,
        address provider,
        bytes memory config,
        uint24 minCadenceMinutes
    ) external returns (uint32);


    function adapter(uint32 id) external view returns (address);
    function adapterName(uint32 id) external view returns (string memory);
    function isCommunityAdapter(uint32 id) external view returns (bool);
    function nextAdapterId() external view returns (uint32);
    function registerAdapter(address impl, string calldata name, address registrant, bool community) external returns (uint32 id);

    function streamMinCadenceMinutes(uint32 streamId) external view returns (uint24);

    function namedAdapterId() external view returns (uint32);

    // ========== Stream Management ==========

    function setValue(uint32 streamId, int232 newValue) external;
    function updateValue(uint32 streamId) external;
    function updateValuesStrict(uint32[] calldata streamIds) external returns (uint32 failed);
    /// Best-effort batch pull: ticks each adapter stream whose cadence has
    /// elapsed and silently skips the rest (not due, Simple, or failing). An
    /// adapter that fails or returns bad data is skipped, but running out of gas
    /// or an oversized return buffer still reverts the whole call. Returns how
    /// many were actually written.
    function updateValues(uint32[] calldata streamIds) external returns (uint256 updated);
    function setDataStreamName(uint32 streamId, string memory newName) external;
    function setProvider(uint32 streamId, address newProvider) external;

    // ========== Stream Queries ==========

    function getValue(uint32 streamId) external view returns (int256);
    function getDataStreamInfo(uint32 streamId) external view returns (
        string memory name,
        address provider,
        uint8 streamType,
        int256 value,
        uint256 valueHour,
        bool exists
    );
    function getDataStreamCount() external view returns (uint256);
    function getAllDataStreams() external view returns (uint32[] memory);
    function getAnchorFirstAfter(uint32 streamId, uint256 anchorHour, uint256 targetAfterHour) external view returns (int232 anchor, int232 post, bool found, bool anchorEvicted);
    function getRecentHistory(uint32 streamId) external view returns (
        int256[] memory values,
        uint256[] memory updateHours
    );
    function getFirstTwoValuesAfter(uint32 streamId, uint256 afterHour) external view returns (
        int232 valueB,
        int232 valueC,
        bool found,
        bool anchorEvicted
    );

    // ========== State Access ==========

    function nextStreamId() external view returns (uint32);
    function vstate(uint32 streamId) external view returns (SatoriTypes.ValueState memory);
    function getValueState(uint32 streamId) external view returns (SatoriTypes.ValueState memory);
    function getHistoryPage(uint32 streamId, uint256 offset, uint256 limit) external view returns (int232[] memory values, uint24[] memory entryHours, uint16 total);
    function getLatestUpdateInfo(uint32 streamId) external view returns (uint16 count, uint64 latestHour, uint64 lastUpdateTimestamp, uint24 minCadenceMinutes, bool named, int232 latestValue);

    /// A stream's minimum cadence in minutes and whether it is a named stream.
    /// Both immutable after creation, which is why the engine may read them at
    /// settle time rather than caching them.
    function streamScoringInfo(uint32 streamId) external view returns (uint24 minCadenceMinutes, bool named);

    // ========== Events ==========

    /// @notice The whole creation record: every StreamMeta field plus who created it, so a
    ///         reader rebuilds a stream from this log alone (`adapterId == 0` is Simple).
    ///         `creator` is the hub's caller and is not stored; `provider` is the key or
    ///         source the stream was given.
    event DataStreamCreated(
        uint32 indexed streamId,
        address indexed creator,
        address indexed provider,
        uint32 adapterId,
        uint24 minCadenceMinutes,
        bytes config,
        string name
    );
    /// @notice One-shot wiring of the named adapter (`setNamedAdapterId`).
    event NamedAdapterSet(uint32 indexed adapterId);
    /// @notice A Sentiment stream's name key, alongside its `DataStreamCreated`.
    event NamedStreamCreated(uint32 indexed streamId, bytes32 indexed nameKey);
    event AdapterRegistered(uint32 indexed adapterId, address indexed impl, address indexed registrant, bool community, string name);
    event StreamValueUpdated(uint32 indexed streamId, int256 oldValue, int256 newValue, uint256 hour);
    event NameUpdated(uint32 indexed streamId, string newName);
    event ProviderChanged(uint32 indexed streamId, address indexed oldProvider, address indexed newProvider);
    event SatoriCoreSet(address indexed newCore);
}
