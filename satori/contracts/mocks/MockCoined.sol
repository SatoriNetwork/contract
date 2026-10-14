// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Coined's `register`: end-trimming and the id rule exactly as Coined computes
// them, with the control-byte and invisible-code-point BadName checks so that
// revert path is reachable locally. Coined's MixedScript rule (and the rest of
// its UTF-8 validation) is Coined's own suite to pin, not ours: this mock
// never reverts MixedScript.
contract MockCoined {
    error EmptyName();
    error BadName();

    event Coined(bytes32 indexed id, string text);

    mapping(bytes32 => bool) public exists;

    function register(string calldata text) external returns (bytes32 id) {
        id = idOf(text);
        if (exists[id]) return id;
        exists[id] = true;
        emit Coined(id, text);
    }

    function idOf(string memory text) public pure returns (bytes32 id) {
        bytes memory b = bytes(text);
        uint256 start = 0;
        uint256 end = b.length;
        while (start < end && _isSpace(b[start])) start++;
        while (end > start && _isSpace(b[end - 1])) end--;
        uint256 len = end - start;
        if (len == 0) revert EmptyName();
        for (uint256 i = start; i < end;) {
            uint256 c = uint8(b[i]);
            if (c < 0x80) {
                if (c < 0x20 || c == 0x7f) revert BadName();
                i += 1;
            } else if (c < 0xE0) {
                if (i + 1 >= end) revert BadName();
                uint256 cp = ((c & 0x1F) << 6) | (uint8(b[i + 1]) & 0x3F);
                if (cp == 0xAD) revert BadName();
                i += 2;
            } else if (c < 0xF0) {
                if (i + 2 >= end) revert BadName();
                uint256 cp = ((c & 0x0F) << 12) | ((uint256(uint8(b[i + 1])) & 0x3F) << 6) | (uint8(b[i + 2]) & 0x3F);
                if ((cp >= 0x200B && cp <= 0x200F) || (cp >= 0x2060 && cp <= 0x206F) || cp == 0xFEFF) revert BadName();
                i += 3;
            } else {
                i += 4;
            }
        }
        if (len <= 32) {
            for (uint256 i = 0; i < len; i++) id |= bytes32(b[start + i]) >> (i * 8);
        } else {
            bytes memory trimmed = new bytes(len);
            for (uint256 i = 0; i < len; i++) trimmed[i] = b[start + i];
            id = keccak256(trimmed) & bytes32(~(uint256(0xff) << 248));
        }
    }

    function _isSpace(bytes1 c) private pure returns (bool) {
        return c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d;
    }
}
