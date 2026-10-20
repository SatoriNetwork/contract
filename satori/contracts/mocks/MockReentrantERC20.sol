// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice An ERC-20 that, once armed, calls `target` with `data` from inside a
///         transfer out of `target` (or into it, with `incoming`), to prove the
///         target's reentrancy guard.
contract MockReentrantERC20 is ERC20 {
    address public target;
    bytes public data;
    bool public reentered;
    bytes public reentryError;
    bool public incoming;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data_, bool incoming_) external {
        target = target_;
        data = data_;
        incoming = incoming_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && !reentered && (incoming ? to == target : from == target)) {
            reentered = true;
            (bool ok, bytes memory ret) = target.call(data);
            if (!ok) reentryError = ret;
        }
    }
}
