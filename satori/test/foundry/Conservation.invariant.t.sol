// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/**
 * @title Conservation invariants
 * @notice Foundry's invariant runner picks random sequences of calls on the
 *         Handler contract; after each sequence, every `invariant_*`
 *         function on this contract is invoked. Failing any one is a bug.
 *
 *         These invariants are the *structural* conservation laws of the
 *         protocol — properties that must hold across every reachable state.
 *
 *         THE BURN-VOTING RESTATEMENT
 *         The old law here was `Σ getVotingPower(all holders) == totalSupply`:
 *         voting power was a VIEW over the token supply, so every minted token's
 *         weight had to be cast exactly once, by its holder or their delegate.
 *         That law is gone with the model it described. Weight is no longer a
 *         view over supply — it is created by DESTROYING supply, permanently and
 *         unmovably, and there is no per-holder weight left to add up.
 *
 *         What replaces it is two laws instead of one, splitting the old
 *         statement along its seam:
 *           - the SUPPLY side (INV-1): every token is still accounted for, but
 *             the ledger now has a burn column.
 *           - the WEIGHT side (INV-1a/1b/1c): weight is conserved against the
 *             burns that bought it, and only ever moves in one direction.
 */
contract ConservationInvariantTest is Test {
    Handler public handler;

    function setUp() public virtual {
        handler = new Handler();
        // Restrict the fuzzer to calling functions on the handler (don't let
        // it call into the contracts directly — they have access control we
        // don't want to bypass).
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------
    // INV-1: Supply conservation across the burn.
    //
    //        SUCCESSOR TO `Σ getVotingPower == totalSupply`. Every SATORI wei
    //        that has ever existed is still accounted for, but the accounting
    //        now has three terms instead of two:
    //
    //            totalSupply + burned == rewardsMinted + airdropMinted
    //
    //        The three mint sites are the token's own counters (`rewardMint`
    //        and `mintDevFee` both bump `totalRewardsMinted`; `airdropMint`
    //        bumps `airdropMinted`; the genesis mint seeds both supply and
    //        `totalRewardsMinted` with INITIAL_MINT). The only burn any handler
    //        action reaches is `SatoriHub.vote` -> `token.burnFrom`, ghosted by
    //        the handler. `crosschainMint`/`crosschainBurn` are unreachable —
    //        they require `msg.sender == SUPERCHAIN_BRIDGE` (the hardcoded OP
    //        predeploy) and no fuzz sender is pranked to it. (The
    //        token also inherits ERC20Burnable's permissionless self-burn; no
    //        fuzz action calls it, and one that did would have to ghost it.)
    //
    //        This is the invariant that gives "burning reduces totalSupply by
    //        exactly the amount burnt" teeth: the handler ghosts the amount it
    //        ASKED to burn, not a measured supply delta, so a vote that
    //        destroyed the wrong number of tokens — or destroyed them without
    //        crediting weight, or credited weight without destroying them —
    //        breaks this equality rather than silently agreeing with itself.
    // ------------------------------------------------------------------
    function invariant_supplyConservedAcrossBurn() public view {
        SatoriToken t = handler.satoriToken();
        assertEq(
            t.totalSupply() + handler.ghostBurned(),
            t.totalRewardsMinted() + t.airdropMinted(),
            "totalSupply + burned must equal rewardsMinted + airdropMinted"
        );
    }

    // ------------------------------------------------------------------
    // INV-1a: The default game (id 1) is derived, never bought.
    //
    //         `gameWeight[1]` must be permanently zero — the raw burn ledger
    //         never has an entry for it, because `voting.vote` rejects it with
    //         CannotVoteDefault before touching storage. Its earning weight
    //         comes from `defaultDerivedWeight()` instead, floored at
    //         DEFAULT_WEIGHT_FLOOR so it is non-zero from genesis.
    //
    //         The floor is what makes the very first round payable: at launch
    //         `totalBurnedWeight == 0` and the default is the only game in
    //         existence, so without the floor its weight — and therefore the
    //         whole round denominator — would be zero. A regression that let
    //         the default fall to zero weight would produce rounds nobody can
    //         be paid out of.
    // ------------------------------------------------------------------
    function invariant_defaultGameDerivedNotBought() public view {
        SatoriVoting v = handler.voting();
        assertEq(v.gameWeight(1), 0, "the default game must never accrue burned weight");
        assertGe(
            v.weightOf(1),
            v.DEFAULT_WEIGHT_FLOOR(),
            "the default game's derived weight must never fall below its floor"
        );
        assertTrue(v.isEligible(1), "the default game must always be eligible to earn");
    }

    // ------------------------------------------------------------------
    // INV-1b: Weight conservation — `totalBurnedWeight` is exactly the sum of
    //         the raw per-game weights over every APPROVED, non-default game.
    //
    //         The default is excluded because its weight DERIVES from this
    //         total; including it would be circular. An unapproved game is
    //         excluded because revoking approval subtracts its weight from the
    //         total (and re-approving adds it back), which with `moveVotes` is
    //         the only way weight ever leaves the total — burns are
    //         irreversible.
    //
    //         This is the aggregate that the default game's entitlement and
    //         every leaderboard read are computed from, so drift here silently
    //         misprices the default's share of every round.
    // ------------------------------------------------------------------
    function invariant_totalBurnedWeightEqualsSumOfEnabledGames() public view {
        SatoriVoting v = handler.voting();
        uint256 gcount = handler.games().gameCount();
        uint256 sum = 0;
        // From game 2: id 1 is the default, which by INV-1a carries no raw
        // weight and by construction is not part of this total.
        for (uint32 g = 2; g <= gcount; g++) {
            if (!v.gameApproved(g)) continue;
            sum += v.gameWeight(g);
        }
        assertEq(
            sum,
            v.totalBurnedWeight(),
            "totalBurnedWeight must equal the sum of enabled, non-default gameWeight"
        );
    }

    // ------------------------------------------------------------------
    // INV-1c: Weight is MONOTONIC up to sanctioned moves. The quantity
    //         `gameWeight[g] + movedOut[g]` may only ever increase.
    //
    //         This is the structural heart of burn voting and the reason the
    //         old suite's entire delegation/lock/sync apparatus could be
    //         deleted: weight on a LIVE game cannot be moved, revoked,
    //         re-pointed, or reclaimed, because the tokens that bought it no
    //         longer exist. `vote` only ever adds. The single sanctioned
    //         decrease (owner-decided 2026-09-05) is `moveVotes`: a burner
    //         re-pointing their own share off a DISABLED game — the handler
    //         records every such move in `ghostMovedOut`, so a raw-ledger
    //         decrease is legal exactly when a recorded move explains it, to
    //         the wei. Any other decrease still fails here.
    //
    //         Note the deliberate scope: this is the RAW ledger, not the live
    //         weight. Disabling a game zeroes `weightOf` and removes it from
    //         `totalBurnedWeight`, but leaves `gameWeight` untouched — which is
    //         precisely what makes a disable fully reversible, restoring the
    //         exact prior weight on re-enable. Asserting on the raw ledger
    //         (rather than on `weightOf`, which legitimately drops to zero on
    //         a disable) is what pins that distinction down; the handler's
    //         `setGameApproved` and `moveVotes` actions drive it.
    // ------------------------------------------------------------------
    mapping(uint32 => uint256) public observedGameWeight;

    function invariant_gameWeightMonotonic() public {
        SatoriVoting v = handler.voting();
        uint256 gcount = handler.games().gameCount();
        for (uint32 g = 1; g <= gcount; g++) {
            uint256 cur = v.gameWeight(g) + handler.ghostMovedOut(g);
            assertGe(
                cur,
                observedGameWeight[g],
                "gameWeight + movedOut must never decrease (burns are irreversible; only moveVotes off a disabled game may re-point)"
            );
            observedGameWeight[g] = cur;
        }
    }

    // ------------------------------------------------------------------
    // INV-2: The round's numerators sum to its denominator.
    //
    //            roundVoteTotal[r] == Σ over g of gameVotesAtRound[g][r]
    //
    //        SUCCESSOR TO the `isRoundTotalLocked` / `roundTotals` lockstep
    //        check. That one existed because numerator and denominator were
    //        written by DIFFERENT passes — a once-per-round heap snapshot set
    //        the totals, five gated writers set the per-game entries, and an
    //        in-contract LockstepBroken guard fired at lock time if they
    //        disagreed. This invariant re-checked that guard had not been
    //        stepped around after the fact.
    //
    //        Under burn voting both sides are written in the SAME branch of
    //        `recordGameVotesForRound` — the first predictor of a game in a
    //        round writes the numerator and adds it to the denominator in one
    //        breath — so they cannot drift, and the lock, the snapshot pass and
    //        the guard are all gone. The law therefore holds BY CONSTRUCTION,
    //        which makes this a REGRESSION GUARD rather than a drift detector:
    //        it fails only if a future change splits those two writes apart
    //        again, which is exactly the change that must never be made
    //        silently. Shares sum to 1 and the full round budget is minted
    //        precisely because this holds.
    //
    //        Scanned over the full game-id range (not stream ids): the votable
    //        unit is a GAME, and adapter games (ids 3/4/5 here, all on stream 2)
    //        carry weight and enter the denominator just like binary games do.
    // ------------------------------------------------------------------
    function invariant_roundNumeratorsSumToDenominator() public view {
        SatoriVoting v = handler.voting();
        uint256 currentRound = handler.satori().getCurrentRound();
        // Scan recent rounds (cheap; the only relevant ones). The current,
        // still-open round is included on purpose: the equality holds at every
        // instant, not just once the round closes — only `roundDenominator`'s
        // finality guard cares about the difference.
        uint256 startRound = currentRound > 5 ? currentRound - 5 : 0;
        uint256 gcount = handler.games().gameCount();

        for (uint256 r = startRound; r <= currentRound; r++) {
            uint256 sumNumerators = 0;
            for (uint32 gid = 1; gid <= gcount; gid++) {
                sumNumerators += v.gameVotesAtRound(gid, r);
            }
            assertEq(
                sumNumerators,
                v.roundVoteTotal(r),
                "Sum of gameVotesAtRound must equal roundVoteTotal for the round"
            );
        }
    }

    // ------------------------------------------------------------------
    // INV-2b: The per-round participant list is a faithful index of the
    //         numerators, and nothing joins a round without being predicted.
    //
    //         `_eligibleGamesAtRound[r]` is the enumerable companion to
    //         `gameVotesAtRound[*][r]`: both are written in the same branch, so
    //         the list must contain each participating game EXACTLY once and
    //         nothing else. Checked as a bijection —
    //           (a) every listed game has a non-zero numerator, and
    //           (b) the list's length equals the count of non-zero numerators
    //         — which together rule out duplicates, omissions and phantoms
    //         without an O(n^2) scan.
    //
    //         (c) is the behavioural half: a game may only appear in round r's
    //         list if a prediction was actually placed on it in r. The first
    //         predictor is the sole writer of the round record. There WAS a
    //         second door, `SatoriHub.recordOffchainGameVotes`; it was removed
    //         with off-chain games on 2026-08-20, so the first predictor is now
    //         the ONLY writer and this invariant got stronger, not weaker.
    //         So a listed game the handler never predicted means some
    //         new writer has reached the reward numerator — the failure mode
    //         that would let weight nobody played for dilute everyone's share.
    // ------------------------------------------------------------------
    function invariant_eligibleGamesAtRoundMatchParticipants() public view {
        SatoriVoting v = handler.voting();
        uint256 currentRound = handler.satori().getCurrentRound();
        uint256 startRound = currentRound > 5 ? currentRound - 5 : 0;
        uint256 gcount = handler.games().gameCount();

        for (uint256 r = startRound; r <= currentRound; r++) {
            uint32[] memory listed = v.getEligibleGamesAtRound(r);

            for (uint256 i = 0; i < listed.length; i++) {
                uint32 g = listed[i];
                assertGt(
                    v.gameVotesAtRound(g, r),
                    0,
                    "a game listed for a round must carry a non-zero numerator for it"
                );
                assertTrue(
                    handler.ghostPredicted(g, r),
                    "a game may only join a round's participant list by being predicted in it"
                );
            }

            uint256 withNumerator = 0;
            for (uint32 gid = 1; gid <= gcount; gid++) {
                if (v.gameVotesAtRound(gid, r) != 0) withNumerator++;
            }
            assertEq(
                listed.length,
                withNumerator,
                "the participant list must hold each game with a numerator exactly once"
            );
        }
    }

    // (An earlier draft included `invariant_slackCeiling` checking that
    //  effectivelyExisting <= expectedAtSafe + bootstrap. That's not a
    //  real protocol invariant — claimSlack uses that formula to *decide
    //  how much* to mint (it mints 0 when obligations exceed the gap),
    //  not as a global constraint. The actual safety property is the
    //  mint-cap below.)

    // ------------------------------------------------------------------
    // INV-4: totalRewardsMinted never exceeds the schedule cap for the
    //        current round. The rewardMint cap check; verify it never
    //        gets stepped over (e.g. by a slack-then-claim sequence that
    //        somehow double-issues).
    // ------------------------------------------------------------------
    function invariant_mintCapNeverExceeded() public view {
        uint256 nowRound = handler.satori().getCurrentRound();
        uint256 deployRound = handler.satori().deploymentRound();
        uint256 roundsElapsed = nowRound - deployRound + 1;
        uint256 cap = handler.satori().ROUND_REWARD_BUDGET() * roundsElapsed;
        assertLe(
            handler.satoriToken().totalRewardsMinted(),
            cap,
            "totalRewardsMinted must not exceed ROUND_REWARD_BUDGET * roundsElapsed"
        );
    }

    // ------------------------------------------------------------------
    // Emission schedule (docs/issues/emission-issuance-indexed-schedule.md)
    // ------------------------------------------------------------------

    function _emission()
        internal view
        returns (uint256 issued, uint256 rate, uint256 prevRate)
    {
        (uint128 i, , uint128 r, uint128 p, , , , ) = handler.satori().emission();
        return (i, r, p);
    }

    function invariant_issuedMatchesGhost() public view {
        (uint256 issued, , ) = _emission();
        assertEq(issued, handler.ghostIssued(), "emission.issued must equal genesis + grossed commits + reserve banks");
        assertEq(handler.ghostSplitMismatch(), 0, "every RewardSplit must be followed by noteIssued(u + d when W != 0)");
    }

    uint256 public observedIssued;

    function invariant_issuedMonotone() public {
        (uint256 issued, , ) = _emission();
        assertGe(issued, observedIssued, "emission.issued must never decrease");
        observedIssued = issued;
    }

    uint256 public observedRound = type(uint256).max;
    uint256 public observedRateNow;

    function invariant_emissionRateConstantWithinRound() public {
        SatoriHub hub = handler.satori();
        uint256 round = hub.getCurrentRound();
        uint256 rateNow = hub.emissionRateNow();
        if (round == observedRound) {
            assertEq(rateNow, observedRateNow, "emissionRateNow must not change within a round");
        }
        observedRound = round;
        observedRateNow = rateNow;
    }

    uint256 public observedCeiling;

    function invariant_emissionCeilingMonotoneUnderEnvelope() public {
        uint256 ceiling = handler.satori().emissionCeiling();
        assertGe(ceiling, observedCeiling, "emissionCeiling must never decrease");
        assertLt(ceiling, handler.satoriToken().rewardCeiling(), "emissionCeiling must stay under the 1440/round envelope");
        observedCeiling = ceiling;
    }

    function invariant_merkleMintedWithinReserve() public view {
        SatoriHub hub = handler.satori();
        assertLe(hub.merkleMinted(), hub.merkleReserveCumulative(), "merkleMinted must not exceed the banked reserve");
    }

    function invariant_emissionRateWithinBudget() public view {
        SatoriHub hub = handler.satori();
        uint256 budget = hub.ROUND_REWARD_BUDGET();
        (, uint256 rate, uint256 prevRate) = _emission();
        assertLe(rate, budget, "emission.rate above 1440/round");
        assertLe(prevRate, budget, "emission.prevRate above 1440/round");
        assertLe(hub.emissionRateNow(), budget, "emissionRateNow above 1440/round");
    }
}
