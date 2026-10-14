// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/**
 * @title Adapter game conservation invariants (Phase 2)
 * @notice Adapter (type-1+) games use the SCORE/TOTAL model: the adapter owns
 *         all scoring semantics, the protocol owns all money + conservation.
 *         The protocol PINS the first scorer's `total` per (game, round) and
 *         CAPS the running sum of paid numerators at it, so the most a game can
 *         ever mint per round is exactly ONE pool. The same pin+cap rail
 *         applies to the per-round adapter BOUNTY pot.
 *
 *         These two invariants are the Foundry mirror of the run.js
 *         `per-game-round-overpay` backstop, extended to the bounty rail. They
 *         are MEANINGFUL real conservation checks: a divergence means a hostile
 *         adapter (EveryoneWinsGame / ReentrantGameAdapter are wired live) got
 *         the protocol to pay a pool — or a bounty pot — more than once.
 *
 *         The handler measures credit deltas at score time:
 *           - SATORI: the predictor's `unclaimedRewards` growth, attributed to
 *             the round the prediction was MADE in (the round whose pool the
 *             share draws from).
 *           - BOUNTY: the predictor auto-restake (`bountyStake`) + fee-recipient
 *             accrual (`unclaimedBounty`) growth — the only two sinks the
 *             adapter bounty credit flows into.
 */
contract AdapterConservationInvariantTest is Test {
    Handler public handler;

    function setUp() public {
        handler = new Handler();
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------
    // INV-A1 (ADAPTER SATORI conservation): for every (adapter game, round)
    //         the protocol credited SATORI for, the total credited must not
    //         exceed ONE round budget. Under the score/total pin+cap the round's
    //         pool is `budget × gameVotes/activeVotes <= budget`, so a single
    //         game/round paying more than a whole budget means the pool was paid
    //         out more than once — the exact over-mint the hostile adapters
    //         (EveryoneWinsGame: total==own score, multiplier==uint256.max)
    //         attempt. The pin+cap make it structurally impossible; this is the
    //         tripwire.
    // ------------------------------------------------------------------
    function invariant_adapterSatoriCreditedWithinOnePool() public view {
        uint256 budget = handler.satori().ROUND_REWARD_BUDGET();
        uint256 n = handler.creditedGameRoundCount();
        for (uint256 i = 0; i < n; i++) {
            uint32 gameId = handler.creditedGameRoundGames(i);
            uint256 round = handler.creditedGameRoundRounds(i);
            uint256 credited = handler.ghostAdapterSatoriCredited(gameId, round);
            assertLe(
                credited,
                budget,
                "adapter game/round credited SATORI must not exceed one round budget (pool paid once)"
            );
        }
    }

    // ------------------------------------------------------------------
    // INV-A2 (ADAPTER BOUNTY conservation): for every (adapter game, round,
    //         token) the protocol credited bounty for, the total credited must
    //         not exceed the round's DRIPPED POT (`roundBountyPot`). The adapter
    //         bounty rail pins the first scorer's `bountyTotal` and caps the
    //         running paid numerator at it, then pays `pot × num/denom` — so
    //         Σ shares <= pot. Exceeding the pot means the pot was paid more than
    //         once (an over-drip / double-pay), which the pin+cap forbid.
    // ------------------------------------------------------------------
    function invariant_adapterBountyCreditedWithinPot() public view {
        _checkBounty(address(handler.bountyToken()));
        _checkBounty(address(handler.bountyTokenB()));
    }

    function _checkBounty(address token) internal view {
        uint256 n = handler.creditedGameRoundCount();
        for (uint256 i = 0; i < n; i++) {
            uint32 gameId = handler.creditedGameRoundGames(i);
            uint256 round = handler.creditedGameRoundRounds(i);
            uint256 credited = handler.ghostAdapterBountyCredited(gameId, round, token);
            if (credited == 0) continue;
            uint256 pot = handler.roundPotFor(gameId, round, token);
            assertLe(
                credited,
                pot,
                "adapter game/round/token credited bounty must not exceed the dripped roundBountyPot"
            );
        }
    }
}
