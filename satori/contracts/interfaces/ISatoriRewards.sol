// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;


interface ISatoriRewards {
    /**
     * @notice Predict-time commit: snapshot delegation power AND write the
     *         committed weight for this prediction's (direction, round).
     * @dev Weight is computed by the engine at predict time using the
     *      user's CURRENT-streak multiplier (no `+1` look-ahead — the
     *      streak they came in with) and the stream's
     *      eligibility-at-predict-time, then passed in. Conservation falls
     *      out naturally: every prediction commits to `totalWeightByDirection`
     *      at predict time, so the denominator is final by the per-round
     *      predict deadline. Does NOT bump `_unsettledPredictionCount` —
     *      pair with one `bumpUnsettled(user, round, requests.length)` at
     *      the top of the predict batch (1 counter-write instead of N).
     * @param user The predictor address
     * @param round The round number
     * @param direction The prediction direction (1 = UP, 2 = DOWN)
     * @param weight The committed weight (already scaled by streak multiplier
     *        and, for eligible streams, divided by daily-totals)
     */
    function scorePrediction(
        address user,
        uint32 gameId,
        uint256 round,
        uint8 direction,
        uint256 weight
    ) external;

    /**
     * @notice Bulk-add `count` to the per-user pending-prediction counter
     *         for `round`. Called once from the engine's predict batch
     *         before its per-stream loop.
     */
    function bumpUnsettled(address user, uint256 round, uint256 count) external;

    /**
     * @notice Score-time eager credit for a CORRECT prediction.
     * @dev `weight` is the per-(user, game, round, direction) committed
     *      weight, re-derived by the caller (the engine) from the in-storage
     *      Prediction struct (`rawPredictionPower * multiplier`, scaled by
     *      1/totalVotes for eligible streams). Passed in rather than
     *      stored-and-looked-up so the per-prediction cold-SSTORE of the
     *      old `userWeightByDirection` mapping is gone. This call first
     *      cross-calls SatoriBounties.creditBountyForWin when `wasBoosted`
     *      (pure stake-share bounty payout), then computes the SATORI reward
     *      (per-game pool × weight / total), splits it predictor/delegator
     *      (the predictor keeps the predictor fee on the delegated portion;
     *      the delegators' share feeds the per-round delegator-rate
     *      accumulator), and credits the predictor's share through the
     *      referral-skimming credit path. No deferred-walk machinery.
     *      `named` is the engine's settle-time `streamScoringInfo` read: a named
     *      game pays pari-mutuel. Other games divide by both sides' total,
     *      except the default game, which divides by its own side's.
     */
    function scoreCorrectPrediction(
        address user,
        uint32 gameId,
        uint256 round,
        uint8 direction,
        uint256 weight,
        bool wasBoosted,
        bool named
    ) external;

    /**
     * @notice Adapter-game predict-time commit (score/total model). Writes the
     *         delegation snapshot and marks the (user, gameId, round) bet
     *         pending. No SATORI weight is stored — that share is decided at
     *         score time. Does NOT bump the per-user pending counter (the
     *         caller pre-bumps via `bumpUnsettled` for the whole batch).
     */
    function recordAdapterPrediction(
        address user,
        uint32 gameId,
        uint256 round,
        bool boosted
    ) external;

    /**
     * @notice Adapter-game score-time entry. Pays no SATORI. If this bet was
     *         boosted, it pays the round's single
     *         active bounty token's pot by `pot × (userScore × stake) /
     *         bountyTotal` (first-scorer pins `bountyTotal`, running paid capped).
     *         Conservation: the bounty paid per (game, round) <= its pot.
     * @return finalized Whether a REAL protocol-recorded pending bet was
     *                    consumed by this call. False for a no-op — the game is
     *                    off-chain, or the user had no pending on it. The caller
     *                    MUST NOT decrement the unsettled counter when this is
     *                    false, or an untrusted adapter reporting a phantom
     *                    "resolved" could strand a victim's counter (F1).
     * @return wasBoosted Whether this bet took a bounty snapshot at predict
     *                    (threaded into _notifyFinalized so the round's
     *                    boosted-token list is cleared on the last finalize).
     */
    function scoreAdapterPrediction(
        address user,
        uint32 gameId,
        uint256 round,
        uint256 userScore,
        uint256 bountyTotal
    ) external returns (bool finalized, bool wasBoosted);


    /**
     * @notice Notify Rewards that a prediction has been finalized (correct,
     *         incorrect, voided, or unrecoverable). Decrements the per-user
     *         pending counter; on the round's LAST finalize, when the finalizing
     *         prediction was boosted, cross-calls SatoriBounties.clearRoundBountyList.
     * @param user The predictor address
     * @param round The round the prediction was made on
     * @param wasBoosted Whether this prediction took a bounty snapshot (the
     *        prediction slot's "boosted" bit) — gates the round-list clear
     */
    function notifyPredictionFinalized(address user, uint256 round, bool wasBoosted) external;

    /**
     * @notice Self-claim entry: claim `owner`'s rewards to `recipient`.
     * @param owner The reward owner (same address as caller; this is the
     *        non-delegated path — see `claimFor` for the claim-delegation
     *        variant)
     * @param recipient The address to send rewards to
     * @return The amount of rewards claimed
     */
    function claim(address owner, address recipient) external returns (uint256);

    /**
     * @notice Claim rewards for an owner using claim delegation authorization
     * @param owner The reward owner
     * @param caller The original caller (owner or authorized claim delegate)
     * @param recipient The address to send rewards to
     * @return The amount of rewards claimed
     */
    function claimFor(address owner, address caller, address recipient) external returns (uint256);

    /**
     * @notice Self-claim that mints `fee` to `feeTo` out of the bucket and the
     *         remainder to `recipient`. Reverts if `fee` exceeds the bucket.
     */
    function claimWithFee(address owner, address recipient, address feeTo, uint256 fee) external returns (uint256);

    /// @notice A stream produced a value this round (registry-gated, deduped per
    ///         stream per round). Arms off-chain game pots on that stream.
    function onStreamProduced(uint32 streamId) external;

    function syncPredictionDelegation(address from, address to, uint256 value) external;

    function delegatePredictionPower(address delegate, address delegator, uint256 power) external;

    function delegateClaimAbility(address delegate, address delegator) external;

    /// @notice Total prediction power for a user (own + delegated).
    function getPredictionPower(address user) external view returns (uint256);

    /// @notice Auto-getter for the public `predictionDelegateInfo` mapping.
    ///         Returns (delegate, power) as a tuple.
    function predictionDelegateInfo(address user) external view returns (address delegate, uint96 power);

    /// @notice Auto-getter for the public `predictionDelegationInfo` snapshot.
    ///         Returns (ownPower, delegatedPower) captured at predict-time.
    ///         (Previously also returned `sumPower` as rawPower; that's now
    ///         stored inline on SatoriEngine's packed `userPredictions` slot and
    ///         recovered via `_predRaw` at score time.)
    function predictionDelegationInfo(address user, uint32 gameId, uint256 round)
        external view returns (uint128 ownPower, uint128 delegatedPower);

    function admin() external view returns (address);
    function setAdmin(address newAdmin) external;

    /// @notice Progressive-rollout capability flags (storage + admin setter live
    ///         on rewards; the hub and bounties gate against them).
    function setCapabilities(uint256 bitmap) external;
    function capabilityAllowed(uint8 capId, address caller) external view returns (bool);

    /**
     * @notice Set the caller's referral address. Set-once, immutable. Called
     *         directly on SatoriRewards (no hub/engine forwarder exists for this; the engine's predictMultipleWithReferral uses setReferralFor instead).
     * @param ref The referral address
     */
    function setReferral(address ref) external;
    /// @notice Best-effort, onlyCore referral set for `user` (never reverts;
    ///         no-op on zero/self ref or an already-set slot).
    function setReferralFor(address user, address ref) external;
    function referral(address user) external view returns (address);
    /// @notice onlyCore `setPredictorFee` as `user` — the hub's relay path.
    function setPredictorFeeFor(address user, uint16 bps) external;

    /// @notice The SATORI burned to register a community stream or game adapter.
    function registrationFee() external view returns (uint256);
}
