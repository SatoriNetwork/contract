// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IStreamAdapter.sol";
import "../interfaces/IStreamAdapterUIDescriptor.sol";

/**
 * @title CustomAdapter
 * @notice Canonical adapter for user-deployed `IDataStream` contracts.
 * @dev Unlike Chainlink and Uniswap, `validate` deliberately does NOT probe the
 *      target: a custom stream may legitimately not return a value yet at
 *      creation time (awaiting first oracle push). Do not add a probe here — it
 *      would reject valid streams; a bad target only manifests on read.
 */
interface IDataStream {
    function getValue() external view returns (int256);
}

contract CustomAdapter is IStreamAdapter, IStreamAdapterUIDescriptor {
    error InvalidTarget();
    error ValueOverflow();

    function readValue(address target, bytes calldata /* config */)
        external view override returns (int232)
    {
        int256 value = IDataStream(target).getValue();
        if (value < type(int232).min || value > type(int232).max) revert ValueOverflow();
        return int232(value);
    }

    function validate(address target, bytes calldata /* config */)
        external pure override
    {
        if (target == address(0)) revert InvalidTarget();
    }

    // IStreamAdapterUIDescriptor: view-only, never called by core/registry.

    /// @inheritdoc IStreamAdapterUIDescriptor
    function uiSchemaVersion() external pure override returns (uint16) {
        return 1;
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function configSchema() external pure override returns (string memory) {
        return '{"version":1,"fields":[]}';
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function valueDisplay(address /* target */, bytes calldata /* config */)
        external pure override returns (uint8 decimals, string memory unit, string memory label)
    {
        return (0, "", "Custom value");
    }
}
