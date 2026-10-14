// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IGameUIDescriptor
 * @notice OPTIONAL, view-only UI descriptor for prediction games.
 *
 * @dev This interface is a *reference* surface for dapps/UIs only. It is
 *      deliberately NOT part of the prediction protocol:
 *        - The core contracts (SatoriToken/SatoriEngine/SatoriHub), SatoriGames.sol, ISatoriCore.sol,
 *          and the registry NEVER reference, require, or call these methods.
 *        - There is NO enforcement: a game adapter MAY implement it to
 *          advertise how its create-game form and predict input should be
 *          rendered, but nothing on-chain depends on it.
 *        - Every method is `view` and MUST NOT revert, with the single
 *          permitted exception of an out-of-range option `index` in
 *          `optionLabel` / `optionPayload` (which may revert with a custom
 *          error such as IndexOutOfRange).
 *
 *      Discrete-choice predict inputs are the common case (e.g. YES/NO):
 *      `optionCount` / `optionLabel` / `optionPayload` describe the buttons
 *      and the exact predict payload bytes each maps to. When a game's input
 *      is not a discrete choice (a number, text, or range), `optionCount`
 *      returns 0 and the UI falls back to the JSON form in
 *      `predictInputSchema`.
 */
interface IGameUIDescriptor {
    function uiSchemaVersion() external view returns (uint16);
    // Discrete-choice predict input (the common case). gameId-parameterized so labels
    // can derive from THIS game's config. If optionCount(gameId)==0, the UI reads predictInputSchema.
    function optionCount(uint32 gameId) external view returns (uint256);
    function optionLabel(uint32 gameId, uint256 index) external view returns (string memory);
    function optionPayload(uint32 gameId, uint256 index) external view returns (bytes memory);
    // Escape hatch for non-discrete inputs (number/text/range): a JSON form schema; "" when discrete.
    function predictInputSchema(uint32 gameId) external view returns (string memory);
    // Create-game config form: JSON describing the fields the creator fills and their abi types.
    function configSchema() external view returns (string memory);
    // Optional result rendering: human label for a winning bucket.
    function bucketLabel(uint32 gameId, uint96 bucket) external view returns (string memory);
}
