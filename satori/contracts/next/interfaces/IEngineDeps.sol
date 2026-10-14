// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal token surface the engine reads (clock, deployment round, predict-lane lock).
interface IEngineToken {
    function getCurrentRound() external view returns (uint256);
    function deploymentRound() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function lockUntil(address user, uint8 lane) external view returns (uint24);
    /// The governor was split into one slot per job (dao-governance.md v2). The
    /// engine needs two of them: `appoint` for the curve dials and the curve
    /// operator, `upgrade` for its own proxy gate.
    function appointAuthority() external view returns (address);
    function upgradeAuthority() external view returns (address);
}

/// The hub's privileged-op gateway, as the engine uses it. The hub is the token's
/// sole controller; it permissions callers and forwards to the token.
interface IEngineGateway {
    function engineLock(address user, uint24 untilRound) external;
    /// Minimum total prediction power required to grow a streak. One definition,
    /// owned by the hub (docs/design/farming-threshold.md).
    function farmingThreshold() external view returns (uint256);
}
