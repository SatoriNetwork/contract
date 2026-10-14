// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice A plain ERC-20 that DOES implement ERC-2612, standing in for a
///         well-behaved third-party bounty-funding token (USDC and friends).
///
///         Its non-permit twin is `MockERC20`, which is used in the same tests to
///         prove the permit entry points still work against a token with no
///         permit at all — that path simply falls back to a prior allowance.
contract MockERC20Permit is ERC20, ERC20Permit {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
