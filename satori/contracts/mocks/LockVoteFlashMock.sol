// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IFlashGov { function castVote(uint256 id, uint8 support) external returns (uint256); }
interface IFlashToken { function transfer(address to, uint256 amount) external returns (bool); function balanceOf(address) external view returns (uint256); }

/// The flash-loan shape in one transaction: vote, then move the tokens on —
/// which is exactly what a flash borrower must do to repay. The vote-lock
/// makes the transfer revert, unwinding the whole thing, vote included.
contract LockVoteFlashMock {
    function voteThenTransfer(address gov, address token, uint256 id, address to) external {
        IFlashGov(gov).castVote(id, 1);
        IFlashToken(token).transfer(to, IFlashToken(token).balanceOf(address(this)));
    }
}
