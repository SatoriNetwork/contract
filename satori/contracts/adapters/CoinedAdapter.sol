// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IStreamAdapter.sol";
import "../interfaces/IStreamAdapterUIDescriptor.sol";

/**
 * @title CoinedAdapter
 * @notice Streams a Coined term's price as its block opened, from the one Coined
 *         it was deployed against.
 * @dev `config = abi.encode(bytes32 term)`.
 *      The block-open supply, not the live one: Coined has no fee, so a buy, a
 *      pull and a sell in one block would write any value for about a wei. Not
 *      min(live, open) either: that still lets a holder's same-block sale write
 *      a low value. A trade held into the next block does move the read.
 *      A spot read, not an average: an average's next step is visible before it
 *      happens, which hands ABC predictors free wins.
 */
interface IValues {
    /// units outstanding as the current block began
    function openOf(bytes32 name) external view returns (uint256);
    function exists(bytes32 name) external view returns (bool);
}

contract CoinedAdapter is IStreamAdapter, IStreamAdapterUIDescriptor {
    error InvalidProvider();
    error UnknownTerm();
    error ValueOverflow();

    /// Coined's Curve.priceAt, (units + VIRTUAL_SUPPLY) / K, copied: Curve is
    /// internal to Coined. Must equal Coined's Curve.sol; CoinedAdapterPump.test.js
    /// checks it against Coined's build, and scripts/coined-probe.js against
    /// COINED_ADDRESS before deploy.js writes anything.
    uint256 internal constant K = 5e15;
    uint256 internal constant VIRTUAL_SUPPLY = 1_000e18;

    address public immutable coined;

    constructor(address coined_) {
        if (coined_ == address(0)) revert InvalidProvider();
        coined = coined_;
    }

    function readValue(address values, bytes calldata config)
        external
        view
        override
        returns (int232)
    {
        if (values != coined) revert InvalidProvider();
        bytes32 term = abi.decode(config, (bytes32));
        uint256 price = (IValues(coined).openOf(term) + VIRTUAL_SUPPLY) / K;
        if (price > uint256(int256(type(int232).max))) revert ValueOverflow();
        return int232(int256(price));
    }

    function validate(address values, bytes calldata config) external view override {
        if (values != coined) revert InvalidProvider();
        bytes32 term = abi.decode(config, (bytes32));
        if (!IValues(coined).exists(term)) revert UnknownTerm();
    }

    // ---- IStreamAdapterUIDescriptor (UI only; never called by core/registry) ----

    /// @inheritdoc IStreamAdapterUIDescriptor
    function uiSchemaVersion() external pure override returns (uint16) {
        return 1;
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function configSchema() external pure override returns (string memory) {
        return '{"version":1,"fields":[{"key":"term","type":"bytes32","label":"Term id"}]}';
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function valueDisplay(address, /* values */ bytes calldata /* config */ )
        external
        pure
        override
        returns (uint8 decimals, string memory unit, string memory label)
    {
        return (6, "USDC", "Coined price");
    }
}
