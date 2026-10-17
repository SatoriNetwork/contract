// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IStreamAdapter.sol";
import "../interfaces/IStreamAdapterUIDescriptor.sol";
import "../interfaces/INamedStreamAdapter.sol";
import "../interfaces/ISatoriRegistry.sol";

/**
 * @title NamedStreamAdapter
 * @notice A stream that is just a name. Its value is the engine's per-game
 *         counter of capital-weighted prediction flow (UP adds the
 *         predictor's per-game power, DOWN subtracts); nobody can set it.
 *         The name is a Coined term: `nameKey` coins it if it is new, and
 *         its Coined id is what the registry keys name uniqueness on.
 * @dev `provider` must be the engine and `config = abi.encode(uint32 streamId)`
 *      must name the stream being created — the registry writes it and calls
 *      `validate` BEFORE `nextStreamId++`, which is what binds the config to
 *      exactly that id. The registry's named-stream rules (cadence 60, hour-grid
 *      snapshot, always-write) key off `registry.namedAdapterId`, so an instance
 *      that is not the wired one refuses to create streams at all.
 */
interface ISatoriEngineNamed {
    function namedStreamValue(uint32 streamId) external view returns (int232);
}

interface ICoined {
    function register(string calldata text) external returns (bytes32 id);
}

/// Coined's text errors, inherited so they land in this adapter's ABI and the
/// dapp can decode them when they bubble through the registry.
interface ICoinedErrors {
    error EmptyName();
    error BadName();
    error MixedScript();
}

contract NamedStreamAdapter is IStreamAdapter, IStreamAdapterUIDescriptor, INamedStreamAdapter, ICoinedErrors {
    error InvalidProvider();
    error StreamIdMismatch();
    error NotWired();

    address public immutable engine;
    address public immutable registry;
    address public immutable coined;

    constructor(address engine_, address registry_, address coined_) {
        engine = engine_;
        registry = registry_;
        coined = coined_;
    }

    function readValue(address, bytes calldata config) external view override returns (int232) {
        return ISatoriEngineNamed(engine).namedStreamValue(abi.decode(config, (uint32)));
    }

    function validate(address provider, bytes calldata config) external view override {
        if (provider != engine) revert InvalidProvider();
        if (coined == address(0)) revert NotWired();
        ISatoriRegistry reg = ISatoriRegistry(registry);
        if (abi.decode(config, (uint32)) != reg.nextStreamId()) revert StreamIdMismatch();
        uint16 id = reg.namedAdapterId();
        if (id == 0 || reg.adapter(id) != address(this)) revert NotWired();
    }

    /// @inheritdoc INamedStreamAdapter
    function nameKey(string calldata name) external override returns (bytes32) {
        // The registry calls this BEFORE validate; without the check an unwired
        // adapter reverts inside address(0) with no data the dapp can name.
        if (coined == address(0)) revert NotWired();
        bytes32 id = ICoined(coined).register(name);
        // Coined trims these four bytes off the ends before deriving the id, so
        // a padded name would claim the bare term under text that is not it.
        // After `register`, so a blank name keeps Coined's EmptyName.
        bytes calldata b = bytes(name);
        if (_isSpace(b[0]) || _isSpace(b[b.length - 1])) revert BadName();
        return id;
    }

    function _isSpace(bytes1 c) private pure returns (bool) {
        return c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d;
    }

    // ---- IStreamAdapterUIDescriptor (UI only; never called by core/registry) ----

    /// @inheritdoc IStreamAdapterUIDescriptor
    function uiSchemaVersion() external pure override returns (uint16) {
        return 1;
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function configSchema() external pure override returns (string memory) {
        return '{"version":1,"fields":[{"name":"streamId","type":"uint32","label":"Stream id (next id at creation)"}]}';
    }

    /// @inheritdoc IStreamAdapterUIDescriptor
    function valueDisplay(address, /* provider */ bytes calldata /* config */ )
        external
        pure
        override
        returns (uint8 decimals, string memory unit, string memory label)
    {
        return (18, "SATORI", "Net prediction flow");
    }
}
