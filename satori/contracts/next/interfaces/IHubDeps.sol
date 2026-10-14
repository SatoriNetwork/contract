// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../../libraries/SatoriTypes.sol";

/// Full token surface the hub (token controller) needs.
interface ISatoriTokenFull {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    /// ERC20Burnable — spends the caller's allowance and destroys the tokens.
    /// The burn-to-vote path; the hub is the only caller.
    function burnFrom(address from, uint256 amount) external;
    /// The token's ERC-1271 permit overload: an arbitrary-length signature, so a
    /// Safe or passkey account can approve by signature and not only an EOA.
    /// Used by the hub's `...WithPermit` entry points, always inside try/catch.
    function permit(
        address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature
    ) external;
    function getCurrentRound() external view returns (uint256);
    function deploymentRound() external view returns (uint256);
    function totalRewardsMinted() external view returns (uint256);
    function devFeeCeiling() external view returns (uint256);
    function devFeeBps() external view returns (uint256);
    function generalCeilingFor(uint256 ceiling) external view returns (uint256);
    function generalMinted() external view returns (uint256);
    function devFeeMinted() external view returns (uint256);
    /// The governor was split into one slot per job (dao-governance.md v2). The
    /// hub's `setSatoriMerkle` is a pointer binding, so it reads `wiring`.
    function wiringAuthority() external view returns (address);
    function appointAuthority() external view returns (address);
    function hasParticipated(address) external view returns (bool);
    function lockUntil(address user, uint8 lane) external view returns (uint24);
    // controller ops
    function rewardMint(address to, uint256 amount) external;
    function setLock(address user, uint8 lane, uint24 untilRound) external;
    function markParticipated(address user) external;
    function unmarkParticipated(address user) external;
}

/// Engine views + hub-only setters the hub calls.
interface ISatoriEngineView {
    function roundPredictionCount(uint256 round) external view returns (uint256);
    function eligibilityRound(uint256 round) external view returns (uint256);
    function predictedStreamsCount(address user, uint256 round) external view returns (uint256);
    function streaks(address user, uint32 gameId) external view returns (uint256);
    function predictions(address user, uint32 gameId, uint256 round)
        external view returns (SatoriTypes.Prediction memory);
    function getLatestPrediction(address user, uint32 gameId)
        external view returns (SatoriTypes.Prediction memory);
    function markDefaultStreamInitialized() external;
    function predictMultipleFor(
        address user, address referrer, SatoriTypes.PredictionRequestWithPayload[] calldata requests
    ) external;
}
