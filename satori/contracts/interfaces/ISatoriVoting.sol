// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ISatoriVoting
 * @dev    The votable unit is a **game** (registered in SatoriGames), not a
 *         data stream. Voting is burn-backed: SATORI is destroyed to buy a
 *         game permanent weight, and a game earns in direct proportion to it.
 *         No delegation, no locks, no threshold, no top-N — see SatoriVoting.
 */
interface ISatoriVoting {
    /// @notice Buy `gameId` permanent weight by burning SATORI. The caller (the
    ///         hub) must have already burned `amount` from `voter`.
    /// @return weightAdded The weight credited — always exactly `amount`
    ///         (weight is linear in tokens burnt; the old off-chain handicap
    ///         is gone — non-binary game types are simply not votable).
    function vote(uint32 gameId, address voter, uint256 amount) external returns (uint256 weightAdded);

    /// @notice A game's current voting weight (0 unless live — approved, or
    ///         the default). For the default game this is its derived share of
    ///         all other burned weight.
    function weightOf(uint32 gameId) external view returns (uint256);

    /// @notice Paginated leaderboard read in GAME-ID order — callers sort.
    ///         Includes unapproved games (`weights` is RAW — what was burned,
    ///         which revocation never touches; earning weight is
    ///         `approved[i] ? weights[i] : 0`).
    ///         `limit` bounds ids scanned, not entries returned; never-voted
    ///         games are skipped. Page until `nextOffset > gameCount()`.
    function getGameWeights(uint32 offset, uint32 limit, uint256 round)
        external view
        returns (
            uint32[] memory ids,
            uint256[] memory weights,
            bool[] memory approved,
            uint256[] memory burnedInRound,
            uint32 nextOffset
        );

    /// @notice Weight bought for `gameId` during `round` — the trending number.
    function gameBurnAtRound(uint32 gameId, uint256 round) external view returns (uint256);

    /// @notice Σ weight burned across all games in `round`.
    function totalBurnAtRound(uint256 round) external view returns (uint256);

    /// @notice Is `gameId` earning right now? Equivalent to `weightOf > 0` —
    ///         there is no threshold and no top-N.
    function isEligible(uint32 gameId) external view returns (bool);

    /// @notice Has the admin APPROVED `gameId`? Born false; the default game
    ///         is live without it (see `gameLive` = approved-or-default). An
    ///         unapproved game cannot be
    ///         voted on, has no predictions recorded, and cannot be scored.
    function gameApproved(uint32 gameId) external view returns (bool);
    function gameLive(uint32 gameId) external view returns (bool);

    /// @notice Freeze `gameId`'s weight into `round` and add it to that round's
    ///         denominator. Called on every prediction; only the first per
    ///         (game, round) does work. No-op for an UNAPPROVED game.
    function recordGameVotesForRound(uint32 gameId, uint256 round) external;

    /// @notice The reward denominator for a FINISHED round. Reverts
    ///         `RoundNotFinal` while `round` is still open.
    function roundDenominator(uint256 round) external view returns (uint256);

    /// @notice The round's running vote total, readable while the round is
    ///         still open. Use `roundDenominator` for anything that pays out.
    function roundVoteTotal(uint256 round) external view returns (uint256);

    /// @notice A game's frozen weight for a round — the reward numerator.
    ///         Zero means it did not participate and earns nothing.
    function getGameVotesAtRound(uint32 gameId, uint256 round) external view returns (uint256);

    /// @notice Every game that participated in `round`, in first-prediction order.
    function getEligibleGamesAtRound(uint256 round) external view returns (uint32[] memory);

    /// @notice Σ burned weight over every enabled game, excluding the default.
    function totalBurnedWeight() external view returns (uint256);

    /// @notice The default game's derived weight entitlement.
    function defaultDerivedWeight() external view returns (uint256);

    /// @notice Grant (or revoke) a game's approval. Rewards-admin only.
    function setGameApproved(uint32 gameId, bool approved) external;

    /// Re-point the caller's own burned weight from an UNAPPROVED game to a
    /// live one — the single exception to vote permanence (owner-decided
    /// 2026-09-05). Reverts `SourceStillApproved` when the source IS approved;
    /// also requires that the destination
    /// passes every `vote` guard, the amount is within the caller's recorded
    /// burns, and the source was not frozen into the current round.
    function moveVotes(uint32 fromGame, uint32 toGame, uint256 amount) external;
}
