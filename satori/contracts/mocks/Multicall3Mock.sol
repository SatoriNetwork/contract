// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Multicall3Mock
 * @notice Minimal Multicall3 surface for hardhat-local dev. Implements the
 *         subset the satori-ui dapp actually calls:
 *           - aggregate3(Call3[])    — per-call allowFailure batch reads
 *           - getBlockNumber()
 *           - getChainId()
 * @dev On mainnet (and most EVM chains) Multicall3 lives at the canonical
 *      address 0xcA11bde05977b3631167028862bE2a173976CA11. Hardhat's
 *      `hardhat_setCode` is the standard pattern for placing this mock's
 *      runtime bytecode at that address so the dapp's hard-coded address
 *      points at something live on chainId 31337. See deploy.js for the
 *      setCode call.
 *
 *      This intentionally does NOT implement the rest of Multicall3
 *      (`aggregate`, `tryAggregate`, `blockAndAggregate`, etc.). If the
 *      dapp ever adds a consumer for those, extend here in step with the
 *      canonical interface.
 */
contract Multicall3Mock {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        uint256 length = calls.length;
        returnData = new Result[](length);
        for (uint256 i = 0; i < length; i++) {
            Call3 calldata call = calls[i];
            (bool success, bytes memory ret) = call.target.call(call.callData);
            if (!success && !call.allowFailure) {
                // Bubble up the failure so callers see the underlying revert,
                // matching canonical Multicall3 behavior.
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            returnData[i] = Result({success: success, returnData: ret});
        }
    }

    function getBlockNumber() external view returns (uint256) {
        return block.number;
    }

    function getChainId() external view returns (uint256) {
        return block.chainid;
    }
}
