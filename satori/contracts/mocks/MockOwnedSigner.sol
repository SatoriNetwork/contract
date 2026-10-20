// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice An ERC-1271 account that approves exactly what its owner key signed
///         over the given hash, so a wrong digest fails (unlike ERC1271WalletMock).
contract MockOwnedSigner {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        (address got, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && got == owner ? bytes4(0x1626ba7e) : bytes4(0);
    }
}
