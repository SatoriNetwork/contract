// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IStreamAdapter
 * @notice Pull-based oracle adapter interface for Adapter-type streams.
 * @dev Every adapter is registered against a `uint16 adapterId` in
 *      `SatoriRegistry.adapter`. Adapter IDs are immutable once registered
 *      — the owner can register new IDs but never replace one — so existing
 *      streams never have their adapter swapped out from under them.
 *
 *      `target` is the primary address argument (typically the feed,
 *      pool, or custom-contract address). `config` is arbitrary extra
 *      bytes that the adapter decodes (e.g. Chainlink encodes `maxFeedAge`
 *      here; Uniswap and Custom adapters ignore `config`).
 */
interface IStreamAdapter {
    /// @notice Pull the current value from the underlying source.
    /// @dev MUST be view (no state mutation). Called inside
    ///      `SatoriRegistry.updateValue` on every pull. The registry
    ///      enforces cadence guards before calling this; the adapter
    ///      is responsible only for the read itself.
    function readValue(address target, bytes calldata config)
        external view returns (int232);

    /// @notice Create-time validation. Called once by
    ///         `SatoriRegistry.createAdapterDataStream`. Reverts on bad
    ///         (target, config); passes silently on good. Adapters MAY
    ///         do a probe call to the target to confirm it responds.
    function validate(address target, bytes calldata config)
        external view;
}
