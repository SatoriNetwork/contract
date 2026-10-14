// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Minimal RLP decoding, enough to read an Ethereum block header and an
///        account/storage trie node.
///
/// ON CANONICALITY. A permissive decoder is normally a security problem — two
/// different byte strings decoding to the same value lets an attacker restate a
/// proof. It is not a problem *here*, and the reason is worth stating so nobody
/// later "hardens" this into something slower for no gain:
///
///   * The block header is accepted only when `keccak256(rawHeader)` equals a
///     hash the EVM itself captured. Exactly one byte string satisfies that.
///   * Trie nodes are accepted only when their keccak matches the hash held by
///     their parent node, all the way up to a root that came from the header.
///
/// In both cases the bytes are pinned by a hash before anything is decoded, so
/// a non-canonical re-encoding cannot be substituted — it would not hash right.
library RLPReader {
    error RLPBadItem();
    error RLPNotList();
    error RLPOverflow();

    /// A view into `self`: where an item's PAYLOAD starts and how long it is.
    ///
    /// `isList` exists for one consumer: the trie walker. A branch child is
    /// either empty, a 32-byte hash, or — when the child node's whole encoding
    /// is under 32 bytes — the child node EMBEDDED inline as a list. Telling a
    /// hash from an embedded node is exactly telling a string from a list.
    struct Item {
        uint256 ptr;    // memory pointer to the payload
        uint256 len;    // payload length in bytes
        bool    isList;
    }

    function _decodeLength(uint256 ptr, uint256 bound)
        private
        pure
        returns (uint256 payloadPtr, uint256 payloadLen, uint256 itemLen, bool isList)
    {
        if (bound == 0) revert RLPBadItem();
        uint256 prefix;
        assembly { prefix := byte(0, mload(ptr)) }

        if (prefix < 0x80) {
            // Single byte, and it IS its own payload.
            return (ptr, 1, 1, false);
        }
        if (prefix < 0xb8) {
            payloadLen = prefix - 0x80;
            itemLen = payloadLen + 1;
            if (itemLen > bound) revert RLPBadItem();
            return (ptr + 1, payloadLen, itemLen, false);
        }
        if (prefix < 0xc0) {
            uint256 lenOfLen = prefix - 0xb7;
            if (lenOfLen > 8 || 1 + lenOfLen > bound) revert RLPBadItem();
            payloadLen = _readLen(ptr + 1, lenOfLen);
            itemLen = 1 + lenOfLen + payloadLen;
            if (itemLen > bound) revert RLPBadItem();
            return (ptr + 1 + lenOfLen, payloadLen, itemLen, false);
        }
        if (prefix < 0xf8) {
            payloadLen = prefix - 0xc0;
            itemLen = payloadLen + 1;
            if (itemLen > bound) revert RLPBadItem();
            return (ptr + 1, payloadLen, itemLen, true);
        }
        uint256 lolen = prefix - 0xf7;
        if (lolen > 8 || 1 + lolen > bound) revert RLPBadItem();
        payloadLen = _readLen(ptr + 1, lolen);
        itemLen = 1 + lolen + payloadLen;
        if (itemLen > bound) revert RLPBadItem();
        return (ptr + 1 + lolen, payloadLen, itemLen, true);
    }

    function _readLen(uint256 ptr, uint256 n) private pure returns (uint256 out) {
        assembly { out := shr(sub(256, mul(8, n)), mload(ptr)) }
        // A length that cannot address memory is malformed, not merely large.
        if (out > type(uint32).max) revert RLPOverflow();
    }

    /// Split an RLP list into its items. Reverts if `self` is not a list, or if
    /// the items do not exactly fill the list payload — a short read would
    /// silently ignore trailing bytes, which is how a lenient decoder lets two
    /// different encodings mean the same thing.
    function toList(bytes memory self) internal pure returns (Item[] memory) {
        uint256 ptr;
        assembly { ptr := add(self, 0x20) }
        (uint256 payloadPtr, uint256 payloadLen, uint256 itemLen, bool isList) =
            _decodeLength(ptr, self.length);
        if (!isList) revert RLPNotList();
        if (itemLen != self.length) revert RLPBadItem();
        return _itemsIn(payloadPtr, payloadLen);
    }

    /// The items of a LIST item — how the trie walker descends into an embedded
    /// node, whose list header was already consumed when its parent was split.
    function sublist(Item memory it) internal pure returns (Item[] memory) {
        if (!it.isList) revert RLPNotList();
        return _itemsIn(it.ptr, it.len);
    }

    function _itemsIn(uint256 payloadPtr, uint256 payloadLen)
        private
        pure
        returns (Item[] memory items)
    {
        uint256 count;
        uint256 cur = payloadPtr;
        uint256 end = payloadPtr + payloadLen;
        while (cur < end) {
            (, , uint256 il, ) = _decodeLength(cur, end - cur);
            cur += il;
            unchecked { ++count; }
        }
        if (cur != end) revert RLPBadItem();

        items = new Item[](count);
        cur = payloadPtr;
        for (uint256 i = 0; i < count; ++i) {
            (uint256 pp, uint256 pl, uint256 il, bool il2) = _decodeLength(cur, end - cur);
            items[i] = Item(pp, pl, il2);
            cur += il;
        }
    }

    function toBytes(Item memory it) internal pure returns (bytes memory out) {
        out = new bytes(it.len);
        uint256 src = it.ptr;
        uint256 dst;
        assembly { dst := add(out, 0x20) }
        for (uint256 i = 0; i < it.len; i += 32) {
            assembly { mstore(add(dst, i), mload(add(src, i))) }
        }
    }

    /// Read the payload as a big-endian integer. RLP integers are minimal-width,
    /// so a 32-byte value is the maximum and anything longer is malformed.
    function toUint(Item memory it) internal pure returns (uint256 v) {
        if (it.isList || it.len > 32) revert RLPBadItem();
        if (it.len == 0) return 0;
        uint256 p = it.ptr;
        assembly { v := shr(sub(256, mul(8, mload(add(it, 0x20)))), mload(p)) }
    }

    /// Read the payload as a bytes32. Used for roots and hashes, which are
    /// always exactly 32 bytes in a well-formed header or account.
    function toBytes32(Item memory it) internal pure returns (bytes32) {
        if (it.isList || it.len != 32) revert RLPBadItem();
        uint256 p = it.ptr;
        bytes32 v;
        assembly { v := mload(p) }
        return v;
    }

    /// True when the item is the RLP empty string (0x80) — how the trie encodes
    /// "absent" in a branch slot.
    function isEmpty(Item memory it) internal pure returns (bool) {
        return it.len == 0 && !it.isList;
    }
}
