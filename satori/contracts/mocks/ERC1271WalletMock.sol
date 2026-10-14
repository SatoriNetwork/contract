// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ERC1271WalletMock
 * @notice A smart-contract wallet standing in for the class of accounts the
 *         `permit(..., bytes)` overload exists to serve: Safes, ERC-4337
 *         accounts, and Base Account.
 *
 * @dev The signature it accepts is DELIBERATELY not 65 bytes. That is the whole
 *      point of the overload: ERC-2612's `(v, r, s)` parameters express exactly
 *      65 bytes, so a Safe's concatenated owner signatures or a passkey's
 *      authenticator payload cannot be passed through the standard entry point at
 *      all. A mock that signed with a single 65-byte ECDSA blob would pass
 *      against the old interface too and prove nothing.
 *
 *      `mode` drives the three behaviours the token must handle distinctly:
 *      accept, reject, and revert. A reverting `isValidSignature` must DENY
 *      rather than brick the call — the token reaches it through a low-level
 *      staticcall precisely so a hostile account cannot bubble a revert out.
 */
contract ERC1271WalletMock {
    bytes4 private constant MAGIC = 0x1626ba7e; // IERC1271.isValidSignature.selector

    enum Mode { Accept, Reject, Revert, WrongMagic, ShortReturn }

    Mode public mode;
    /// The one signature blob this "wallet" considers valid. Any length.
    bytes public expected;

    constructor(bytes memory expected_) {
        expected = expected_;
    }

    function setMode(Mode m) external { mode = m; }

    /// Lets a test drive the wallet as the CALLER, so `msg.sender` at the far end
    /// is this contract rather than an EOA. Needed to exercise entry points that
    /// permit on behalf of `msg.sender`: without it a smart account can only ever
    /// be the signature's subject, never the transaction's sender, and the
    /// contract-account path goes untested.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly { revert(add(ret, 0x20), mload(ret)) }
        }
        return ret;
    }

    function isValidSignature(bytes32, bytes calldata signature) external view returns (bytes4) {
        if (mode == Mode.Revert) revert("wallet down");
        if (mode == Mode.WrongMagic) return 0xdeadbeef;
        if (mode == Mode.ShortReturn) {
            // Returns fewer than 32 bytes; the token's length check must reject it.
            assembly { return(0, 4) }
        }
        if (mode == Mode.Reject) return 0x00000000;
        return keccak256(signature) == keccak256(expected) ? MAGIC : bytes4(0);
    }
}
