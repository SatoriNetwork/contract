// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BlockHeaderProof} from "../governance/libraries/BlockHeaderProof.sol";

/// Phase 2 prototype: raw header -> verified state root. Stateless and `pure`,
/// so a test can hand it mutated bytes and watch them fail with no setup.
contract HistoricalHeaderProbe {
    error BlockhashUnavailable();

    function stateRootOf(bytes32 expectedHash, uint256 expectedNumber, bytes calldata rawHeader)
        external
        pure
        returns (bytes32)
    {
        return BlockHeaderProof.stateRootOf(expectedHash, expectedNumber, rawHeader);
    }

    event SnapshotCaptured(uint256 number, bytes32 hash);

    /// CALL AND TRANSACTION DISAGREE, and it is worth knowing which you are
    /// looking at. In a TRANSACTION `block.number` is the block being mined, so
    /// this pins the current head. In an `eth_call` most providers set
    /// `block.number` to the latest MINED block, so the same code pins head-1.
    /// Neither is wrong; production only ever runs the transaction path, and a
    /// test that reads this through `staticCall` will see a different block than
    /// the one a proposal would really capture.
    function captureSnapshot() public view returns (uint256 number, bytes32 hash) {
        number = block.number - 1;
        hash = blockhash(number);
        if (hash == bytes32(0)) revert BlockhashUnavailable();
    }

    /// The same thing through a transaction, so a test can observe the semantics
    /// a real `propose()` would get rather than `eth_call`'s.
    function recordSnapshot() external returns (uint256 number, bytes32 hash) {
        (number, hash) = captureSnapshot();
        emit SnapshotCaptured(number, hash);
    }
}
