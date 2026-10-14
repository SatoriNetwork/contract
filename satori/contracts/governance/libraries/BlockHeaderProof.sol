// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RLPReader} from "./RLPReader.sol";

/// @title Authenticate a historical block header against a hash the EVM itself
///        captured, and read its state root.
///
/// Phase 2 of `docs/design/holder-voting-proposal.txt`. This is the hinge of the
/// whole design: a proposal records `blockhash(block.number - 1)` while it is
/// natively available, and from then on ANY party may present the raw header for
/// that block. Exactly one byte string hashes to the stored value, so the header
/// cannot be forged, and the 256-block `BLOCKHASH` window stops mattering.
///
/// ON FIELD POSITIONS AND OP STACK. `stateRoot` is field 3 and `number` is field
/// 8, and both stay put as the chain evolves: every fork that has extended the
/// header — London's `baseFeePerGas`, Shanghai's `withdrawalsRoot`, Cancun's
/// blob fields and `parentBeaconBlockRoot`, Isthmus's `requestsHash` — APPENDS.
/// So this reads a prefix that has been stable since frontier, and a future fork
/// adding a field 21 changes nothing here. That is why the length check below is
/// a MINIMUM and not an equality: pinning the exact field count would turn the
/// next routine OP Stack upgrade into a governance outage.
library BlockHeaderProof {
    error HeaderHashMismatch();
    error HeaderTooShort();
    error HeaderWrongNumber();

    uint256 private constant FIELD_STATE_ROOT = 3;
    uint256 private constant FIELD_NUMBER = 8;

    /// @param expectedHash   the block hash the proposal captured on chain
    /// @param expectedNumber the block number the proposal captured on chain
    /// @param rawHeader      the RLP-encoded header, from anyone at all
    function stateRootOf(
        bytes32 expectedHash,
        uint256 expectedNumber,
        bytes memory rawHeader
    ) internal pure returns (bytes32 stateRoot) {
        // FIRST, BEFORE DECODING ANYTHING. Checking the hash up front is what
        // makes the permissive RLP reader safe to use on this input: only the
        // exact bytes that produce the already-trusted hash get past this line,
        // so there is no second encoding of the same header to smuggle in.
        if (keccak256(rawHeader) != expectedHash) revert HeaderHashMismatch();

        RLPReader.Item[] memory fields = RLPReader.toList(rawHeader);
        if (fields.length <= FIELD_NUMBER) revert HeaderTooShort();

        // Belt and braces. The hash already pins the header to a specific block,
        // so this cannot fail on honest input — but it is one comparison, and it
        // turns "the proposal recorded a hash and a number that disagree" from a
        // silent wrong answer into a revert.
        if (RLPReader.toUint(fields[FIELD_NUMBER]) != expectedNumber) revert HeaderWrongNumber();

        stateRoot = RLPReader.toBytes32(fields[FIELD_STATE_ROOT]);
    }
}
