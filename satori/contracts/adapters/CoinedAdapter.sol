// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IStreamAdapter.sol";
import "../interfaces/IStreamAdapterUIDescriptor.sol";

/**
 * @title CoinedAdapter
 * @notice Streams a Coined term's current price into Satori.
 * @dev `config = abi.encode(bytes32 term)`. Reads the spot mark, not an
 *      average: the direction of a smoothed series is visible before it
 *      happens, so an average would hand ABC predictors free wins (a naive
 *      "it keeps heading toward spot" bettor wins ~85% on a 12h EMA sampled
 *      hourly, ~50% on spot). Coined's lagged quotes already make a flash
 *      pump at the pull cost the pumper.
 */
interface IValues {
    /// wei per unit, premiums folded in
    function priceOf(bytes32 name) external view returns (uint256);
    function exists(bytes32 name) external view returns (bool);
}

contract CoinedAdapter is IStreamAdapter, IStreamAdapterUIDescriptor {
    error InvalidTarget();
    error UnknownTerm();
    error ValueOverflow();

    function readValue(address values, bytes calldata config)
        external
        view
        override
        returns (int232)
    {
        bytes32 term = abi.decode(config, (bytes32));
        uint256 price = IValues(values).priceOf(term);
        if (price > uint256(int256(type(int232).max))) revert ValueOverflow();
        return int232(int256(price));
    }

    function validate(address values, bytes calldata config) external view override {
        if (values == address(0)) revert InvalidTarget();
        bytes32 term = abi.decode(config, (bytes32));
        if (!IValues(values).exists(term)) revert UnknownTerm();
    }

    // ---- IStreamAdapterUIDescriptor (UI only; never called by core/registry) ----

    /// @inheritdoc IStreamAdapterUIDescriptor
    function uiSchemaVersion() external pure override returns (uint16) {
        return 1;
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function configSchema() external pure override returns (string memory) {
        return '{"version":1,"fields":[{"name":"term","type":"bytes32","label":"Term id"}]}';
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function valueDisplay(address, /* values */ bytes calldata /* config */ )
        external
        pure
        override
        returns (uint8 decimals, string memory unit, string memory label)
    {
        return (18, "ETH", "Coined price");
    }
}
