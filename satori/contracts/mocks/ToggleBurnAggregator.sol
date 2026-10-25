// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// TEST-ONLY Chainlink aggregator that answers normally until told to burn all the gas
/// it is given, so a stream can validate at creation and then fail by running out of gas.
contract ToggleBurnAggregator {
    bool public burn;
    int256 public answer = 1000;

    function setBurn(bool b) external { burn = b; }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        if (burn) {
            assembly { invalid() }
        }
        return (1, answer, block.timestamp, block.timestamp, 1);
    }
}
