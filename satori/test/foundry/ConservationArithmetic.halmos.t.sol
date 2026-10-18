// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Halmos symbolic proof: the conservation ARITHMETIC cannot over-mint.
/// @notice Halmos proves FUNCTION-LEVEL / arithmetic properties symbolically over
///         ALL inputs (within stated bounds). It is NOT a whole-contract invariant
///         engine — that is the Foundry fuzzer's job (see *.invariant.t.sol). Here
///         we extract the exact arithmetic kernels from the conservation-critical
///         paths and prove they cannot mint more than the pool/pot, for every
///         symbolic input, with no revert/overflow.
///
///         The kernels below are byte-for-byte mirrors of:
///           - SatoriRewards.scoreAdapterPrediction        (SATORI slice)
///           - SatoriBounties.creditAdapterBounty / _accrueAdapterBounty (BOUNTY slice)
///           - Satori.rewardMint                            (mint-cap guard)
///         If the contract math changes, these mirrors must be re-synced (the JS
///         unit tests fuzz the live contract; these tests fix the math kernel).
contract ConservationArithmeticHalmos is Test {
    // ============================================================
    // mulDiv kernel + the conservation strategy.
    //
    // The contract pays out via OpenZeppelin Math.mulDiv(pool, num, total) where
    // `num` is a clamped numerator and `total` the round denominator. Conservation
    // is the statement: floor(pool * num / total) <= pool, which holds exactly
    // when num <= total.
    //
    // We split this into two halves and prove the half Halmos CAN discharge:
    //   (A) num <= total  — the clamp half. The contract clamps every numerator
    //       to `room = total - paid <= total` (effShare / bountyNum). This is pure
    //       saturating multiply + min, NO division, and Halmos proves it for ALL
    //       256-bit inputs (check_effShareNeverExceedsRoom, check_bountyNumNever-
    //       ExceedsRoom, check_paidNeverExceedsRoundTotal, check_bountyPaidNever-
    //       ExceedsTotal). This is the part a hostile adapter actually attacks
    //       (overflow / over-numerator), and it is fully proven.
    //   (B) floor(pool*num/total) <= pool given num <= total — the pure division
    //       monotonicity. See the OUT-OF-SCOPE note below: Halmos/z3 cannot
    //       discharge a property whose path multiplies two symbolic values and
    //       divides by a third symbolic value (nonlinear integer arithmetic —
    //       it times out at EVERY bit-width, even uint8, confirmed empirically).
    //       (B) is a width-independent integer identity; with (A) proven, the
    //       conservation bound follows. We additionally prove the structural
    //       identity that the contract's mulDiv equals plain (a*b)/c on the
    //       no-overflow domain (check_mulDivMatchesOZ).
    function _mulDivExact(uint256 a, uint256 b, uint256 c) internal pure returns (uint256) {
        return (a * b) / c;
    }

    /// PROOF: on the no-overflow domain (a,b fit in uint32 so a*b < 2^64 << 2^256),
    /// the contract's OZ Math.mulDiv returns exactly the plain floor quotient
    /// (a*b)/c. This pins the SEMANTICS of the live payout call: it is floor
    /// division of pool*num by total, nothing exotic — so the conservation
    /// argument reduces to the integer identity floor(pool*num/total) <= pool when
    /// num <= total. Proven for ALL symbolic uint32 (a,b,c>0). uint32 keeps the
    /// product (a*b < 2^64) inside OZ mulDiv's single-limb fast path so z3 decides
    /// the structural identity reliably and quickly; the identity itself is
    /// width-independent (mulDiv == mul-then-div whenever a*b does not overflow).
    function check_mulDivMatchesOZ(uint32 a, uint32 b, uint32 c) public pure {
        vm.assume(c > 0);
        assert(Math.mulDiv(uint256(a), uint256(b), uint256(c)) == _mulDivExact(a, b, c));
    }

    // ------------------------------------------------------------
    // OUT OF SCOPE for Halmos (documented honestly):
    //   floor(pool * num / total) <= pool   given   num <= total
    // Every encoding of this was tried and TIMED OUT at the 90s assertion limit,
    // at uint128, uint64, AND uint8 width, including a division-free witness form
    // (introduce q, assume q*total <= pool*num < (q+1)*total, prove q <= pool).
    // The blocker is z3's nonlinear integer arithmetic (multiply two symbolics,
    // relate to a third) — a fundamental solver limitation, not a modeling miss.
    // This step is a standard width-independent integer fact; combined with the
    // PROVEN clamp half (num <= total) it gives conservation. The whole-contract
    // conservation INVARIANT is independently covered by the Foundry fuzzer
    // (Conservation.invariant.t.sol, deep 512x50, 0 violations).
    // ------------------------------------------------------------

    // ============================================================
    // KERNEL 1 — adapter SATORI slice (SatoriRewards.scoreAdapterPrediction)
    //
    // Mirrors the exact clamp/saturate sequence:
    //   if (paid >= roundTotal) return;            // pool fully allocated
    //   room = roundTotal - paid;                  // > 0
    //   effMul = multiplier == 0 ? 1 : multiplier;
    //   if (effMul > type(uint256).max / userScore) effShare = room;  // overflow clamp
    //   else { prod = userScore*effMul; effShare = prod > room ? room : prod; }
    //   _adapterRoundPaid = paid + effShare;       // <= roundTotal
    //   reward = mulDiv(streamPool, effShare, roundTotal);
    // ============================================================

    /// @dev Returns effShare exactly as the contract computes it. Mirrors lines
    ///      1212-1220 of SatoriRewards.sol. userScore==0 short-circuits to 0
    ///      (the contract early-returns; effShare contributes nothing).
    function _effShare(uint256 userScore, uint256 multiplier, uint256 room)
        internal pure returns (uint256 effShare)
    {
        if (userScore == 0) return 0;
        uint256 effMul = multiplier == 0 ? 1 : multiplier;
        if (effMul > type(uint256).max / userScore) {
            effShare = room;                       // product overflows -> clamp
        } else {
            uint256 prod = userScore * effMul;     // proven non-overflowing by the branch
            effShare = prod > room ? room : prod;
        }
    }

    /// PROOF: the saturating multiply never reverts/overflows AND effShare is
    /// always clamped to room. For ALL symbolic (userScore, multiplier, room).
    /// This is the heart of "a hostile adapter cannot brick settle nor over-mint".
    function check_effShareNeverExceedsRoom(uint256 userScore, uint256 multiplier, uint256 room)
        public pure
    {
        uint256 e = _effShare(userScore, multiplier, room);
        assert(e <= room);
    }

    /// PROOF: running `paid` never exceeds `roundTotal`. Given the contract's
    /// guard (paid < roundTotal, so room = roundTotal - paid > 0), after
    /// crediting effShare the new paid stays <= roundTotal. No per-round over-mint
    /// of the score numerator. For ALL symbolic inputs.
    function check_paidNeverExceedsRoundTotal(
        uint256 userScore,
        uint256 multiplier,
        uint256 roundTotal,
        uint256 paid
    ) public pure {
        vm.assume(paid < roundTotal);              // contract guard: else early-return
        uint256 room = roundTotal - paid;          // > 0
        uint256 e = _effShare(userScore, multiplier, room);
        uint256 newPaid = paid + e;                // contract: _adapterRoundPaid = paid + effShare
        assert(newPaid <= roundTotal);             // Sigma paid <= total
    }

    // NOTE: the final SATORI step `floor(streamPool * effShare / roundTotal) <=
    // streamPool` (given the proven effShare <= roundTotal) is the OUT-OF-SCOPE
    // division-monotonicity documented above — it timed out at every width and is
    // left to the Foundry conservation invariant. The attackable clamp half
    // (effShare <= roundTotal, Sigma paid <= roundTotal, no overflow/brick) IS
    // proven by check_effShareNeverExceedsRoom + check_paidNeverExceedsRoundTotal.

    // ============================================================
    // KERNEL 2 — adapter BOUNTY slice
    //   (SatoriBounties.creditAdapterBounty + _accrueAdapterBounty)
    //
    //   if (paid >= bt) return;
    //   room = bt - paid;
    //   if (userScore > type(uint256).max / stake) bountyNum = room;   // overflow clamp
    //   else { prod = userScore*stake; bountyNum = prod > room ? room : prod; }
    //   _adapterBountyPaid = paid + bountyNum;
    //   share = mulDiv(pot, num, denom);   // denom == bt
    //   _payBounty: capped at pot - claimed (shared with the binary rail)
    // ============================================================

    /// @dev Mirrors SatoriBounties.sol lines 885-887. stake==0 short-circuits to 0
    ///      (contract early-returns).
    function _bountyNum(uint256 userScore, uint256 stake, uint256 room)
        internal pure returns (uint256 bountyNum)
    {
        if (stake == 0) return 0;
        if (userScore > type(uint256).max / stake) {
            bountyNum = room;
        } else {
            uint256 prod = userScore * stake;
            bountyNum = prod > room ? room : prod;
        }
    }

    /// PROOF: the saturating bounty multiply never overflows and bountyNum is
    /// always clamped to room. For ALL symbolic (userScore, stake, room).
    function check_bountyNumNeverExceedsRoom(uint256 userScore, uint256 stake, uint256 room)
        public pure
    {
        uint256 n = _bountyNum(userScore, stake, room);
        assert(n <= room);
    }

    /// PROOF: running bounty `paid` never exceeds the pinned `bt` (bountyTotal).
    /// Sigma bountyNum <= bt. For ALL symbolic inputs.
    function check_bountyPaidNeverExceedsTotal(
        uint256 userScore,
        uint256 stake,
        uint256 bt,
        uint256 paid
    ) public pure {
        vm.assume(paid < bt);                      // contract guard
        uint256 room = bt - paid;                  // > 0
        uint256 n = _bountyNum(userScore, stake, room);
        uint256 newPaid = paid + n;
        assert(newPaid <= bt);
    }

    /// @dev Mirrors SatoriBounties._payBounty's cap. Returns the new `claimed`.
    function _payCapped(uint256 pot, uint256 claimed, uint256 share)
        internal pure returns (uint256)
    {
        if (claimed >= pot) return claimed;
        if (share > pot - claimed) share = pot - claimed;
        if (share == 0) return claimed;
        return claimed + share;
    }

    /// PROOF: whatever share the division produces, and whatever was claimed
    /// before (a reclaim sets claimed = pot), a payout never takes claimed past
    /// the pot, never reverts, and never lowers claimed. For ALL symbolic inputs,
    /// on both rails.
    function check_payNeverExceedsPot(uint256 pot, uint256 claimed, uint256 share)
        public pure
    {
        uint256 c = _payCapped(pot, claimed, share);
        assert(c >= claimed);
        if (claimed <= pot) assert(c <= pot);
        else assert(c == claimed);
    }

    // NOTE: `floor(pot * bountyNum / bt) <= pot` is the same OUT-OF-SCOPE
    // symbolic-divisor division documented above, and no longer needed for the
    // pot bound: check_payNeverExceedsPot proves Sigma paid <= pot from the cap
    // alone. check_bountyNumNeverExceedsRoom + check_bountyPaidNeverExceedsTotal
    // still prove the attackable clamp half (no overflow/brick).

    // REMOVED: check_bountyFeeSplitConserves. The bounty PAYOUT fee (once
    // fee = share*feeBps/20000, predictorAmount = share - fee in
    // _accrueBountyForWinToken/_accrueAdapterBounty) was removed entirely —
    // winning predictors now receive the full share (predictorAmount == share),
    // so there is no fee split left to prove. Bounty revenue is now the upfront
    // non-SATORI posting burn (Satori.chargeBountyBurn), a plain SATORI transfer.

    // ============================================================
    // KERNEL 3 — mint-cap guard (Satori.rewardMint)
    //
    //   if (totalRewardsMinted + amount > ROUND_REWARD_BUDGET * roundsElapsed)
    //       revert BudgetExceeded();
    //   totalRewardsMinted += amount;
    // ============================================================

    uint256 internal constant ROUND_REWARD_BUDGET = 720 ether;

    /// @dev The exact guard. Returns the post-mint total, or reverts (returns
    ///      the input unchanged via the `passes` flag) if the cap would be
    ///      exceeded. Modeled to match the contract's checked arithmetic: the
    ///      `+ amount` itself is checked (Solidity 0.8), so an overflowing sum
    ///      reverts too. We expose `passes` so the proof can reason about both
    ///      branches.
    function _rewardMintGuard(uint256 totalMinted, uint256 amount, uint256 roundsElapsed)
        internal pure returns (bool passes, uint256 newTotal)
    {
        uint256 cap = ROUND_REWARD_BUDGET * roundsElapsed;   // checked mul
        // Solidity 0.8 checked add: if totalMinted + amount overflows it reverts.
        // We model that as "does not pass" because the contract would revert and
        // no mint occurs.
        unchecked {
            uint256 sum = totalMinted + amount;
            if (sum < totalMinted) return (false, totalMinted); // overflow -> revert -> no mint
            if (sum > cap) return (false, totalMinted);          // BudgetExceeded -> no mint
            return (true, sum);
        }
    }

    /// PROOF: WHENEVER rewardMint succeeds, the resulting totalRewardsMinted is
    /// provably <= ROUND_REWARD_BUDGET * roundsElapsed. The cap can never be
    /// breached by a successful mint, for ALL symbolic (totalMinted, amount,
    /// roundsElapsed). This is the defense-in-depth that catches any over-issue
    /// bug in SatoriRewards.
    function check_mintCapNeverExceeded(
        uint256 totalMinted,
        uint256 amount,
        uint256 roundsElapsed
    ) public pure {
        // Bound roundsElapsed so the cap multiply (720e18 * rounds) stays well
        // below 2^256 — the protocol mints once per ~daily round, so even a
        // millennium is < 4e5 rounds. 1e12 rounds is astronomically generous.
        vm.assume(roundsElapsed <= 1e12);
        (bool passes, uint256 newTotal) = _rewardMintGuard(totalMinted, amount, roundsElapsed);
        if (passes) {
            assert(newTotal <= ROUND_REWARD_BUDGET * roundsElapsed);
            assert(newTotal == totalMinted + amount);   // the mint accounted exactly `amount`
        }
    }

    /// PROOF: if a prior total already sits at/below the cap and the new amount
    /// would push it over, the guard MUST reject (no silent over-mint). For ALL
    /// symbolic inputs in the bounded round range.
    function check_mintCapRejectsOvershoot(
        uint256 totalMinted,
        uint256 amount,
        uint256 roundsElapsed
    ) public pure {
        vm.assume(roundsElapsed <= 1e12);
        uint256 cap = ROUND_REWARD_BUDGET * roundsElapsed;
        vm.assume(totalMinted <= cap);
        vm.assume(amount <= type(uint256).max - totalMinted); // no add-overflow: isolate the cap branch
        vm.assume(totalMinted + amount > cap);                // overshoot
        (bool passes, ) = _rewardMintGuard(totalMinted, amount, roundsElapsed);
        assert(!passes);                                      // must be rejected
    }
}
