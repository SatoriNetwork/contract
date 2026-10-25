// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev `anchorEvicted` is true only once the round's anchor entry has been
///      pushed out of the hour-keyed history ring — after which no binary
///      prediction from that round can ever score a win again (design 9.5).
interface IRegistryForBounties {
    function getFirstValueAfter(uint32 streamId, uint256 afterHour)
        external view returns (int232 valueB, bool found, bool anchorEvicted);
    function isNamedStream(uint32 streamId) external view returns (bool);
}
