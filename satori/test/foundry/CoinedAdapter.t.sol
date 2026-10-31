// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/adapters/CoinedAdapter.sol";

/// A stand-in for Coined: the surface the adapter reads, plus a live price the
/// adapter must ignore.
contract MockValues {
    mapping(bytes32 => bool) public exists;
    mapping(bytes32 => uint256) public openOf;
    mapping(bytes32 => uint256) public priceOf;

    function setExists(bytes32 term, bool e) external {
        exists[term] = e;
    }

    function setOpen(bytes32 term, uint256 u) external {
        openOf[term] = u;
    }

    function setPrice(bytes32 term, uint256 p) external {
        priceOf[term] = p;
    }
}

contract CoinedAdapterTest is Test {
    CoinedAdapter a;
    MockValues v;
    bytes32 constant TERM = keccak256("honesty");
    uint256 constant K = 5e15;
    uint256 constant V = 1_000e18;

    function setUp() public {
        v = new MockValues();
        a = new CoinedAdapter(address(v));
        v.setExists(TERM, true);
    }

    function _cfg(bytes32 t) internal pure returns (bytes memory) {
        return abi.encode(t);
    }

    function _read(uint256 open) internal returns (int256) {
        v.setOpen(TERM, open);
        return int256(a.readValue(address(v), _cfg(TERM)));
    }

    function test_constructor_refuses_a_zero_coined() public {
        vm.expectRevert(CoinedAdapter.InvalidProvider.selector);
        new CoinedAdapter(address(0));
    }

    function test_coined_is_the_pinned_address() public view {
        assertEq(a.coined(), address(v));
    }

    function test_readValue_is_the_curve_price_at_the_open_supply() public {
        assertEq(_read(0), int256(V / K));
        assertEq(_read(10e18), int256((10e18 + V) / K));
        assertEq(_read(K - 1), int256(V / K));
        assertEq(_read(K), int256(V / K + 1));
    }

    function test_readValue_ignores_the_live_price() public {
        v.setPrice(TERM, 12_345);
        assertEq(_read(0), int256(V / K));
    }

    function test_readValue_refuses_any_other_provider() public {
        MockValues other = new MockValues();
        other.setExists(TERM, true);
        vm.expectRevert(CoinedAdapter.InvalidProvider.selector);
        a.readValue(address(other), _cfg(TERM));
        vm.expectRevert(CoinedAdapter.InvalidProvider.selector);
        a.readValue(address(0), _cfg(TERM));
    }

    function test_validate_passes_for_a_real_term() public view {
        a.validate(address(v), _cfg(TERM));
    }

    function test_validate_refuses_any_other_provider() public {
        MockValues other = new MockValues();
        other.setExists(TERM, true);
        vm.expectRevert(CoinedAdapter.InvalidProvider.selector);
        a.validate(address(other), _cfg(TERM));
        vm.expectRevert(CoinedAdapter.InvalidProvider.selector);
        a.validate(address(0), _cfg(TERM));
    }

    function test_validate_refuses_an_unknown_term() public {
        vm.expectRevert(CoinedAdapter.UnknownTerm.selector);
        a.validate(address(v), _cfg(keccak256("never-coined")));
        vm.expectRevert(CoinedAdapter.UnknownTerm.selector);
        a.validate(address(v), _cfg(bytes32(0)));
    }

    /// With K = 5e15 every uint256 supply prices inside int232.
    function test_readValue_fits_int232_at_any_supply() public {
        assertEq(_read(type(uint256).max - V), int256(type(uint256).max / K));
    }

    function test_value_display_is_usdc() public view {
        (uint8 decimals, string memory unit, ) = a.valueDisplay(address(v), _cfg(TERM));
        assertEq(decimals, 6);
        assertEq(unit, "USDC");
    }

    function test_config_schema_names_its_field_by_key() public view {
        assertEq(a.configSchema(), '{"version":1,"fields":[{"key":"term","type":"bytes32","label":"Term id"}]}');
    }
}
