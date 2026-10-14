// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BridgeAuthorityMock
 * @notice Test double for the external transport registry the token consults
 *         for its tier-2 lane. Deliberately minimal: the real one is out of
 *         scope for the token and can carry whatever policy it wants (per-bridge
 *         rate limits in the xERC-20 style, timelocks, a fixed list), which is
 *         the entire reason it lives outside an immutable contract.
 * @dev `shouldRevert` exists to prove the token treats a broken authority as
 *      "deny", never as a brick — and that the tier-1 protocol lane keeps
 *      working regardless, because it is checked first and short-circuits.
 */
contract BridgeAuthorityMock {
    mapping(address => bool) public allowed;
    bool public shouldRevert;

    function set(address bridge, bool ok) external { allowed[bridge] = ok; }
    function setRevert(bool r) external { shouldRevert = r; }

    function isBridge(address bridge) external view returns (bool) {
        require(!shouldRevert, "authority down");
        return allowed[bridge];
    }
}
