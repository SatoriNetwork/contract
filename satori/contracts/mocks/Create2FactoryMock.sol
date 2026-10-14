// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Create2FactoryMock
 * @notice Behavioural stand-in for Arachnid's deterministic deployment proxy,
 *         for hardhat-local dev only.
 *
 * @dev On every real target chain the proxy already exists at the canonical
 *      address 0x4e59b44847b379578588920cA78FbF26c0B4956C — it is an OP Stack
 *      *preinstall*, so it is present on Base and every Superchain chain by
 *      construction, and it is separately deployed on most other EVM chains.
 *      A fresh hardhat chain has nothing there, so `deploy.js` installs this
 *      mock's runtime bytecode at that address with `hardhat_setCode`, exactly
 *      as it already does for Multicall3Mock.
 *
 *      WHY A BEHAVIOURAL MOCK IS SOUND HERE. A CREATE2 address is
 *      `keccak256(0xff ++ factory ++ salt ++ keccak256(initCode))[12:]`. The
 *      factory's *address* is an input; its *code* is not. So a faithful mock at
 *      the canonical address yields byte-identical deployment addresses to the
 *      real proxy — which is the whole property the Superchain requires, and it
 *      is asserted directly in test/next/Create2Deploy.test.js rather than
 *      assumed.
 *
 *      PROTOCOL (Arachnid's, reproduced exactly):
 *        calldata = salt (32 bytes) ++ initCode (rest)
 *        returns  = the 20-byte deployed address
 *
 *      Note the deliberate absence of a revert on failure: the real proxy
 *      returns the zero address when CREATE2 fails (address already taken, or
 *      constructor reverted) rather than bubbling it up. That is a genuine
 *      footgun and it is reproduced rather than fixed, so the deploy scripts are
 *      forced to handle it the same way here as in production — they verify code
 *      actually landed at the predicted address instead of trusting the receipt.
 */
contract Create2FactoryMock {
    fallback() external payable {
        assembly {
            let salt := calldataload(0)
            let size := sub(calldatasize(), 32)
            calldatacopy(0, 32, size)
            let deployed := create2(callvalue(), 0, size, salt)
            mstore(0, deployed)
            return(12, 20)
        }
    }
}
