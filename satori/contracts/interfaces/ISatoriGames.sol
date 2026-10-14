// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISatoriGames
 * @notice External-call interface for the game registry. Mirrors the
 *         `ISatoriRegistry` pattern — defines only what other contracts
 *         (Satori core, Rewards, Voting) need to call on SatoriGames.
 */
interface ISatoriGames {
    struct GameMeta {
        address authority;
        uint16  gameTypeId;
        uint32  dataStreamId;
        uint24  targetMinutes;
        string  name;
        bytes   gameConfig;
    }

    /// @notice One-shot wiring at deploy. Resolves the data-stream registry off the core.
    function setSatoriCore(address _satoriCore) external;

    /// @notice Bind an adapter implementation to the next free game type ID.
    function registerGameAdapter(
        address impl,
        address registrant,
        string calldata name,
        bool isCommunity
    ) external returns (uint16 gameTypeId);

    /// @notice Create a game pointing at an existing data stream.
    function createGame(
        address authority,
        uint32 streamId,
        uint16 gameTypeId,
        bytes memory gameConfig,
        string memory name
    ) external returns (uint32 gameId);
    function createGame(address authority, uint32 streamId, uint16 gameTypeId, bytes memory config, string memory name, uint24 targetMinutes_) external returns (uint32);

    function setGameName(uint32 gameId, string memory newName) external;
    function setGameAuthority(uint32 gameId, address newAuthority) external;

    function gameMeta(uint32 gameId) external view returns (GameMeta memory);
    function dataStreamId(uint32 gameId) external view returns (uint32);
    function targetMinutes(uint32 gameId) external view returns (uint24);
    function gameAdapter(uint16 gameTypeId) external view returns (address);
    function gameAdapterAddress(uint16 gameTypeId) external view returns (address);
    function gameAdapterFor(uint32 gameId) external view returns (address);
    function gameTypeIdOf(uint32 gameId) external view returns (uint16);
    function gameConfig(uint32 gameId) external view returns (bytes memory);
    /// @return adapter  the game's adapter, or address(0) for built-in binary
    /// @return streamId  the stream it reads, or 0 if the game does not exist
    function gameDispatch(uint32 gameId)
        external view returns (address adapter, uint32 streamId);
    function isCommunityGameAdapter(uint16 gameTypeId) external view returns (bool);
    function isRegisteredGameAdapter(address adapter) external view returns (bool);
    function gameAuthority(uint32 gameId) external view returns (address);
    function gameCount() external view returns (uint256);
    function gameExists(uint32 gameId) external view returns (bool);
    function gamesByStream(uint32 streamId) external view returns (uint32[] memory);
    function binaryGameByStream(uint32 streamId) external view returns (uint32);
    function gamesByStreamCount(uint32 streamId) external view returns (uint256);
}
