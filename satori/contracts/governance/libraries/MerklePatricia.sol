// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RLPReader} from "./RLPReader.sol";

/// @title Merkle-Patricia trie proof verification — the one primitive the whole
///        historical-balance voting design rests on.
///
/// Walks a proof from a known root to the value stored at a path, checking at
/// every step that the node presented hashes to what its parent said it would.
/// Nothing here is trusted: the caller supplies the nodes, and a wrong node
/// simply fails to hash.
///
/// THE SECURE TRIE. Ethereum hashes the key before using it as a trie path — the
/// account trie is keyed by `keccak256(address)` and the storage trie by
/// `keccak256(slot)`. That hashing is the CALLER's job here, not this library's,
/// because getting it wrong in either direction is the classic bug in this area
/// (see the proposal's §10 on double hashing): `eth_getProof` takes the RAW slot,
/// while the trie path is the hashed one.
library MerklePatricia {
    using RLPReader for bytes;
    using RLPReader for RLPReader.Item;

    error BadNodeHash();
    error BadNode();
    error PathDiverges();
    error ProofTooShort();

    /// Walk `proof` from `root` along `path` and return the value found.
    ///
    /// @param root  the trie root the first node must hash to
    /// @param path  the ALREADY-HASHED 32-byte trie path
    /// @param proof the RLP-encoded nodes, root first
    /// @return value the RLP-encoded value at `path`, or empty if absent
    function get(bytes32 root, bytes32 path, bytes[] memory proof)
        internal
        pure
        returns (bytes memory value)
    {
        // Nibbles of the path, consumed as we descend. 64 for a 32-byte key.
        uint256 nibbleIdx;
        bytes32 expected = root;

        for (uint256 i = 0; i < proof.length; ++i) {
            bytes memory node = proof[i];

            // THE ONLY THING THAT MAKES ANY OF THIS TRUSTWORTHY: the node must
            // hash to what the level above committed to. The root comes from a
            // block header the EVM itself vouched for, so the chain of hashes
            // reaches all the way to consensus.
            if (keccak256(node) != expected) revert BadNodeHash();

            RLPReader.Item[] memory items = node.toList();

            // The INNER loop exists for EMBEDDED nodes. A child whose whole
            // encoding is under 32 bytes is not hash-referenced — it sits
            // inline in its parent as a list, and `eth_getProof` does not ship
            // it as a separate proof node. It needs no hash check of its own:
            // its bytes are inside a node that already passed one.
            //
            // This is not theoretical. An embedded storage leaf needs ~14
            // nibbles of shared path, and a birthday collision on 56 bits is
            // ~2^28 keccaks — seconds on a GPU. A walker that treats every
            // child as a hash rejects such proofs, silencing exactly the
            // voters whose keys happen (or were made) to collide. Wrong in the
            // liveness direction only, but wrong.
            //
            // Terminates: every embedded item is strictly inside its parent's
            // span, so the chain of sublists is bounded by the node's length.
            while (true) {
                if (items.length == 17) {
                    // BRANCH. Sixteen child slots plus a value slot.
                    if (nibbleIdx == 64) {
                        // Path exhausted here: the value rides in slot 16.
                        return items[16].toBytes();
                    }
                    RLPReader.Item memory child = items[_nibbleAt(path, nibbleIdx)];
                    ++nibbleIdx;
                    if (child.isList) { items = RLPReader.sublist(child); continue; }
                    if (child.isEmpty()) return new bytes(0);   // proven ABSENT
                    expected = child.toBytes32();
                    break;   // descend to the next hash-referenced proof node
                }

                if (items.length == 2) {
                    // LEAF or EXTENSION, told apart by the first nibble of the
                    // compact-encoded path fragment.
                    bytes memory enc = items[0].toBytes();
                    if (enc.length == 0) revert BadNode();
                    uint256 flag = uint8(enc[0]) >> 4;
                    bool isLeaf = (flag & 2) != 0;
                    bool oddLen = (flag & 1) != 0;

                    // Odd-length fragments carry their first nibble in the low
                    // half of the prefix byte; even ones pad with a zero nibble.
                    uint256 fragStart = oddLen ? 1 : 2;      // nibbles into `enc`
                    uint256 fragLen = enc.length * 2 - fragStart;

                    for (uint256 j = 0; j < fragLen; ++j) {
                        if (nibbleIdx + j >= 64) revert PathDiverges();
                        if (_nibbleAtBytes(enc, fragStart + j) != _nibbleAt(path, nibbleIdx + j)) {
                            // The fragment does not match our key. That is a
                            // valid proof OF ABSENCE: this is where our key
                            // would live, and something else lives here.
                            return new bytes(0);
                        }
                    }
                    nibbleIdx += fragLen;

                    if (isLeaf) {
                        if (nibbleIdx != 64) revert PathDiverges();
                        return items[1].toBytes();
                    }
                    // Extension: items[1] is the next node — by hash, or inline.
                    RLPReader.Item memory next = items[1];
                    if (next.isList) { items = RLPReader.sublist(next); continue; }
                    expected = next.toBytes32();
                    break;
                }

                revert BadNode();
            }
        }
        revert ProofTooShort();
    }

    /// Nibble `i` of a 32-byte value, counting from the most significant.
    function _nibbleAt(bytes32 v, uint256 i) private pure returns (uint256) {
        uint256 b = uint256(uint8(v[i / 2]));
        return (i % 2 == 0) ? (b >> 4) : (b & 0x0f);
    }

    function _nibbleAtBytes(bytes memory v, uint256 i) private pure returns (uint256) {
        uint256 b = uint256(uint8(v[i / 2]));
        return (i % 2 == 0) ? (b >> 4) : (b & 0x0f);
    }
}
