// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IStreamAdapterUIDescriptor
 * @notice OPTIONAL, view-only UI descriptor for stream adapters.
 *
 * @dev This interface is a *reference* surface for dapps/UIs only. It is
 *      deliberately NOT part of the stream/adapter protocol:
 *        - The core contracts (SatoriToken/SatoriEngine/SatoriHub), the registry (SatoriRegistry.sol),
 *          SatoriGames.sol, and ISatoriCore.sol NEVER reference, require, or
 *          call these methods.
 *        - There is NO enforcement: a stream adapter MAY implement it to
 *          advertise how its create-stream form and value display should be
 *          rendered, but nothing on-chain depends on it. Adapters stay
 *          append-only and freely deployable, so the UI surface can evolve
 *          without touching the frozen surface.
 *        - Every method is `view`. `valueDisplay` in particular MUST NOT
 *          revert: any external probe of `target` must be wrapped in
 *          try/catch and fall back to sane defaults.
 */
interface IStreamAdapterUIDescriptor {
    function uiSchemaVersion() external view returns (uint16);

    // Create-STREAM config form: JSON describing the fields the creator fills and their abi types.
    // Encoded into the stream's adapter `config` bytes via AbiCoder.encode(fields.map(type), values) IN ORDER.
    function configSchema() external view returns (string memory);

    // How to render this stream's value. Parameterized by (target, config) like readValue, because
    // e.g. Chainlink decimals/description live on the target aggregator, not the adapter.
    // MUST NOT revert — wrap any external probe of target in try/catch and fall back.
    function valueDisplay(address target, bytes calldata config)
        external view returns (uint8 decimals, string memory unit, string memory label);
}
