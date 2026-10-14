// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MockTransferHook {
    uint8 public mode;
    uint256 public calls;
    address public lastFrom;
    address public lastTo;
    uint256 public lastValue;

    function setMode(uint8 m) external {
        mode = m;
    }

    function onTokenTransfer(address from, address to, uint256 value) external {
        if (mode == 1) revert("hook revert");
        calls += 1;
        lastFrom = from;
        lastTo = to;
        lastValue = value;
    }
}
