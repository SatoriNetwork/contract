// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITransferHook {
    function onTokenTransfer(address from, address to, uint256 value) external;
}
