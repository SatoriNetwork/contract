// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/ISatoriCore.sol";

/**
 * @title MockRewardsMinter
 * @notice Test-only helper that calls `core.rewardMint` / `core.setMerkleReserveRate`.
 *         Used UNWIRED (never a child) to prove the hub's authorization gate
 *         rejects a non-rewards caller (`Unauthorized`). On-chain over-issue cap
 *         tests now inject by impersonating the REAL rewards child directly
 *         (setChild was removed — audit F3), not by wiring this contract in.
 */
contract MockRewardsMinter {
    function mint(address core, address to, uint256 amount) external {
        ISatoriCore(core).rewardMint(to, amount);
    }

    function setReserveRate(address core, uint256 rate) external {
        ISatoriCore(core).setMerkleReserveRate(rate);
    }

    // `_onlyAdmin()` reads `satoriRewards.admin()`. After this mock is wired as
    // the rewards child, keep admin calls resolving to a known EOA so wiring
    // sequences that touch admin don't brick.
    address public admin;
    function setAdmin(address a) external { admin = a; }
}
