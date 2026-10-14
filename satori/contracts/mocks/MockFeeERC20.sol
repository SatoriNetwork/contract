// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal fee-on-transfer ERC20 for tests. Burns `feeBps / 10000`
/// of every transferred amount before crediting the recipient. Used to
/// exercise contracts' balance-delta deposit handling.
contract MockFeeERC20 is ERC20 {
    uint256 public feeBps;

    constructor(string memory name, string memory symbol, uint256 _feeBps) ERC20(name, symbol) {
        require(_feeBps < 10000, "Fee too high");
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        // _update is the unified hook in OZ v5: mint (from==0), burn
        // (to==0), and transfer go through it. Skip the fee on mint/burn
        // so test setup transfers a clean amount in.
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10000;
        uint256 net = value - fee;
        super._update(from, to, net);
        if (fee > 0) super._update(from, address(0), fee); // burn the fee
    }
}
