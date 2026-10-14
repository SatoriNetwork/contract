// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "./Handler.sol";

/// Sanity (non-invariant) test: prove the adapter handler surface actually
/// REACHES the adapter score path and records non-zero credit, so the adapter
/// conservation invariants are not vacuously true.
///
/// SCOPE CORRECTED 2026-08-17. This used to also assert that an adapter settle
/// credits non-zero SATORI, and failed on it for months. That assertion was
/// impossible, not broken: `SatoriVoting.vote` reverts `GameNotMintEligible` for
/// any game whose `gameTypeId != 0`, because **only the built-in binary game
/// earns from the mint**. An adapter game can therefore never carry vote weight,
/// never draw a SATORI pool, and never credit SATORI. The engine says the same
/// thing on the predict path: "Adapter games earn no SATORI, so `thisPower` is
/// always 0 for them."
///
/// So the SATORI leg is now asserted in the direction the design actually
/// guarantees — adapter settles credit ZERO SATORI — which pins the rule instead
/// of failing against it. If adapter games ever become mint-eligible, this test
/// fails and someone has to think about it.
///
/// The BOUNTY leg is the one that carries the original intent: bounties are the
/// thing adapter games do pay, so that credit must be provably non-zero or
/// `AdapterConservation.invariant.t.sol` is passing on an empty set.
contract AdapterSanityTest is Test {
    Handler public handler;

    function setUp() public {
        handler = new Handler();
    }

    function test_adapterPlayCreditsNonZero() public {
        uint256 gcount = handler.adapterGameCount();
        assertGt(gcount, 0, "adapter games wired");
        // The YesNo adapter game's id is DERIVED, never hardcoded. It used to be
        // asserted as 3; the burn-voting migration shifted creation order and it
        // is now 6, which nobody noticed because a reserved-keyword parse error
        // in Rewards.invariant.t.sol had taken the whole forge suite out of
        // service since 2026-08-08 (forge compiles test/foundry together).
        uint32 yesNo = handler.adapterGameIds(0);
        assertGt(yesNo, 0, "yesno adapter game wired");

        // The two handler actions pick their target DIFFERENTLY, and the test is
        // only coherent if both land on the same game:
        //   voteAdapterStreamGame(_, seed) -> the adapter stream's BINARY game
        //   fundBounty(_, seed, ...) -> 1 + (seed % gameCount)
        // So derive the bounty seed from the id rather than assuming one. A
        // hardcoded seed would silently fund a DIFFERENT game than the one being
        // voted, leaving the bounty leg asserting nothing.
        uint256 bountySeed = uint256(yesNo) - 1;

        // Concentrate all five actors' burns on the YesNo game so it carries
        // weight and draws a real pool. Burns ACCUMULATE — weight is permanent and can
        // never be moved off a game — so one pass is enough and there is no
        // last-vote-wins race to avoid; burning only for game 3 simply keeps it
        // the dominant share of the round denominator.
        // NOTE: no vote here. An ADAPTER game cannot be voted at all, which is
        // the whole point of this file's SATORI assertion below. The handler's
        // vote action has been retargeted at the stream's BINARY game, and
        // `test_voteActionIsNotAVacuousNoOp` proves it lands.

        // Stake the bounty token, then fund a bounty on the SAME game.
        for (uint256 a = 0; a < 5; a++) handler.stakeBountyToken(a, 0, 100 ether);
        handler.fundBounty(0, bountySeed, 0, 500 ether, 100 ether);

        bool sawSatori = false;
        bool sawBounty = false;
        for (uint256 round = 0; round < 8 && !(sawSatori && sawBounty); round++) {
            // The adapter stream is cadence 2 (adapter games require host stream
            // minCadenceRounds >= 2), so every updateValue must land >= 2 rounds
            // after the previous write or it is silently cadence-blocked (the
            // handler swallows the CadenceRoundsNotElapsed revert). Advance a clean
            // 2 rounds (49h > 2x24h AND > the 47.5h wall-clock cadence gap)
            // before BOTH the anchor and the post update so neither no-ops.
            handler.advanceTime(49 hours);
            handler.updateAdapterValue(int128(60 + int256(round))); // anchor > threshold 50 => YES
            handler.predictAdapter(0, 0, 2); // d=2 -> direction 1 (YES); value>threshold => YES wins
            handler.predictAdapter(1, 0, 2); // YES
            handler.advanceTime(49 hours);
            handler.updateAdapterValue(int128(70 + int256(round))); // post value, 2 rounds later
            handler.settleAdapter(0, 0, 0);
            handler.settleAdapter(1, 1, 0);
            // No re-vote: burned weight is PERMANENT, so the game keeps the weight
            // bought above in every subsequent round without paying again. (The
            // old per-round re-vote existed because a stake-based vote was
            // re-snapshotted each round and had to be refreshed; it would now
            // just burn the actors' balances down for nothing, and a predictor
            // with no balance earns nothing and grows no streak — so it would
            // make this test vacuous rather than fail it.)

            uint256 m = handler.creditedGameRoundCount();
            for (uint256 i = 0; i < m; i++) {
                uint32 gid = handler.creditedGameRoundGames(i);
                uint256 r = handler.creditedGameRoundRounds(i);
                if (handler.ghostAdapterSatoriCredited(gid, r) > 0) sawSatori = true;
                if (handler.ghostAdapterBountyCredited(gid, r, address(handler.bountyToken())) > 0)
                    sawBounty = true;
            }
        }
        assertFalse(
            sawSatori,
            "adapter settle must credit NO SATORI: only gameTypeId 0 is mint-eligible"
        );
        assertTrue(sawBounty, "adapter settle credited non-zero BOUNTY (bounty invariant has teeth)");
    }

    /// The handler's vote action must actually DO something.
    ///
    /// It used to be `voteAdapterGame`, pointed at an adapter game, which
    /// `SatoriVoting.vote` rejects with `GameNotMintEligible`. It swallowed that
    /// revert, so it recorded 69 fuzz calls and 0 successes: an action that reads
    /// as coverage in the fuzz report while providing none, and that quietly
    /// starved every invariant depending on an adapter-hosted stream carrying
    /// weight. This pins the fix so it cannot silently regress.
    function test_voteActionIsNotAVacuousNoOp() public {
        uint32 binary = handler.games().gamesByStream(handler.adapterStreamId())[0];
        assertGt(binary, 0, "the adapter stream has a votable binary game");
        uint256 before = handler.voting().gameWeight(binary);

        for (uint256 a = 0; a < 5; a++) handler.voteAdapterStreamGame(a, 1 ether);

        assertEq(handler.callCount_voteAdapterStreamGame(), 5, "every call must land, not be caught");
        assertGt(handler.voting().gameWeight(binary), before, "and weight must actually move");
    }
}