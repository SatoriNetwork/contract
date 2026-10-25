// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RLPReader} from "../governance/libraries/RLPReader.sol";
import {MerklePatricia} from "../governance/libraries/MerklePatricia.sol";

/// @title Phase 1 of `docs/design/holder-voting-proposal.txt` — the standalone
///        proof prototype, and nothing else.
contract HistoricalBalanceProbe {
    using RLPReader for bytes;
    using RLPReader for RLPReader.Item;

    error NoAccount();
    error BadAccountEncoding();

    /// SatoriToken's `_balances` mapping lives at storage slot 0 — VERIFIED
    /// against the compiled layout, not assumed (see holder-voting-review.md §1).
    uint256 public constant BALANCES_SLOT = 0;
    uint256 public constant TOTAL_SUPPLY_SLOT = 2;

    /// The raw Solidity slot for a holder's balance. This is what goes to
    /// `eth_getProof` — NOT its hash. The trie path is the hash, applied inside
    /// `storageValue` below. Conflating the two is the trap in §10 of the
    /// proposal.
    function balanceSlot(address holder) public pure returns (bytes32) {
        return keccak256(abi.encode(holder, BALANCES_SLOT));
    }

    /// An Ethereum account is RLP `[nonce, balance, storageRoot, codeHash]`.
    function accountStorageRoot(
        bytes32 stateRoot,
        address account,
        bytes[] memory accountProof
    ) public pure returns (bytes32) {
        bytes memory encoded = MerklePatricia.get(
            stateRoot,
            keccak256(abi.encodePacked(account)),   // secure trie: hash the address
            accountProof
        );
        if (encoded.length == 0) revert NoAccount();
        RLPReader.Item[] memory fields = encoded.toList();
        if (fields.length != 4) revert BadAccountEncoding();
        return fields[2].toBytes32();
    }

    /// Returns 0 for a proven-absent slot, which is how the trie represents a
    /// zero value: zero entries are simply not stored.
    function storageValue(
        bytes32 storageRoot,
        bytes32 rawSlot,
        bytes[] memory storageProof
    ) public pure returns (uint256) {
        bytes memory encoded = MerklePatricia.get(
            storageRoot,
            keccak256(abi.encodePacked(rawSlot)),   // secure trie: hash the slot
            storageProof
        );
        if (encoded.length == 0) return 0;
        // Storage values are stored RLP-encoded inside the leaf.
        RLPReader.Item memory it = _asItem(encoded);
        return it.toUint();
    }

    function proveBalance(
        bytes32 storageRoot,
        address holder,
        bytes[] memory storageProof
    ) external pure returns (uint256) {
        return storageValue(storageRoot, balanceSlot(holder), storageProof);
    }

    function _asItem(bytes memory raw) private pure returns (RLPReader.Item memory it) {
        uint256 ptr;
        assembly { ptr := add(raw, 0x20) }
        uint256 prefix = uint8(raw[0]);
        if (prefix < 0x80) return RLPReader.Item(ptr, 1, false);
        if (prefix < 0xb8) return RLPReader.Item(ptr + 1, prefix - 0x80, false);
        uint256 lolen = prefix - 0xb7;
        uint256 len;
        assembly { len := shr(sub(256, mul(8, lolen)), mload(add(ptr, 1))) }
        return RLPReader.Item(ptr + 1 + lolen, len, false);
    }
}
