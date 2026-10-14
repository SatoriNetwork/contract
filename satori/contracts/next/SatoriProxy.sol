// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal ERC-1967 UUPS proxy (0.8.20-compatible; avoids OZ proxy code that
/// requires solc >= 0.8.22, keeping the whole project on one compiler). The
/// implementation address lives in the standard ERC-1967 slot so the implementation's
/// sequential storage (slots 0,1,2,...) never collides with it. Upgrade logic
/// lives in the implementation (SatoriUUPS.upgradeTo, inherited by the hub and
/// children), executed here via delegatecall — the UUPS pattern.
contract SatoriProxy {
    // bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 private constant _IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    event Upgraded(address indexed implementation);

    constructor(address implementation, bytes memory initData) {
        require(implementation.code.length > 0, "impl !contract");
        // initData MUST be non-empty (the initialize call): initializing in the
        // same tx as deploy closes any front-run window on the unguarded
        // initialize(). Deploying uninitialized is forbidden.
        require(initData.length > 0, "empty initData");
        assembly { sstore(_IMPL_SLOT, implementation) }
        emit Upgraded(implementation);
        (bool ok, bytes memory ret) = implementation.delegatecall(initData);
        if (!ok) {
            assembly { revert(add(ret, 0x20), mload(ret)) }
        }
    }

    fallback() external payable {
        assembly {
            let impl := sload(_IMPL_SLOT)
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
