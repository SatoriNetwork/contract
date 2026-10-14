// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/adapters/CoinedAdapter.sol";

/// A stand-in for Coined: just the surface the adapter reads.
contract MockValues {
    mapping(bytes32 => bool) public exists;
    mapping(bytes32 => uint256) public priceOf;

    function setExists(bytes32 term, bool e) external {
        exists[term] = e;
    }

    function setPrice(bytes32 term, uint256 p) external {
        priceOf[term] = p;
    }
}

contract CoinedAdapterTest is Test {
    CoinedAdapter a;
    MockValues v;
    bytes32 constant TERM = keccak256("honesty");

    function setUp() public {
        a = new CoinedAdapter();
        v = new MockValues();
        v.setExists(TERM, true);
        v.setPrice(TERM, 12_345);
    }

    function _cfg(bytes32 t) internal pure returns (bytes memory) {
        return abi.encode(t);
    }

    function test_readValue_returns_the_spot_price() public {
        assertEq(int256(a.readValue(address(v), _cfg(TERM))), int256(12_345));
        v.setPrice(TERM, 99);
        assertEq(int256(a.readValue(address(v), _cfg(TERM))), int256(99));
    }

    function test_validate_passes_for_a_real_term() public view {
        a.validate(address(v), _cfg(TERM));
    }

    function test_validate_rejects_an_unknown_term() public {
        vm.expectRevert(CoinedAdapter.UnknownTerm.selector);
        a.validate(address(v), _cfg(keccak256("never-coined")));
    }

    function test_validate_rejects_a_zero_target() public {
        vm.expectRevert(CoinedAdapter.InvalidTarget.selector);
        a.validate(address(0), _cfg(TERM));
    }

    function test_readValue_reverts_on_int232_overflow() public {
        v.setPrice(TERM, uint256(int256(type(int232).max)) + 1);
        vm.expectRevert(CoinedAdapter.ValueOverflow.selector);
        a.readValue(address(v), _cfg(TERM));
    }
}
