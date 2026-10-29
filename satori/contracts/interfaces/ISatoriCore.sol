// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/SatoriTypes.sol";

interface ISatoriCore {
    /// @notice Current round number = block.timestamp / timeUnitSeconds.
    function getCurrentRound() external view returns (uint256);

    /// @notice The per-round dev fee accruing this round (the senior slice off the
    ///         top of the round's emission). The on-chain game gross is the residual.
    function devRateNow() external view returns (uint256);

    /// @notice This round's rate under the hub's issuance-indexed, admin-settable
    ///         schedule; frozen for the whole round. The token's
    ///         ROUND_REWARD_BUDGET is only the outer constitutional envelope.
    function emissionRateNow() external view returns (uint256);

    /// @notice The rate round cur+1 will pay; equals `emissionRateNow` unless a
    ///         step landed this round.
    function emissionRateNext() external view returns (uint256);

    /// @notice `emissionRateNext` net of the dev fee. Both dial bounds check
    ///         against this, because a dial change is effective next round.
    function residualNext() external view returns (uint256);

    /// @notice Count a general-lane reward commit (`userPortion +
    ///         committedDelegatorShare`): reported to the token as earned (the
    ///         token books the dev fee on it) and toward the issuance counter
    ///         that triggers emission steps. Refuses a commit beyond the rounds
    ///         priced by `freezeRoundGross`. Restricted to SatoriRewards.
    function noteIssued(uint256 general) external;

    /// @notice The on-chain gross a fresh round is priced at: the residual
    ///         after the dev fee, less the off-chain share.
    function onChainGrossNow() external view returns (uint256);

    /// @notice Price the current round once, on its first touch, returning its
    ///         on-chain gross; the on-chain lane may commit that much more. A
    ///         repeat call for the same round returns 0 and adds nothing.
    ///         Restricted to SatoriRewards.
    function freezeRoundGross(uint256 round) external returns (uint256 gross);

    /// @notice Which round's vote weights govern `round`. The identity — a
    ///         prediction is paid against its OWN round's weights.
    function eligibilityRound(uint256 round) external view returns (uint256);

    /// @notice Mint tokens as reward. Restricted to SatoriRewards (on-chain
    ///         lane) and the wired SatoriMerkle (reserve lane); the hub enforces the split.
    function rewardMint(address to, uint256 amount) external;



    /**
     * @notice Mirror the reward split (`SatoriRewards.offchainShareBps`) into
     *         core's Merkle reserve. Restricted to SatoriRewards; called from
     *         `setOffchainShareBps`. Core banks the old share through the
     *         current round, then the new one applies from the next.
     */
    function setMerkleReserveBps(uint256 bps) external;

    function balanceOf(address account) external view returns (uint256);

    function satoriRewards() external view returns (address);

    function satoriRegistry() external view returns (address);

    function satoriGames() external view returns (address);

    /// @notice Lock the user's balance until they undelegate.
    function lockUntilUndelegation(address user) external;

    /// @notice Lock the user's balance until the next round.
    function lockUntilNextRound(address user) external;

    /**
     * @notice Mark `user` as a protocol participant. Read by
     *         SatoriToken._update's participation skip-mask to decide whether
     *         to fire the hub transfer hook (which runs the child sync calls).
     *         Only SatoriRewards calls it (when a user delegates); the hub
     *         reverts `Unauthorized` for any other caller.
     */
    function markParticipated(address user) external;

    /// @notice Clears the delegator gate (bit 240) for `user`, the symmetric
    ///         partner of markParticipated. Only rewards calls it, on undelegate.
    function unmarkParticipated(address user) external;

    /**
     * @notice Burn the upfront bounty fee (heavy SATORI tier) from `funder`.
     *         Called by SatoriBounties.fundBounty when a bounty is
     *         posted in a NON-SATORI token. Reverts if `funder` is short on
     *         SATORI. Restricted to the bounties child.
     * @return fee The SATORI amount burned.
     */
    function chargeBountyBurn(address funder) external returns (uint256 fee);

    /// @notice Look up a user's Prediction on a specific (game, round).
    /// @dev Used by SatoriRewardsLens.userWeightByDirection to re-derive the
    ///      committed weight from `rawPredictionPower` + `multiplier` without a
    ///      dedicated storage mapping. Returns the zero-valued Prediction when
    ///      no slot matches.
    function predictions(address user, uint32 gameId, uint256 round)
        external view returns (SatoriTypes.Prediction memory);
}
