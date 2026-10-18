// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/**
 * @title Bounty conservation invariants
 * @notice Tokens enter the bounty system via `fundBounty` (pool grows) and
 *         `stakeBountyToken` (bountyStake grows), and leave only via
 *         `unstakeBountyToken`. Winnings auto-compound INTO `bountyStake`
 *         (pool -> pot -> stake, all internal to the contract), so no tokens
 *         leave on a win — the only exit is unstake. (The dead `unclaimedBounty`
 *         withdraw path was removed — A4.)
 *
 *         The handler exercises TWO distinct bounty tokens so the multi-token
 *         paths in streamBountyTokens / _roundBountyTokens get cross-checked.
 *
 *         At every moment, per token:
 *
 *             contractBalance[T] = totalFunded[T] + totalStaked[T] − totalUnstaked[T]
 *
 *         A divergence means either tokens were created (over-drip) or
 *         destroyed (drained without payout), or the internal accounting
 *         has drifted from the actual token balance.
 */
contract BountyInvariantTest is Test {
    Handler public handler;

    function setUp() public {
        handler = new Handler();
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------
    // INV-B1: Contract balance of each bounty token equals the net flow
    //         (funded − withdrawn). The handler-side ghost totals are
    //         authoritative for what entered/left externally; the
    //         contract should hold the difference. Checked for both
    //         bounty tokens — drift on either is a bug.
    // ------------------------------------------------------------------
    function invariant_bountyContractBalanceMatchesNetFlow() public view {
        _checkNetFlow(address(handler.bountyToken()));
        _checkNetFlow(address(handler.bountyTokenB()));
    }

    function _checkNetFlow(address token) internal view {
        uint256 contractBal = IERC20Like(token).balanceOf(address(handler.bounties()));
        // Two independent token-flow paths INTO the contract: fundBounty
        // (pool/pots/unclaimed bucket) and stakeBountyToken (separate
        // `bountyStake[user][T]` bucket). Both leave via their own
        // withdraw/unstake counterparts.
        uint256 netFlow = handler.totalFundedAllStreamsForToken(token)
                        + handler.totalStakedForToken(token)
                        - handler.totalUnstakedForToken(token);
        assertEq(
            contractBal,
            netFlow,
            "bounty-token balance must equal funded + (staked - unstaked)"
        );
    }

    // ------------------------------------------------------------------
    // INV-B2 (solvency): the contract must always hold AT LEAST what it
    //         OWES to claimants. Per token, Σ over users of
    //         (unclaimedBounty + bountyStake) — the only two withdrawable /
    //         unstakeable claim buckets — must be <= the contract's token
    //         balance. If owed ever exceeds held, some withdraw/unstake
    //         reverts (insolvency). Holding MORE is fine: the undistributed
    //         pot remainder + per-round drip dust safely strand (never
    //         double-paid — `cleanupDrainedBountyToken` transfers nothing).
    //
    //         WHY NOT sum the pots: `roundBountyPot` is a PERMANENT
    //         DENOMINATOR — credited on drip, NEVER decremented (read at
    //         settle to compute `share = pot × num/denom`; see SatoriBounties
    //         RATE_SCALE / _dripTokenForRound NatSpec). Summing it as held
    //         tokens double-counts every credited share (the share lands in
    //         unclaimed/bountyStake while the pot it came from stays full),
    //         i.e. internalSum = balance + creditedFromPots. The marathon
    //         fuzz (10k×150) surfaced exactly that as a 1067-wei over-count
    //         == one credited adapter share — a flaw in the OLD equality
    //         form, not a contract bug (verified: withdraw drains the exact
    //         bucket, Σshares ≤ pot ≤ funded, cleanup moves no tokens).
    //         Exact token conservation is INV-B1 (balance == net external
    //         flow); the per-stream pool+pots ≤ funded bound is INV-B3; this
    //         is the solvency direction those two don't directly assert.
    // ------------------------------------------------------------------
    function invariant_bountyClaimsNeverExceedBalance() public view {
        _checkSolvency(address(handler.bountyToken()));
        _checkSolvency(address(handler.bountyTokenB()));
    }

    function _checkSolvency(address token) internal view {
        uint256 owed = 0;
        uint256 n = handler.touchedAddressesLength();
        for (uint256 i = 0; i < n; i++) {
            address a = handler.touchedAddresses(i);
            owed += handler.bounties().bountyStake(a, token);
        }
        uint256 contractBal = IERC20Like(token).balanceOf(address(handler.bounties()));
        assertLe(
            owed,
            contractBal,
            "owed bounty claims (bountyStake) must never exceed the contract's token balance (solvency)"
        );
    }

    // ------------------------------------------------------------------
    // INV-B3: Per (stream, token), the in-stream slice (pool + Σ
    //         roundPots) must not exceed totalFunded for that stream/token.
    //         per-user unclaimedBounty isn't streamed so we can't attribute
    //         it back — we check only the stream-side, which should never
    //         exceed what was funded into that stream.
    // ------------------------------------------------------------------
    function invariant_perStreamBountyBoundedByFunding() public view {
        _checkPerStream(address(handler.bountyToken()));
        _checkPerStream(address(handler.bountyTokenB()));
    }

    function _checkPerStream(address token) internal view {
        uint256 currentRound = handler.satori().getCurrentRound();
        uint256 deployRound = handler.satori().deploymentRound();
        // Per-GAME (bounty state is per-game id); include adapter games.
        uint32 gameCountU = uint32(handler.games().gameCount());
        for (uint32 s = 1; s <= gameCountU; s++) {
            uint256 streamSide = handler.bounties().pool(s, token);
            for (uint256 r = deployRound; r <= currentRound; r++) {
                streamSide += handler.bounties().roundBountyPot(s, uint32(r), token);
            }
            assertLe(
                streamSide,
                handler.totalFundedForStreamToken(s, token),
                "per-stream (pool + roundPots) cannot exceed totalFunded for that (stream, token)"
            );
        }
    }

    // INV-B4: no (game, round, token) pays out more than its pot.
    function invariant_roundNeverPaysPastPot() public view {
        _checkPotClaims(address(handler.bountyToken()));
        _checkPotClaims(address(handler.bountyTokenB()));
    }

    function _checkPotClaims(address token) internal view {
        uint256 currentRound = handler.satori().getCurrentRound();
        uint256 deployRound = handler.satori().deploymentRound();
        uint32 gameCountU = uint32(handler.games().gameCount());
        for (uint32 g = 1; g <= gameCountU; g++) {
            for (uint256 r = deployRound; r <= currentRound; r++) {
                assertLe(
                    handler.bounties().roundBountyPotClaimed(g, uint32(r), token),
                    handler.bounties().roundBountyPot(g, uint32(r), token),
                    "a round's claimed bounty cannot exceed its pot"
                );
            }
        }
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
}
