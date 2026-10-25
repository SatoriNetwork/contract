// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPredictionGame
 * @notice Adapter interface for non-default prediction games. The protocol
 *         core dispatches `record` and `score` calls to the registered
 *         adapter for any game whose `gameTypeId != 0`. Type 0 is the
 *         built-in binary game and runs inline in `SatoriEngine.sol` — it does
 *         NOT implement this interface and never receives external calls.
 *
 *         Adapter games mint no SATORI: they carry no vote weight and draw no
 *         emission (docs/issues/adapter-games-cannot-earn.md). Their only payout
 *         is a bounty on boosted bets. `multiplier` and `total` below are still
 *         part of the return shape, but the protocol decodes past them.
 *
 * @dev    See `docs/narratives/A_game_adapters.md` for the full
 *         architectural contract — the rules in that document are
 *         load-bearing.
 *
 *         Score/total model: the protocol owns ALL money-touching state and
 *         enforces conservation; the adapter owns ALL scoring semantics. At
 *         predict time the adapter just remembers the bet (returns nothing).
 *         At score time the adapter answers, for the user's pending round, a
 *         `userScore` (raw ACCURACY numerator) and a `bountyTotal` (the sum over
 *         winners of accuracy × bounty stake). The protocol pays the round's
 *         bounty pot `pot × (userScore × stake) / bountyTotal`, PINS the first
 *         scorer's `bountyTotal` for the whole (game, round), and caps the running
 *         sum paid at the pot — so the most a game can ever pay is exactly one
 *         pot, regardless of what the adapter returns.
 *         The adapter is free to compute scores any way it likes
 *         (buckets, partial credit, multi-outcome, ranges, anything); it can
 *         decide WHO wins and how much, but can never multiply the pot.
 */
interface IPredictionGame {
    /**
     * @notice Verify that this game type can be configured against a given
     *         data stream with the provided config blob.
     * @dev    Called by the core at game-create time. Reverts on any
     *         configuration that the adapter cannot honor. MUST NOT include
     *         any lifecycle / resolution-round / "ends-at" fields.
     */
    function validateForStream(
        uint32 streamId,
        bytes calldata gameConfig
    ) external view;

    /**
     * @notice Record a bet. The adapter remembers whatever it needs to score
     *         the user later. The SATORI side stores no per-bet weight (the share
     *         is decided at score time); only the protocol's delegation snapshot +
     *         a pending flag are written protocol-side. Returns nothing.
     *
     * @dev    MUST NOT revert except on structurally invalid payload (wrong
     *         length, malformed ABI). All lifecycle and permission concerns
     *         belong to the protocol.
     *
     * @param  user         Predictor (may be a delegate).
     * @param  gameId       The game being predicted on.
     * @param  predictorPower The user's UNDIVIDED prediction power — own balance
     *                      + unclaimed + delegated-in. INFORMATIONAL ONLY: the
     *                      protocol mints no SATORI for adapter games, so this is
     *                      not a reward weight and is never read back. Note it is
     *                      NOT divided across the batch (the old
     *                      `/ eligibleCount` split existed purely to apportion
     *                      SATORI, and there is none to apportion here), so it
     *                      does not wobble with how many other games the user
     *                      predicted alongside this one. Use it or ignore it.
     * @param  bountyStake  The user's stake of the round's ACTIVE bounty token
     *                      (0 if none). The adapter folds it into `bountyTotal`
     *                      (Σ accuracy × stake over winners) so the protocol can
     *                      pay the bounty by accuracy × stake.
     * @param  payload      Adapter-defined opaque bytes (e.g. first byte is the
     *                      direction for a yes/no adapter).
     */
    function record(
        address user,
        uint32 gameId,
        uint256 predictorPower,
        uint256 bountyStake,
        bytes calldata payload
    ) external;

    /**
     * @notice Score the user's oldest unscored prediction on this game.
     *         Returns the user's accuracy numerator and the bounty denominator
     *         `bountyTotal` (Σ over winners of accuracy × stake; the protocol pays
     *         pot × (userScore × stake) / bountyTotal for the round's single
     *         active bounty token, first-scorer pinned + capped).
     *
     * @dev    MUST NOT revert. Pending state is signaled by scored=false.
     *
     * @return scored        True iff this call moved a prediction to a terminal
     *                       state. False means still pending (return zeros).
     * @return userScore     This user's raw ACCURACY numerator (0 = won nothing),
     *                       WITHOUT the SATORI-weight multiplier applied.
     * @return multiplier    Ignored: the protocol mints no SATORI for adapter games.
     * @return total         Ignored, for the same reason.
     * @return bountyTotal   The bounty denominator: Σ over winners of
     *                       (accuracy × bountyStake) for the round's single
     *                       active bounty token. Only the FIRST scorer's value is
     *                       used (pinned); the protocol pays
     *                       pot × (userScore × stake) / bountyTotal.
     * @return roundIndex    The round whose pools the shares are drawn from.
     */
    function score(
        address user,
        uint32 gameId
    ) external returns (
        bool scored,
        uint256 userScore,
        uint256 multiplier,
        uint256 total,
        uint256 bountyTotal,
        uint64 roundIndex
    );
}
