// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IAirdropDoor {
    function airdropMint(address to, uint256 amount) external;
}

/// Test stand-in for SatoriAirdrop as the token's airdrop door: it reports
/// whatever table total it is set to and mints whatever it is asked, so tests
/// can reach the token's cap check behind a door that lies about its table.
contract MockAirdropTable {
    address public token;
    uint256 public airdropLoadedTotal;

    constructor(address token_) {
        token = token_;
    }

    function setLoaded(uint256 total) external {
        airdropLoadedTotal = total;
    }

    function mint(address to, uint256 amount) external {
        IAirdropDoor(token).airdropMint(to, amount);
    }
}
