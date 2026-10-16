// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./libraries/SatoriTypes.sol";
import "./interfaces/ISatoriRewards.sol";
import "./interfaces/ISatoriCore.sol";
import "./interfaces/ISatoriVoting.sol";
import "./interfaces/ISatoriRegistry.sol";
import "./interfaces/ISatoriGames.sol";
import "./interfaces/ISatoriBounties.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./next/SatoriUUPS.sol";

import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title SatoriRewards
 * @notice Manages reward calculation, claiming, and both delegation systems
 * @dev Handles prediction delegation (predictor-vs-delegators per-prediction
 *      split, with a 5% referral cut skimmed from every reward credit) and claim
 *      delegation. Rewards are computed and distributed immediately at scoring
 *      time; the referral cut is likewise taken eagerly at credit time (see
 *      `_creditReward`), routing to the earner's referral or, absent one, to
 *      `marketingFeeRecipient`. unclaimedRewards[user] is always the exact
 *      claimable amount (already net of the referral cut).
 */
contract SatoriRewards is ISatoriRewards, ReentrancyGuard, SatoriUUPS {

    // ========== State Variables ==========

    /// @notice Deployer address (used to guard setSatoriCore from front-running)
    address private deployer;


    address public satoriCore;

    address public satoriVoting;

    /// @notice Stored pointer to the SatoriGames contract. Not invoked on-chain
    ///         from here — a producing stream only refreshes the budget
    ///         (SatoriEngine.onStreamProduced); kept for off-chain resolution.
    address public satoriGames;

    address public satoriRegistry;

    /// @notice The SatoriBounties contract. Bound once at wiring time via
    ///         `setSatoriBounties`. SatoriBounties owns the bounty subsystem
    ///         (pool / drip / stake / subscribe / score-time credit / boost
    ///         apply) that was split out to bring SatoriRewards back under
    ///         EIP-170.
    address public satoriBounties;

    /// @notice The SatoriEngine, a second authorized caller of onlyCore methods.
    address public satoriEngine;

    /// @notice The SatoriToken — the upgrade-gate pointer. `_upgradeGovernor()`
    ///         reads `upgradeAuthority()` off it, so a zero here takes `upgradeTo`
    ///         away from everyone (this is exactly how the Base Sepolia proxy was
    ///         bricked on 2026-08-30 — see scripts/check-upgrade-safety.js).
    ///
    /// PACKING: shares a slot with `_initialized` below (20 + 1 of 32).
    address public satoriToken;

    /// @dev Set by BOTH init paths: the implementation constructor (locking the
    ///      raw implementation instance) and the proxy `initialize` (making it
    ///      one-shot).
    bool private _initialized;

    // (No per-game bounty gate. The score-time credit cross-call is gated
    //  per-prediction by the "boosted" bit carried in the prediction slot and
    //  passed into `scoreCorrectPrediction` / `notifyPredictionFinalized` by the
    //  Satori core — so a non-boosted prediction, including every predictor on a
    //  never-funded OR drained-and-cleaned game, pays zero extra gas and nothing
    //  can be stranded by token cleanup.)

    /// @notice Address authorized to register OFFICIAL adapters/game adapters
    ///         (via the hub), set the off-chain emission dial
    ///         (`setOffchainBudget`), and transfer this admin
    ///         role. Upgrading a child (its proxy's `upgradeTo`) is NOT an admin
    ///         power — it is gated on `token.upgradeAuthority()`, a different key. This is a
    ///         minimal operational role, NOT contract ownership:
    ///         `SatoriHub.owner()` deliberately returns `address(0)` (ownerless
    ///         signal); read this role via the `admin()` getter directly.
    address public admin;

    // (The marketing recipient moved to APPENDED PROXY STORAGE — see
    //  `marketingFeeRecipient` near the end of this file for why, and for the
    //  two-step rotation that replaces the old immutable.)

    /// @dev The old hard-coded marketing placeholder the constructor refuses, so
    ///      a deploy can never ship it by accident.
    address internal constant _PLACEHOLDER_MARKETING = 0x000000000000000000000000000000000000bEEF;

    // ===== Per-predictor fee rate =====
    //
    // Each predictor sets their own cut of the *delegated* portion of their
    // wins, capped at MAX_PREDICTOR_FEE_BPS (1000 = 10%, == the default — so a
    // predictor can only ever undercut the 10% baseline, never exceed it).
    // Default-swap
    // involution on a single uint16 — two reserved stored values, swapped so
    // a zero-init slot reads as the default while an explicit zero is still
    // expressible (and the explicit-zero path stays SSTORE-free at score time):
    //   stored 0    → effective 1000 (DEFAULT 10%, the untouched / never-set state)
    //   stored 1000 → effective 0    (explicit zero)
    //   stored N    → effective as-is (literal, INCLUDING 1 = 0.01%)
    // Immutable: committing to a non-default rate locks on first use (mirrors
    // the stream authority cut), so the score path reads the rate directly with
    // no snapshot. NOTE: the rate is read FRESH at settlement, so an UNCOMMITTED
    // predictor's single first-commit (default -> a non-default rate, capped at
    // MAX_PREDICTOR_FEE_BPS) DOES apply to that round's in-flight delegated split
    // -- a deliberate, bounded, one-time change; delegating to a not-yet-committed
    // predictor carries that risk. A COMMITTED rate (stored != 0) can never
    // change again. "Already locked" is just
    // stored != 0. Passing exactly the default encodes to 0 (the untouched
    // state): a harmless no-op that neither changes the rate nor consumes the
    // lock — the default is the perpetually-uncommitted state, and only a real
    // (non-default) rate locks you in.
    uint16 internal constant MAX_PREDICTOR_FEE_BPS = 1000;
    uint16 internal constant DEFAULT_PREDICTOR_FEE_BPS = 1000;
    /// @notice Raw stored predictor fee bps. The "effective" rate applies a
    ///         default-swap involution (0 ↔ 1000) — consult
    ///         `SatoriRewardsLens.predictorFeeBps(predictor)` for the
    ///         transformed value. Direct reads of this mapping return the
    ///         raw storage byte.
    mapping(address => uint16) public predictorFeeStored;

    /// @dev Resolve the stored value (default-swap involution) to effective bps.
    ///      THE single source of truth for the sentinel decode — do not
    ///      re-implement it off-chain. The lens/dapp read `effectivePredictorFee`
    ///      (below), which wraps this, so the rule lives in exactly one place.
    function _effectivePredictorFee(uint16 stored) internal pure returns (uint16) {
        if (stored == 0) return DEFAULT_PREDICTOR_FEE_BPS;
        if (stored == DEFAULT_PREDICTOR_FEE_BPS) return 0;
        return stored;
    }

    /// @notice Effective predictor-fee bps for `predictor` — the authoritative
    ///         decode of the set-once `predictorFeeStored` sentinel (stored 0 →
    ///         the 10% default; stored DEFAULT_PREDICTOR_FEE_BPS → 0%; else
    ///         verbatim). The lens and the dapp call this instead of duplicating
    ///         the rule (was re-implemented in three places).
    function effectivePredictorFee(address predictor) external view returns (uint16) {
        return _effectivePredictorFee(predictorFeeStored[predictor]);
    }

    uint32 internal constant DEFAULT_STREAM_ID = 1;

    // ===== Per-round budget =====
    //
    // Each round's payable budget is the on-chain gross, snapshotted on the
    // round's first action so every path that draws from it sees the SAME
    // number regardless of update-vs-predict ordering. Nothing is reserved out
    // of it any more: the first-predictor bonus and the value-provider cut are
    // both gone, so the whole gross is distributable to predictors. (The
    // platform/dev fee is not carved from the budget here — it lives in the
    // immutable SatoriToken.)
    mapping(uint256 => uint256) internal _roundBudget;

    /// @notice The per-round emission routed to the off-chain Merkle channel, in
    ///         wei. The on-chain reward system gets the remainder,
    ///         `onChainGross = emissionRateNow − devRateNow − offchainBudget`.
    ///         Absolute wei (a percentage is UI-only). The setter floors it
    ///         strictly below that residual so `onChainGross >= 1 wei` — which
    ///         keeps the `_roundBudget[round]==0` "unset" sentinel honest and
    ///         gives functional (not literal) true zero. Default 0 = the whole
    ///         residual stays on-chain.
    uint256 public offchainBudget;

    /// @notice Emitted when the dial changes. `roundSet` is the round it was set
    ///         in; the change takes effect on the next round that gets touched
    ///         (an already-touched round has its gross frozen).
    event OffchainBudgetSet(uint256 newOffchainBudget, uint256 roundSet, address indexed setter);

    /// @notice Frozen on-chain gross per round (the residual less the dial,
    ///         captured at the round's first touch). BOTH the reserved bonus and
    ///         the credited bonus derive from this one frozen number, so a
    ///         mid-round dial move can never desync them; the payable snapshot
    ///         (`_roundBudget`) stays the lazily-settled allocation base.
    mapping(uint256 => uint256) internal _roundGross;

    /// @notice Scaling factor for SATORI delegator reward rates (per-round,
    /// per-unit-balance). Disambiguated from the bounty-side `RATE_SCALE`
    /// (declared in `SatoriBounties`, since the bounty subsystem was extracted)
    /// which scales the bounty drip rate at a different magnitude.
    uint256 private constant SATORI_RATE_SCALE = 1e24;

    // Reward Calculation
    //
    // `totalWeightPacked[stream][round]` holds BOTH directions in one slot:
    //   upper 128 bits = UP total weight (direction == 1)
    //   lower 128 bits = DOWN total weight (direction == 2)
    // Halves the storage footprint per (stream, round) and turns the
    // second-direction-predicter's SSTORE from cold (~22K) into a warm
    // modify (~5K). uint128 = 3.4e38 — bounded weights stay well under
    // (per-user weight ≈ 1e30, summed across millions of users ≈ 1e36).
    mapping(uint32 => mapping(uint256 => uint256)) public totalWeightPacked;

    uint256 private constant DIR_HALF_MASK = (1 << 128) - 1;

    /// @notice Per-address accrued-but-unclaimed reward bucket. Drained
    /// atomically by `_claimFor`. Predictor credits flow in through
    /// `scoreCorrectPrediction`; delegator-share credits in
    /// `_accrueDelegatorRewards`.
    mapping(address => uint256) public unclaimedRewards;

    /// @dev Number of (user, round) predictions that have not yet been
    ///      finalized by the engine settle path (SatoriEngine._scorePreviousPrediction
    ///      / _scoreAdapterPrediction). Bumped via bumpUnsettled at predict
    ///      time, dropped in notifyPredictionFinalized when finalization runs
    ///      (regardless of correct/incorrect/voided/unrecoverable). At any round
    ///      where this is non-zero, the delegator-accrual walk banks the
    ///      rate-as-of-now as an OpenRound entry and keeps walking; later claims
    ///      collect any rate growth via _replayOpenRounds, so an early claimer
    ///      never loses a rate still being filled in.
    ///
    ///      v5: also gates the `_predictorWinRoundIndex`-style mappings'
    ///      removal — under eager credit, no `_predictorWinRounds` walk
    ///      exists, so a per-user halt for SATORI claim is no longer needed.
    mapping(address => mapping(uint32 => uint256)) private _unsettledPredictionCount;

    // Prediction Delegation
    //
    // `delegate` (20) + `power` (uint96 = 12) = 32 bytes, one storage slot.
    // uint96 power caps at 7.9e28 wei — the same bound used by Prediction's
    // `rawPredictionPower`, which is the value that flows into this counter.
    // Predict-time receipt overflow would have to truncate rawPower first.
    // Saves one cold SSTORE (~22K gas) on each user's first delegation.
    struct PredictionDelegate {
        address delegate;       // 20 bytes
        uint96  power;          // 12 bytes — incoming delegators' summed balances
    }
    /// @notice Per-(user) prediction-delegation state. Auto-getter returns
    ///         (delegate, power) — `delegate` is whom `user` delegated TO,
    ///         `power` is the total balance OTHERS have delegated to `user`.
    mapping(address => PredictionDelegate) public predictionDelegateInfo;
    mapping(address => mapping(uint32 => mapping(uint256 => SatoriTypes.PredictionDelegationInfo))) public predictionDelegationInfo;

    // ========== Adapter-game (type 1+) bucket storage ==========
    //
    // The default binary game (type 0) uses the packed `totalWeightPacked`
    // (UP|DOWN in one slot). Adapter games (type 1+) use the SCORE/TOTAL model:
    // the protocol owns no per-bet share state — at score time the adapter
    // supplies the user's numerator and the round's shared denominator, and the
    // protocol pays pool × userScore / total under two conservation rails:
    // (1) the FIRST scorer's `total` is pinned for the whole (gameId, round)
    // and reused for everyone; (2) the running sum of paid numerators is capped
    // at that total. Together: total minted per (game, round) <= one pool, no
    // matter what the adapter returns. The adapter owns ALL scoring semantics
    // (buckets, partial credit, multi-outcome, ...) but can never multiply the
    // pool. This generalizes — and is strictly simpler than — the old bucket
    // model (which was the special case userScore=weight, total=bucketTotal).

    // _adapterPending[user][gameId][round] — set between record and score for an
    //   adapter bet. 0 = none, 1 = pending-unboosted, 2 = pending-boosted (the
    //   predict-time `applyBoost` snapshotted a bounty stake under the bucket).
    //   Consumed at score: prevents double-pay and unsolicited pay (the protocol,
    //   not the adapter, owns double-pay prevention) and carries the boosted bit
    //   into the score-time bounty credit.
    mapping(address => mapping(uint32 => mapping(uint256 => uint8))) internal _adapterPending;

    // Per-period delegator state. A delegator's contribution starts at
    // period.startBalance and grows when the delegator receives tokens —
    // but the new effective balance only takes effect at the NEXT round, not
    // the same round. Same-round predictions snapshot the pre-receipt pool
    // so denominator (rate pool) and numerator (per-delegator lookup) agree.
    // Next-round predictions snapshot the post-receipt pool, and per-delegator
    // checkpoints stamped at the activation round line up by construction.
    /// @dev Packed: uint32 round + uint224 value = 32 bytes, one storage slot.
    ///      uint224 max ≈ 2.7e67; cumulative SATORI emission at 1440/round is
    ///      bounded by total supply, which is bounded by 1440 ether × rounds.
    ///      Even a millennium of full issuance is ~5.3e26 wei — dozens of
    ///      orders of magnitude under the cast limit. Aligns with the int224
    struct Checkpoint {
        uint24  round;                // 3 bytes
        uint224 value;                // 28 bytes — effective balance starting at `round`
    }

    /// @dev Per-round "open" entry recorded when the delegator's accrual walk
    ///      crossed a round whose per-round rate could still grow (the delegate
    ///      had unfinalized predictions in that round when crossed). `banked`
    ///      is the rate value already credited; subsequent claims pay the delta
    ///      `currentRate - banked` and update `banked`. The entry is popped
    ///      once `_unsettledPredictionCount[delegate][round] == 0` — the round
    ///      is then final and can never grow again. Packed into one slot:
    ///      uint32 round (4 bytes) + uint224 banked (28 bytes) = 32 bytes.
    struct OpenRound {
        uint24 round;
        uint224 banked;
        /// @dev `L` as of `round`. A replayed delta must weight identically to
        ///      the original crossing, and by then the walk's carried `L` has
        ///      moved on — so the historical value rides on the entry.
        uint256 loyalty;
    }

    struct DelegationPeriod {
        address delegate;
        uint24 startRound;
        uint24 endRound;              // accrual-exclusive: pool subtracted on this round, so this round is NOT credited via this period. 0 sentinel while active.
        uint24 nextClaimRound;        // next round the delegator should accrue from
        uint24 replayCursor;          // F6: resume index into openRounds for the capped replay walk. Packs into slot 0's free 3 bytes (address+3×uint24 = 29, +this = 32).
        uint256 startBalance;
        // ---- Delegation loyalty (docs/design/delegation-loyalty-weighting.md) ----
        /// @dev `L` for this relationship, LOY_ONE-scaled. Starts at 0 (a fresh
        ///      delegation earns nothing until the predictor's first scored round);
        ///      carried forward by the claim walk, which is the only writer.
        uint256 loyalty;
        /// @dev The period's PER-UNIT-OF-CAPITAL contribution to the delegate's
        ///      `K` running sum — `B_s·2¹²⁸/A_s`, fixed at join. Capital is
        ///      time-varying, so `K` tracks `Σ cᵢ(r)·B_{sᵢ}/A_{sᵢ}` and every
        ///      capital delta moves it by `Δcᵢ × joinFactor`. Leave subtracts
        ///      exactly `cᵢ × joinFactor`, so no stale `L` read is ever needed.
        uint256 joinFactor;
        /// @dev Renormalisation epoch `joinFactor` was measured in. Rescaled by
        ///      `>> (LOY_RENORM_SHIFT × Δepoch)` at use.
        uint32  joinEpoch;
        Checkpoint[] checkpoints;
        OpenRound[] openRounds;       // rounds crossed while still pending; revisited each claim until they close.
    }

    /// @dev Single-bucket pending activation for a delegate's rate pool.
    ///      `amount` is the deferred increment; `activationRound` is the round
    ///      at which it folds into _delegatePowerForRate. By construction,
    ///      activationRound == today+1 (set when a delegator receives tokens
    ///      while delegated to this delegate). _flushPool lazily activates.
    /// @dev Packed: uint224 amount + uint32 activationRound = 32 bytes, one
    ///      storage slot. Same uint224 bound argument as `Checkpoint.value` —
    ///      `amount` accumulates same-round receipts toward today+1 and is
    ///      hard-capped by total SATORI supply.
    struct Pending {
        uint224 amount;             // 28 bytes
        uint24  activationRound;    // 3 bytes
    }

    mapping(address => DelegationPeriod[]) private _delegationPeriods;
    /// @dev Index of the first delegation period that may still need accrual
    ///      for the user. Periods at indices [0, _firstActiveDelegationPeriod)
    ///      are fully retired (closed AND nextClaimRound >= endRound) and are
    ///      never revisited. Advanced after _accrueDelegatorRewards walks the
    ///      array. Bounds claim gas to active+pending periods, not lifetime
    ///      delegation count.
    mapping(address => uint256) private _firstActiveDelegationPeriod;
    /// @dev Pool used as the rate denominator in `_scorePredictionCommit` and the
    ///      universal numerator basis. Tracks Σ over open delegators of
    ///      effective(delegator, today). Bumped on delegate/undelegate
    ///      (whole-balance entry/exit) and lazily on flush of pending
    ///      receipts. delegatedPredictionPower remains the live total used
    ///      by getPredictionPower / view paths.
    mapping(address => uint256) private _delegatePowerForRate;
    /// @dev Pending activation for _delegatePowerForRate. See Pending.
    mapping(address => Pending) private _delegatePoolPending;
    // _delegatorRewardRatePerRound[delegate][round] = sum across all streams the
    // delegate won that round of (delegatorsShare * SATORI_RATE_SCALE) / snapshotDelegatedPower.
    // Per-stream addition is mathematically clean because delegatedPower is the
    // same snapshot value for every stream the predictor predicted that round.
    mapping(address => mapping(uint256 => uint256)) private _delegatorRewardRatePerRound;

    // Claim Delegation
    //
    // Single-pointer authorization: who, if anyone, is authorized to call
    // `claimFor(owner, recipient)` on the owner's behalf. No balance lock,
    // no cooldown, no economic weight transfer — pure authorization on a
    // single function.
    mapping(address => address) public claimDelegateInfo;

    /// @notice Referral pointer per address. Set-once, immutable. `REFERRAL_BPS`
    ///         of EVERY reward credited to a user is diverted to this address at
    ///         credit time (see `_creditReward`); a zero or self pointer routes the
    ///         cut to `marketingFeeRecipient` instead.
    mapping(address => address) public referral;

    /// @notice The referral cut, in basis points, skimmed from every reward credit
    ///         and paid to the earner's referral (or the marketing wallet).
    ///         500 bps = 5%.
    ///
    /// @dev `_creditReward` has three call sites, but only TWO can ever pay:
    ///        1. a predictor's own share of a BINARY-game reward
    ///        2. a DELEGATOR's accrued share, at claim
    ///
    ///      The third, on the adapter-game scoring path, is structurally dead.
    ///      An adapter game cannot be voted for (`SatoriVoting.vote` reverts
    ///      `GameNotMintEligible` for any `gameTypeIdOf != 0`), and weight is
    ///      written nowhere else, so `getGameVotesAtRound` is always 0 for one.
    ///      `_gameRoundAllocation` then returns 0, `_streamPoolPostCut` returns
    ///      0, the reward computes to 0, and the `if (reward > 0)` guard above
    ///      the credit never opens. Adapter games still pay BOUNTIES — real
    ///      money, separately funded, credited earlier on that same path — but
    ///      bounties do not route through here and pay no referral cut.
    ///
    ///      So a referrer earns from the mint only, and only via a binary game:
    ///      directly when the referee predicts, or through their delegator
    ///      accrual when they delegate instead. The skim is keyed to the EARNER
    ///      (`referral[who]`), so a delegator's accrual pays the DELEGATOR's
    ///      referrer, not the delegate's — a referrer earns either way.
    ///
    ///      NOT paid on: airdrop claims, bounty payouts, or the Merkle
    ///      off-chain lane — none of those route through `_creditReward`.
    uint16 internal constant REFERRAL_BPS = 500;

    // (Bounty subsystem extracted to SatoriBounties. SatoriRewards holds no
    //  bounty state now — the score-time credit cross-call is gated entirely by
    //  the per-prediction `wasBoosted` bit the core passes in.)

    // ========== Events ==========

    /// @notice Fired on every `claim` / `claimFor`. The first field is the
    ///         **owner** whose `unclaimedRewards` bucket was drained, NOT the
    ///         caller. If a delegate triggered the claim, the delegate is not
    ///         visible in this event — join with `ClaimDelegated` to infer.
    event RewardsClaimed(address indexed owner, address indexed recipient, uint256 totalAmount, uint256 round);
    /// Every credited win. `newUnclaimed` is the predictor's bucket after the
    /// referral skim; with `DelegatorRewardsAccrued`, `ReferralPaid` and
    /// `RewardsClaimed` (which zeroes it) it is the whole `unclaimedRewards` ledger.
    event RewardSplit(
        address indexed predictor,
        uint32 indexed gameId,
        uint256 indexed round,
        uint256 predictorAmount,
        uint256 delegatorAmount,
        uint256 newUnclaimed
    );
    event DelegatorRewardsAccrued(address indexed delegator, uint256 amount, uint256 newUnclaimed);
    /// Once per round, except once emission is exhausted: a 0 budget is the "unset"
    /// sentinel, so every touch re-freezes and re-emits 0. Readers take the first.
    event RoundBudgetFrozen(uint256 indexed round, uint256 budget);
    /// `newDelegatePower` is `predictionDelegateInfo[delegate].power` after the write.
    event PredictionDelegated(address indexed delegator, address indexed delegate, uint256 predictionPower, uint24 activationRound, uint256 newDelegatePower);
    event PredictionUndelegated(address indexed delegator, address indexed delegate, uint256 predictionPower, uint256 newDelegatePower);
    event DelegatePowerSynced(address indexed delegate, address indexed delegator, uint256 value, uint24 activationRound, uint256 newDelegatePower);
    event ClaimDelegated(address indexed delegator, address indexed delegate);
    event ClaimUndelegated(address indexed delegator);
    event SatoriCoreSet(address indexed newCore);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
    event EmissionSplitAuthorityChanged(address indexed oldHolder, address indexed newHolder);
    /// Marketing-fee role handover: nominated, then accepted. `oldRecipient` is
    /// address(0) on the initial set at deploy.
    event MarketingFeeRecipientTransferStarted(address indexed oldRecipient, address indexed newRecipient);
    event MarketingFeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event ReferralSet(address indexed user, address indexed referral);
    event ReferralPaid(address indexed owner, address indexed referral, uint256 amount, uint256 round, uint256 newUnclaimed);

    // (Bounty events moved to SatoriBounties.)

    /// @notice Emitted once per predictor when they set their fee rate. Carries
    /// the caller's raw input (0 for an explicit zero), not the stored sentinel.
    event PredictorFeeSet(address indexed predictor, uint16 bps);

    // ========== Custom Errors ==========
    // Bounty-path errors. Saves ~30-50 bytes/site vs string requires; lets
    // SatoriRewards fit comfortably under EIP-170. (The SATORI-path string
    // requires that once lived here have since been converted to custom
    // errors as well — this file has no `require` strings left.)
    // Bucketed errors (reduces EIP-170 bytecode vs. one error per condition).
    // `BadInput` covers zero/invalid inputs (zero address, zero amount, etc).
    // `Unauthorized` covers caller-gate failures (not core, not owner, not the
    //   fee recipient, not the claim delegate, not the registry, etc).
    // `AlreadySet` covers idempotency / one-shot config errors (core already
    //   bound, referral already set, predictor fee already set, owner already
    //   renounced, already subscribed, etc).
    // Specific-condition errors that off-chain consumers actually want to
    // distinguish are kept named.
    error BadInput();
    error Unauthorized();
    error AlreadySet();
    error NoPendingPrediction();
    error ClaimDelegatedAway();
    /// @notice setPredictorFee: a value above MAX_PREDICTOR_FEE_BPS.
    error InvalidPredictorFee();
    error InvalidReferral();
    error Overflow();
    // ========== Modifiers ==========

    modifier onlyCore() {
        if (msg.sender != satoriCore && msg.sender != satoriEngine) revert Unauthorized();
        _;
    }

    function setSatoriEngine(address _engine) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (satoriEngine != address(0)) revert AlreadySet();
        if (_engine == address(0)) revert BadInput();
        satoriEngine = _engine;
    }

    // ========== Constructor ==========

    /// @param _voting        SatoriVoting address.
    /// @param _admin      Address that registers OFFICIAL adapters/game
    ///                       adapters, sets the off-chain budget dial, and
    ///                       transfers this admin
    ///                       role (child repointing is gated on a token
    ///                       authority, not an admin power). The protocol "owner" identity.
    /// @param _marketingFeeRecipient The marketing wallet for the no-referral cut.
    ///                       Rejects address(0) and the old 0xbEEF placeholder.
    /// @dev On the PROXIED path this constructor only initializes the raw
    ///      implementation instance (locking it); the proxy's own copy is set by
    ///      `initialize`. It is still taken here so a directly-deployed
    ///      SatoriRewards — which the constructor fully initializes, so
    ///      `initialize` can never run on it — is usable on its own.
    ///      (The platform/dev fee lives entirely in the immutable SatoriToken —
    ///      see docs/design/immutable-dev-fee.md.)
    constructor(
        address _voting,
        address _admin,
        address _marketingFeeRecipient
    ) {
        _setMarketingFeeRecipient(_marketingFeeRecipient);
        _init(_voting, _admin);
        _initialized = true;
    }

    /// Proxy initializer — runs atomically inside SatoriProxy's constructor
    /// (PHASE2-PROXY-ALL.md). The implementation constructor above locks the raw
    /// implementation; proxy storage gets everything, including the marketing
    /// recipient (storage, not an immutable — see `marketingFeeRecipient`) and
    /// the token pointer that governs upgradeTo/renounceUpgrade.
    function initialize(
        address _voting,
        address _admin,
        address _token,
        address _marketingFeeRecipient
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _setMarketingFeeRecipient(_marketingFeeRecipient);
        _init(_voting, _admin);
        _requireGovernorSource(_token);
        satoriToken = _token;
    }

    /// @dev Shared validation for both init paths. Rejects zero and the old
    ///      0xbEEF placeholder so a real, claimable address must be supplied —
    ///      the cut is credited eagerly, so an unclaimable destination silently
    ///      burns 5% of every un-referred reward.
    function _setMarketingFeeRecipient(address who) private {
        if (who == address(0) || who == _PLACEHOLDER_MARKETING) revert BadInput();
        marketingFeeRecipient = who;
        emit MarketingFeeRecipientChanged(address(0), who);
    }

    /// @notice Begin handing the marketing-fee role to `newRecipient`. Callable
    ///         ONLY by the current recipient — deliberately not an admin power:
    ///         `admin` is documented non-extractive, and a re-point would give it
    ///         5% of all un-referred emission.
    /// @dev Two-step (nominate + accept), same shape and same reasoning as the
    ///      LA-1 fix on SatoriMerkle's publisher: a one-step transfer to a typo'd
    ///      or unowned address would route the cut somewhere unclaimable forever.
    ///      Passing address(0) cancels a pending nomination.
    function transferMarketingFeeRecipient(address newRecipient) external {
        if (msg.sender != marketingFeeRecipient) revert Unauthorized();
        if (newRecipient == _PLACEHOLDER_MARKETING) revert BadInput();
        pendingMarketingFeeRecipient = newRecipient;
        emit MarketingFeeRecipientTransferStarted(marketingFeeRecipient, newRecipient);
    }

    /// @notice Complete the handover. Only the nominee can call it, which is what
    ///         proves the address is real and controlled before any cut routes there.
    function acceptMarketingFeeRecipient() external {
        address nominee = pendingMarketingFeeRecipient;
        if (msg.sender != nominee || nominee == address(0)) revert Unauthorized();
        address old = marketingFeeRecipient;
        marketingFeeRecipient = nominee;
        pendingMarketingFeeRecipient = address(0);
        emit MarketingFeeRecipientChanged(old, nominee);
    }

    function _init(address _voting, address _admin) private {
        if (_voting == address(0)) revert BadInput();
        if (_admin == address(0)) revert BadInput();
        deployer = msg.sender;
        satoriVoting = _voting;
        admin = _admin;
        emit AdminChanged(address(0), _admin);
    }

    // ========== Admin Functions ==========

    function setSatoriCore(address _core) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (satoriCore != address(0)) revert AlreadySet();
        if (_core == address(0)) revert BadInput();
        satoriCore = _core;
        satoriRegistry = ISatoriCore(_core).satoriRegistry();
        satoriGames = ISatoriCore(_core).satoriGames();
        emit SatoriCoreSet(_core);
    }

    /// @notice Bind the SatoriBounties contract. One-shot, deployer-only —
    ///         same pattern as `setSatoriCore`. Called by the deploy script
    ///         after SatoriBounties is deployed.
    function setSatoriBounties(address _bounties) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (satoriBounties != address(0)) revert AlreadySet();
        if (_bounties == address(0)) revert BadInput();
        satoriBounties = _bounties;
    }

    // `admin` is its own public getter; `SatoriHub.owner()` returns `address(0)`
    // (ownerless signal) and does NOT surface `admin`.

    /// The holder of a split-out job: the slot if it has been set, otherwise
    /// `admin`. The fallback is what makes this upgrade a no-op on a live proxy —
    /// an unset slot behaves exactly as it did before the split.
    function _holder(address slot) internal view returns (address) {
        return slot == address(0) ? admin : slot;
    }

    /// Who may reassign a split-out job: its current holder, or the token's
    /// appoint authority. Same shape as `setAdmin` below, and for the same
    /// reason — appointment is a token-level power, and a holder must be able to
    /// rotate its own key without asking anyone.
    function _requireCanAppoint(address slot) internal view {
        if (msg.sender != _holder(slot) &&
            msg.sender != ISatoriAppointAuthority(satoriToken).appointAuthority()) {
            revert Unauthorized();
        }
    }

    /// @notice Assign the on-chain/off-chain dial. Zero returns it to `admin`.
    function setEmissionSplitAuthority(address who) external {
        _requireCanAppoint(emissionSplitAuthority);
        emit EmissionSplitAuthorityChanged(_holder(emissionSplitAuthority), who);
        emissionSplitAuthority = who;
    }


    /// @notice Transfer the admin (owner) role. Callable by the admin itself, OR
    ///         by the token's APPOINT authority as a recovery path (see the
    ///         inline note below for why recall is the appoint slot, not upgrade).
    /// @dev Deliberately not two-step: during a key compromise the priority is
    ///      severing the attacker NOW, and a pending state they could re-trigger
    ///      is worse than useless.
    function setAdmin(address newAdmin) external override {
        // The recall path is the APPOINT slot, not the upgrade slot. Replacing
        // the admin is an appointment; reading it off the upgrade key would have
        // meant whoever can upgrade contracts also decides who operates them,
        // which is precisely the bundling the split exists to undo.
        if (msg.sender != admin && msg.sender != ISatoriAppointAuthority(satoriToken).appointAuthority()) {
            revert Unauthorized();
        }
        if (newAdmin == address(0)) revert BadInput();
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminChanged(oldAdmin, newAdmin);
    }

    /// @notice Set the caller's predictor fee — their cut of the delegated
    /// portion of their wins, in basis points (cap 10% = 1000, == the default).
    /// Pass the rate you want: 0 → 0%, 1000 → the 10% default, etc. Only values above the cap
    /// revert; asking for the default is a harmless no-op (you stay unlocked).
    /// Immutable: committing to a non-default rate locks on first use.
    function setPredictorFee(uint16 bps) external {
        _setPredictorFee(msg.sender, bps);
    }

    /// @notice `setPredictorFee` as `user`, for the hub's signed relay path
    ///         (docs/design/gasless-relay.md).
    function setPredictorFeeFor(address user, uint16 bps) external override onlyCore {
        _setPredictorFee(user, bps);
    }

    function _setPredictorFee(address user, uint16 bps) private {
        if (bps > MAX_PREDICTOR_FEE_BPS) revert InvalidPredictorFee();
        if (predictorFeeStored[user] != 0) revert AlreadySet();
        // Default-swap is an involution, so the same helper encodes and decodes:
        // passing the default (1000) stores 0 (the untouched state — a no-op
        // that doesn't lock); passing 0 stores 1000 (the explicit-zero flag);
        // everything else is stored as-is.
        predictorFeeStored[user] = _effectivePredictorFee(bps);
        emit PredictorFeeSet(user, bps);
    }

    /// @dev On-chain gross for a fresh round: the residual after the SENIOR dev
    ///      fee — `emissionRateNow − devRateNow − the dial`. The prediction game
    ///      and the off-chain dial split only this residual, so game + dial + dev
    ///      never exceeds the round's emission (no BudgetExceeded at the token).
    ///      The setter keeps `offchainBudget < emissionRateNow − devRateNow`, so
    ///      the gross is >= 1 at set time; see the yield below for later rounds.
    function _onChainGrossNow() internal view returns (uint256) {
        // The round's emission, net of the senior fee, net of the dial.
        //
        // Read from the core (the hub), never a constant: the rate is set there.
        //
        // THE DIAL YIELDS rather than underflowing. Its bound is checked at SET
        // time against a residual that can SHRINK later (an emission step or a
        // fee raise), so a dial legal today can exceed the whole residual later. Left as a bare
        // subtraction that panics — and `_ensureRoundBudget` is on the
        // predict/settle path, so it would brick every round rollover. The fee
        // is senior, the dial is junior, so the dial is what gives way. Floors
        // at 1 wei while any emission remains, because `budget == 0` is the
        // "unset" sentinel in `_ensureRoundBudget`.
        uint256 residual = ISatoriCore(satoriCore).emissionRateNow()
                         - ISatoriCore(satoriCore).devRateNow();
        if (residual == 0) return 0;
        uint256 dial = offchainBudget;
        return dial >= residual ? 1 : residual - dial;
    }

    /// @notice Set the off-chain split (admin only). Applies to FUTURE rounds: a
    ///         round already touched has its gross frozen (see _ensureRoundBudget),
    ///         so a change never rewrites an in-flight round. Floored so the
    ///         on-chain gross is always >= 1 wei.
    // ================= Capability flags (progressive rollout) =================
    // The hub and bounties gate their community / creation entry points against
    // these flags. Storage + admin setter live here because rewards owns the
    // `admin` role and is already called by both the hub and bounties. Every bit
    // defaults OFF, so the protocol launches with only predict / vote / claim and
    // opens features one at a time per the rollout roadmap; the admin always
    // bypasses every flag. Bits live in a fixed slot, OUTSIDE the sequential
    // storage layout (same pattern as SatoriUUPS's slots), so this adds no
    // storage-layout change. bytes32(uint256(keccak256("satori.hub.capabilities")) - 1)
    bytes32 private constant _CAP_SLOT = 0x27cad01dc4254e9bdafe1f698ebd1d17b1c95ec4178340a9736b0bd1b3f5eb71;
    event CapabilitiesSet(uint256 bitmap);

    /// @notice Admin sets the whole capability policy at once: bit `i` enables
    ///         capability `i` (ids defined in SatoriHub). Atomic — pass the full
    ///         intended mask (read the current one off-chain / from the event, OR
    ///         in the next bit). Defaults to 0 (all OFF) at deploy.
    function setCapabilities(uint256 bitmap) external {
        if (msg.sender != admin) revert Unauthorized();
        assembly { sstore(_CAP_SLOT, bitmap) }
        emit CapabilitiesSet(bitmap);
    }

    /// @notice Whether `caller` may use capability `capId` right now — the flag is
    ///         enabled for the public, or `caller` is the admin (bypasses toggles).
    ///         The hub and bounties read this to gate their user entry points.
    function capabilityAllowed(uint8 capId, address caller) external view returns (bool) {
        uint256 bits;
        assembly { bits := sload(_CAP_SLOT) }
        return ((bits >> capId) & 1 == 1) || caller == admin;
    }

    function setOffchainBudget(uint256 newOffchain) external {
        if (msg.sender != _holder(emissionSplitAuthority)) revert Unauthorized();
        // Bounded by NEXT round's residual (the first round the dial applies to),
        // matching the hub's setMerkleReserveRate bound exactly. The rate can
        // fall later (a step or a fee raise), which is why `_onChainGrossNow`
        // yields rather than trusting a once-legal dial forever.
        if (newOffchain >= ISatoriCore(satoriCore).residualNext()) revert BadInput();
        // Effective NEXT round: pin the current round's on-chain gross at the OLD
        // dial before switching, so a change never rewrites the in-flight round —
        // in lockstep with the hub's Merkle reserve, which likewise carries the old
        // rate through this round. Both lanes then read the same dial per round.
        _ensureRoundBudget(_currentRound());
        offchainBudget = newOffchain;
        // Mirror the dial into core's Merkle reserve accumulator (Phase 2b). Core
        // owns the authoritative per-lane ceiling; the Merkle contract never reads
        // rewards. Reverts if the core is not yet wired — dialing pre-wiring is a
        // deploy-order error, and nothing can mint before the core is set anyway.
        ISatoriCore(satoriCore).setMerkleReserveRate(newOffchain);
        emit OffchainBudgetSet(newOffchain, _currentRound(), msg.sender);
    }

    /// @dev The round's PAYABLE budget IS the on-chain gross. It used to be
    ///      `gross` minus a reserved first-predictor bonus; with that bonus gone
    ///      the reserve went with it, or the withheld amount would simply never
    ///      have been minted.
    function _computeRoundBudget(uint256 gross) internal pure returns (uint256) {
        return gross;
    }

    /// @dev Snapshot BOTH the on-chain gross and the payable budget for `round`
    ///      on its first state-changing touch. The dial is read exactly once,
    ///      here, and the fee accrual and predictor pools all derive from the
    ///      frozen gross, so a mid-round dial move never desyncs them. Payable
    ///      stays the lazily-settled base;
    ///      with the >= 1-wei gross floor it is never a literal 0, so the `== 0`
    ///      "unset" sentinel stays honest.
    function _ensureRoundBudget(uint256 round) internal returns (uint256 budget) {
        budget = _roundBudget[round];
        if (budget == 0) {
            uint256 gross = _onChainGrossNow();
            _roundGross[round] = gross;
            budget = _computeRoundBudget(gross);
            _roundBudget[round] = budget;
            emit RoundBudgetFrozen(round, budget);
        }
    }

    /// @dev Shared per-game round allocation: the game's vote-share of the
    ///      round's payable budget, resolved through the governing round.
    ///      Returns (allocation, govRound, gameVotes). allocation == 0
    ///      when the game isn't in the governing round's snapshot. Single
    ///      source of the allocation formula — `_computeReward` and both accrual
    ///      paths use it, so the math + item-5 resolution live in one place.
    function _gameRoundAllocation(uint32 gameId, uint256 currentRound)
        internal view returns (uint256 allocation, uint256 govRound, uint256 gameVotes)
    {
        govRound = ISatoriCore(satoriCore).eligibilityRound(currentRound);
        // A game that is not live — unapproved, or approval revoked — scores
        // NOTHING, including for rounds it participated in before the
        // revocation. Without this, an operator could farm a manipulated game
        // and still collect on rounds already predicted by the time the admin
        // caught it. Re-approving makes those rounds claimable again, so an
        // erroneous revocation is reversible. The default game is live by
        // construction (`gameLive`).
        if (!ISatoriVoting(satoriVoting).gameLive(gameId)) return (0, govRound, 0);
        uint256 totalVotes = _roundTotals(govRound);
        if (totalVotes == 0) return (0, govRound, 0);
        gameVotes = ISatoriVoting(satoriVoting).getGameVotesAtRound(gameId, govRound);
        if (gameVotes == 0) return (0, govRound, 0);
        // Snapshotted budget (saved by the round's first state-changing touch);
        // view fallback recomputes if a read somehow precedes any save.
        uint256 budget = _roundBudget[currentRound];
        if (budget == 0) budget = _computeRoundBudget(_onChainGrossNow());
        allocation = (budget * gameVotes) / totalVotes;
    }


    /// @notice A stream produced a value this round. Registry-gated, deduped to
    ///         the FIRST update of each stream per round.
    /// @dev Registry-gated. Its one job is the round-budget freeze: a stream
    ///      producing is one of the touches that can come first in a round, and
    ///      `_ensureRoundBudget` pins the round's gross on first touch.
    function onStreamProduced(uint32) external {
        if (msg.sender != satoriRegistry) revert Unauthorized();
        _ensureRoundBudget(_currentRound());
    }

    /// @dev Credit a REWARD to `who`, diverting `REFERRAL_BPS` (5%) to their
    ///      referral. This is the single chokepoint for every reward that pays a
    ///      referral cut: predictor wins, delegator shares, and value-provider
    ///      cuts all route through here. The cut goes to `referral[who]`, or to
    ///      `marketingFeeRecipient` when the earner has no referral — so the
    ///      skim applies to EVERY earner, referred or not. (A self-referral can
    ///      never be stored — `setReferral` and `setReferralFor` both reject it —
    ///      so `ref` is always either zero or a genuine third party.) The
    ///      referral's cut is written straight to its bucket, never back through
    ///      `_creditReward`, so a referral payment never itself pays a referral
    ///      (no referral-on-referral / MLM). Total credited (`who` + dest) always
    ///      equals `amount`, so per-round budget conservation is untouched — this
    ///      only redistributes, it never mints or over-credits.
    function _creditReward(address who, uint256 amount) internal {
        if (amount == 0) return;
        uint256 cut = uint256(amount) * REFERRAL_BPS / 10000; // 5%, truncated
        address ref = referral[who];
        address dest = ref == address(0) ? marketingFeeRecipient : ref;
        unclaimedRewards[who]  += amount - cut;
        if (cut > 0) {
            uint256 destUnclaimed = unclaimedRewards[dest] + cut;
            unclaimedRewards[dest] = destUnclaimed;
            emit ReferralPaid(who, dest, cut, _currentRound(), destUnclaimed);
        }
    }

    /**
     * @notice Set the caller's referral pointer. Set-once, immutable.
     * @dev Called directly by the user on this contract (not routed through the hub or engine). msg.sender is the
     *      address whose referral is being registered. A self-referral
     *      (`ref == msg.sender`) is rejected: it serves no purpose now — the
     *      `REFERRAL_BPS` cut (5%) is skimmed from every earner regardless, so
     *      referring yourself neither
     *      avoids the cut nor pays it to you (it would just route to the marketing
     *      wallet, same as having no referral). Zero is likewise rejected. The slot
     *      locks on first set; future setReferral calls revert.
     */
    function setReferral(address ref) external override {
        if (ref == address(0) || ref == msg.sender) revert InvalidReferral();
        if (referral[msg.sender] != address(0)) revert AlreadySet();
        referral[msg.sender] = ref;
        emit ReferralSet(msg.sender, ref);
    }

    /**
     * @notice Best-effort referral set on behalf of `user`, called by the core
     *         from `predictMultipleWithReferral` so a referred client can have
     *         their referral registered on their first prediction.
     * @dev Unlike `setReferral`, this NEVER reverts: a zero/self `ref`, or a
     *      slot that is already set, is a silent no-op so the surrounding
     *      prediction is never blocked. Only a fresh, valid referral is stored.
     */
    function setReferralFor(address user, address ref) external override onlyCore {
        if (ref == address(0) || ref == user) return;
        if (referral[user] != address(0)) return;
        referral[user] = ref;
        emit ReferralSet(user, ref);
    }

    // ========== Scoring Functions ==========

    /**
     * @notice Predict-time commit: snapshot the delegation split AND write
     *         the committed weight for this prediction's (direction, round).
     * @dev Conservation falls out of writing weight at predict time: every
     *      prediction contributes to `totalWeightByDirection` before the
     *      per-round predict deadline, so by the time anyone scores or
     *      claims, the denominator is final. The streak multiplier is
     *      locked using the user's CURRENT streak at predict time (see
     *      `SatoriEngine._makePrediction` — no `+1` look-ahead; rewards the
     *      streak they came in with). Predictions made before a prior
     *      prediction's outcome is known therefore use the not-yet-updated
     *      streak — by design (conservation is preserved; only the
     *      within-side redistribution is timing-dependent).
     *
     *      Does NOT bump `_unsettledPredictionCount`: the caller pre-bumps
     *      once for the whole batch via `bumpUnsettled(user, round, count)`
     *      before its per-stream loop (1 counter-write instead of N).
     */
    function scorePrediction(
        address user,
        uint32 gameId,
        uint256 round,
        uint8 direction,
        uint256 weight
    ) external override onlyCore {
        _scorePredictionCommit(user, gameId, round, direction, weight);
    }

    /**
     * @notice Bulk-bump the per-user pending counter by `count`. Called once
     *         from the engine's predict batch before its per-stream loop
     *         (the loop's commit calls never bump). The counter drives
     *         OpenRound banking in `_accrueDelegatorRewards`: a round the
     *         cursor crosses while the delegate still has an unresolved
     *         prediction is recorded as an OpenRound and revisited on later
     *         claims — so a later-arriving correct
     *         prediction in the same round would otherwise be lost.
     */
    function bumpUnsettled(address user, uint256 round, uint256 count) external override onlyCore {
        _unsettledPredictionCount[user][uint32(round)] += count;
        // Loyalty: `q`'s denominator. The engine already calls this once per
        // predict batch with the batch size, so the count is free here and no
        // cross-contract read of `predictedStreamsCount` is needed. Also marks
        // the round active so `_advanceAccum` can jump identity rounds.
        _roundPredictions[user][round] += count;
        if (round > _lastPredictedRound[user]) _lastPredictedRound[user] = round;
        // Global pending counter is bumped on `SatoriEngine._roundState[round]` by
        // the caller in the same predict transaction.
    }

    /// @dev Commit body for `scorePrediction`: pure delegation-split
    /// snapshot + weight write — no pending-counter mutation
    /// (`bumpUnsettled` covers the whole batch).
    function _scorePredictionCommit(
        address user,
        uint32 gameId,
        uint256 round,
        uint8 direction,
        uint256 weight
    ) internal {
        // Pin the round's gross at predict time, so a step that lands before the
        // round is scored cannot reach it through `_gameRoundAllocation`'s live fallback.
        _ensureRoundBudget(round);
        _flushPool(user);
        // Delegation snapshot is per-(user, gameId, round). Stores predictor's
        // full ownPower (balance + unclaimed) and full inbound delegatedPower
        // (drives predictor/delegator split + rate accumulator). Per-stream
        // rawPower lives inline on the engine's packed `userPredictions`
        // slot and is recovered via _predRaw at score time.
        //
        // GAS (review #19): written ONLY when the predictor has inbound
        // delegated power. For a non-delegate the snapshot's sole consumer —
        // _splitReward's `delegatedPower == 0` early-return — reads the same
        // zero from the never-written slot, and ownPower is never read on that
        // path. Skipping saves a cold SSTORE (~22K gas) per predicted game for
        // the common no-delegators case. Predict-time attribution is unchanged:
        // delegators who arrive AFTER predict never share this prediction
        // either way.
        uint256 delegatedPower = _delegatePowerForRate[user];
        if (delegatedPower != 0) {
            SatoriTypes.PredictionDelegationInfo storage delInfo = predictionDelegationInfo[user][gameId][round];
            delInfo.ownPower = uint128(_balanceOf(user) + unclaimedRewards[user]);
            delInfo.delegatedPower = uint128(delegatedPower);
            _snapshotRoundWeight(user, round);
        }
        // Commit the per-direction total at predict time. The
        // per-(user, stream, round, direction) weight is NOT stored —
        // it's re-derived at score time from the Prediction struct
        // (`rawPredictionPower * multiplier`). One cold SSTORE saved
        // per prediction (~22K gas); the packed total still needs a
        // read-modify-write because per-stream/round totals are read
        // many times at score time and can't be derived without
        // scanning every user's predictions.
        if (weight > 0) {
            // Total weight per (game, round) drives the per-game allocation
            // distribution at score time — keyed on gameId. `weight` is now just
            // `rawPower × multiplier` (the WEIGHT_SCALE / totalVotes factor was
            // dropped — it cancelled in the share and broke once the round total
            // stopped being locked; see SatoriEngine._deriveWeight). That removed
            // the 1e30-per-prediction case these bounds were sized for, but the
            // checks are kept: they are cheap, and a saturating bucket must fail
            // loudly rather than wrap and mis-split a game's pot.
            uint256 packed = totalWeightPacked[gameId][round];
            uint256 up = packed >> 128;
            uint256 down = packed & DIR_HALF_MASK;
            if (direction == 1) {
                up += weight;
                if (up > DIR_HALF_MASK) revert Overflow();
            } else {
                down += weight;
                if (down > DIR_HALF_MASK) revert Overflow();
            }
            totalWeightPacked[gameId][round] = (up << 128) | down;
        }
    }

    /**
     * @notice Decrement the per-user unsettled-prediction counter AND, when
     *         this is the round's LAST finalize and the finalizing prediction
     *         was boosted, cross-call SatoriBounties to clear (and refund) the
     *         per-round boosted-token list.
     * @dev The unsettled-prediction counter stays here because it gates the
     *      delegator-rate walk in `_accrueDelegatorRewards`. The per-round
     *      boosted-token list lives on SatoriBounties; it can only be cleared
     *      once EVERY prediction the user made in `round` has finalized (any
     *      still-pending one could still read it at score time). That moment is
     *      exactly when this counter hits zero. `wasBoosted` (the finalizing
     *      prediction's slot bit, passed by the core) gates the cross-call so
     *      non-boosted finalizes pay nothing. If the round's final finalize is a
     *      non-boosted prediction the list isn't refunded (it's already paid out
     *      and harmless) — a tolerated rare miss, not a correctness issue.
     */
    function notifyPredictionFinalized(address user, uint256 round, bool wasBoosted) external override onlyCore {
        uint32 r = uint32(round);
        uint256 c = _unsettledPredictionCount[user][r];
        if (c == 0) revert NoPendingPrediction();
        uint256 nc = c - 1;
        _unsettledPredictionCount[user][r] = nc;

        if (nc == 0 && wasBoosted) {
            ISatoriBounties(satoriBounties).clearRoundBountyList(user, round);
        }
    }

    /**
     * @notice Score-time eager credit for a CORRECT prediction.
     * @dev Bounty credit is per-prediction, gated on the `wasBoosted` slot
     *      bit the core snapshotted at predict time (see below). Per-token
     *      credit is NOT done eagerly here for the whole stream; bounty
     *      capture/payout is delegated to `ISatoriBounties.creditBountyForWin`,
     *      which works off the user's actual stake
     *      (`bountyStake` / `userStakedTokens` and the round's
     *      `boostedTokensInRound`). Non-boosted predictions skip the bounty
     *      pass entirely (zero extra gas) — defeats the shitcoin-spam attack.
     *
     *      This call:
     *      1. Computes the SATORI reward at score-time totals.
     *      2. Splits SATORI predictor-vs-delegators (no platform fee here — the
     *         platform/dev take now lives in the immutable SatoriToken), credits
     *         the user and writes the per-round delegator-rate accumulator.
     *      3. For each token the user actually staked
     *         (`userStakedTokens` / `boostedTokensInRound`) that the
     *         game has funded, the bounty contract lazy-drips that token
     *         for the round and credits the user's boost-aware
     *         stake-share.
     */
    function scoreCorrectPrediction(
        address user,
        uint32 gameId,
        uint256 round,
        uint8 direction,
        uint256 weight,
        bool wasBoosted,
        bool named
    ) external override onlyCore {
        // Bounty pass runs FIRST, regardless of weight. Gated per-prediction on
        // `wasBoosted` (the slot bit the core set when applyBoost snapshotted),
        // NOT on any per-game flag — so a non-boosted prediction (never-funded
        // OR drained-and-cleaned game) does zero bounty work, and cleanup can't
        // strand a boosted prediction's captured pot. On a boosted prediction
        // the share is pure stake-share (`pot × userStake / totalStake`), so no
        // SATORI-side numbers are passed — just (user, game, round, direction).
        if (wasBoosted) {
            ISatoriBounties(satoriBounties).creditBountyForWin(
                user, gameId, uint32(round), uint96(direction)
            );
        }

        // Loyalty: `q`'s numerator. Counted BEFORE the `weight == 0` return, so a
        // correct call on an ineligible (non-paying) stream still counts — same
        // reasoning as audit F16 keeping the streak ungated on power/eligibility:
        // it is a reputation signal, and `_roundPredictions` counts those
        // predictions in the denominator too.
        _roundWins[user][round] += 1;

        // No-op the SATORI credit path if no weight was committed at predict
        // time. The caller (SatoriEngine._scorePreviousPrediction) re-derives the weight from
        // the Prediction struct; we trust the value rather than re-look it up.
        if (weight == 0) return;

        // Eager SATORI credit. Allocation and delegation split are per-game
        // (different games on the same stream have different vote weights
        // and predictor pools), so this path keys on gameId.
        uint256 reward = _computeReward(gameId, round, weight, direction, named);
        if (reward > 0) {
            (uint256 u, uint256 delegatorsShare, uint256 d) = _splitReward(user, gameId, round, reward);
            _creditReward(user, u); // predictor's own share pays the referral skim
            emit RewardSplit(user, gameId, round, u, delegatorsShare, unclaimedRewards[user]);
            // The only SATORI commit point: the hub's step counter must see every
            // general-lane reward here and nowhere else (claims only drain it).
            ISatoriCore(satoriCore).noteIssued(u + d);
        }
    }

    /**
     * @notice Adapter-game predict-time commit (score/total model). Writes the
     *         delegation snapshot for the predictor/delegator split and marks
     *         the (user, gameId, round) bet pending. No bucket/weight is stored
     *         — the share is decided entirely at score time by the adapter,
     *         bounded by the protocol's pin + cap. Used by the engine's adapter
     *         dispatch in lieu of `scorePrediction` (reserved for the
     *         type-0 binary path). Does NOT bump the per-user pending counter
     *         (the caller pre-bumps once via `bumpUnsettled`).
     */
    function recordAdapterPrediction(
        address user,
        uint32 gameId,
        uint256 round,
        bool boosted
    ) external override onlyCore {
        _recordAdapterCommit(user, gameId, round, boosted);
    }

    /// @dev Commit body for `recordAdapterPrediction`: delegation
    /// snapshot + mark pending. No per-bet SATORI weight state (the score/total
    /// model decides the share at score time); no pending-counter mutation
    /// (the caller pre-bumps via `bumpUnsettled`). The bounty
    /// stake is NOT snapshotted here — the core snapshots the round's single
    /// ACTIVE bounty token via `snapshotAdapterStake` BEFORE `record`, and passes
    /// the resulting `boosted` bit (stake > 0) in here. The boosted bit is folded
    /// into `_adapterPending` so the score-time credit fires only for bets that
    /// actually snapshotted a stake.
    function _recordAdapterCommit(
        address user,
        uint32 gameId,
        uint256 round,
        bool boosted
    ) internal {
        _flushPool(user);
        // GAS (review #19): same guarded snapshot as _scorePredictionCommit —
        // written only when inbound delegated power exists; the settle-side
        // split's `delegatedPower == 0` early-return reads the same zero from
        // the never-written slot.
        uint256 delegatedPower = _delegatePowerForRate[user];
        if (delegatedPower != 0) {
            SatoriTypes.PredictionDelegationInfo storage delInfo =
                predictionDelegationInfo[user][gameId][round];
            delInfo.ownPower = uint128(_balanceOf(user) + unclaimedRewards[user]);
            delInfo.delegatedPower = uint128(delegatedPower);
            _snapshotRoundWeight(user, round);
        }

        // Mark the bet pending so score can pay it exactly once. The protocol —
        // not the adapter — owns double-pay prevention. 2 = pending-boosted,
        // 1 = pending-unboosted.
        _adapterPending[user][gameId][round] = boosted ? 2 : 1;
    }

    /**
     * @notice Adapter-game score-time entry. Consumes the protocol-recorded
     *         pending bet and credits the game's BOUNTY, if it had one.
     * @dev    It pays no SATORI, and there is no code here that could. An
     *         adapter game cannot hold vote weight — `SatoriVoting.vote` reverts
     *         `GameNotMintEligible` for any `gameTypeIdOf != 0`, and weight is
     *         written nowhere else — so `_gameRoundAllocation` yields 0, its
     *         pool is 0, and every payout computed from it is 0. It credits only
     *         the game's BOUNTY (separately funded escrow, stake-weighted,
     *         independent of any SATORI outcome).
     */
    function scoreAdapterPrediction(
        address user,
        uint32 gameId,
        uint256 round,
        uint256 userScore,
        uint256 bountyTotal
    ) external override onlyCore returns (bool finalized, bool wasBoosted) {
        // NOT finalized: these no-ops must NOT decrement the caller's shared
        // unsettled counter (F1). Off-chain games never pay through this lane;
        // an s == 0 slot means the user has no pending on this game/round (or a
        // hostile adapter is reporting a phantom finalize).
        uint8 s = _adapterPending[user][gameId][round];
        if (s == 0) return (false, false);              // not pending / already scored
        _adapterPending[user][gameId][round] = 0;       // consume → no double-pay
        finalized = true;                               // a real pending was consumed
        wasBoosted = (s == 2);

        // Bounty credit is STAKE-weighted, and gated on `wasBoosted` plus a
        // positive `bountyTotal` — never on any SATORI outcome. That
        // independence used to be the subtle part, because a boosted bet could
        // win nothing on SATORI and still win its bounty. With the mint lane
        // gone it is simply the whole function.
        // `userScore` is the accuracy returned by the adapter; SatoriBounties pays
        // pot × (userScore × stake) / bountyTotal for the round's active token,
        // pinning `bountyTotal` first-scorer and capping the running paid.
        if (wasBoosted && satoriBounties != address(0) && bountyTotal > 0) {
            ISatoriBounties(satoriBounties).creditAdapterBounty(user, gameId, round, userScore, bountyTotal);
        }

        return (true, wasBoosted);
    }


    /// @dev Auth + lockout check for `_claimFor` (SATORI mint). Returns the
    ///      current round so callers don't have to read it again.
    function _checkClaimAuth(address owner, address caller) internal view returns (uint256 currentRound) {
        currentRound = _currentRound();
        address ownerDelegate = claimDelegateInfo[owner];
        if (caller != owner) {
            if (ownerDelegate != caller) revert Unauthorized();
        } else {
            if (ownerDelegate != address(0) && ownerDelegate != owner) revert ClaimDelegatedAway();
        }
    }

    // ========== Reward Distribution ==========

    /// @notice Split a predictor's SATORI reward between the predictor and
    /// their delegators. No platform fee here — the platform/dev take now lives
    /// in the immutable SatoriToken; this split is purely predictor-vs-delegators.
    /// @dev Returns the predictor's portion and the delegators' share actually
    /// committed to the pull-rate accumulator (0 when it evaporates at W == 0). The predictor keeps
    /// their own-power portion in full plus a bonus on the delegated portion
    /// equal to their chosen `predictorFeeBps` (default 10%).
    function _splitReward(
        address user,
        uint32 gameId,
        uint256 round,
        uint256 totalReward
    ) internal returns (uint256 userPortion, uint256 delegatorsShare, uint256 committedDelegatorShare) {
        // The snapshot (ownPower, delegatedPower) is kept after _splitReward
        // reads it — used at claim time by the delegator-rate accrual to
        // reconstruct each round's split ratio. (Previously also held
        // `sumPower` as rawPower; that's now on the engine's packed slot,
        // recovered by the predictions(...) view via _predRaw.)
        SatoriTypes.PredictionDelegationInfo storage delInfo = predictionDelegationInfo[user][gameId][round];

        if (delInfo.delegatedPower == 0) {
            return (totalReward, 0, 0);
        }

        uint128 delegatedPower = delInfo.delegatedPower;
        uint256 delegatedReward;
        {
            uint256 totalPower = uint256(delInfo.ownPower) + uint256(delegatedPower);
            delegatedReward = (totalReward * uint256(delegatedPower)) / totalPower;
        }

        {
            // Predictor's cut of the delegated portion = their chosen rate
            // (default 10%). At an explicit 0 the carve-out is skipped
            // entirely and delegators take the full delegated portion.
            uint16 feeBps = _effectivePredictorFee(predictorFeeStored[user]);
            if (feeBps == 0) {
                delegatorsShare = delegatedReward;
                userPortion = totalReward - delegatedReward;
            } else {
                uint256 predictorBonus = (delegatedReward * feeBps) / 10000;
                delegatorsShare = delegatedReward - predictorBonus;
                userPortion = (totalReward - delegatedReward) + predictorBonus;
            }
        }

        // Per-round delegator rate accumulator. The denominator is now the
        // LOYALTY-WEIGHTED total `W = Σ cᵢLᵢ` rather than raw delegated power, so
        // each delegator pulls `cᵢ × Lᵢ × rate` via `_accrueDelegatorRewards`.
        // The predictor/delegator split above is untouched — loyalty only divides
        // the delegator pot, it never resizes it (design §1 scope).
        if (delegatorsShare > 0) {
            // The PREDICT-TIME pin, never a fresh computation — see
            // `_roundWeightSnapshot` for why recomputing here over-mints.
            uint256 W = _roundWeightSnapshot[user][round];
            if (W != 0) {
                _delegatorRewardRatePerRound[user][round] +=
                    Math.mulDiv(delegatorsShare, SATORI_RATE_SCALE, W);
                committedDelegatorShare = delegatorsShare;
            }
            // W == 0 EVAPORATES (design §7): every delegator is still at L = 0,
            // which happens on a predictor's first winning round with delegators
            // and on any round where the whole delegator set turned over. The
            // share is simply never minted — it does NOT fall through to the
            // predictor, which would pay predictors to churn their delegators.
            // The guard is load-bearing, not defensive: unguarded this is a
            // division by zero, i.e. a Panic 0x12 that reverts the settle path.
        }

    }

    // ========== Reward Claiming Functions ==========

    /**
     * @notice Claim rewards for `owner` to `recipient` (self-claim path).
     * @dev Self-claim only — `owner` is both the address whose unclaimed
     *      bucket is drained AND the original caller (`SatoriHub.claim()`
     *      passes `msg.sender` here under `onlyCore`). Claim delegation
     *      lives separately on `claimFor(owner, recipient)` below.
     */
    function claim(address owner, address recipient) external override onlyCore nonReentrant returns (uint256) {
        return _claimFor(owner, owner, recipient);
    }

    /**
     * @notice Claim rewards for an owner to a recipient using claim delegation authorization
     */
    function claimFor(address owner, address caller, address recipient) external override onlyCore nonReentrant returns (uint256) {
        return _claimFor(owner, caller, recipient);
    }

    /// @dev NOTE (audit F30 — accepted, working-as-intended): `recipient` is
    ///      DELIBERATELY caller-chosen, not pinned to `owner`. Claim delegation is
    ///      designed for delegating to your OWN other address — delegate wallet A's
    ///      claim to wallet B you also control, so B directing A's rewards wherever
    ///      is the intended point. The delegate is fully trusted with the reward
    ///      stream, and it is consent-gated (only the owner sets/clears it via
    ///      `delegateClaimAbility`, and while set the owner can't self-claim). Do
    ///      NOT "fix" this by pinning the recipient to `owner` — it would break the
    ///      multi-wallet use case.
    function _claimFor(address owner, address caller, address recipient) internal returns (uint256) {
        if (recipient == address(0)) revert BadInput();
        uint256 currentRound = _checkClaimAuth(owner, caller);

        // v5: no `_settleRewards(owner)` — eager credit at score time keeps
        // `unclaimedRewards[owner]` always current. The delegator-rate walk
        // is still needed to fold the delegator's slice of any delegate
        // wins into their bucket.
        _accrueDelegatorRewards(owner);

        uint256 totalRewards = unclaimedRewards[owner];
        if (totalRewards > 0) {
            unclaimedRewards[owner] = 0;
            // No referral split here anymore: the 5% cut is taken eagerly at
            // credit time (`_creditReward`), so `unclaimedRewards[owner]` is
            // already net of it — and the referral's own cut sits in ITS bucket,
            // to be claimed the same way. Claim simply mints the whole net bucket.
            _rewardMint(recipient, totalRewards);
        }

        emit RewardsClaimed(owner, recipient, totalRewards, currentRound);
        return totalRewards;
    }

    /// @dev Walk every delegation period and accrue per-round delegator shares.
    ///      Under eager credit, `_delegatorRewardRatePerRound[delegate][round]`
    ///      is populated by `scoreCorrectPrediction` as soon as the delegate
    ///      is scored. Non-winning rounds are a single zero-SLOAD pass-through.
    ///
    ///      Pending-round handling: the walk does NOT halt at rounds where the
    ///      delegate still has unfinalized predictions. Instead it banks the
    ///      rate-as-of-now, records an `OpenRound(round, banked)` entry on
    ///      the period, and continues. Each subsequent claim's first step is
    ///      `_replayOpenRounds` — it collects any rate growth as a delta and
    ///      pops entries whose round has since closed. Net result: a dark
    ///      stream stops nothing — the delegator gets what's scored now and
    ///      the delta later (or no delta at all, if the stream never returns).
    /// @notice A8: per-call cap on rounds walked by `_accrueDelegatorRewards`.
    ///         Bounds the gas a long-lapse delegator pays on their first
    ///         claim after a multi-year inactivity. Hitting the cap returns
    ///         control with the cursors advanced — a subsequent claim picks
    ///         up where this one stopped. 512 rounds = 512 days ≈ 1.4 years
    ///         at the 24-hour round cadence; a five-year lapse clears in
    ///         ~4 claims.
    /// @dev Sized from measurement, not guesswork (2026-08-12). A walked round
    ///      costs ~10.1k gas idle and ~8.6k on a winning round. `_accrueDelegatorRewards`
    ///      gives the open-round REPLAY its own budget of the same size, so a
    ///      single claim can walk 2× this. At the old 1024 that was ~21M against
    ///      a 30M block — enough headroom to be a bug rather than a margin. 512
    ///      lands the worst case near 11M (~38% of a block) and still clears 512
    ///      days (≈ 1.4 years) of backlog per call at the 24-hour cadence; a
    ///      five-year lapse
    ///      drains in ~4 claims, which the resumable cursors already support.
    uint256 internal constant MAX_DELEGATOR_ROUNDS_PER_CALL = 512;

    /// @dev The per-call round budget, as a function so tests can override it to
    ///      a small value and exercise the cap/resumption cheaply.
    function _maxDelegatorRoundsPerCall() internal view virtual returns (uint256) {
        return MAX_DELEGATOR_ROUNDS_PER_CALL;
    }

    function _accrueDelegatorRewards(address user) internal {
        DelegationPeriod[] storage periods = _delegationPeriods[user];
        uint24 nowRound = uint24(_currentRound());
        uint256 len = periods.length;
        uint256 start = _firstActiveDelegationPeriod[user];

        // Accumulate every per-round share locally and apply ONE pair of
        // sstore's at the end (user bucket + global counter), instead of
        // one pair per round in the inner loop. With long-lived delegations
        // this saves N × (5k + 5k) gas where N is rounds covered.
        uint256 sumAccrued = 0;
        uint256 roundsWalked = 0;
        uint256 replayWalked = 0;   // F6: a SEPARATE per-call budget for the open-round replay.
        uint256 maxPerCall = _maxDelegatorRoundsPerCall();
        bool capHit = false;

        for (uint256 i = start; i < len && !capHit; i++) {
            DelegationPeriod storage p = periods[i];

            // First: replay any rounds we previously crossed while their rate
            // could still grow. Pay deltas and pop closed entries. Capped +
            // resumable (F6): the replay has its OWN per-call budget, so a large
            // open-round backlog can neither exceed block gas nor starve the main
            // round walk below; it resumes from p.replayCursor on the next call.
            if (replayWalked < maxPerCall) {
                (uint256 d, uint256 ex) = _replayOpenRounds(p, maxPerCall - replayWalked);
                sumAccrued += d;
                replayWalked += ex;
            }

            uint24 from = p.nextClaimRound;
            if (from < p.startRound) from = p.startRound;

            // Closed periods walk up to but not including endRound — the
            // close-out path subtracts the delegator's contribution from the
            // rate pool synchronously on endRound, so the close-day rate is
            // sized as if they're already out and crediting their period for
            // that day would be phantom mint. Open periods walk up to but
            // not including the current round (rates may not be final yet —
            // predictor could win on more streams).
            uint24 to;
            if (p.endRound != 0) {
                to = p.endRound - 1;
            } else {
                if (nowRound == 0) { p.nextClaimRound = nowRound; continue; }
                to = nowRound - 1;
            }

            if (from > to) {
                p.nextClaimRound = to + 1;
                continue;
            }

            // No forfeiture cutoff: delegators can claim indefinitely,
            // matching predictors. The per-call cap (A8) lets a long-lapse
            // claimer pay bounded gas; the cursor (`p.nextClaimRound = r`
            // at the end of the while) resumes on the next call.

            address delegate = p.delegate;
            uint24 r = from;
            // Loyalty rides the walk. It is already round-by-round, so carrying
            // `L` costs one extra SLOAD (the frozen `q`) and a mulDiv per round —
            // no division, no sqrt, and no new writes inside the loop.
            uint256 L = p.loyalty;
            while (r <= to) {
                if (roundsWalked >= maxPerCall) {
                    capHit = true;
                    break;
                }
                uint256 rate = _delegatorRewardRatePerRound[delegate][r];
                // Hoist the rate check so non-winning rounds skip the
                // checkpoint walk entirely. _lookupBalanceAt is O(C) per
                // call; most rounds have rate==0 and don't need it. L == 0 is
                // the same short-circuit: a delegator still at zero loyalty
                // carries zero weight and earns nothing this round.
                if (rate > 0 && L > 0) {
                    uint256 bal = _lookupBalanceAt(p, r);
                    if (bal > 0) {
                        // rate was scaled by W = Σ cᵢLᵢ, so the numerator is
                        // capital × loyalty and the LOY_ONE cancels.
                        uint256 credit = Math.mulDiv((bal * L) / LOY_ONE, rate, SATORI_RATE_SCALE);
                        if (credit > 0) {
                            sumAccrued += credit;
                        }
                    }
                }
                // Pending check AFTER the credit — if the round still has
                // unfinalized predictions by this delegate, record the
                // banked rate so subsequent claims can collect any deltas.
                // `L` rides along: the replay must weight its delta with the
                // loyalty of THAT round, not whatever the walk has reached by
                // the time the delta arrives.
                if (_unsettledPredictionCount[delegate][r] > 0) {
                    p.openRounds.push(OpenRound({ round: r, banked: uint224(rate), loyalty: L }));
                }
                // Advance loyalty by the frozen q of the round LOY_LAG behind —
                // the SAME fold point `_snapshotRoundWeight` used to size this
                // round's denominator. Folding round `r` here instead would read
                // a `q` that cannot be settled yet (see LOY_LAG) and would also
                // put the walk out of step with `W`, breaking conservation.
                if (uint256(r) >= LOY_LAG) {
                    (uint256 alpha, uint256 beta) = _loyCoeffs(delegate, uint256(r) - LOY_LAG);
                    L = (L * alpha) / LOY_ONE + beta;
                }
                r++;
                roundsWalked++;
            }
            p.nextClaimRound = r;
            p.loyalty = L;
        }

        // Single sstore instead of one per round.
        if (sumAccrued > 0) {
            _creditReward(user, sumAccrued); // delegator's accrued share pays the referral skim
            emit DelegatorRewardsAccrued(user, sumAccrued, unclaimedRewards[user]);
        }

        // Advance the cursor past any leading periods that are fully retired
        // (closed AND nextClaimRound has reached endRound AND no open-round
        // entries left to revisit). Periods with surviving open rounds may
        // still grow on future claims, so they're not safe to skip yet.
        uint256 cur = start;
        while (cur < len) {
            DelegationPeriod storage p2 = periods[cur];
            if (
                p2.endRound != 0 &&
                p2.nextClaimRound >= p2.endRound &&
                p2.openRounds.length == 0
            ) {
                cur++;
            } else {
                break;
            }
        }
        if (cur != start) _firstActiveDelegationPeriod[user] = cur;
    }

    /// @dev Walk this period's `openRounds`: for each entry, credit any rate
    ///      growth since it was banked, and pop the entry if the round has
    ///      since closed (counter hit zero). Swap-pop preserves the gas refund
    ///      on the trailing slot.
    ///
    ///      F6 — bounded + resumable. Examines at most `budget` entries per call
    ///      (the caller shares this out of a per-call replay budget), starting
    ///      from `p.replayCursor`, so an arbitrarily long open-round backlog can
    ///      never blow the block gas limit. On a full pass (cursor reaches the
    ///      end) the cursor resets to 0 so the next call re-collects deltas from
    ///      the front; on a partial pass it saves the resume index. Returns the
    ///      delta credited and the number of entries `examined` (charged to the
    ///      budget). Invariant across a pass: [0, cursor) are examined-and-still-
    ///      open, [cursor, n) are not-yet-examined; swap-pop keeps it as the
    ///      swapped-in entry (from the unexamined tail) lands at the cursor.
    function _replayOpenRounds(DelegationPeriod storage p, uint256 budget)
        internal returns (uint256 delta, uint256 examined)
    {
        uint256 n = p.openRounds.length;
        if (n == 0) { p.replayCursor = 0; return (0, 0); }
        if (budget == 0) return (0, 0);
        address delegate = p.delegate;
        uint256 i = p.replayCursor;
        if (i >= n) i = 0; // cursor stale (list shrank since last call) -> fresh pass
        while (i < n && examined < budget) {
            OpenRound storage o = p.openRounds[i];
            uint24 r = o.round;
            uint256 currentRate = _delegatorRewardRatePerRound[delegate][r];
            uint256 banked = uint256(o.banked);
            if (currentRate > banked) {
                uint256 loy = o.loyalty;
                uint256 bal = loy == 0 ? 0 : _lookupBalanceAt(p, r);
                if (bal > 0) {
                    // Same weighting as the original crossing — capital × the
                    // loyalty recorded for THAT round.
                    uint256 add = Math.mulDiv((bal * loy) / LOY_ONE, currentRate - banked, SATORI_RATE_SCALE);
                    if (add > 0) {
                        delta += add;
                    }
                }
                o.banked = uint224(currentRate);
            }
            examined++;
            if (_unsettledPredictionCount[delegate][r] == 0) {
                // Round closed — pop the entry. Swap-pop so the popped slot
                // is the trailing one (gas refund), and re-process index i
                // since a new entry now lives there.
                uint256 last = n - 1;
                if (i != last) {
                    p.openRounds[i] = p.openRounds[last];
                }
                p.openRounds.pop();
                n--;
                // Do not increment i.
            } else {
                i++;
            }
        }
        // Full pass (reached the end) -> reset for the next call; else resume at i.
        p.replayCursor = uint24(i >= n ? 0 : i);
    }

    // ========== Lens read surface (raw delegation-walk state) ==========

    function delegationPeriodsLength(address user) external view returns (uint256) {
        return _delegationPeriods[user].length;
    }

    /// @notice F6 resume index into a period's openRounds for the capped replay.
    function delegationReplayCursor(address user, uint256 i) external view returns (uint256) {
        return _delegationPeriods[user][i].replayCursor;
    }

    function firstActiveDelegationPeriod(address user) external view returns (uint256) {
        return _firstActiveDelegationPeriod[user];
    }

    function delegationPeriodAt(address user, uint256 i)
        external view
        returns (
            address delegate,
            uint24 startRound,
            uint24 endRound,
            uint24 nextClaimRound,
            uint256 startBalance,
            uint256 checkpointsLength,
            uint256 openRoundsLength
        )
    {
        DelegationPeriod storage p = _delegationPeriods[user][i];
        return (
            p.delegate, p.startRound, p.endRound, p.nextClaimRound,
            p.startBalance, p.checkpoints.length, p.openRounds.length
        );
    }

    function delegationCheckpointAt(address user, uint256 i, uint256 j)
        external view returns (uint24 round, uint224 value)
    {
        Checkpoint storage cp = _delegationPeriods[user][i].checkpoints[j];
        return (cp.round, cp.value);
    }

    function delegationOpenRoundAt(address user, uint256 i, uint256 j)
        external view returns (uint24 round, uint224 banked, uint256 loyalty)
    {
        OpenRound storage o = _delegationPeriods[user][i].openRounds[j];
        return (o.round, o.banked, o.loyalty);
    }

    /// @notice View twin of `_loyCoeffs` — same decode, no freeze. The Lens
    ///         mirrors the claim walk by hand and needs the loyalty recursion's
    ///         coefficients; without them it reports `bal × rate` and, since the
    ///         rate is now scaled by a loyalty-weighted denominator, over-reports
    ///         pending rewards by orders of magnitude.
    function loyaltyCoeffs(address delegate, uint256 round)
        external view returns (uint256 alpha, uint256 beta)
    {
        uint256 enc = _frozenQ[delegate][round];
        uint256 q;
        if (enc == 0) {
            uint256 preds = _roundPredictions[delegate][round];
            if (preds == 0) return (LOY_ONE, 0);     // identity, never pinned
            uint256 wins = _roundWins[delegate][round];
            if (wins > preds) wins = preds;
            q = (wins * LOY_ONE) / preds;
        } else {
            q = enc - 1;
        }
        alpha = LOY_D + (q * (LOY_A - LOY_D)) / LOY_ONE;
        beta = q;
    }

    /// @notice The loyalty fold lag, so off-chain mirrors stay in lockstep.
    function loyaltyLag() external pure returns (uint256) { return LOY_LAG; }

    function delegatorRewardRatePerRound(address delegate, uint256 round) external view returns (uint256) {
        return _delegatorRewardRatePerRound[delegate][round];
    }

    // ========== Effective-Balance Helpers ==========

    /// @dev Effective delegated balance for period `p` at round `r`. Returns
    ///      the value of the latest checkpoint with round <= r, falling back
    ///      to the period's startBalance if no such checkpoint exists.
    function _lookupBalanceAt(DelegationPeriod storage p, uint24 r) internal view returns (uint256) {
        Checkpoint[] storage cps = p.checkpoints;
        uint256 n = cps.length;
        for (uint256 i = n; i > 0; i--) {
            Checkpoint storage cp = cps[i - 1];
            if (cp.round <= r) {
                return cp.value;
            }
        }
        return p.startBalance;
    }

    /// @dev Append or overwrite the checkpoint at the given round. Multiple
    ///      same-day receipts collapse into a single cp(today+1) holding the
    ///      cumulative effective value.
    function _writeCheckpoint(Checkpoint[] storage cps, uint24 r, uint256 v) internal {
        uint224 vNarrow = uint224(v);
        uint256 n = cps.length;
        if (n > 0 && cps[n - 1].round == r) {
            cps[n - 1].value = vNarrow;
        } else {
            cps.push(Checkpoint({round: r, value: vNarrow}));
        }
    }

    function _currentRound() private view returns (uint256) {
        return ISatoriCore(satoriCore).getCurrentRound();
    }

    function _rewardMint(address recipient, uint256 amount) private {
        ISatoriCore(satoriCore).rewardMint(recipient, amount);
    }

    function _balanceOf(address user) private view returns (uint256) {
        return ISatoriCore(satoriCore).balanceOf(user);
    }

    /// @dev The round's reward denominator. Now owned by SatoriVoting, which
    ///      accumulates it across the round as each game's first predictor
    ///      arrives, rather than by the engine locking a heap total up front.
    ///      Reverts `RoundNotFinal` if `round` is still open — scoring an open
    ///      round would divide by a partial total and over-pay.
    function _roundTotals(uint256 round) private view returns (uint256) {
        return ISatoriVoting(satoriVoting).roundDenominator(round);
    }

    /// @dev Activate any pending pool increment whose activation round has
    ///      arrived, folding it into _delegatePowerForRate. Callers run this
    ///      before reading or mutating the pool so the pre/post invariants
    ///      hold (pool == Σ effective(delegator, today) after any flush).
    function _flushPool(address delegate) internal {
        Pending storage pend = _delegatePoolPending[delegate];
        if (pend.activationRound == 0) return;
        uint24 nowRound = uint24(_currentRound());
        if (nowRound >= pend.activationRound) {
            _delegatePowerForRate[delegate] += pend.amount;
            // The matching K delta activates with it, so `W`'s capital basis
            // never drifts from `C`'s.
            uint256 pk = _delegatePoolPendingK[delegate];
            if (pk != 0) {
                _accumK[delegate] += pk;
                _delegatePoolPendingK[delegate] = 0;
            }
            pend.amount = 0;
            pend.activationRound = 0;
        }
    }

    /// @dev Score-time SATORI pool for `gameId` in `round`: the game's vote
    ///      share of the round budget. Single source used by BOTH score paths
    ///      (binary + adapter). The derived-stream family split that used to
    ///      live here was deleted with derived streams (2026-09-06, question 6
    ///      of docs/issues/rolling-24h-scoring.md) — its divisor was already 1
    ///      for every standalone stream, so this is the same arithmetic.
    function _streamPoolPostCut(uint32 gameId, uint256 round) internal view returns (uint256) {
        (uint256 nominalAllocation, , ) = _gameRoundAllocation(gameId, round);
        if (nominalAllocation == 0) return 0;

        // Conservation holds because `recordGameVotesForRound` freezes a game's
        // weight into the round at its FIRST predictor, so numerator and
        // denominator (`_roundTotals`) are the same recorded set.
        // NOTE: the old "predicting requires a fresh value that round"
        // produce-coupling argument predates phase 6 — flagged for owner review.
        return nominalAllocation;
    }

    /**
     * @notice Compute the exact reward for a user on a specific game/round/direction.
     * @dev Uses final totalWeight — always proportionally correct.
     */
    function _computeReward(
        uint32 gameId,
        uint256 round,
        uint256 userWeight,
        uint8 direction,
        bool named
    ) internal view returns (uint256) {
        if (userWeight == 0) return 0;

        uint256 _packedW = totalWeightPacked[gameId][round];
        uint256 totalWeight = direction == 1 ? (_packedW >> 128) : (_packedW & DIR_HALF_MASK);
        if (totalWeight == 0) return 0;

        // Eligibility + the nominal slice are governed by the round's OWN
        // recorded set (`eligibilityRound` is the identity — see
        // SatoriEngine.eligibilityRound). `nominalAllocation` = budget × votes /
        // ALL-eligible-votes; `gameVotes` is this game's snapshot weight.
        // `nominalAllocation == 0` ⇒ the game isn't in the snapshot.
        // (`totalWeight`/`userWeight` keep round R's divisor; it cancels in
        // userWeight/totalWeight, so its index is moot.)
        // Pool sizing (shared helper): the game's share of the round budget.
        // Nothing is
        // skimmed on the way — the whole slice reaches this game's predictors.
        uint256 streamPool = _streamPoolPostCut(gameId, round);
        if (streamPool == 0) return 0;
        // Named games are pari-mutuel: a side is paid only in proportion to
        // what the OTHER side committed, so a crowd that merely agrees with
        // itself (the counter is self-referential) draws nothing. UP pool +
        // DOWN pool still == streamPool.
        if (named) {
            uint256 other = direction == 1 ? (_packedW & DIR_HALF_MASK) : (_packedW >> 128);
            streamPool = (streamPool * other) / (totalWeight + other);
        }
        return (streamPool * userWeight) / totalWeight;
    }

    // ========== Prediction Delegation Functions ==========

    function syncPredictionDelegation(address from, address to, uint256 value) external override onlyCore {
        // Keeps the live delegatedPredictionPower in sync with delegator wallet
        // changes so getPredictionPower (the view) reflects post-transfer state.
        //
        // For receipts (to-side), also schedules next-round activation: writes
        // a per-delegator checkpoint at today+1 with the new effective balance,
        // and bumps the delegate's pool pending bucket. The rate pool itself
        // is NOT bumped here — same-day predictions still see the pre-receipt
        // pool, preserving the same-round invariant that pool == Σ effective.
        //
        // Sender side: the send-lock in SatoriToken._update blocks transfers
        // while a user is delegated, so the from-side branch should not be
        // reachable in practice. Kept for defense-in-depth.
        if (from != address(0)) {
            address predDelegate = predictionDelegateInfo[from].delegate;
            if (predDelegate != address(0)) {
                uint96 left = predictionDelegateInfo[predDelegate].power - uint96(value);
                predictionDelegateInfo[predDelegate].power = left;
                emit DelegatePowerSynced(predDelegate, from, value, uint24(_currentRound()), left);
            }
        }

        if (to != address(0)) {
            address predDelegate = predictionDelegateInfo[to].delegate;
            if (predDelegate != address(0)) {
                PredictionDelegate storage di = predictionDelegateInfo[predDelegate];
                uint256 newPower = uint256(di.power) + value;
                if (newPower > type(uint96).max) revert Overflow();
                di.power = uint96(newPower);

                // Flush any prior pending so the bucket only holds today+1
                // activations after this call.
                _flushPool(predDelegate);
                uint24 today = uint24(_currentRound());
                uint24 activation = today + 1;

                Pending storage pend = _delegatePoolPending[predDelegate];
                if (pend.activationRound == activation) {
                    pend.amount = uint224(uint256(pend.amount) + value);
                } else {
                    pend.amount = uint224(value);
                    pend.activationRound = activation;
                }

                // Stamp a per-delegator checkpoint at the activation round,
                // CUMULATIVELY across same-round receipts. If a checkpoint
                // already sits at `activation` (a prior same-round receipt), add
                // `value` to ITS current value — it already includes the earlier
                // receipt(s). Recomputing from `_lookupBalanceAt(today)` would
                // re-read the PRE-receipt startBalance (the activation cp at
                // today+1 is invisible at today) and OVERWRITE the cp, silently
                // dropping the earlier receipt (audit adv_15). This keeps
                // cp(today+1) == startBalance + Σ same-round receipts, matching
                // the pool pending accumulated above, so pool == Σ effective.
                uint256 pLen = _delegationPeriods[to].length;
                if (pLen > 0) {
                    DelegationPeriod storage p = _delegationPeriods[to][pLen - 1];
                    if (p.endRound == 0) {
                        uint256 cpLen = p.checkpoints.length;
                        uint256 base = (cpLen > 0 && p.checkpoints[cpLen - 1].round == activation)
                            ? uint256(p.checkpoints[cpLen - 1].value)
                            : _lookupBalanceAt(p, today);
                        _writeCheckpoint(p.checkpoints, activation, base + value);
                        // K tracks Σ cᵢ(r)·B_{sᵢ}/A_{sᵢ}, so a capital delta moves
                        // it by Δc × this period's join factor. Parked with the
                        // capital delta so both activate at today+1 together.
                        uint256 fac = _loyFactorNow(p, predDelegate);
                        if (fac != 0) _delegatePoolPendingK[predDelegate] += value * fac;
                    }
                }
                emit DelegatePowerSynced(predDelegate, to, value, activation, newPower);
            }
        }
    }

    /// @dev NOTE (audit F68 — accepted, working-as-intended liveness). A prediction
    ///      delegate that HOLDS inbound power may itself delegate away (become a
    ///      delegator via this call). It can then no longer PREDICT, so it stops
    ///      writing new `_delegatorRewardRatePerRound[delegate][·]` and its inbound
    ///      delegators' power sits IDLE — it is NOT forwarded on (delegation is not
    ///      transitive). This is a recoverable liveness wart, NOT a fund issue:
    ///      (1) already-earned delegator rewards are UNAFFECTED — `_accrueDelegatorRewards`
    ///      reads the delegate's IMMUTABLE historical per-round rates plus the
    ///      delegator's own checkpoints, with zero dependency on the delegate's
    ///      current state, so they stay claimable at any time; (2) this call never
    ///      touches the inbound delegators' periods; (3) each inbound delegator
    ///      recovers UNILATERALLY by re-delegating (or predicting) their own power —
    ///      no cooperation from the now-delegated delegate is required. The only cost
    ///      is that idle power earns nothing new until they act, with no on-chain
    ///      signal that it happened. Do NOT "fix" by blocking a delegate-with-inbound
    ///      from delegating out: that adds a state-coupling foot-gun for no fund gain.
    function delegatePredictionPower(address delegate, address delegator, uint256 power) external override onlyCore {
        // Defense-in-depth: collapse self-delegation to address(0) before
        // any storage read. predictionDelegate must only ever hold
        // address(0) (undelegated) or some-other-address (delegated).
        if (delegate == delegator) delegate = address(0);

        address previousDelegate = predictionDelegateInfo[delegator].delegate;

        // No-op if re-delegating to the same active delegate.
        if (delegate != address(0) && delegate == previousDelegate) {
            return;
        }

        uint24 today = uint24(_currentRound());

        // Close out the current active period, if any.
        if (previousDelegate != address(0)) {
            uint96 prevLeft = predictionDelegateInfo[previousDelegate].power - uint96(power);
            predictionDelegateInfo[previousDelegate].power = prevLeft;
            emit PredictionUndelegated(delegator, previousDelegate, power, prevLeft);

            // Flush so any activation that should have already happened is
            // reflected in the pool before we subtract this delegator's slice.
            _flushPool(previousDelegate);

            uint256 pLen = _delegationPeriods[delegator].length;
            if (pLen > 0) {
                DelegationPeriod storage active = _delegationPeriods[delegator][pLen - 1];
                if (active.endRound == 0) {
                    // Subtract this delegator's effective stake at today —
                    // exactly what the rate pool currently reflects from them.
                    uint256 effectiveAtToday = _lookupBalanceAt(active, today);
                    _delegatePowerForRate[previousDelegate] -= effectiveAtToday;

                    // K mirrors C: this period contributed `c × joinFactor`, so
                    // leaving subtracts exactly that. `joinFactor` is a CONSTANT
                    // fixed at join, so this is exact and O(1) — no stale `L`
                    // read, no bounded walk, and nothing to bias (design §9.1).
                    uint256 fac = _loyFactorNow(active, previousDelegate);
                    if (fac != 0) {
                        uint256 kOut = effectiveAtToday * fac;
                        uint256 kHave = _accumK[previousDelegate];
                        _accumK[previousDelegate] = kHave > kOut ? kHave - kOut : 0;
                    }

                    // If this delegator has a future cp (cp(today+1) by
                    // construction), its delta is sitting in pool pending —
                    // strip it out so the new period doesn't get double-counted
                    // when activation fires.
                    uint256 cpLen = active.checkpoints.length;
                    if (cpLen > 0) {
                        Checkpoint storage last = active.checkpoints[cpLen - 1];
                        if (last.round > today) {
                            uint256 pendingPortion = uint256(last.value) - effectiveAtToday;
                            Pending storage pend = _delegatePoolPending[previousDelegate];
                            pend.amount = uint224(uint256(pend.amount) - pendingPortion);
                            if (pend.amount == 0) pend.activationRound = 0;
                            if (fac != 0) {
                                uint256 pk = _delegatePoolPendingK[previousDelegate];
                                uint256 pkOut = pendingPortion * fac;
                                _delegatePoolPendingK[previousDelegate] = pk > pkOut ? pk - pkOut : 0;
                            }
                        }
                    }

                    active.endRound = today;
                }
            }
        }

        predictionDelegateInfo[delegator].delegate = delegate;

        if (delegate != address(0)) {
            // Self-delegation was normalized to address(0) above, so reaching
            // here means delegate is a genuinely different address.
            //
            // Mark the DELEGATOR (not the delegate) as a participant here — the
            // single chokepoint both SatoriHub.delegatePredictionPower and
            // burnForVote's internal re-delegation pass through, so both mark
            // identically. A delegator's balance receipts must re-book onto the
            // delegate's pool, which is exactly what the transfer hook does; a
            // delegate's own balance is read live, so it needs no mark. The
            // symmetric clear is in the undelegate branch below.
            ISatoriCore(satoriCore).markParticipated(delegator);

            _flushPool(delegate);

            PredictionDelegate storage di = predictionDelegateInfo[delegate];
            uint256 newPower = uint256(di.power) + power;
            if (newPower > type(uint96).max) revert Overflow();
            di.power = uint96(newPower);

            // Open a new period for this delegator.
            _delegationPeriods[delegator].push();
            uint256 newIdx = _delegationPeriods[delegator].length - 1;
            DelegationPeriod storage p = _delegationPeriods[delegator][newIdx];
            p.delegate = delegate;
            p.startRound = today;
            p.endRound = 0;
            p.nextClaimRound = today;

            // Loyalty starts at 0 — a fresh delegation earns nothing until the
            // predictor's first scored round, which is the switching cost. Pin
            // the period's per-unit K factor `B_s·2¹²⁸/A_s` against the CURRENT
            // accumulator, so `Lᵢ(r) = B_r − (A_r/A_s)·B_s` starts this period at
            // exactly zero and grows from there.
            // Pin against the SAME lagged fold point the walk and the weight
            // snapshot use, so the closed form and the walk's carried `L` agree
            // exactly. The period therefore folds from `startRound − LOY_LAG`:
            // `L` is still 0 on the joining round (the fold range is empty
            // there), but the first few folds are rounds just before the join.
            // That bounded head start is the price of having ONE fold point;
            // the alternative is a walk and a denominator that disagree.
            if (today > LOY_LAG) _advanceAccum(delegate, today - 1 - LOY_LAG);
            {
                uint256 accA = _accumA[delegate];
                if (accA == 0) accA = LOY_TWO128;
                p.joinFactor = Math.mulDiv(_accumB[delegate], LOY_TWO128, accA);
                p.joinEpoch = _accumEpoch[delegate];
            }

            // OVER-MINT GUARD (audit H1). If the delegate has ALREADY predicted
            // this round, that prediction's split snapshot (`delegatedPower =
            // _delegatePowerForRate` at predict time) is frozen and EXCLUDES this
            // delegator. Activating immediately would let this delegator collect
            // round `today`'s delegator rate against a denominator that never
            // counted them — a phantom mint (the inverse of the intended
            // undelegate-mid-round forfeit). In that case DEFER to today+1, exactly
            // like a mid-round balance increase (syncPredictionDelegation): the
            // pool and the period's effective balance both activate next round, the
            // first round whose snapshot includes this delegator. Otherwise (the
            // delegate has NOT predicted yet) activate immediately, so a delegation
            // made BEFORE the prediction is correctly in that round's snapshot —
            // the common, documented case. `_unsettledPredictionCount[delegate]
            // [today] > 0` iff the delegate predicted this round (a same-round
            // settle is impossible, so the count can only have grown);
            // `_flushPool(delegate)` above already folded any DUE pending, so a
            // non-zero pending here is this round's today+1 bucket.
            uint24 activation = today;
            if (_unsettledPredictionCount[delegate][uint32(today)] > 0) {
                activation = today + 1;
                Pending storage pend = _delegatePoolPending[delegate];
                if (pend.activationRound == activation) {
                    pend.amount = uint224(uint256(pend.amount) + power);
                } else {
                    pend.amount = uint224(power);
                    pend.activationRound = activation;
                }
                _delegatePoolPendingK[delegate] += power * p.joinFactor;
                p.startBalance = 0;
                _writeCheckpoint(p.checkpoints, activation, power);
            } else {
                _delegatePowerForRate[delegate] += power;
                _accumK[delegate] += power * p.joinFactor;
                p.startBalance = power;
            }

            ISatoriCore(satoriCore).lockUntilUndelegation(delegator);
            emit PredictionDelegated(delegator, delegate, power, activation, newPower);
        } else {
            // No longer a delegator: clear the transfer-hook gate, symmetric with
            // the mark above. burnForVote undelegates here mid-flow and the caller
            // is genuinely out of the pool for the burn (that is why it undelegates
            // first), so clearing now is correct; its step-3 re-delegation re-marks.
            ISatoriCore(satoriCore).unmarkParticipated(delegator);
            ISatoriCore(satoriCore).lockUntilNextRound(delegator);
        }
    }

    function getPredictionPower(address user) external view override returns (uint256) {
        // Storage invariant (enforced at delegatePredictionPower entry):
        // predictionDelegate is either address(0) (undelegated) or a
        // genuinely different address (delegated). Self-delegation is
        // normalized away, so the only "you have power" case is address(0).
        PredictionDelegate storage di = predictionDelegateInfo[user];
        if (di.delegate != address(0)) {
            return 0;
        }
        // v5: under eager credit, `unclaimedRewards[user]` is the always-current
        // accrued SATORI shadow. Including it here lets a user predict with
        // their unclaimed rewards counted as stake without having to claim
        // them first — O(1) read.
        //
        // Inbound delegated power uses the DEFERRED rate pool
        // (`_delegatePowerForRate`, activated), NOT the live `di.power`. di.power
        // is bumped immediately on a same-round token receipt to a delegator,
        // but the reward split defers that receipt to next round (the rate pool
        // stays "pool == Σ effective"). Using di.power here would let a same-round
        // receipt inflate THIS predictor's pool slice without inflating the split
        // it is divided by — the delegate over-collects (audit adv_6). Mirror
        // `_flushPool` in this view: fold a pending increment in only once its
        // activation round has arrived, so the value equals the flushed pool the
        // predict-time split snapshots (`delegatedPower = _delegatePowerForRate`
        // after `_flushPool`). di.power is still maintained — its uint96 cap
        // bounds the pool so the uint128 snapshot at predict time can't truncate.
        uint256 inbound = _delegatePowerForRate[user];
        Pending storage pend = _delegatePoolPending[user];
        if (pend.activationRound != 0 && _currentRound() >= pend.activationRound) {
            inbound += uint256(pend.amount);
        }
        return _balanceOf(user)
             + unclaimedRewards[user]
             + inbound;
    }

    // ========== Claim Delegation Functions ==========

    function delegateClaimAbility(address delegate, address delegator) external override onlyCore {
        claimDelegateInfo[delegator] = delegate;
        if (delegate != address(0) && delegate != delegator) {
            emit ClaimDelegated(delegator, delegate);
        } else {
            emit ClaimUndelegated(delegator);
        }
    }


    /// @notice Where the referral cut goes when the earner has no referral.
    /// @dev    This was previously an `immutable`, i.e. a value compiled into the
    ///         implementation's BYTECODE. On an upgradeable contract that is a
    ///         weak guarantee: a new implementation carries a new value, which is
    ///         why an `_validateNewImplementation` pin had to be bolted on to
    ///         re-check it — and that pin was itself only a speed bump, since the
    ///         check runs in the OUTGOING implementation and a second upgrade
    ///         could simply drop it.
    ///
    ///         Living in PROXY STORAGE is strictly stronger on that axis: an
    ///         upgrade swaps code, not storage, so no implementation can change
    ///         this by being compiled differently. It also removes a permanent
    ///         failure mode — an immutable recipient whose key is lost burns 5%
    ///         of every un-referred reward forever, with no recovery.
    ///
    ///         Rotation is deliberately NOT an admin power. `admin` is documented
    ///         as non-extractive ("can never direct funds or votes to itself"),
    ///         and letting it re-point this would hand it 5% of un-referred
    ///         emission. Only the CURRENT recipient may nominate a successor, and
    ///         the successor must accept — see `transferMarketingFeeRecipient`.
    address public marketingFeeRecipient;

    /// @notice Nominee from `transferMarketingFeeRecipient`, pending acceptance.
    address public pendingMarketingFeeRecipient;

    // ================= Delegation loyalty (appended storage) =================
    //
    // docs/design/delegation-loyalty-weighting.md. A predictor's delegator pot is
    // divided by `weight = capital × L` instead of by capital alone, where `L` is
    // a per-(delegator → predictor) loyalty score updated once per round from the
    // predictor's fraction of that round's predictions that were correct (`q`):
    //
    //     L' = q(aL + 1) + (1−q)(dL)  =  αL + β,  α = d + q(a−d),  β = q
    //
    // Because weight is LINEAR in L and the update is AFFINE, the round
    // denominator stays closed-form — it is never iterated over delegators:
    //
    //     W(r) = Σ cᵢLᵢ(r) = B_r·C − A_r·K,   K = Σ cᵢ·B_{sᵢ}/A_{sᵢ}
    //
    // with (A, B) the composed affine map from round 0 and `C` the existing
    // `_delegatePowerForRate`. `K`'s per-period term is a constant fixed at join,
    // so joins and leaves are exact O(1) adjustments.

    /// @dev Fixed-point one for α, β, B and L. All are O(1)…O(1/(1−a)) magnitudes.
    uint256 internal constant LOY_ONE = 1e18;
    /// @dev Growth damping `a`. L saturates at `1/(1−a)` ≈ 33.33 for a
    ///      fully-correct predictor; `a` is the sole concentration dial
    ///      (design §12). A newcomer reaches ~90% of that in ~76 rounds.
    uint256 internal constant LOY_A = 97e16;
    /// @dev Loss decay `d` — the golden-ratio conjugate, matching the protocol's
    ///      existing use of φ. Must stay < LOY_A so α ∈ [d, a] ⊂ (0, 1).
    uint256 internal constant LOY_D = 618033988749894848;
    /// @dev Base for `A`. `A` decays every scored round, so it carries its own
    ///      (larger) scale than the LOY_ONE quantities.
    uint256 internal constant LOY_TWO128 = 1 << 128;
    /// @dev Renormalisation: when `A` drops below this it is shifted back up and
    ///      `K` is shifted down by the same amount, preserving `A·K`. A fixed
    ///      POWER OF TWO, deliberately — renormalising `A` to 1 on fixed round
    ///      boundaries would hand full loyalty to anyone joining just before one.
    uint256 internal constant LOY_RENORM_FLOOR = 1 << 96;
    uint256 internal constant LOY_RENORM_SHIFT = 32;

    /// @dev FOLD LAG, in rounds. Round `r`'s outcome is not knowable at `r + 1`:
    ///      in the band-2 (ABC) case scoring compares the first TWO stream
    ///      values after the prediction, so such a round settles at `r + 2` at
    ///      the earliest.
    ///      Freezing `q` on literal first crossing therefore froze it at ZERO for
    ///      almost every round and loyalty never grew.
    ///      NOTE: LOY_LAG = 4 is unreviewed since the scoring bands changed.
    ///
    ///      So the fold point is LAGGED and FIXED: the loyalty applied to round
    ///      `r` is the map composed through `r − 1 − LOY_LAG`. Fixed, not
    ///      "whenever it happens to be settled" — both the score-time denominator
    ///      and the claim walk must fold to the SAME point or they disagree and
    ///      conservation breaks. 4 rounds gives two rounds of slack over the
    ///      normal settle at `r + 2`; a round still unsettled by then simply
    ///      freezes at its partial `q`, which is the intended graceful
    ///      degradation for slow-cadence streams (design §5) and errs low.
    uint256 internal constant LOY_LAG = 4;

    /// @notice Frozen `q` per (delegate, round) — canonical once written, never
    ///         revised by a late settlement (design §5). Encoded:
    ///         0 = not frozen, else `q·LOY_ONE + 1`. Rounds the delegate never
    ///         predicted in are NOT written: they are identity updates that
    ///         nothing can later settle, so pinning them is pure cost.
    mapping(address => mapping(uint256 => uint256)) internal _frozenQ;
    /// @dev Per-(delegate, round) prediction and win counts feeding `q`. The
    ///      denominator is accumulated in `bumpUnsettled` (which the engine
    ///      already calls once per predict batch), so no cross-contract read is
    ///      needed; the numerator in `scoreCorrectPrediction`.
    mapping(address => mapping(uint256 => uint256)) internal _roundPredictions;
    mapping(address => mapping(uint256 => uint256)) internal _roundWins;

    /// @dev Composed affine map from round 0. `_accumA` is LOY_TWO128-based and
    ///      0 means "uninitialised" (renormalisation keeps it ≥ LOY_RENORM_FLOOR
    ///      thereafter, so 0 is an unambiguous sentinel); `_accumB` is LOY_ONE-based.
    mapping(address => uint256) internal _accumA;
    mapping(address => uint256) internal _accumB;
    /// @dev `K = Σ cᵢ·B_{sᵢ}/A_{sᵢ}`, the second running sum that makes `W`
    ///      derivable rather than stored.
    mapping(address => uint256) internal _accumK;
    /// @dev Cursor — rounds strictly below this have been folded into (A, B).
    mapping(address => uint256) internal _accumRound;
    /// @dev Fixed-shift renormalisation counter (see LOY_RENORM_SHIFT).
    mapping(address => uint32) internal _accumEpoch;
    /// @dev Last round the delegate predicted in. Rounds beyond it are identity
    ///      updates, so the cursor jumps them instead of iterating no-ops.
    mapping(address => uint256) internal _lastPredictedRound;
    /// @dev `K` delta parked alongside `_delegatePoolPending`'s capital delta, so
    ///      the two activate in lockstep and `W`'s basis always matches `C`'s
    ///      (design §13). Flushed by `_flushPool`.
    mapping(address => uint256) internal _delegatePoolPendingK;

    /// @notice `W = Σ cᵢLᵢ` for (delegate, round), SNAPSHOTTED AT PREDICT TIME.
    /// @dev    This must not be recomputed at score time. Scoring happens rounds
    ///         after the predict, and `_loyaltyWeightTotal` reads the LIVE pool —
    ///         so a delegator who left in between would shrink the denominator
    ///         while the claim walk still pays the round's original cohort
    ///         (periods are bounded by startRound/endRound). The rate would be
    ///         scaled by a too-small `W` and the round would OVER-MINT. Pinning
    ///         it at predict time matches the cohort the walk actually pays, and
    ///         mirrors how `delegatedPower` is already snapshotted. 0 means
    ///         "no loyalty-weighted power that round" and evaporates.
    mapping(address => mapping(uint256 => uint256)) internal _roundWeightSnapshot;


    // ------------------------------------------------------------------
    // `admin` IS SPLIT, one level down from the token's governor split.
    //
    // `admin` was a single address holding several unrelated jobs: the
    // on-chain/off-chain dial, capability toggles, game approval, official
    // adapter registration, and appointing the off-chain reporter. That is the
    // same bundling `token.governor` had, and the same argument applies.
    //
    // THE DIAL is carved out: the largest economic lever in the protocol. It
    // decides how much of each round's emission goes to on-chain scoring versus
    // the off-chain Merkle channel, and it also BOUNDS the root publisher, since
    // a published root can only ever pay out of the reserve the dial accrued.
    // (Airdrop loading was the other carve-out until the airdrop moved into its
    // own contract — docs/issues/airdrop-own-contract.md.)
    //
    // Everything else stays with `admin`: capability toggles, game approval,
    // official adapter registration, reporter appointment. Those are denial or
    // noise, not theft, and splitting them further would be ceremony.
    //
    // APPENDED, never inserted — this contract is behind a proxy and its layout
    // is pinned slot-by-slot by scripts/check-storage-layout.js.
    //
    // ZERO MEANS "FALL BACK TO `admin`". A slot that has never been set behaves
    // exactly as it did before the split, so an already-deployed proxy keeps
    // working across the upgrade with no migration step and no window where a
    // job has no holder.
    // ------------------------------------------------------------------

    /// @notice Holds `setOffchainBudget`. Zero ⇒ `admin` holds it.
    address public emissionSplitAuthority;

    /// @dev Pin the round's loyalty-weighted denominator on the delegate's first
    ///      prediction of that round. Shared by both commit paths.
    function _snapshotRoundWeight(address user, uint256 round) internal {
        if (_roundWeightSnapshot[user][round] != 0) return;   // already pinned
        if (round > LOY_LAG) _advanceAccum(user, round - 1 - LOY_LAG);
        uint256 w = _loyaltyWeightTotal(user);
        if (w != 0) _roundWeightSnapshot[user][round] = w;
    }

    /// @notice `L` for delegation period `i` of `user`, LOY_ONE-scaled. Joins the
    ///         existing dumb-getter family (`delegationPeriodAt`, …).
    function delegationLoyaltyAt(address user, uint256 i) external view returns (uint256) {
        return _delegationPeriods[user][i].loyalty;
    }

    /// @dev The (α, β) for `round`, freezing `q` on FIRST CROSSING if it is not
    ///      already frozen. Freezing from whatever has settled at this moment is
    ///      what stops a slow-cadence prediction blocking every later round's
    ///      loyalty update (design §5); late settlements still pay their reward
    ///      delta through the existing OpenRound machinery, they just never
    ///      revise `q`.
    function _loyCoeffs(address delegate, uint256 round) internal returns (uint256 alpha, uint256 beta) {
        uint256 enc = _frozenQ[delegate][round];
        if (enc == 0) {
            uint256 preds = _roundPredictions[delegate][round];
            // A round the delegate never predicted in is an IDENTITY update, and
            // nothing can ever settle to change that — so it needs no pinning.
            // Skipping the SSTORE here is what keeps a long backlog affordable:
            // idle rounds dominate any real one, and pinning them cost ~22k gas
            // EACH on a walk that otherwise does no writes at all.
            if (preds == 0) return (LOY_ONE, 0);
            uint256 wins = _roundWins[delegate][round];
            if (wins > preds) wins = preds;                  // defensive
            enc = (wins * LOY_ONE) / preds + 1;
            _frozenQ[delegate][round] = enc;
        }
        uint256 q = enc - 1;
        // α = d + q(a − d) ∈ [d, a] ⊂ (0, 1); β = q.
        alpha = LOY_D + (q * (LOY_A - LOY_D)) / LOY_ONE;
        beta = q;
    }

    /// @dev Advance (A, B) through `through` inclusive, freezing `q` as it goes.
    ///      Strictly ordered, so every path that needs them at a round calls this
    ///      first; the first caller pays and everyone else free-rides. Rounds
    ///      after the delegate's last prediction are identity, so the cursor jumps
    ///      them rather than iterating.
    function _advanceAccum(address delegate, uint256 through) internal {
        uint256 A = _accumA[delegate];
        if (A == 0) {
            // FIRST TOUCH. Rounds are absolute (timestamp-derived, ~4e4 and
            // climbing), so a zero cursor would try to fold every round since
            // the epoch — tens of thousands of iterations, out of gas. Base the
            // accumulator HERE instead: no delegator existed before this point,
            // and every period's join factor is measured against this same
            // accumulator, so the base round is arbitrary and only differences
            // matter. First touch is always a join — `_splitReward` returns
            // early when there is no inbound delegated power.
            _accumA[delegate] = LOY_TWO128;
            _accumRound[delegate] = through + 1;
            return;
        }
        uint256 r = _accumRound[delegate];
        if (r > through) return;
        uint256 lastPred = _lastPredictedRound[delegate];
        uint256 B = _accumB[delegate];
        while (r <= through && r <= lastPred) {
            (uint256 alpha, uint256 beta) = _loyCoeffs(delegate, r);
            if (alpha != LOY_ONE || beta != 0) {
                A = (A * alpha) / LOY_ONE;
                B = (B * alpha) / LOY_ONE + beta;
                if (A < LOY_RENORM_FLOOR) {
                    A <<= LOY_RENORM_SHIFT;
                    _accumK[delegate] >>= LOY_RENORM_SHIFT;
                    // The PARKED delta has to move with it. It was measured in
                    // the outgoing epoch, so activating it unshifted would fold
                    // in a value 2³² too large — inflating K, shrinking W, and
                    // over-minting the round. Rare (a renorm every ~211 scored
                    // rounds against a one-round activation window) and therefore
                    // exactly the kind of straddle that would survive testing.
                    uint256 pk = _delegatePoolPendingK[delegate];
                    if (pk != 0) _delegatePoolPendingK[delegate] = pk >> LOY_RENORM_SHIFT;
                    unchecked { _accumEpoch[delegate] += 1; }
                }
            }
            unchecked { r++; }
        }
        _accumRound[delegate] = through + 1;   // remaining rounds are identity
        _accumA[delegate] = A;
        _accumB[delegate] = B;
    }

    /// @dev `W = B·C − A·K` — the round denominator, derived rather than stored.
    ///      Clamped at 0: `Σ cᵢLᵢ` is non-negative by construction, so a negative
    ///      difference is pure rounding at the all-loyalty-zero boundary.
    function _loyaltyWeightTotal(address delegate) internal view returns (uint256) {
        uint256 A = _accumA[delegate];
        if (A == 0) A = LOY_TWO128;
        uint256 C = _delegatePowerForRate[delegate];
        uint256 pos = _accumB[delegate] * C;
        uint256 neg = Math.mulDiv(A, _accumK[delegate], LOY_TWO128);
        if (pos <= neg) return 0;
        // NORMALISED BACK TO CAPITAL UNITS. `Σ cᵢLᵢ` carries LOY_ONE, so leaving
        // it in would make the denominator 1e18 larger than the raw delegated
        // power it replaced — and `rate = share × SATORI_RATE_SCALE / W` would
        // lose 18 digits of headroom with it, dropping from ~24 significant
        // digits to ~6 (measured: a 4.4e-7 error against pinned splits). Divide
        // it back out here so the rate keeps exactly the precision it had, and
        // credit sites multiply by `L / LOY_ONE` to match.
        // Σ⌊cᵢLᵢ/LOY_ONE⌋ ≤ ⌊Σ cᵢLᵢ/LOY_ONE⌋, so flooring here stays conservative.
        // CONSERVATION BIAS (design §10). The claim walk derives each `Lᵢ` from
        // its own floor-truncated recursion (`L ← ⌊Lα⌋ + β`), while `W` derives
        // from the accumulator's separately-truncated `B` and `A`. Both are
        // correct to ~1e-18 but they are DIFFERENT computations, so nothing makes
        // `Σ cᵢLᵢ ≤ W` hold automatically — and the invariant-only rail (no
        // runtime payout cap) needs it to. Each recursion's compounded truncation
        // loss is bounded by Σαᵏ = 1/(1−a), so the headroom is DERIVED FROM `a`
        // and must be revisited whenever `a` moves: at a = 0.97 that bound is
        // 33.3 units of `L` per recursion, and the walk and `W` are two separate
        // recursions, so the gap can reach ~67. 128 units per unit of capital
        // clears that with ~2x margin. (At the previous a = 0.9 the bound was 10
        // and 32 sufficed — raising `a` without raising this would have let the
        // invariant fail.) Relative cost ~1e-17 of the pot, i.e. dust; the
        // alternative direction is a hard `BudgetExceeded` revert at the token's
        // cumulative cap.
        return (pos - neg) / LOY_ONE + (C / LOY_ONE) * 128 + 1;
    }

    /// @dev The period's per-unit `K` factor rescaled into the delegate's current
    ///      renormalisation epoch. A pure shift, so it cannot overflow and
    ///      underflows to 0 once the period has aged out — which is the correct
    ///      answer: such a delegator has fully converged to `B_r`.
    function _loyFactorNow(DelegationPeriod storage p, address delegate) internal view returns (uint256) {
        uint256 drift = uint256(_accumEpoch[delegate] - p.joinEpoch) * LOY_RENORM_SHIFT;
        if (drift >= 256) return 0;
        return p.joinFactor >> drift;
    }

    /// Upgrade authority = the token's upgrade authority (same key as the engine).
    /// Compile-time identity — pinned by SatoriUUPS.upgradeTo so only another
    /// SatoriRewards implementation can ever be installed here.
    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriRewards");
    }

    function _upgradeGovernor() internal view override returns (address) {
        return ISatoriUpgradeAuthority(satoriToken).upgradeAuthority();
    }

    // No `_validateNewImplementation` override any more, and removing it was
    // REQUIRED, not optional. It used to compare a candidate implementation's
    // MARKETING_FEE_RECIPIENT() immutable against the live one (phase-2 review,
    // Finding 1). Now that the recipient is proxy STORAGE, calling that getter on
    // the implementation address reads the implementation's own uninitialized
    // storage — address(0) — which would mismatch and revert EVERY upgrade,
    // bricking the proxy's upgrade path permanently.
    //
    // Nothing is lost: the pin existed because immutables travel in bytecode and
    // an upgrade could silently re-point the cut. Storage does not travel in
    // bytecode, so a differently-compiled implementation cannot change it at all.
    // The storage form is the stronger guarantee, and it is self-enforcing rather
    // than depending on each successive implementation to keep re-checking.
}
