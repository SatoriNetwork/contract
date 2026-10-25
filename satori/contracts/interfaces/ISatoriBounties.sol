// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISatoriBounties
 * @notice Bounty share is pure stake-share:
 *             share = pot × userStake / totalStake
 *         Eligibility requires `bountyStake[user][T] > 0` at predict time
 *         (the predict-time snapshot in `applyBoost`). No SATORI in the
 *         bounty math; skill rewards itself via frequency.
 */
interface ISatoriBounties {
    /// @notice Score-time per-token credit. Called from SatoriRewards
    ///         `scoreCorrectPrediction` only when the settling prediction's
    ///         per-prediction "boosted" bit is set. Iterates the user's
    ///         predict-time boosted-token set for the round; for each funded
    ///         token, lazy-drips the pot and credits
    ///         `share = pot × userStake / totalStake` from the snapshot.
    ///         `totalStake` is the boost on BOTH directions: each prediction
    ///         scores its own window, so both can win one round.
    function creditBountyForWin(
        address user,
        uint32 gameId,
        uint32 round
    ) external;

    /// @notice Predict-time auto-boost hook. Called by `SatoriEngine._makePrediction`
    ///         (binary path only; adapter games use `snapshotAdapterStake` instead).
    ///         For every token T the user has stake in AND the game has a live
    ///         bounty in:
    ///           - snapshots `stake × multiplier` into
    ///             `boostStakeForPrediction[user][game][round][T]`
    ///           - bumps `_totalBoostStakeByKey[game][round][key][T]`
    ///           - locks the user's T stake until round + 1 (cycle guard)
    /// @param key        Outcome group: binary passes `uint96(direction)`,
    ///                   adapter passes the predictor's bucket from `record`.
    /// @param multiplier Binary passes the streak multiplier; adapter passes 1
    ///                   (pure stake weighting — no streak on adapter games).
    /// @return boosted True iff at least one snapshot was written.
    function applyBoost(
        address user,
        uint32 gameId,
        uint256 round,
        uint96 key,
        uint256 multiplier
    ) external returns (bool boosted);

    /// @notice Clear (and refund) the per-(user, round) boosted-token set once
    ///         the user's last prediction for `round` has finalized — after
    ///         that no `creditBountyForWin` can read it. Called by
    ///         `SatoriRewards.notifyPredictionFinalized` only on the round's
    ///         final finalize when it lands on a bounty game.
    function clearRoundBountyList(address user, uint256 round) external;

    /// @notice Adapter predict-time stake snapshot for the round's single ACTIVE
    ///         bounty token (first queued token with live funding, pinned + frozen
    ///         for the round). Snapshots + locks the caller's stake and returns it
    ///         so the core can fold it into the adapter's `bountyTotal`. 0 ⇒ no
    ///         live bounty or the user has no stake in it.
    function snapshotAdapterStake(address user, uint32 gameId, uint256 round)
        external returns (uint256 stake);

    /// @notice A boosted binary prediction finalized WITHOUT a win (loss, void,
    ///         unrecoverable, displaced). Its share of each boosted token's pot
    ///         goes back to the pool now instead of waiting for the history ring
    ///         to roll past the round. Engine only; call before the finalize
    ///         notification clears the user's boosted set.
    function releaseForfeit(address user, uint32 gameId, uint32 round) external;

    /// @notice Adapter score-time bounty credit (score/total, single token).
    ///         Pays pot(T) × (userScore × stake) / bountyTotal; first scorer pins
    ///         `bountyTotal`; running paid capped ⇒ Σ ≤ one pot.
    function creditAdapterBounty(
        address user,
        uint32 gameId,
        uint256 round,
        uint256 userScore,
        uint256 bountyTotal
    ) external;
}
