// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mintable ERC20 with configurable decimals for tests. Lets a
/// single fixture stand up tokens that mimic real-world decimal counts
/// (e.g. USDC = 6, WBTC = 8, DAI = 18) so bounty math is exercised across
/// the realistic range.
contract MockERC20WithDecimals is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
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
