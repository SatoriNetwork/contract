// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/**
 * @title Reward accuracy invariants
 * @notice The protocol's economic floor: SATORI is scheduled to mint at
 *         ROUND_REWARD_BUDGET per round, no more. Two ways the budget can
 *         leak into circulation:
 *           1. Direct `_mint` via claim() / claimSlack() — counted in
 *              `totalRewardsMinted`.
 *           2. Eager credit at score time — sits in `unclaimedRewards`
 *              and `totalUnclaimedRewards` until claimed, at which point
 *              it crosses into category 1 atomically.
 *
 *         A budget breach can therefore happen even before anyone claims:
 *         if `_computeReward` over-credits a winner, eager credit silently
 *         exceeds the budget. The existing `invariant_mintCapNeverExceeded`
 *         catches this only after claims — at which point the bug already
 *         minted excess SATORI. We want it caught at score time.
 *
 *         INV-R1 below is the strong version: minted + pending must
 *         never exceed the schedule.
 */
contract RewardsInvariantTest is Test {
    Handler public handler;

    function setUp() public {
        handler = new Handler();
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------
    // INV-R1: minted (already-paid via rewardMint) plus pending (the sum
    //         of unclaimedRewards across all touched addresses) must not
    //         exceed the schedule cap. Stronger than mintCapNeverExceeded
    //         because it catches over-crediting at score time, before any
    //         claim has minted the excess.
    //
    //         Implemented as a per-user sum since the aggregate accumulator
    //         was removed when slack came out.
    //
    //         BOOTSTRAP OVERLAP (Phase 2): `totalRewardsMinted` is seeded at
    //         deploy with `INITIAL_MINT` (one round of the hub's base rate,
    //         under one ROUND_REWARD_BUDGET) — the bootstrap that pre-pays the
    //         deployment round's emission. That
    //         same deployment round can ALSO eager-CREDIT `unclaimedRewards`
    //         (the predictor pools) even though `rewardMint` will REVERT
    //         (BudgetExceeded) if anyone tries to mint that credit while the
    //         cap is already met — the credit can never become circulating
    //         supply beyond the cap. So the ceiling on the (minted +
    //         eager-pending) bookkeeping quantity is the schedule cap PLUS the
    //         bootstrap (the deployment round is counted once as
    //         bootstrap-minted and once as eager-creditable).
    //         The real solvency property — circulating supply ≤ cap — is held
    //         by `rewardMint`'s own hard cap and verified by
    //         `invariant_mintCapNeverExceeded` (minted alone) + Conservation
    //         INV-1 (`totalSupply + burned == rewardsMinted + airdropMinted`,
    //         the burn-model successor to the old Σ-voting-power law). This
    //         invariant stays a strong over-CREDIT detector: it still fires if
    //         any round eager-credits MORE than a full extra budget on top of
    //         the schedule.
    // ------------------------------------------------------------------
    function invariant_committedRewardsWithinBudget() public view {
        uint256 nowRound = handler.satori().getCurrentRound();
        uint256 deployRound = handler.satori().deploymentRound();
        uint256 roundsElapsed = nowRound - deployRound + 1;
        uint256 maxBudget = handler.satori().ROUND_REWARD_BUDGET() * roundsElapsed
            + handler.satoriToken().INITIAL_MINT(); // bootstrap overlap (see NatSpec)

        uint256 minted = handler.satoriToken().totalRewardsMinted();
        uint256 pending = 0;
        uint256 n = handler.touchedAddressesLength();
        for (uint256 i = 0; i < n; i++) {
            pending += handler.rewards().unclaimedRewards(handler.touchedAddresses(i));
        }
        uint256 committed = minted + pending;

        assertLe(
            committed,
            maxBudget,
            "totalRewardsMinted + sum(unclaimedRewards) must not exceed scheduled budget + bootstrap"
        );
    }

    // ------------------------------------------------------------------
    // INV-R2: A round's denominator grows only while the round is OPEN, and is
    //         frozen forever once it closes.
    //
    //         SUCCESSOR TO the `isRoundTotalLocked` / `roundTotals` immutability
    //         check. The explicit lock is gone: there is no `rs.locked` flag to
    //         re-open, because there is no longer a snapshot pass that needed
    //         one. The denominator is now built INCREMENTALLY — the first
    //         predictor of each game adds that game's frozen weight to
    //         `roundVoteTotal[r]` — so "settled" is expressed by the round
    //         ending rather than by a flag being set.
    //
    //         The property that actually mattered survives intact, and is what
    //         is asserted here: every share paid for round r is
    //         `numerator / roundVoteTotal[r]`, so if that denominator could
    //         still move after payouts began, early claimants would be paid
    //         against a smaller denominator than late ones and the round would
    //         over-mint. Two halves:
    //           - MONOTONIC ALWAYS: it may only ever grow, never shrink. A
    //             shrink would retroactively inflate every share already
    //             computed against it.
    //           - FROZEN ONCE CLOSED: once observed at a moment when r had
    //             already ended, it may never change again. `observedClosed`
    //             is set only after such an observation, so the equality below
    //             always compares two post-close readings.
    // ------------------------------------------------------------------
    mapping(uint256 => uint256) public observedRoundVoteTotal;
    mapping(uint256 => bool) public roundObserved;
    mapping(uint256 => bool) public observedClosed;

    function invariant_roundVoteTotalGrowsThenFreezes() public {
        uint256 currentRound = handler.satori().getCurrentRound();
        uint256 startRound = currentRound > 10 ? currentRound - 10 : 0;
        for (uint256 r = startRound; r <= currentRound; r++) {
            uint256 cur = handler.voting().roundVoteTotal(r);
            if (roundObserved[r]) {
                assertGe(
                    cur,
                    observedRoundVoteTotal[r],
                    "roundVoteTotal must never shrink (it would inflate shares already paid)"
                );
                if (observedClosed[r]) {
                    assertEq(
                        cur,
                        observedRoundVoteTotal[r],
                        "roundVoteTotal must be immutable once its round has closed"
                    );
                }
            }
            observedRoundVoteTotal[r] = cur;
            roundObserved[r] = true;
            if (r < currentRound) observedClosed[r] = true;
        }
    }

    // ------------------------------------------------------------------
    // INV-R3: `roundDenominator` is the payout-safe read of that same total,
    //         and its finality guard is load-bearing.
    //
    //         Because the denominator accumulates over the round, reading it
    //         mid-round returns a PARTIAL sum — and every share computed
    //         against a partial denominator is too large, which is precisely
    //         how a round over-mints. `roundDenominator` therefore reverts
    //         `RoundNotFinal` for any round that has not ended, and returns
    //         `roundVoteTotal` verbatim for any round that has. Both halves are
    //         asserted here: agreement on closed rounds (so nothing else is
    //         being smuggled into the payout denominator) and the revert on the
    //         open one (so the ordering rule stays a contract-level guarantee
    //         rather than a convention every caller must remember).
    // ------------------------------------------------------------------
    function invariant_roundDenominatorFinalityGuard() public {
        uint256 currentRound = handler.satori().getCurrentRound();
        uint256 startRound = currentRound > 10 ? currentRound - 10 : 0;

        // Closed rounds: the guarded read must equal the raw accumulator.
        for (uint256 r = startRound; r < currentRound; r++) {
            assertEq(
                handler.voting().roundDenominator(r),
                handler.voting().roundVoteTotal(r),
                "roundDenominator must return roundVoteTotal verbatim for a closed round"
            );
        }

        // The open round: the read must be refused outright.
        bool reverted = false;
        // NB: `partial` is a RESERVED Solidity keyword, so it cannot name this
        // binding — using it made this file fail to parse, which silently took
        // the whole Foundry suite out of service (forge compiles all of
        // test/foundry together).
        try handler.voting().roundDenominator(currentRound) returns (uint256 partialTotal) {
            partialTotal; // unused — reaching this branch at all is the failure
        } catch {
            reverted = true;
        }
        assertTrue(
            reverted,
            "roundDenominator must revert RoundNotFinal while the round is still open"
        );
    }

    // ------------------------------------------------------------------
    // INV-R4: Per `(stream, round, direction)`, the per-user weight SUM
    //         must never EXCEED the accumulator `totalWeightByDirection`
    //         (the score-time denominator). One-directional (<=), NOT an
    //         equality — see why below.
    //
    //         `totalWeightByDirection` (totalWeightPacked) is a PERMANENT
    //         accumulator: `_scorePredictionCommit` does `+= weight` at
    //         predict and NEVER decrements it — it is the fixed denominator
    //         every winner's share is divided by. The per-user sum is
    //         re-derived from `userPredictions`, a 2-SLOT-per-(user,game)
    //         circular buffer: a 3rd prediction on the same game overwrites
    //         the oldest, and if that oldest could not be scored yet
    //         (forfeit-by-overwrite, Satori.sol (pre-split)) its record is
    //         gone while its weight stays in the accumulator. So the
    //         accumulator can legitimately EXCEED the live per-user sum by
    //         those forfeited, never-minted weights — a conservation-safe
    //         UNDER-mint, never an over-pay.
    //
    //         The safety-relevant direction is therefore one-way: a live
    //         winner's weight must never exceed the denominator (that would
    //         over-pay / break per-round conservation); the denominator
    //         being LARGER is harmless. (The deep marathon fuzz surfaced
    //         total=50.28e18 vs live-sum=0 for a forfeited round; the score
    //         path guards `totalWeight==0`, so an oversized/zero denominator
    //         never bricks settlement nor over-mints. Was assertEq; the
    //         equality held only while every contributing prediction still
    //         occupied a buffer slot — which a user can break within just 2
    //         same-game predictions, independent of round distance — so the
    //         equality was unsound; relaxed to the safe assertLe direction.)
    //
    //         Bounded to the last 5 rounds to keep the invariant cost flat
    //         as the fuzzer drives time forward.
    // ------------------------------------------------------------------
    function invariant_totalWeightByDirectionBoundsUserSum() public view {
        uint256 currentRound = handler.satori().getCurrentRound();
        uint256 deployRound = handler.satori().deploymentRound();
        // Last-5-rounds window, but never scan rounds that predate deployment.
        // The lens reads `SatoriCore.predictions(user, stream, round)`, whose
        // packed-delta decode computes `round - deploymentRound` and PANICS on
        // underflow for any round < deploymentRound. Pre-deploy rounds also
        // hold no predictions (both sides of the equality are 0), so clamping
        // the lower bound to deployRound preserves the invariant's strength.
        uint256 startRound = currentRound > deployRound + 5
            ? currentRound - 5
            : deployRound;

        // Iterate the full votable GAME-id range, not just streams: adapter
        // games (id != stream id) are valid binary-weight keys too (they store
        // zero binary per-direction weight, so both sides of the equality are
        // 0 for them — the check stays exact). Binary games 1,2 align with
        // streams 1,2. (Phase 2: was 1..streamCount.)
        uint32 gameCountU = uint32(handler.games().gameCount());
        uint256 n = handler.touchedAddressesLength();

        for (uint32 s = 1; s <= gameCountU; s++) {
            for (uint256 r = startRound; r <= currentRound; r++) {
                for (uint8 dir = 1; dir <= 2; dir++) {
                    uint256 sum = 0;
                    for (uint256 i = 0; i < n; i++) {
                        address u = handler.touchedAddresses(i);
                        // Weight getters moved off SatoriRewards into
                        // SatoriRewardsLens (EIP-170 split); read them there.
                        sum += handler.lens().userWeightByDirection(u, s, r, dir);
                    }
                    assertLe(
                        sum,
                        handler.lens().totalWeightByDirection(s, uint32(r), dir),
                        "per-user weight sum must never exceed the (permanent) totalWeightByDirection denominator"
                    );
                }
            }
        }
    }

    // INV-R5: no binary (game, round) credits more than its slice, and no
    //         round credits more than its budget. On games other than the
    //         default both sides can win one round (B4).
    function invariant_binaryGameRoundWithinSlice() public view {
        uint256 n = handler.binaryCreditPairsLength();
        for (uint256 i = 0; i < n; i++) {
            (uint32 g, uint256 r) = handler.binaryCreditPair(i);
            assertLe(handler.ghostBinaryCredited(g, r), handler.gameSlice(g, r),
                "a binary game-round credited more than its slice");
            assertLe(handler.ghostRoundCredited(r), handler.roundBudget(r),
                "a round credited more than its budget");
        }
    }

    // INV-R6: nothing is scored inside its own round, where the round's
    //         totals are still growing (B3).
    function invariant_noScoreInsideOwnRound() public view {
        assertEq(handler.ghostScoredInOwnRound(), 0, "a prediction was scored inside its own round");
    }
}
