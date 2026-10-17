// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Coined's `register` for local stacks and tests. `_id` through `_scriptOf` are
// copied verbatim from coined/contracts/src/CoinedState.sol (at d2a101d): a
// named stream's name is a Coined term, so a name the real Coined refuses must
// be refused here too. Re-copy them whenever Coined's text rules change.
contract MockCoined {
    error EmptyName();
    error BadName();
    error MixedScript();

    event Coined(bytes32 indexed id, string text);

    mapping(bytes32 => bool) public exists;

    function register(string calldata text) external returns (bytes32 id) {
        id = idOf(text);
        if (exists[id]) return id;
        exists[id] = true;
        emit Coined(id, text);
    }

    function idOf(string memory text) public pure returns (bytes32 id) {
        return _id(text, true);
    }

    function _id(string memory text, bool check) internal pure returns (bytes32 id) {
        bytes memory b = bytes(text);
        uint256 start = 0;
        uint256 end = b.length;
        while (start < end && _isSpace(b[start])) start++;
        while (end > start && _isSpace(b[end - 1])) end--;
        uint256 len = end - start;
        if (len == 0) revert EmptyName();
        if (check) _checkText(b, start, end);

        if (len <= 32) {
            for (uint256 i = 0; i < len; i++) {
                id |= bytes32(b[start + i]) >> (i * 8);
            }
        } else {
            bytes memory trimmed = new bytes(len);
            for (uint256 i = 0; i < len; i++) {
                trimmed[i] = b[start + i];
            }
            id = keccak256(trimmed) & bytes32(~(uint256(0xff) << 248));
        }
    }

    function _isSpace(bytes1 c) private pure returns (bool) {
        return c == 0x20 || c == 0x09 || c == 0x0a || c == 0x0d;
    }

    /// WHAT A NAME MAY BE MADE OF. Printable text in ONE writing system, plus
    /// digits, punctuation, symbols and emoji. Control bytes are refused:
    /// "bit\x01coin" renders as "bitcoin". Invisible characters are refused:
    /// a zero-width space makes a second "bitcoin" nobody can see. Every
    /// space but the plain ASCII one is refused: a no-break space renders as
    /// a space, so "free<NBSP>speech" is a "free speech" nobody can tell
    /// apart — and since the edge trim leaves it alone, one at the end would
    /// hide inside the id too. Letters from two alphabets are refused:
    /// "bitcoin" with a Cyrillic о is the same trick. Lookalikes within one
    /// alphabet (l and I, rn and m, styled letters) are the client's to flag;
    /// the chain cannot see them.
    function _checkText(bytes memory b, uint256 start, uint256 end) private pure {
        uint256 script;
        uint256 i = start;
        while (i < end) {
            uint256 c = uint8(b[i]);
            uint256 cp;
            if (c < 0x80) {
                if (c < 0x20 || c == 0x7f) revert BadName();
                cp = c;
                i += 1;
            } else if (c < 0xE0) {
                if (c < 0xC2 || i + 1 >= end) revert BadName();
                cp = ((c & 0x1F) << 6) | _tail(b, i + 1);
                i += 2;
            } else if (c < 0xF0) {
                if (i + 2 >= end) revert BadName();
                cp = ((c & 0x0F) << 12) | (_tail(b, i + 1) << 6) | _tail(b, i + 2);
                if (cp < 0x800 || (cp >= 0xD800 && cp < 0xE000)) revert BadName();
                i += 3;
            } else {
                if (c > 0xF4 || i + 3 >= end) revert BadName();
                cp = ((c & 0x07) << 18) | (_tail(b, i + 1) << 12) | (_tail(b, i + 2) << 6) | _tail(b, i + 3);
                if (cp < 0x10000 || cp > 0x10FFFF) revert BadName();
                i += 4;
            }
            uint256 s = _scriptOf(cp);
            if (s == 0) continue;
            if (script == 0) script = s;
            else if (s != script) revert MixedScript();
        }
    }

    /// a UTF-8 continuation byte's six bits
    function _tail(bytes memory b, uint256 i) private pure returns (uint256) {
        uint256 c = uint8(b[i]);
        if (c & 0xC0 != 0x80) revert BadName();
        return c & 0x3F;
    }

    /// The writing system of a code point: 0 for anything that belongs to
    /// none (digits, punctuation, marks, symbols, emoji), a small number for
    /// each alphabet that has lookalikes of another, a block number for the
    /// rest. Invisible and private-use characters revert, and so do the C1
    /// controls and every space separator other than 0x20 (no-break, ogham,
    /// en/em/thin/hair, line and paragraph, narrow no-break, mathematical,
    /// ideographic): each renders as a space the trim does not touch. The
    /// invisible list is Unicode's Default_Ignorable set in full — the hangul
    /// fillers, the khmer and mongolian ignorables and the musical and
    /// shorthand format controls draw nothing just as a zero-width space does
    /// — plus the braille blank, a glyph that is an empty cell.
    function _scriptOf(uint256 cp) private pure returns (uint256) {
        if (cp < 0x80) return (cp | 0x20) >= 0x61 && (cp | 0x20) <= 0x7A ? 1 : 0;
        if (
            cp < 0xA1 || cp == 0xAD || cp == 0x34F || cp == 0x61C || cp == 0x115F || cp == 0x1160 || cp == 0x1680
                || cp == 0x17B4 || cp == 0x17B5 || (cp >= 0x180B && cp <= 0x180F) || (cp >= 0x2000 && cp <= 0x200F)
                || (cp >= 0x2028 && cp <= 0x202F) || (cp >= 0x205F && cp <= 0x206F) || cp == 0x2800 || cp == 0x3000
                || cp == 0x3164 || (cp >= 0xE000 && cp <= 0xF8FF) || (cp >= 0xFE00 && cp <= 0xFE0F) || cp == 0xFEFF
                || cp == 0xFFA0 || (cp >= 0xFFF0 && cp <= 0xFFFF) || (cp >= 0x1BCA0 && cp <= 0x1BCA3)
                || (cp >= 0x1D173 && cp <= 0x1D17A) || (cp >= 0xE0000 && cp <= 0xE0FFF) || cp >= 0xF0000
        ) revert BadName();
        if (cp < 0xC0) return 0; // latin-1 punctuation and symbols
        if (cp < 0x300) return cp == 0xD7 || cp == 0xF7 ? 0 : 1; // latin, IPA, modifier letters
        if (cp < 0x370) return 0; // combining marks
        if (cp < 0x400) return 2; // greek
        if (cp < 0x530) return 3; // cyrillic
        if (cp < 0x590) return 4; // armenian
        if (cp < 0x600) return 5; // hebrew
        if (cp < 0x900) return 6; // arabic, syriac, thaana, nko
        if (cp < 0xF00) return 7 + (cp - 0x900) / 0x80; // the indic blocks, thai, lao
        if (cp < 0x1100) return 1000 + cp / 0x100;
        if (cp < 0x1200) return 30; // hangul jamo
        if (cp < 0x13A0) return 1000 + cp / 0x100;
        if (cp < 0x1400) return 31; // cherokee
        if (cp < 0x1E00) return 1000 + cp / 0x100;
        if (cp < 0x1F00) return 1; // latin extended additional
        if (cp < 0x2000) return 2; // greek extended
        if (cp < 0x2100) return 0; // general punctuation, super/subscripts, currency
        if (cp < 0x2190) return 1; // letterlike symbols, roman numerals
        if (cp < 0x2460) return 0; // arrows, math, technical, box drawing
        if (cp < 0x2500) return 1; // enclosed alphanumerics
        if (cp < 0x2C00) return 0; // shapes, symbols, dingbats, braille
        if (cp < 0x2C60) return 1000 + cp / 0x100;
        if (cp < 0x2C80) return 1; // latin extended-c
        if (cp < 0x2E80) return 1000 + cp / 0x100;
        if (cp < 0x3000) return 30; // cjk radicals
        if (cp < 0x3040) return 0; // cjk punctuation
        if (cp < 0xA000) return 30; // kana, bopomofo, hangul compatibility, han
        if (cp < 0xA4D0) return 1000 + cp / 0x100;
        if (cp < 0xA500) return 32; // lisu
        if (cp < 0xA640) return 1000 + cp / 0x100;
        if (cp < 0xA6A0) return 3; // cyrillic extended-b
        if (cp < 0xA720) return 0; // modifier tone letters
        if (cp < 0xA800) return 1; // latin extended-d
        if (cp < 0xAB30) return 1000 + cp / 0x100;
        if (cp < 0xAB70) return 1; // latin extended-e
        if (cp < 0xABC0) return 31; // cherokee supplement
        if (cp < 0xAC00) return 1000 + cp / 0x100;
        if (cp < 0xD7B0) return 30; // hangul syllables
        if (cp < 0xF900) return 1000 + cp / 0x100;
        if (cp < 0xFB00) return 30; // cjk compatibility
        if (cp < 0xFB07) return 1; // latin ligatures
        if (cp < 0xFB50) return 1000 + cp / 0x100;
        if (cp < 0xFE00) return 6; // arabic presentation forms
        if (cp < 0xFE70) return 0; // cjk compatibility forms, small forms
        if (cp < 0xFF00) return 6; // arabic presentation forms b
        if (cp < 0xFF21) return 0; // fullwidth punctuation and digits
        if (cp < 0xFF5B) return 1; // fullwidth latin
        if (cp < 0xFF66) return 0;
        if (cp < 0xFFE0) return 30; // halfwidth kana and hangul
        if (cp < 0x10000) return 0;
        if (cp < 0x1D400) return 1000 + cp / 0x100;
        if (cp < 0x1D6A8) return 1; // mathematical latin
        if (cp < 0x1D7CC) return 2; // mathematical greek
        if (cp < 0x1D800) return 0; // mathematical digits
        if (cp < 0x1F000) return 1000 + cp / 0x100;
        if (cp < 0x20000) return 0; // emoji and symbols
        if (cp < 0x40000) return 30; // cjk extensions
        return 1000 + cp / 0x100;
    }
}
