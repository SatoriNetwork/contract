// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal forward of the rewards getters the Lens needs. Avoids
///         dragging in the full ISatoriRewards interface and its many
///         scoring/claim mutators.
interface IRewardsForLens {
    function effectivePredictorFee(address predictor) external view returns (uint16);
    function totalWeightPacked(uint32 gameId, uint256 round) external view returns (uint256);
    function unclaimedRewards(address user) external view returns (uint256);
    function delegationPeriodsLength(address user) external view returns (uint256);
    function firstActiveDelegationPeriod(address user) external view returns (uint256);
    function delegationPeriodAt(address user, uint256 i) external view returns (
        address delegate,
        uint24 startRound,
        uint24 endRound,
        uint24 nextClaimRound,
        uint256 startBalance,
        uint256 checkpointsLength,
        uint256 openRoundsLength
    );
    function delegationCheckpointAt(address user, uint256 i, uint256 j) external view returns (uint24 round, uint224 value);
    function delegationOpenRoundAt(address user, uint256 i, uint256 j) external view returns (uint24 round, uint224 banked);
    function delegatorRewardRatePerRound(address delegate, uint256 round) external view returns (uint256);
    function offchainBudget() external view returns (uint256);
    function registrationFee() external view returns (uint256);
}
