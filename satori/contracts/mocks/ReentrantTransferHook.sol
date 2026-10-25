// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISatoriTokenReentry {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function rewardMint(address to, uint256 amount) external;
    function mintDevFee() external returns (uint256);
    function accrueRewards(uint256 general) external returns (uint256, uint256);
}

/// Adversarial transfer hook. On every onTokenTransfer it (1) records the balances
/// it observes — which proves the token calls it AFTER the balance move — and
/// (2) optionally re-enters the token to try to inflate supply or bypass the cap.
contract ReentrantTransferHook {
    ISatoriTokenReentry public token;
    uint8 public mode;   // 0 observe-only | 1 rewardMint | 2 mintDevFee | 3 self-transfer | 4 accrueRewards
    bool internal _in;
    uint256 public observedFromBal;
    uint256 public observedToBal;
    uint256 public calls;

    constructor(address t) { token = ISatoriTokenReentry(t); }

    function setMode(uint8 m) external { mode = m; }

    function onTokenTransfer(address from, address to, uint256) external {
        calls += 1;
        observedFromBal = token.balanceOf(from);
        observedToBal = token.balanceOf(to);
        if (_in) return;                 // one-shot: don't recurse forever
        _in = true;
        if (mode == 1) {
            token.rewardMint(address(this), 1 ether);          // not the controller -> must revert
        } else if (mode == 2) {
            token.mintDevFee();                                // permissionless -> bounded by devFeeAccrued
        } else if (mode == 3) {
            if (token.balanceOf(address(this)) >= 1) token.transfer(address(0xBEEF), 1);
        } else if (mode == 4) {
            token.accrueRewards(1 ether);                      // not the controller -> must revert
        }
        _in = false;
    }
}
