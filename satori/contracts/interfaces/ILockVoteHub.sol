// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ILockVoteHub {
    function voteLock(address user, uint256 untilRound) external;
}
