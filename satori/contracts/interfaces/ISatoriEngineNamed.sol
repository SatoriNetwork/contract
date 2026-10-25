// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ISatoriEngineNamed {
    function namedStreamValue(uint32 streamId) external view returns (int232);
}
