// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "./interfaces/ISatoriCore.sol";
import "./libraries/SatoriTypes.sol";

interface IHubForLens {
    function emissionCeiling() external view returns (uint256);
    function token() external view returns (address);
    function registry() external view returns (address);
    function voting() external view returns (address);
    function rewards() external view returns (address);
    function bounties() external view returns (address);
    function games() external view returns (address);
    function merkle() external view returns (address);
    function merkleReserveCeiling() external view returns (uint256);
    function merkleReserveCumulative() external view returns (uint256);
    function emission() external view returns (
        uint128 issued, uint128 nextStepAt, uint128 rate, uint128 prevRate,
        uint64 from, uint64 ratioWad, uint32 stepsTaken, uint256 banked
    );
    function emissionRateNext() external view returns (uint256);
    function residualNext() external view returns (uint256);
    function emissionHolder() external view returns (address);
}

interface ITokenForLens {
    function getCurrentRound() external view returns (uint256);
    function deploymentRound() external view returns (uint256);
    function devFeeCeiling() external view returns (uint256);
    function devFeeBps() external view returns (uint256);
    function generalCeilingFor(uint256 ceiling) external view returns (uint256);
    function lockUntil(address user, uint8 lane) external view returns (uint24);
}

interface IRegistryForLens {
    function streamExists(uint32 streamId) external view returns (bool);
    function getValueAtHour(uint32 streamId, uint256 hour) external view returns (int256);
}

/// @notice Minimal forward of the rewards getters the Lens needs. Avoids
///         dragging in the full ISatoriRewards interface and its many
///         scoring/claim mutators.
interface IRewardsForLens {
    function effectivePredictorFee(address predictor) external view returns (uint16);
    function totalWeightPacked(uint32 gameId, uint256 round) external view returns (uint256);
    function unclaimedRewards(address user) external view returns (uint256);
    function delegationPeriodsLength(address user) external view returns (uint256);
    function firstActiveDelegationPeriod(address user) external view returns (uint256);
    function delegationPeriodAt(address user, uint256 i) external view returns (
        address delegate,
        uint24 startRound,
        uint24 endRound,
        uint24 nextClaimRound,
        uint256 startBalance,
        uint256 checkpointsLength,
        uint256 openRoundsLength
    );
    function delegationCheckpointAt(address user, uint256 i, uint256 j) external view returns (uint24 round, uint224 value);
    function delegationOpenRoundAt(address user, uint256 i, uint256 j) external view returns (uint24 round, uint224 banked, uint256 loyalty);
    function delegationLoyaltyAt(address user, uint256 i) external view returns (uint256);
    function loyaltyCoeffs(address delegate, uint256 round) external view returns (uint256 alpha, uint256 beta);
    function loyaltyLag() external view returns (uint256);
    function delegatorRewardRatePerRound(address delegate, uint256 round) external view returns (uint256);
    function offchainBudget() external view returns (uint256);
}

/**
 * @title SatoriRewardsLens
 * @notice Computed view aggregator for SatoriRewards. Hosts the off-chain
 *         read surface that would otherwise push SatoriRewards over the
 *         EIP-170 24,576-byte limit. None of these are called on-chain by
 *         other protocol contracts — they're for dapps, indexers, and test
 *         harnesses.
 *
 *         The Lens carries no state of its own. Each call STATICCALLs into
 *         SatoriRewards's public getters (or SatoriCore's, for the
 *         user-weight derivation) and does the unpacking / default-swap /
 *         math locally.
 */
contract SatoriRewardsLens {
    address public immutable satoriCore;
    IRewardsForLens public immutable rewards;

    // Constants mirrored from SatoriRewards. Internal — small enough that
    // inlining is fine vs another cross-contract read. REFERRAL_BPS and
    // SATORI_RATE_SCALE are frozen protocol constants (changing them on
    // SatoriRewards is a redeploy, at which point a new lens ships too).
    uint256 private constant DIR_HALF_MASK = (1 << 128) - 1;
    uint256 private constant REFERRAL_BPS = 500;
    uint256 private constant SATORI_RATE_SCALE = 1e24;
    /// Loyalty fixed-point one. Mirrored from SatoriRewards on the same
    /// frozen-constant terms as REFERRAL_BPS above; the LAG is read live via
    /// `loyaltyLag()` because it is the one value a re-tune would move.
    uint256 private constant LOY_ONE = 1e18;

    // Constants mirrored from SatoriHub (audit LA-4). Same frozen-constant rule
    // as REFERRAL_BPS above: changing them on the hub means shipping a new lens.
    uint256 private constant FARMING_FLOOR = 1 ether;    // flat, mirrors SatoriHub.FARMING_FLOOR
    uint256 private constant STREAM_BURN = 0.001 ether;  // flat, mirrors SatoriHub.STREAM_BURN
    uint256 private constant GAME_BURN   = 0.1 ether;    // flat, mirrors SatoriHub.GAME_BURN
    uint256 private constant ROUND_REWARD_BUDGET = 1440 ether; // mirrors SatoriHub.ROUND_REWARD_BUDGET
    uint256 private constant NO_STEP = type(uint128).max;      // mirrors SatoriHub.NO_STEP

    constructor(address _satoriCore, address _rewards) {
        require(_satoriCore != address(0) && _rewards != address(0), "bad input");
        satoriCore = _satoriCore;
        rewards = IRewardsForLens(_rewards);
    }

    /// @notice The effective predictor fee for `predictor`, in basis points.
    ///         Returns the 10% default for a predictor who never set a rate.
    function predictorFeeBps(address predictor) external view returns (uint16) {
        return rewards.effectivePredictorFee(predictor);
    }

    /// @notice Per-(game, round, direction) total committed weight.
    function totalWeightByDirection(uint32 gameId, uint256 round, uint8 direction)
        external view returns (uint256)
    {
        uint256 packed = rewards.totalWeightPacked(gameId, round);
        return direction == 1 ? (packed >> 128) : (packed & DIR_HALF_MASK);
    }

    /// @notice Per-(user, game, round, direction) committed weight,
    ///         re-derived from the Prediction struct stored in
    ///         `SatoriEngine.userPredictions` (read through the core facade's
    ///         `predictions()` view).
    /// @dev    Mirrors `SatoriEngine._deriveWeight` byte-for-byte: rawPower ×
    ///         multiplier, with no normalisation. Returns zero when no Prediction
    ///         exists at this (round, direction): every real prediction carries a
    ///         non-zero multiplier (DUST_MULTIPLIER == 1 at streak 0, the streak
    ///         curve above it), so a zero multiplier means the absent/default
    ///         struct.
    function userWeightByDirection(address user, uint32 gameId, uint256 round, uint8 direction)
        external view returns (uint256)
    {
        SatoriTypes.Prediction memory pred =
            ISatoriCore(satoriCore).predictions(user, gameId, round);
        if (pred.direction != direction || pred.multiplier == 0) return 0;
        return uint256(pred.rawPredictionPower) * uint256(pred.multiplier);
    }

    struct PeriodView {
        address delegate;
        uint24 startRound;
        uint24 endRound;
        uint24 nextClaimRound;
        uint256 startBalance;
        uint256 checkpointsLength;
        uint256 openRoundsLength;
    }

    /// @dev Per-call budget on the delegator pending-walk (audit F28/F29). The walk
    ///      makes cross-contract staticcalls — one per checkpoint / forward round,
    ///      TWO per open round — and a long-lapse delegator has enough of them to
    ///      exceed the `eth_call` gas cap, reverting the VIEW for exactly the users
    ///      with the most pending. The budget counts those staticcalls (an open
    ///      round charges 2), so it bounds the real gas; a truncated walk reports
    ///      `complete = false` with a partial (lower-bound) total (the real claim
    ///      path, capped + resumable per audit F6, still pays in full). Sized for
    ///      `eth_call` gas (~4096 staticcalls ≈ years of lapse); a function so a
    ///      test harness can shrink it.
    function _maxLensRounds() internal view virtual returns (uint256) {
        return 4096;
    }

    /// @notice Pending (not-yet-claimed) delegator-rate accruals for `user` —
    ///         a read-only reconstruction of SatoriRewards' claim walk
    ///         (`_accrueDelegatorRewards`), summing every period's open-round
    ///         deltas plus the forward walk, without mutating cursors. Reads
    ///         the stored per-round rate; if the predictor hasn't yet been
    ///         settled for some winning round, that rate is 0 and the
    ///         contribution does not appear here (the actual claim path
    ///         triggers the settle and credits correctly).
    /// @return total    pending accrued WITHIN the walk budget.
    /// @return complete true if the whole walk fit the budget; false if it was
    ///         truncated — then `total` is a lower bound (claim to realize the
    ///         rest; the on-chain path pays it in full).
    function pendingDelegatorRewards(address user) public view returns (uint256 total, bool complete) {
        uint256 len = rewards.delegationPeriodsLength(user);
        uint256 start = rewards.firstActiveDelegationPeriod(user);
        uint24 nowRound = uint24(ISatoriCore(satoriCore).getCurrentRound());
        uint256 budget = _maxLensRounds();
        complete = true;
        for (uint256 i = start; i < len; i++) {
            (uint256 sub, uint256 used, bool periodComplete) = _pendingForPeriod(user, i, nowRound, budget);
            total += sub;
            // Saturating on purpose. `_pendingForPeriod` charges its own budget
            // and never overshoots, but this subtraction is the one line where a
            // future accounting slip would turn "truncate and report incomplete"
            // into a Panic(0x11) revert for exactly the long-lapse users the
            // budget protects — the regression `getTotalClaimableRewards`'s
            // "never reverts" promise forbids. Clamp, never trust.
            budget = used >= budget ? 0 : budget - used;
            if (!periodComplete) { complete = false; break; }
        }
    }

    /// @dev Walks one period within `budget` total staticcalls (checkpoints +
    ///      open rounds + forward rounds). Returns the pending it accrued, how much
    ///      budget it consumed (`used`), and whether it finished the whole period
    ///      (`complete`) or ran out of budget partway (F28/F29).
    function _pendingForPeriod(address user, uint256 i, uint24 nowRound, uint256 budget)
        internal view returns (uint256 total, uint256 used, bool complete)
    {
        PeriodView memory p;
        (
            p.delegate, p.startRound, p.endRound, p.nextClaimRound,
            p.startBalance, p.checkpointsLength, p.openRoundsLength
        ) = rewards.delegationPeriodAt(user, i);

        // Checkpoints must load in FULL (every balance lookup below reads the whole
        // memory image), so if they alone exceed the budget this period cannot be
        // computed within it — report incomplete without loading.
        if (p.checkpointsLength > budget) return (0, budget, false);
        uint24[] memory cpRound = new uint24[](p.checkpointsLength);
        uint256[] memory cpValue = new uint256[](p.checkpointsLength);
        for (uint256 j = 0; j < p.checkpointsLength; j++) {
            (uint24 r_, uint224 v_) = rewards.delegationCheckpointAt(user, i, j);
            cpRound[j] = r_;
            cpValue[j] = uint256(v_);
        }
        used = p.checkpointsLength;

        // Open-round deltas: rate growth on previously-crossed pending rounds.
        // Each iteration issues TWO staticcalls, so it charges 2 to the budget.
        // Weighted by the loyalty recorded ON THE ENTRY, matching
        // `_replayOpenRounds` — the walk's carried `L` has moved on by now.
        for (uint256 k = 0; k < p.openRoundsLength; k++) {
            // Check the FULL iteration cost (2) up front, not `used >= budget`:
            // with one unit of budget left the old check passed and the charge
            // below drove `used` to budget + 1, which underflowed the caller's
            // `budget -= used` and turned the budgeted walk into a panic-revert
            // (the exact F28/F29 failure the budget exists to prevent).
            if (used + 2 > budget) return (total, used, false);
            (uint24 oRound, uint224 banked, uint256 oLoyalty) = rewards.delegationOpenRoundAt(user, i, k);
            uint256 currentRate = rewards.delegatorRewardRatePerRound(p.delegate, oRound);
            if (currentRate > uint256(banked) && oLoyalty > 0) {
                uint256 bal = _balanceAt(cpRound, cpValue, p.startBalance, oRound);
                if (bal > 0) {
                    total += Math.mulDiv(
                        (bal * oLoyalty) / LOY_ONE, currentRate - uint256(banked), SATORI_RATE_SCALE
                    );
                }
            }
            used += 2;
        }

        uint24 from = p.nextClaimRound;
        if (from < p.startRound) from = p.startRound;

        uint24 to;
        if (p.endRound != 0) {
            to = p.endRound - 1;
        } else {
            if (nowRound == 0) return (total, used, true);
            to = nowRound - 1;
        }
        if (from > to) return (total, used, true);

        // Forward walk does NOT halt on pending — matches the mutating path.
        // Each round contributes rate × (predict-time balance × loyalty), with
        // `L` carried exactly as `_accrueDelegatorRewards` carries it: folded
        // from the round LOY_LAG behind, which is the same point the score-time
        // denominator used. Omitting the loyalty factor here does not merely
        // round differently — the rate is scaled by a loyalty-weighted `W`, so
        // `bal × rate` over-reports pending by orders of magnitude.
        uint256 L = rewards.delegationLoyaltyAt(user, i);
        uint256 lag = rewards.loyaltyLag();
        for (uint24 r = from; r <= to; r++) {
            // This round's exact cost — 2 with the coefficient staticcall, 1
            // without — checked BEFORE any of it is spent, so `used` can never
            // exceed `budget` (see the open-round loop for the underflow this
            // off-by-one caused in the caller).
            uint256 cost = uint256(r) >= lag ? 2 : 1;
            if (used + cost > budget) return (total, used, false);
            uint256 rate = rewards.delegatorRewardRatePerRound(p.delegate, r);
            if (rate > 0 && L > 0) {
                uint256 bal = _balanceAt(cpRound, cpValue, p.startBalance, r);
                if (bal > 0) total += Math.mulDiv((bal * L) / LOY_ONE, rate, SATORI_RATE_SCALE);
            }
            if (cost == 2) {
                (uint256 alpha, uint256 beta) = rewards.loyaltyCoeffs(p.delegate, uint256(r) - lag);
                L = (L * alpha) / LOY_ONE + beta;
            }
            used += cost;
        }
        return (total, used, true);
    }

    /// @dev `_lookupBalanceAt` over the memory-loaded checkpoints: value of the
    ///      latest checkpoint with round <= r, else the period's startBalance.
    function _balanceAt(
        uint24[] memory cpRound,
        uint256[] memory cpValue,
        uint256 startBalance,
        uint24 r
    ) internal pure returns (uint256) {
        for (uint256 j = cpRound.length; j > 0; j--) {
            if (cpRound[j - 1] <= r) return cpValue[j - 1];
        }
        return startBalance;
    }

    /// @notice Total claimable (unclaimed + pending, net of the referral skim).
    ///         Never reverts — the pending walk is budgeted (audit F28/F29).
    /// @dev    Under eager credit, `unclaimedRewards[user]` is the always-current
    ///         SATORI shadow; this adds the pending delegator-rate accruals,
    ///         netted of the 5% referral cut `_creditReward` skims at claim. When
    ///         `complete` is true the returned `total` equals what a full claim
    ///         mints to `user`; when the budgeted walk truncates (`complete ==
    ///         false`) `total` is a LOWER BOUND (never an over-report) (audit F59).
    /// @return total    unclaimed + pending accrued within the walk budget.
    /// @return complete false if the pending walk was truncated by the budget —
    ///         then `total` is a LOWER BOUND (never an over-report); the on-chain
    ///         claim still pays the full amount (capped + resumable, audit F6).
    function getTotalClaimableRewards(address user) external view returns (uint256 total, bool complete) {
        uint256 pending;
        (pending, complete) = pendingDelegatorRewards(user);
        total = rewards.unclaimedRewards(user)
            + (pending - (pending * REFERRAL_BPS) / 10000);
    }

    function _token()    private view returns (ITokenForLens)    { return ITokenForLens(IHubForLens(satoriCore).token()); }
    function _registry() private view returns (IRegistryForLens) { return IRegistryForLens(address(IHubForLens(satoriCore).registry())); }

    /// @notice Flat burn fees, mirroring SatoriHub.STREAM_BURN / GAME_BURN.
    function streamBurn() public pure returns (uint256) { return STREAM_BURN; }
    function gameBurn()   public pure returns (uint256) { return GAME_BURN; }
    function bountyBurn() public pure returns (uint256) { return GAME_BURN; }
    /// @notice Minimum total prediction power to GROW a streak; mirrors SatoriHub.
    function farmingThreshold() public pure returns (uint256) { return FARMING_FLOOR; }

    /// @notice Prediction/delegation transfer lock (lane A) — was `SatoriHub.lockedUntil`.
    function lockedUntil(address u) external view returns (uint256) { return uint256(_token().lockUntil(u, 0)); }

    /// @notice Emission still mintable by the ON-CHAIN lane, i.e. the hub's
    ///         emission ceiling net of the dev fee and of the Merkle lane's
    ///         reserve. Was `SatoriHub.onChainRewardCeiling`.
    ///
    /// This MIRRORS `SatoriHub.rewardMint`'s `generalCap` exactly, and must keep
    /// mirroring it — so it asks the TOKEN the same question the hub asks,
    /// rather than recomputing the carve-out here. It used to subtract
    /// `devFeeCeiling()` — the fee's realized accrual — which was right only
    /// while that accrual tracked the clock. It now tracks what was MINTED, so
    /// it lags whenever the lanes run below the emission rate, and subtracting
    /// it here would report headroom the hub would refuse.
    function onChainRewardCeiling() external view returns (uint256) {
        uint256 general = _token().generalCeilingFor(
            IHubForLens(satoriCore).emissionCeiling()
        );
        uint256 merk = IHubForLens(satoriCore).merkleReserveCeiling();
        // Saturating: report zero, never a panic, should the reserve ever reach
        // the general cap.
        return merk >= general ? 0 : general - merk;
    }

    struct EmissionStatus {
        uint256 rateNow;
        uint256 rateNext;
        /// The rate the next step sets, mirroring `SatoriHub._applySteps`;
        /// equals `rateNext` while no step is pending.
        uint256 rateAfterStep;
        uint256 ratioWad;
        uint256 stepsTaken;
        uint256 issued;
        /// `issued` plus the Merkle reserve accrued but not yet banked, grossed up.
        uint256 issuedProjected;
        uint256 nextStepAt;
        /// False at ratio 1e18 (steps short-circuit) or once emission has ended.
        bool stepsActive;
        address holder;
        uint256 dial;
        /// The off-chain dial the hub reserve actually accrues next round:
        /// `min(dial, residualNext − 1)`, mirroring `SatoriHub._effDial`.
        uint256 dialEffective;
    }

    /// @notice The emission schedule in one read, for the dapp's admin and
    ///         public panels.
    function emissionStatus() external view returns (EmissionStatus memory st) {
        IHubForLens hub = IHubForLens(satoriCore);
        (uint128 issued, uint128 nextStepAt,,,, uint64 ratioWad, uint32 stepsTaken,) = hub.emission();
        st.rateNow = ISatoriCore(satoriCore).emissionRateNow();
        st.rateNext = hub.emissionRateNext();
        st.ratioWad = ratioWad;
        st.stepsTaken = stepsTaken;
        st.issued = issued;
        st.nextStepAt = nextStepAt;
        st.stepsActive = ratioWad != 1e18 && nextStepAt != NO_STEP;
        st.rateAfterStep = st.stepsActive
            ? Math.min(st.rateNext * ratioWad / 1e18, ROUND_REWARD_BUDGET)
            : st.rateNext;
        uint256 ceil = hub.merkleReserveCeiling();
        uint256 cum = hub.merkleReserveCumulative();
        st.issuedProjected = ceil > cum
            ? st.issued + (ceil - cum) * 10000 / (10000 - _token().devFeeBps())
            : st.issued;
        st.holder = hub.emissionHolder();
        st.dial = rewards.offchainBudget();
        uint256 res = hub.residualNext();
        st.dialEffective = Math.min(st.dial, res == 0 ? 0 : res - 1);
    }

    /// @notice Whether a stream exists — was `SatoriHub.streamExists`.
    function streamExists(uint32 s) external view returns (bool) { return _registry().streamExists(s); }

    /// @notice Direction of a stream's value move between two rounds: 1 up,
    ///         -1 down, 0 flat/unknown. Was `SatoriHub.getValueChange`.
    function getValueChange(uint32 streamId, uint256 fromRound, uint256 toRound) external view returns (int8) {
        IRegistryForLens reg = _registry();
        if (!reg.streamExists(streamId)) return 0;
        // Hour-keyed ring: a round's value is the value standing at its LAST
        // hour (r*24 + 23).
        int256 fromValue = reg.getValueAtHour(streamId, fromRound * 24 + 23);
        int256 toValue   = reg.getValueAtHour(streamId, toRound * 24 + 23);
        if (toValue > fromValue) return 1;
        if (toValue < fromValue) return -1;
        return 0;
    }

    function satoriVoting()   external view returns (address) { return address(IHubForLens(satoriCore).voting()); }
    function satoriBounties() external view returns (address) { return address(IHubForLens(satoriCore).bounties()); }
    function satoriMerkle()   external view returns (address) { return IHubForLens(satoriCore).merkle(); }
}
