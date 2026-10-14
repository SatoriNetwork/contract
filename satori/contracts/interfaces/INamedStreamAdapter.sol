// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice The one call SatoriRegistry makes on the named adapter beyond
///         IStreamAdapter: a name's Coined id, coining it if it is new.
interface INamedStreamAdapter {
    /// @dev Not a view: registers the name on Coined. Coined's own reverts
    ///      (EmptyName / BadName / MixedScript) propagate unwrapped.
    function nameKey(string calldata name) external returns (bytes32);
}
