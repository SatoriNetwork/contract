// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../SatoriVoting.sol";

/// Phase-2 upgrade probe: SatoriVoting plus one new view. Inheriting the real
/// contract keeps the storage layout and the full API — upgrading a voting
/// proxy to this proves a logic upgrade lands with state intact and new
/// behavior live (test/next/ProxyUpgrades.test.js).
contract VotingV2Mock is SatoriVoting {
    constructor() SatoriVoting() {}

    function version() external pure returns (uint256) {
        return 2;
    }
}
