// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../libraries/SatoriTypes.sol";
import "../interfaces/IPredictionGame.sol";
import "../interfaces/ISatoriVoting.sol";
import "../interfaces/ISatoriRewards.sol";
import "../interfaces/ISatoriRegistry.sol";
import "../interfaces/ISatoriGames.sol";
import "../interfaces/ISatoriBounties.sol";
import "./interfaces/IEngineDeps.sol";
import "./interfaces/IHubDeps.sol";
import "./SatoriUUPS.sol";
import "../interfaces/ISatoriEngineNamed.sol";

contract SatoriEngine is ISatoriEngineView, ISatoriEngineNamed, SatoriUUPS {

    bool private _initialized;

    // Upgrade-safe reentrancy guard: fresh proxy storage reads 0 (not entered);
    // 2 == entered.
    uint256 private _reentrancyGuard;
    error Reentrancy();
    modifier nonReentrant() {
        if (_reentrancyGuard == 2) revert Reentrancy();
        _reentrancyGuard = 2;
        _;
        _reentrancyGuard = 1;
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    IEngineToken   public token;
    IEngineGateway public hub;

    ISatoriVoting   public satoriVoting;
    ISatoriRewards  public satoriRewards;
    ISatoriRegistry public satoriRegistry;
    ISatoriGames    public satoriGames;
    ISatoriBounties public satoriBounties;

    uint256 public deploymentRound;

    uint8   public constant LANE_PREDICT = 0;
    uint32  public constant DEFAULT_STREAM_ID = 1;

    // ------------------------------------------------------------------
    // Prediction storage
    // ------------------------------------------------------------------

    /// @dev `totalPower` / `locked` are gone. The round denominator is no longer
    ///      a value the engine freezes at the top of a round — it is accumulated
    ///      across the round by SatoriVoting and read back via
    ///      `roundDenominator`. `predictionCount` survives because
    ///      the `roundPredictionCount` view reads it; nothing on chain does.
    struct RoundState {
        uint64  predictionCount;   //  8 bytes — count of predictions (backs the
                                   //  public roundPredictionCount view).
    }
    mapping(uint256 => RoundState) internal _roundState;

    mapping(address => mapping(uint32 => uint256)) public userPredictions;
    mapping(address => mapping(uint256 => uint256)) public predictedStreamsCount;

    /// Flow that others added to a named game's counter in the prediction's hour
    /// before the prediction, per (user, game, slot). The hour's snapshot is the
    /// anchor, so settle adds this back with the predictor's own flow: the question
    /// is whether the network leaned my way AFTER I predicted.
    mapping(address => mapping(uint32 => mapping(uint256 => int232))) internal _flowBefore;

    // ===== Payout-curve redesign: rational S-curve + adaptive dust threshold =====
    // Design: docs/design/payout-curve-redesign.md.
    struct GameStreakState {
        uint16 threshold;   // dust cutoff (streak); the bar is h = max(dustFloor, threshold). Below h a prediction is dust; at/above it earns the real band. 0 = unset → bootstrap to the floor f
        uint40 round;       // last ACTIVE round for this game — drives the lazy per-game controller finalize
    }
    /// @notice Per-game adaptive threshold (dust cutoff / S-curve inflection).
    mapping(uint32 => GameStreakState) public gameStreakState;                 // slot 16
    /// @notice Transient per-(game,round) signed accumulator for the threshold
    ///         controller: Σ perStreamPower·(below ? +(BPS_SCALE−target) : −target).
    ///         Its SIGN at the next active round's finalize is the ±1 nudge; consumed once then deleted.
    mapping(uint32 => mapping(uint256 => int256)) internal _dustSignal;        // slot 17

    // Admin-tunable S-curve dials (all four pack into one slot). Four governor-settable
    // globals shaping the multiplier curve W(streak, h, g, r, b) (design §A) — tunable
    // without a redeploy. Each reads 0 ⇒ its compiled DEFAULT, so a fresh upgrade behaves
    // exactly as the defaults until the governor dials a value. Packed into one slot
    // (4×uint16). The monotonicity invariant r ≥ g is enforced by the setters; g is capped
    // so the curve is inversion-free for every reachable threshold.
    uint16 public dustFloor;        // f: floor of h = max(f, threshold).   0 ⇒ DEFAULT_FLOOR
    uint16 public topGradient;      // g: above-bar gradient.               0 ⇒ DEFAULT_TOP_GRADIENT
    uint16 public bottomGradient;   // r: below-bar (dust) gradient.        0 ⇒ DEFAULT_BOTTOM_GRADIENT
    uint16 public topShift;         // b: flat lift on the above-bar branch (multiplier units). default 0

    /// @notice The dust-threshold controller's SETPOINT in bps — the target share of
    ///         prediction power kept below the bar (§B). Unset ⇒ DEFAULT_DUST_TARGET;
    ///         0 is a legal target, so this consults `dustTargetSet`, not a 0 sentinel.
    /// @dev    APPENDED into slot 18's unused upper bytes (the four dials above occupy
    ///         only 8 of its 32) — it shifts nothing, so the layout guard holds.
    ///
    ///         Deliberately NOT part of `curveConfig()` / `CurveConfigSet`: this is a
    ///         CONTROLLER dial, not a curve dial. It never enters W(s,h,g,r,b) — it only
    ///         decides where the bar settles (design §B2: "the dials g, r, b do not enter
    ///         this decision"). Keeping it separate also leaves the curveConfig() ABI
    ///         untouched for the dapp (satori-ui/src/hooks/useOwner.ts reads cfg[0..3]).
    uint16 public dustTarget;

    /// @notice Whether `dustTarget` has ever been dialled. Read `dustTarget` only through
    ///         `dustTargetBps()`, which consults this.
    /// @dev    This dial CANNOT use the `0 ⇒ compiled default` sentinel the other four use,
    ///         because 0 is a legal, meaningful setting for it: with a 0 target the
    ///         above-bar term vanishes, the signal is never negative, and the bar pins at
    ///         the floor `f` — i.e. "switch the adaptive controller off and fix the bar at
    ///         f". Overloading 0 as the sentinel would make that setting unreachable and,
    ///         worse, silent: `setDustTarget(0)` would read back as the default. So the "has it
    ///         been set" bit is carried explicitly here. Also APPENDED into slot 18.
    bool public dustTargetSet;

    // PACKING (load-bearing): `offchainReporter` shares a slot with the five
    // curve dials and `dustTargetSet` above (11 of 32 bytes used). Moving it
    // next to `curveOperator` would spend a fresh slot.
    /// @notice The one key allowed to add off-chain predictions to the running
    ///         count. Set/rotated by `rewards.admin()`; zero means the feature is
    ///         off and every report reverts.
    address public offchainReporter;

    /// @notice Optional warm key allowed to move the five curve dials. Set by the
    ///         GOVERNOR; zero means only the governor can tune. The dials are
    ///         bounded in the setters, so this key cannot reach a value the
    ///         governor could not.
    address public curveOperator;

    /// @notice Per-game net prediction flow of a named stream: UP adds the
    ///         predictor's `_effectiveRaw` per-game power, DOWN subtracts.
    mapping(uint32 => int232) public namedCounter;

    // Curve + controller constants (storage-neutral — `constant`s never occupy slots).
    // Tunable rational S-curve W(streak, h, g, r, b)·SCALE (design §A), h = max(f, threshold):
    //   streak <  h :  SCALE·h·streak / ((r+1)·(h + r·(h − streak)))                              (convex dust ramp; W(0)=0 for any r)
    //   streak >= h :  SCALE·h·((streak−h)(g²+g+1) + g·h) / ((g+1)(streak + h(g−1))) + b·SCALE     (saturating top)
    // Anchors W(0)=0, W(h)=h/(g+1)+b; asymptote h·(g²+g+1)/(g+1)+b. Monotone when r ≥ g.
    uint256 internal constant CURVE_SCALE = 1_000_000;   // integer precision; cancels in the normalized payout
    int256  internal constant BPS_SCALE   = 10_000;
    /// @dev The multiplier a streak-0 prediction carries. 1 is the SMALLEST non-zero
    ///      value, and the curve's first real rung (streak 1) is ~10,989 at the
    ///      defaults (h=2, r=12) — so a streak-0 win pays about 1/10,989 of a real
    ///      one. Genuinely dust, and never zero. (It was ~1/100,000 while r
    ///      defaulted to 3; raising r to 12 crushed the whole below-bar branch ~9x,
    ///      which pulls the first rung DOWN toward this flat dust, not away from it.)
    ///
    ///      It is a MULTIPLIER, not an addend on the final weight, and that choice is
    ///      load-bearing twice over:
    ///        1. It scales the weight rather than nudging it, so it survives
    ///           `reward = pool x userWeight / totalWeight`. A flat addend on the
    ///           WEIGHT would be swamped and truncate to a zero payout the moment
    ///           any real predictor shared the round. (This used to lean on a
    ///           1e18 WEIGHT_SCALE factor; that factor is gone, but the argument
    ///           holds for the same reason — a ratio needs a proportional term.)
    ///        2. It stays PROPORTIONAL to holdings, so splitting a balance across N
    ///           addresses splits the dust N ways instead of multiplying it. A flat
    ///           per-prediction floor would be sybil-multipliable.
    ///
    ///      Bounties are excluded separately, at the applyBoost call site — the
    ///      multiplier cannot carry that signal, because a non-zero multiplier is
    ///      exactly what makes applyBoost pay out.
    uint256 internal constant DUST_MULTIPLIER = 1;

    // Curve-dial defaults (used when the storage dial reads 0) and governor bounds.
    // f: bar floor + a fresh game's bootstrap. 2, not 4 — a materially softer gate. A pure
    // coin-flipper's streak is geometric, so it clears f=2 about 25% of the time versus
    // 6.25% at f=4. Measured against the simulated field at g=3, r=12, b=0 and target=6667
    // (a target low enough that the FLOOR is what differs, which is the point of the
    // comparison — at the shipped 8541 the controller ranges above both floors), f=2 vs f=4:
    //   converged bar     3      vs 4     — with headroom under it the controller DOES lift
    //   below-bar leak    0.44%  vs 1.05%
    //   lucky-guesser     7.5%   vs 4.3%  — the cost: a softer gate lets more luck through
    //   Gini              0.820  vs 0.858 — the benefit: less concentrated payouts
    // So this trades a wider earning base for more noise in it.
    uint16 internal constant DEFAULT_FLOOR           = 2;
    uint16 internal constant DEFAULT_TOP_GRADIENT    = 3;   // g
    uint16 internal constant DEFAULT_BOTTOM_GRADIENT = 12;  // r — crushes the below-bar dust harder than g=r=3 did
    uint16 internal constant FLOOR_MIN           = 1;
    uint16 internal constant FLOOR_MAX           = 64;
    uint16 internal constant GRADIENT_MIN        = 1;
    uint16 internal constant TOP_GRADIENT_MAX    = 8;      // cap ⇒ curve is inversion-free for all reachable h (with r ≥ g)
    uint16 internal constant BOTTOM_GRADIENT_MAX = 64;
    uint16 internal constant TOP_SHIFT_MAX       = 64;

    // Controller setpoint (§B): target share of power below the bar, in bps.
    //
    // 5000 (50%) — half of prediction power below the bar, so the bar sits at the
    // POWER-WEIGHTED MEDIAN streak. At steady state a predictor of skill p has
    // a GEOMETRIC streak distribution (+1 on a win, reset on a loss), so P(streak >= h) = p^h
    // and the controller's equilibrium bar is h = ln(1 - target)/ln(p). The bar therefore only
    // clears the floor when target > 1 - f^... in practice `target > 1 - p^f`. For a realistic
    // field (power-weighted skill ~0.6) that needs ~8500+; at 3300 the bar sat pinned on the
    // floor in EVERY round, i.e. the adaptive controller never actually ran and `f` was doing
    // all the work. Measured on scripts/sim-payout-curve.js (N=5000, 1500 rounds, floor 4):
    //   target 3300/5000/6700 -> bar on the floor 100% of rounds (inert)
    //   target 8000           -> bar off the floor 47% of rounds, mean 4.49, max 6
    //   target 9000           -> bar off the floor 100% of rounds, mean 7.06
    // WHERE THE KNEE ACTUALLY IS, and why the earlier "~8000" figure was misleading. That
    // number was measured at floor 4; at the shipped floor of 2 the bar leaves the floor at
    // ~6667 on a STATIC field. And the static field is itself the wrong model: it holds
    // every player's power fixed, while on chain prediction power counts unclaimed rewards,
    // so payouts feed straight back into next round's weight and winners COMPOUND.
    //
    // scripts/sim-power-compounding.js adds that feedback. Power-weighted skill drifts
    // 0.617 -> 0.714 over 1500 rounds (flat at 0.617 without it), and the knee moves DOWN:
    //   target   static bar   compounding bar
    //     5000    2 (floor)    2 (floor)
    //     6000    2 (floor)    3
    //     6667    3            4
    //     8000    4            6
    //
    // At the shipped 5000 the bar therefore PARKS ON THE FLOOR under both models — `f` is
    // the real gate at this setting, and the controller only starts ranging past ~6000.
    // That is a deliberate choice rather than a mis-set dial, because compounding does the
    // anti-faucet work by itself: with the bar identical at the floor, the lucky-guesser
    // share falls 11.8% -> 4.7% purely because power migrates toward skill. A harsh bar is
    // not the only tool for that job, and it is the one that costs the most breadth.
    uint16 internal constant DEFAULT_DUST_TARGET = 5_000;  // 50% — the power-weighted median
    // Range [0, 9999]. The cap is the last target for which the control law HAS A FIXED
    // POINT, which is what makes it principled rather than taste:
    //   target < BPS_SCALE — the controller solves P_power(streak >= h) = 1 - target for a
    //           finite h. A real equilibrium exists for every such value.
    //   target = BPS_SCALE — that becomes P_power(streak >= h) = 0, which has NO solution
    //           while anyone holds a streak. The bar never settles; it chases the field's
    //           leader indefinitely. Not a more extreme setting — a different kind of thing.
    //   target > BPS_SCALE — worse still: the below-bar term (BPS_SCALE - target) turns
    //           NEGATIVE, so below-bar predictors push the bar UP too. Nothing opposes it
    //           and it runs away to HDR_STREAK_MASK. (Unreachable given the cap; noted
    //           because it is why the cap can never be relaxed later.)
    // 9999 is also far past any usable setting. h = ln(1 - target)/ln(p) grows only
    // LOGARITHMICALLY in the target: each extra nine buys a constant +ln(10)/(-ln p) of
    // streak (~3.3 at p=0.5, ~22 at p=0.9), and bps can express only four nines. At 9999 a
    // strong field's bar already demands a ~44-day unbroken streak while staying reachable.
    // There is nothing beyond it worth asking for.
    //   0 is allowed at the low end: the above-bar term vanishes, the signal is never
    //   negative, and the bar pins at the floor `f` — "switch the adaptive controller off",
    //   which is exactly what the floor already does in any weak field.
    // Nothing inside the range is clamped: there is no cliff, the mechanism varies
    // continuously across it, and the governor is trusted pre-renounce
    // (docs/issues/closed/curve-dials-first-governor-economic-setter.md).
    // No MIN constant: 0 is the minimum and uint16 cannot go below it.
    uint16 internal constant DUST_TARGET_MAX     = 9_999;  // last target with a finite equilibrium

    // ------------------------------------------------------------------
    // Prediction bit-codec — consensus-critical layout: renumbering re-bases
    // every prediction already on chain.
    // ------------------------------------------------------------------

    uint256 internal constant PR_BITS          = 119;
    uint256 internal constant PR_ELIG_OFFSET   = 2;
    uint256 internal constant PR_SCORED_OFFSET = 3;
    uint256 internal constant PR_MULT_OFFSET   = 4;
    // NARROWED 48 -> 47 to free the top bit of this field for the farming-threshold
    // flag below. Safe, and backward compatible with predictions already on chain:
    // the multiplier cannot exceed ~1.33e11 even with every governor dial at its
    // maximum (h <= HDR_STREAK_MASK, g <= TOP_GRADIENT_MAX, b <= TOP_SHIFT_MAX),
    // which needs 37 bits, so bits 41..51 have ALWAYS been zero in every prediction
    // ever packed. `MultiplierOverflow` enforces the narrower bound for free.
    uint256 internal constant PR_MULT_BITS     = 47;
    /// Was the predictor's TOTAL prediction power at or above the farming
    /// threshold when this prediction was made? Read at settle to decide whether a
    /// correct call may advance the streak (docs/design/farming-threshold.md).
    ///
    /// Captured at PREDICT time, not settle time, for two reasons: settlement is
    /// permissionless, so a settle-time balance read would make the outcome depend
    /// on who calls and when; and total power is only in hand during the batch,
    /// since the packed `raw` is the per-stream SHARE and testing against that
    /// would punish a user for predicting several games at once.
    uint256 internal constant PR_ABOVEFLOOR_OFFSET = 51;
    uint256 internal constant PR_ROUND_OFFSET  = 52;
    // 20-bit HOUR delta (hourMade - deploymentRound*24; phase 6, design 9.4).
    // 2^20 hours ≈ 119 years before wrap. The pool-keying round is derived as
    // hour / 24 — one field, both uses, no extra bits.
    uint256 internal constant PR_ROUND_BITS    = 20;
    uint256 internal constant PR_RAW_OFFSET    = 72;
    uint256 internal constant PR_RAW_BITS      = 47;
    uint256 internal constant PR_RAW_SHIFT     = 40;

    uint256 internal constant PR_MASK       = (uint256(1) << PR_BITS) - 1;
    uint256 internal constant PR_DIR_MASK   = 0x3;
    uint256 internal constant PR_MULT_MASK  = (uint256(1) << PR_MULT_BITS)  - 1;
    uint256 internal constant PR_ROUND_MASK = (uint256(1) << PR_ROUND_BITS) - 1;
    uint256 internal constant PR_RAW_MASK   = (uint256(1) << PR_RAW_BITS)   - 1;

    uint256 internal constant HDR_OFFSET        = PR_BITS * 2;
    uint256 internal constant HDR_STREAK_BITS   = 14;
    uint256 internal constant HDR_STREAK_MASK   = (uint256(1) << HDR_STREAK_BITS) - 1;
    uint256 internal constant HDR_BOOSTED_OFFSET = HDR_OFFSET + HDR_STREAK_BITS;
    /// @dev FREE. Bit 254 held the per-(user,game) "this prediction was made on a
    ///      cadence-1 stream" flag, read at settle to choose the ABC branch. It was
    ///      redundant: stream cadence is immutable, so settle reads it from the
    ///      registry instead and cannot get a different answer. Left unclaimed
    ///      rather than re-packed — see HDR_HASPART_OFFSET below for why.
    /// @dev RESERVED, no longer read or written. This bit held the per-(user,game)
    ///      "has ever predicted" flag that drove the old first-prediction-only dust
    ///      hook; streak-0 dust is now flat for everyone, so nothing needs it. The
    ///      position is kept rather than re-packed because this is consensus-critical
    ///      packed layout — renumbering would re-base every stored prediction.
    uint256 internal constant HDR_HASPART_OFFSET = HDR_OFFSET + HDR_STREAK_BITS + 3;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @dev `hour` is the clock hour (timestamp / 3600) the prediction's 24h
    ///      window opens on, and what a named game's 24h wait counts from.
    ///      `multiplier` is the streak multiplier and `weight` is power x multiplier,
    ///      the amount added to the game's round pool on `direction`'s side.
    event PredictionMade(address indexed predictor, uint32 indexed gameId, uint256 indexed round, uint8 direction, uint256 streak, uint256 predictionPower, uint64 hour, uint256 multiplier, uint256 weight);
    /// @notice A Sentiment game's net flow counter after a prediction moved it.
    ///         It is the stream's live value, so the chart can follow it.
    event NamedCounterMoved(uint32 indexed gameId, int232 value);
    event MultiplePredictionsMade(address indexed user, uint256 indexed round, uint256 count);
    /// @notice A bet on an adapter game was recorded. `bountyStake` is the stake
    ///         snapshotted for the game's active bounty token (0 if none).
    event AdapterPredictionMade(address indexed user, uint32 indexed gameId, uint256 indexed round, uint256 predictionPower, uint256 bountyStake);
    /// @notice An adapter game reported a result for a recorded bet. `finalized`
    ///         is false when no protocol-recorded pending bet was consumed.
    event AdapterPredictionSettled(address indexed user, uint32 indexed gameId, uint256 indexed round, uint256 userScore, uint256 bountyTotal, bool finalized);
    event PredictionScored(address indexed user, uint32 indexed gameId, uint256 indexed round, bool correct, uint256 streak, uint256 scaledWeight);
    event PredictionUnrecoverable(address indexed user, uint32 indexed gameId, uint256 indexed round, bool anchorEvicted);
    event PredictionVoided(address indexed user, uint32 indexed gameId, uint256 indexed round, uint8 direction, int232 stagnantValue);
    /// A live, unsettled prediction was displaced by a newer one on the same game
    /// (audit C-10). Believed unreachable — alarm on it: if it fires, the
    /// settle-before-write invariant has been broken upstream.
    event PredictionDisplaced(address indexed user, uint32 indexed gameId, uint256 indexed round);
    /// The live effective S-curve dials (0 storage resolved to defaults) after any change.
    event CurveConfigSet(uint16 dustFloor, uint16 topGradient, uint16 bottomGradient, uint16 topShift);
    /// The controller setpoint just set — the effective value from here, since a
    /// set marks `dustTargetSet` (0 stays 0, it is NOT resolved to the default).
    event DustTargetSet(uint16 dustTargetBps);
    /// The stored per-game threshold after a round rollover; the bar is max(dustFloor, threshold).
    event StreakThresholdSet(uint32 indexed gameId, uint256 round, uint16 threshold);
    event HubSet(address indexed hub);
    event CurveOperatorSet(address indexed oldOperator, address indexed newOperator);
    event OffchainReporterSet(address indexed oldReporter, address indexed newReporter);
    /// `newRoundCount` includes the round's on-chain predictions (MultiplePredictionsMade).
    event OffchainPredictionsReported(address indexed reporter, uint256 indexed round, uint64 count, uint64 newRoundCount);

    error BadInput();
    error Unauthorized();
    error AlreadySet();
    error BadDirection();
    error UnknownStream();
    error EmptyStream();
    error DuplicatePrediction();
    error StaleValue();
    /// @dev A stream's pull was due and its read failed, so a prediction would anchor on an old value.
    error StreamPullFailed(uint32 streamId);
    error Delegated();
    error AlreadyPredicted();
    error Locked();
    error MultiplierOverflow();
    /// @notice `setOffchainReporter` called by anyone other than `rewards.admin()`.
    error OnlyAdmin();
    /// @notice A curve dial was moved by neither the governor nor the
    ///         `curveOperator`.
    error NotCurveOperator();
    /// @notice `reportOffchainPredictions` called by anyone other than the
    ///         `offchainReporter` key. Also what an UNSET reporter reverts with,
    ///         so the feature is inert until the admin deliberately turns it on.
    error NotOffchainReporter();
    error EmptyBatch();

    // ------------------------------------------------------------------
    // Init / upgrade authority
    // ------------------------------------------------------------------

    /// Locks the implementation instance so only proxies can be initialized.
    constructor() {
        _initialized = true;
    }

    function initialize(
        address _token,
        address _voting,
        address _rewards,
        address _registry,
        address _games,
        address _bounties
    ) external {
        if (_initialized) revert AlreadySet();
        _initialized = true;
        // A wrong upgrade anchor would freeze upgradeTo and renounceUpgrade for good,
        // and a zero child would brick every predict; fail the deploy instead.
        _requireGovernorSource(_token);
        if (_voting == address(0) || _rewards == address(0) || _registry == address(0) || _games == address(0)) revert BadInput();
        token = IEngineToken(_token);
        satoriVoting = ISatoriVoting(_voting);
        satoriRewards = ISatoriRewards(_rewards);
        satoriRegistry = ISatoriRegistry(_registry);
        satoriGames = ISatoriGames(_games);
        satoriBounties = ISatoriBounties(_bounties);
        deploymentRound = IEngineToken(_token).deploymentRound();
        _emitCurveConfig();
        emit DustTargetSet(DEFAULT_DUST_TARGET);
    }

    /// The hub and engine reference each other; the hub is deployed second and
    /// wired here (one-shot). Predicts revert until it is set.
    function setHub(address _hub) external onlyGovernor {
        if (address(hub) != address(0)) revert AlreadySet();
        if (_hub == address(0)) revert BadInput();
        hub = IEngineGateway(_hub);
        emit HubSet(_hub);
    }

    modifier onlyHub() {
        if (msg.sender != address(hub)) revert Unauthorized();
        _;
    }

    /// Governor OR the delegated curve key. The governor never LOSES the power —
    /// delegation here is additive, so a lost/rotated operator key can always be
    /// repaired (and its dials re-set) from the multisig.
    modifier onlyCurveTuner() {
        if (msg.sender != token.appointAuthority() && (curveOperator == address(0) || msg.sender != curveOperator)) {
            revert NotCurveOperator();
        }
        _;
    }

    modifier onlyGovernor() {
        if (msg.sender != token.appointAuthority()) revert Unauthorized();
        _;
    }

    /// Upgrade authority — same key as every other proxy, now via the SHARED
    /// SatoriUUPS block instead of a hand copy, so future hardening cannot skip
    /// the one proxy with no re-point path.
    function _upgradeGovernor() internal view override returns (address) {
        return token.upgradeAuthority();
    }

    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriEngine");
    }

    // ------------------------------------------------------------------
    // Curve configuration — four curve dials (design §A) plus the controller's
    // setpoint (§B/§C). Global; no redeploy. Each stored dial reads 0 ⇒ its compiled
    // default. The monotonicity invariant r ≥ g is enforced by the two gradient
    // setters; b ≥ 0 only ever lifts the top, so it never breaks monotonicity.
    //
    // NOTE (audit C-6 — accepted, operational): these take effect IMMEDIATELY,
    // unlike the protocol's other economic dials. `SatoriRewards.setOffchainShareBps`
    // pins the in-flight round (`_ensureRoundBudget`) before changing, the hub's
    // `setMerkleReserveBps` carries the old share through the current round, and
    // every emission rate change (a step, whatever `setEmissionRatio` set) lands
    // at round cur+1 — the curve dials are the only ones without that treatment. So a mid-round change
    // splits the round: predictors before and after it are priced on different
    // curves while competing in the same pool. It is NOT retroactive — the
    // multiplier is packed into each prediction at predict time and scoring reads
    // that stored value — so no placed bet is ever repriced.
    //
    // Accepted rather than fixed: making these effective-next-round would add a
    // branch to `_curveParams()`, which is read on EVERY prediction, to remove one
    // round of split pricing on a governor-only, rare operation. Treat dial changes
    // as ROUND-BOUNDARY operations instead (see docs/audits/LAUNCH_AUDIT.md).
    // ------------------------------------------------------------------

    /// Effective S-curve dials (f, g, r, b) — a 0 storage dial resolves to its default.
    function _curveParams() internal view returns (uint256 f, uint256 g, uint256 r, uint256 b) {
        f = dustFloor      == 0 ? DEFAULT_FLOOR           : dustFloor;
        g = topGradient    == 0 ? DEFAULT_TOP_GRADIENT    : topGradient;
        r = bottomGradient == 0 ? DEFAULT_BOTTOM_GRADIENT : bottomGradient;
        b = topShift; // 0 = no lift (the default)
    }

    /// The live effective curve dials (f, g, r, b) for lens/UI. 0 storage ⇒ default.
    function curveConfig() external view returns (uint256 f, uint256 g, uint256 r, uint256 b) {
        return _curveParams();
    }

    /// f — the dust-bar floor (and a fresh game's bootstrap). h = max(f, adaptiveThreshold).
    function setDustFloor(uint16 newFloor) external onlyCurveTuner {
        if (newFloor < FLOOR_MIN || newFloor > FLOOR_MAX) revert BadInput();
        dustFloor = newFloor;
        _emitCurveConfig();
    }

    /// g — the above-bar gradient. Capped at TOP_GRADIENT_MAX, and required ≤ r so the
    /// curve stays monotone (a longer streak never earns less) at every threshold.
    function setTopGradient(uint16 newGradient) external onlyCurveTuner {
        if (newGradient < GRADIENT_MIN || newGradient > TOP_GRADIENT_MAX) revert BadInput();
        (, , uint256 r, ) = _curveParams();
        if (newGradient > r) revert BadInput();                 // enforce r ≥ g
        topGradient = newGradient;
        _emitCurveConfig();
    }

    /// r — the below-bar (dust) gradient. Required ≥ g for monotonicity. Higher r flattens
    /// the dust harder.
    function setBottomGradient(uint16 newGradient) external onlyCurveTuner {
        if (newGradient < GRADIENT_MIN || newGradient > BOTTOM_GRADIENT_MAX) revert BadInput();
        (, uint256 g, , ) = _curveParams();
        if (newGradient < g) revert BadInput();                 // enforce r ≥ g
        bottomGradient = newGradient;
        _emitCurveConfig();
    }

    /// b — a flat lift on the above-bar branch (whole multiplier units, added as b·SCALE).
    /// Higher b starves the below-bar dust toward zero after payout normalization.
    function setTopShift(uint16 newShift) external onlyCurveTuner {
        if (newShift > TOP_SHIFT_MAX) revert BadInput();
        topShift = newShift;
        _emitCurveConfig();
    }

    function _emitCurveConfig() private {
        (uint256 f, uint256 g, uint256 r, uint256 b) = _curveParams();
        emit CurveConfigSet(uint16(f), uint16(g), uint16(r), uint16(b));
    }

    /// Effective controller setpoint in bps. Unlike the four curve dials this does NOT use
    /// a 0-storage sentinel — 0 is a legal target — so it consults `dustTargetSet`.
    function _dustTargetBps() internal view returns (int256) {
        return dustTargetSet ? int256(uint256(dustTarget)) : int256(uint256(DEFAULT_DUST_TARGET));
    }

    /// The live effective setpoint (bps of power targeted BELOW the bar) for lens/UI.
    function dustTargetBps() external view returns (uint256) {
        return uint256(_dustTargetBps());
    }

    /// The controller setpoint — the share of prediction power aimed to sit BELOW the bar.
    /// Higher ⇒ a higher, harsher bar (more of the field is dust). 0 is legal and means
    /// "stop adapting upward; pin the bar at the floor `f`". The cap is 9999, the last
    /// target with a finite equilibrium — see the constant's note. Takes effect immediately;
    /// see the mid-round note above — treat it as a ROUND-BOUNDARY operation.
    function setDustTarget(uint16 newTargetBps) external onlyCurveTuner {
        if (newTargetBps > DUST_TARGET_MAX) revert BadInput();
        dustTarget = newTargetBps;
        dustTargetSet = true;
        emit DustTargetSet(newTargetBps);
    }

    // ------------------------------------------------------------------
    // Views the hub facade / lens / UI consume
    // ------------------------------------------------------------------

    /// Game adapters call this on the engine (their `core`): keep it.
    function getCurrentRound() public view returns (uint256) {
        return token.getCurrentRound();
    }
    
    function roundPredictionCount(uint256 round) external view returns (uint256) {
        return uint256(_roundState[round].predictionCount);
    }

    function streaks(address user, uint32 gameId) external view returns (uint256) {
        return uint256(_slotStreak(userPredictions[user][gameId]));
    }

    /// @notice The round whose vote weights govern `round`'s allocation.
    /// @dev Now the identity: a prediction made in round R is paid against R's
    ///      OWN vote weight. The old design governed R by R-1 so votes could not
    ///      be moved mid-round to chase a prediction already placed. Under burn
    ///      voting that lever stays closed by two facts, not one: weight on a
    ///      LIVE game can only ever be added, and the one exception —
    ///      `moveVotes`, off a game whose approval was revoked — is fenced by
    ///      `SourceFrozenThisRound`, so weight already frozen into a round's
    ///      numerator cannot land in a second numerator the same round. With
    ///      the chase closed, same-round governance means a voter's burn takes
    ///      effect immediately instead of a round later.
    ///      Kept as a named function rather than inlined so the concept stays
    ///      greppable and reversible.
    function eligibilityRound(uint256 round) public pure returns (uint256) {
        return round;
    }

    function predictions(address user, uint32 gameId, uint256 round)
        external view returns (SatoriTypes.Prediction memory)
    {
        // A pre-deploy round has no prediction by definition; return empty rather
        // than underflow-reverting on `round - deploymentRound` (audit F62).
        if (round < deploymentRound) return SatoriTypes.Prediction(0, 0, 0, false, false, 0);
        uint256 slot = userPredictions[user][gameId];
        uint256 predA = _predAt(slot, 0);
        uint256 predB = _predAt(slot, 1);
        if (_predDir(predA) != 0 && uint256(_predPoolRound(predA)) == round) return _viewPred(predA);
        if (_predDir(predB) != 0 && uint256(_predPoolRound(predB)) == round) return _viewPred(predB);
        return SatoriTypes.Prediction(0, 0, 0, false, false, 0);
    }

    function getLatestPrediction(address user, uint32 gameId)
        external view returns (SatoriTypes.Prediction memory)
    {
        uint256 slot = userPredictions[user][gameId];
        uint256 predA = _predAt(slot, 0);
        uint256 predB = _predAt(slot, 1);
        bool aPop = _predDir(predA) != 0;
        bool bPop = _predDir(predB) != 0;
        if (!aPop && !bPop) return SatoriTypes.Prediction(0, 0, 0, false, false, 0);
        uint256 pick;
        if (aPop && bPop) pick = _predRoundDelta(predA) >= _predRoundDelta(predB) ? predA : predB;
        else if (aPop) pick = predA;
        else pick = predB;
        return _viewPred(pick);
    }


    // ------------------------------------------------------------------
    // Off-chain prediction reporting
    // ------------------------------------------------------------------

    function setCurveOperator(address who) external onlyGovernor {
        emit CurveOperatorSet(curveOperator, who);
        curveOperator = who;
    }

    function setOffchainReporter(address who) external {
        if (msg.sender != satoriRewards.admin()) revert OnlyAdmin();
        emit OffchainReporterSet(offchainReporter, who);
        offchainReporter = who;
    }

    /// @dev `count` is `uint64`, NOT `uint256`, and that is load-bearing:
    ///      `_bumpPredictionCount` saturates at the uint64 maximum, so no report can
    ///      make a later prediction in the round revert on overflow.
    function reportOffchainPredictions(uint64 count) external {
        if (msg.sender != offchainReporter || offchainReporter == address(0)) {
            revert NotOffchainReporter();
        }
        uint256 round = _currentRound();
        _bumpPredictionCount(round, count);
        emit OffchainPredictionsReported(msg.sender, round, count, _roundState[round].predictionCount);
    }

    // ------------------------------------------------------------------
    // Predict
    // ------------------------------------------------------------------

    function predictMultipleWithPayloads(
        SatoriTypes.PredictionRequestWithPayload[] calldata requests
    ) external nonReentrant {
        _predictMultipleWithPayloads(msg.sender, requests);
    }

    function predictMultipleWithReferral(
        address referrer,
        SatoriTypes.PredictionRequestWithPayload[] calldata requests
    ) external nonReentrant {
        satoriRewards.setReferralFor(msg.sender, referrer);
        _predictMultipleWithPayloads(msg.sender, requests);
    }

    /// @notice Predict as `user`, from the hub's signed relay path
    ///         (docs/design/gasless-relay.md). The hub has already verified the
    ///         user's EIP-712 authorization over these exact requests.
    function predictMultipleFor(
        address user,
        address referrer,
        SatoriTypes.PredictionRequestWithPayload[] calldata requests
    ) external onlyHub nonReentrant {
        if (referrer != address(0)) satoriRewards.setReferralFor(user, referrer);
        _predictMultipleWithPayloads(user, requests);
    }

    function _predictMultipleWithPayloads(
        address user,
        SatoriTypes.PredictionRequestWithPayload[] calldata requests
    ) internal {
        // Deliberately NOT marked as a participant: predicting neither delegates
        // prediction power nor makes the predictor's balance affect anyone else's
        // pool, so the transfer hook (prediction-delegation sync only) has nothing
        // to do for a plain predictor. Only delegating out marks you, in
        // rewards.delegatePredictionPower.
        if (requests.length == 0) revert EmptyBatch();

        address delegate = _predictionDelegate(user);
        if (delegate != address(0)) revert Delegated();

        uint256 round = _currentRound();
        uint256 hourNow = block.timestamp / 3600;

        if (predictedStreamsCount[user][round] != 0) revert AlreadyPredicted();
        if (uint256(token.lockUntil(user, LANE_PREDICT)) > round) revert Locked();

        // NO MINIMUM TO PLAY. A wallet holding nothing may predict, and will earn
        // nothing for it, because reward weight is power x multiplier and its power
        // is zero. It is not refused at the door.
        //
        // This used to `revert ZeroBalance` at exactly zero, on the belief that the
        // check was what prevented free streak farming. It was not: raw power
        // truncates below ~0.0000011 SATORI, so one wei bought a wallet that earned
        // nothing and still built streaks. The gate separated "holds literally
        // nothing" from "holds anything", which is not a line worth defending, and
        // it excluded exactly the people most likely to make the unpaid
        // reputation-building calls the protocol wants (see the F16 note at the
        // settle site). The farming threshold below is the real defence, and it does
        // not need anyone locked out to work.
        uint256 predictionPower = _predictionPower(user);

        // Farming threshold (docs/design/farming-threshold.md). Below it a correct
        // call still pays, it just cannot GROW a streak — so a fleet of dust or
        // empty wallets can no longer manufacture the multiplier for the price of
        // gas. Computed ONCE per batch from TOTAL power: the per-stream share is
        // total power divided across the batch's eligible games, so testing against
        // that would punish a user for predicting several games at once.
        bool aboveFloor = predictionPower >= hub.farmingThreshold();

        hub.engineLock(user, uint24(round + 1));
        predictedStreamsCount[user][round] = requests.length;

        uint32[] memory streamIds = new uint32[](requests.length);
        bool[]   memory eligibleFlags = new bool[](requests.length);
        // GAS (review #20): gameDispatch answers (impl, streamId) in one call
        // and a game's dispatch is immutable after createGame (typeIds are
        // auto-incremented, never re-pointed), so cache impl here instead of
        // re-calling gameDispatch per game in the execution loop below.
        address[] memory impls = new address[](requests.length);

        // Pass 1 — resolve each game's (impl, stream) and reject in-batch
        // duplicates, so the whole batch's stream ids are known before anchoring.
        for (uint256 i = 0; i < requests.length; i++) {
            uint32 gameId = requests[i].gameId;
            if (requests[i].payload.length == 0) revert BadDirection();

            (address impl, uint32 streamId) = satoriGames.gameDispatch(gameId);
            if (streamId == 0) revert UnknownStream();
            streamIds[i] = streamId;
            impls[i] = impl;

            for (uint256 j = 0; j < i; j++) {
                if (requests[j].gameId == gameId) revert DuplicatePrediction();
            }
        }

        // PREDICTING PULLS A FRESH VALUE FIRST, where each stream's cadence allows
        // it. The rolling-24h scoring model assumes the anchor is pulled at predict
        // time (rolling-24h-scoring.md §2 — the displacement/settle guarantees rest
        // on it), so this is not a nicety: without it a prediction anchors on a
        // stale stored value. The pull ticks every predicted PULL stream whose
        // cadence has elapsed and skips the rest (not due, or not a pull stream).
        // A stream whose pull was due but whose read failed reverts the batch
        // (`StreamPullFailed`) instead of letting the prediction anchor on an old
        // value, whatever made the read fail, out of gas included (M20). The
        // predictor who triggers a due pull pays its gas; that is the intended
        // incentive (LAUNCH_AUDIT C-12).
        uint32 failedStream = satoriRegistry.updateValuesStrict(streamIds);
        if (failedStream != 0) revert StreamPullFailed(failedStream);

        // Pass 2 — anchor freshness / moment-clock / stale checks, now reading the
        // values Pass 1's pull just refreshed.
        bool[] memory named = new bool[](requests.length);
        int232[] memory snapshot = new int232[](requests.length);
        for (uint256 i = 0; i < requests.length; i++) {
            uint32 gameId = requests[i].gameId;
            (uint16 vCount, uint64 streamLastHour, , , bool streamNamed, int232 latestValue)
                = satoriRegistry.getLatestUpdateInfo(streamIds[i]);
            if (vCount == 0) revert EmptyStream();
            named[i] = impls[i] == address(0) && streamNamed;
            snapshot[i] = latestValue;

            // Once per round for every game; targets beyond one round also wait
            // the full target, so a weekly game takes one prediction a week and
            // the two-slot layout keeps holding (design 7.4).
            uint64 lastPredHour = _latestPredHour(userPredictions[user][gameId]);
            if (lastPredHour > 0) {
                if (lastPredHour / 24 == round) revert DuplicatePrediction();
                uint24 tgt = satoriGames.targetMinutes(gameId);
                if (tgt > 1440 && hourNow < uint256(lastPredHour) + uint256(tgt) / 60) revert DuplicatePrediction();
                if (streamLastHour <= lastPredHour) revert StaleValue();
            }
            // PredictExpired is DELETED (design 9.6): predictions anchor to
            // their own moment, so any moment works. StaleValue above is the
            // rule that remains — no new value, no new prediction.
        }

        uint256 streamCount = requests.length;
        uint256 eligibleCount = 0;
        for (uint256 i = 0; i < streamCount; i++) {
            uint32 g = requests[i].gameId;
            // Eligibility is the game's LIVE weight, not whether it happens to
            // have been recorded for this round yet. Reading the round record
            // here would make the FIRST predictor of a game each round see 0,
            // earn nothing, and pay the SSTORE that makes everyone after them
            // eligible — a game with a single predictor would never pay at all.
            // Live weight is also what the burn model means: any game carrying
            // burnt weight is eligible right now.
            bool elig = satoriVoting.weightOf(g) != 0;
            eligibleFlags[i] = elig;
            if (elig) { unchecked { ++eligibleCount; } }
        }
        uint256 perStreamPower = eligibleCount > 0 ? predictionPower / eligibleCount : 0;

        satoriRewards.bumpUnsettled(user, round, streamCount);

        for (uint256 i = 0; i < streamCount; i++) {
            uint32 gameId = requests[i].gameId;
            bytes calldata payload = requests[i].payload;
            uint8  dir = uint8(payload[0]);
            uint256 thisPower = eligibleFlags[i] ? perStreamPower : 0;
            address impl = impls[i];
            _recordVotes(gameId, round);
            if (impl == address(0)) {
                _scorePreviousPrediction(user, gameId, round);
                uint256 slotIdx = _makePrediction(user, gameId, dir, round, hourNow, thisPower, eligibleFlags[i], aboveFloor);
                // After _makePrediction (it validates `dir`), and after the
                // batch's updateValues above, so this hour's snapshot never
                // holds this flow. _effectiveRaw keeps it bit-identical to the
                // `_predRaw(pred)` that settle adds back to the anchor.
                if (named[i]) {
                    // What others added since the hour's snapshot is also not in
                    // the anchor; settle adds it back so only flow AFTER this
                    // prediction counts for or against it.
                    _flowBefore[user][gameId][slotIdx] = namedCounter[gameId] - snapshot[i];
                    int232 flow = int232(int256(_effectiveRaw(thisPower)));
                    namedCounter[gameId] += (dir == 1) ? flow : -flow;
                    emit NamedCounterMoved(gameId, namedCounter[gameId]);
                }
            } else {
                _scoreAdapterPrediction(user, gameId, impl);
                uint256 bStake = (address(satoriBounties) != address(0))
                    ? satoriBounties.snapshotAdapterStake(user, gameId, round) : 0;
                // Adapter games earn no SATORI, so `thisPower` — the
                // apportioned SATORI weight — is always 0 for them and would be
                // a worthless argument. Hand the adapter the user's UNDIVIDED
                // prediction power instead: the protocol's canonical measure of
                // how much stake this predictor has. Undivided because the
                // `/ eligibleCount` split exists solely to apportion SATORI
                // across a batch, and there is no SATORI here to apportion —
                // dividing would just make the figure wobble with how many
                // OTHER games the user happened to predict alongside this one.
                // The engine already has it in memory, so passing it is free;
                // making every adapter staticcall back for it would not be.
                IPredictionGame(impl).record(user, gameId, predictionPower, bStake, payload);
                satoriRewards.recordAdapterPrediction(user, gameId, round, bStake > 0);
                emit AdapterPredictionMade(user, gameId, round, predictionPower, bStake);
            }
        }

        emit MultiplePredictionsMade(user, round, requests.length);

        _bumpPredictionCount(round, requests.length);
    }

    function _makePrediction(
        address user,
        uint32 gameId,
        uint8 direction,
        uint256 round,
        uint256 hourNow,
        uint256 perStreamPower,
        bool eligible,
        bool aboveFloor
    ) internal returns (uint256 idx) {
        if (direction != 1 && direction != 2) revert BadDirection();

        uint256 slot = userPredictions[user][gameId];

        uint256 streak = uint256(_slotStreak(slot));

        // ---- Adaptive threshold (design: docs/design/payout-curve-redesign.md) ----
        // Lazily finalize the LAST active round's controller signal for this game on the
        // FIRST prediction of a new active round (exactly once per game per round; the SLOAD
        // is shared with the threshold read, so no extra hot-path cost).
        (uint256 f, uint256 g, uint256 r, uint256 b) = _curveParams();   // effective S-curve dials
        GameStreakState memory gs = gameStreakState[gameId];
        uint256 threshold = gs.threshold < f ? f : uint256(gs.threshold);   // h = max(f, adaptive threshold)
        if (gs.round != round) {
            int256 sig = _dustSignal[gameId][gs.round];
            if (sig > 0) { if (threshold > f) threshold -= 1; }                        // dusting too many → lower the bar
            else if (sig < 0) { if (threshold < HDR_STREAK_MASK) threshold += 1; }     // dusting too few  → raise the bar
            if (gs.round != 0) delete _dustSignal[gameId][gs.round];                   // consume + prune
            gameStreakState[gameId] = GameStreakState(uint16(threshold), uint40(round));
            emit StreakThresholdSet(gameId, round, uint16(threshold));
        }
        bool belowThreshold = streak < threshold;

        // ---- Streak → multiplier: the tunable rational S-curve W(streak, h, g, r, b)·SCALE,
        //      with h = threshold (the floored adaptive bar / inflection), and the governor
        //      dials g (above-bar gradient), r (below-bar gradient), b (above-bar lift). Cheap
        //      (mul/div, no sqrt): dust below the bar (convex ramp, W(0)=0), a rise just above,
        //      then a saturating top toward h·(g²+g+1)/(g+1)+b. The streak-0 hook is kept. ----
        // Streak 0 pays DUST — the smallest non-zero multiplier, ~1/7,692 of the
        // curve's first real rung at the defaults, so a win always pays something
        // without ever being worth farming (audit C-2).
        uint256 multiplier = (streak == 0)
            ? DUST_MULTIPLIER
            : _streakWeight(streak, threshold, g, r, b);                      // W(streak, h, g, r, b)·CURVE_SCALE
        if (multiplier > PR_MULT_MASK) revert MultiplierOverflow();

        // ---- Feed the threshold controller (one signed accumulator per game/round) ----
        // Same power-weighted `belowThreshold` decision; the SIGN of the round total is the
        // ±1 nudge finalized at the next active round. Ineligible predictions carry
        // perStreamPower == 0, so they never move the (power-weighted) bar.
        int256 target = _dustTargetBps();
        _dustSignal[gameId][round] += int256(perStreamPower) *
            (belowThreshold ? (BPS_SCALE - target) : -target);

        {
            uint256 predA = _predAt(slot, 0);
            uint256 predB = _predAt(slot, 1);
            bool aEmpty = (_predDir(predA) == 0);
            bool bEmpty = (_predDir(predB) == 0);
            if      (aEmpty)             idx = 0;
            else if (bEmpty)             idx = 1;
            else if (_predScored(predA)) idx = 0;
            else if (_predScored(predB)) idx = 1;
            else {
                // Both slots hold LIVE, unsettled predictions, so the write below
                // DISPLACES one. The new prediction still lands normally — this
                // branch only chooses the slot — but the displaced bet must be
                // FINALIZED or its `_unsettledPredictionCount` is stranded forever
                // (audit C-10). That counter is the delegator walk's round-closed
                // test, so a stuck one pins an `openRounds` entry that can never
                // pop and silently eats the budgeted replay (audit F6) on every
                // future claim by every inbound delegator — a slow, invisible
                // degradation with no trail back to here.
                //
                // Reachable on a daily game over an hourly non-named stream that
                // goes quiet (predict late in R, early in R+1, again in R+2): the
                // older bet is dropped unscored and the streak kept (M22, reverted
                // by the owner).
                idx = (_predRoundDelta(predA) <= _predRoundDelta(predB)) ? 0 : 1;
                uint256 displaced = (idx == 0) ? predA : predB;
                _forfeitBounty(user, gameId, uint256(_predPoolRound(displaced)), _boostedAt(slot, idx));
                _notifyFinalized(user, uint256(_predPoolRound(displaced)), _boostedAt(slot, idx));
                emit PredictionDisplaced(user, gameId, uint256(_predPoolRound(displaced)));
            }
        }

        uint256 packedPred = _packPred(direction, eligible, multiplier, uint64(hourNow), perStreamPower, aboveFloor);
        slot = _writePredAt(slot, idx, packedPred);

        // Streak 0 takes NO bounty (audit C-2). Bounty tokens are assets depositors
        // put in, so they only ever pay a real streak — and unlike the SATORI side,
        // the multiplier CANCELS in the bounty share (`pot x userBoost / totalBoost`),
        // so a lone streak-0 winner would otherwise take an entire round's drip
        // rather than dust. Passing 0 makes applyBoost early-return: no snapshot, no
        // boosted bit, no payout.
        bool boosted = satoriBounties.applyBoost(
            user, gameId, round, uint96(direction), streak == 0 ? 0 : multiplier
        );
        slot = _withBoosted(slot, idx, boosted);

        userPredictions[user][gameId] = slot;

        uint256 effectiveRaw = _effectiveRaw(perStreamPower);
        uint256 scaledWeight = _deriveWeight(effectiveRaw, multiplier);

        satoriRewards.scorePrediction(user, gameId, round, direction, scaledWeight);

        emit PredictionMade(user, gameId, round, direction, streak, perStreamPower, uint64(hourNow), multiplier, scaledWeight);
    }

    /// @dev No first-predictor bonus: the denominator accumulates per game,
    ///      so the round's first predictor does nothing more than any other
    ///      predictor and there is nothing to compensate.
    function _bumpPredictionCount(uint256 round, uint256 count) internal {
        if (count == 0) return;
        uint256 sum = uint256(_roundState[round].predictionCount) + count;
        _roundState[round].predictionCount = sum > type(uint64).max ? type(uint64).max : uint64(sum);
    }

    /// @dev A prediction's weight is simply `power x multiplier`. There is no
    ///      normalisation here, deliberately.
    ///
    ///      This used to return `power x multiplier x WEIGHT_SCALE / totalVotes`.
    ///      That factor was a NO-OP: the value is only ever used as a share of
    ///      `totalWeightPacked[game][round]`, which is the sum of the same
    ///      expression over every predictor, so a factor common to all of them
    ///      cancelled exactly. It was harmless while the round total was locked
    ///      up front — but the total is now accumulated across the round, so the
    ///      predict-time call and the settle-time re-derivation would divide by
    ///      DIFFERENT numbers, the per-game bucket would be inflated by early
    ///      predictors, and every game would systematically under-pay its pot.
    ///
    ///      A game's actual share of the round budget is a separate calculation
    ///      (`SatoriRewards._gameRoundAllocation`, against the final denominator
    ///      from `roundDenominator`). Dropping the division here also removes the
    ///      overflow hazard that forced the uint128-half bound checks, since the
    ///      value no longer carries a 1e18 scale factor.
    function _deriveWeight(uint256 perStreamPower, uint256 multiplier) private pure returns (uint256) {
        return perStreamPower * multiplier;
    }

    /// @notice The tunable rational S-curve W(streak, h, g, r, b) · CURVE_SCALE (design §A).
    ///         h = max(dustFloor, adaptiveThreshold) is the bar (inflection); g/r the
    ///         above/below-bar gradients; b a flat lift on the above-bar branch. Two
    ///         all-positive branches — cheap, a couple of mul/div, no sqrt:
    ///           s <  h :  SCALE·h·s / ((r+1)·(h + r·(h − s)))                               (convex dust ramp)
    ///           s >= h :  SCALE·h·((s−h)(g²+g+1) + g·h) / ((g+1)(s + h(g−1))) + b·SCALE      (saturating top)
    ///         Anchors W(0)=0 (any r) and W(h)=h/(g+1)+b; asymptote h·(g²+g+1)/(g+1)+b. Both
    ///         denominators are > 0 for reachable s,h,g,r (s<h ⇒ h+r(h−s) ≥ h+r > 0; s≥h,g≥1 ⇒
    ///         s+h(g−1) ≥ h > 0). With the setters' r ≥ g and g ≤ 8 the curve is monotone and
    ///         inversion-free for every h, and the max value·SCALE stays far under 2⁴⁸ (the
    ///         call site keeps the PR_MULT overflow guard as a backstop). Called for
    ///         streak 0 too: the s < h branch yields 0 over a strictly positive
    ///         denominator, which is the wanted "no curve reward at streak 0".
    function _streakWeight(uint256 s, uint256 h, uint256 g, uint256 r, uint256 b) private pure returns (uint256) {
        if (s < h) {
            return (CURVE_SCALE * h * s) / ((r + 1) * (h + r * (h - s)));
        }
        return (CURVE_SCALE * h * ((s - h) * (g * g + g + 1) + g * h)) / ((g + 1) * (s + h * (g - 1)))
             + b * CURVE_SCALE;
    }

    /// @notice A named stream's value: the counter of its one binary game
    ///         (SatoriGames refuses a second game on a named stream).
    function namedStreamValue(uint32 streamId) external view returns (int232) {
        return namedCounter[satoriGames.binaryGameByStream(streamId)];
    }

    // ------------------------------------------------------------------
    // Settle / score
    // ------------------------------------------------------------------

    function settlePrediction(address user, uint32 gameId) external nonReentrant {
        (address impl, uint32 streamId) = satoriGames.gameDispatch(gameId);
        if (streamId == 0) return;
        if (impl == address(0)) {
            uint256 nowRound = _currentRound();
            for (uint256 i = 0; i < 2; i++) _scorePreviousPrediction(user, gameId, nowRound);
            return;
        }
        _scoreAdapterPrediction(user, gameId, impl);
    }

    function _scoreAdapterPrediction(
        address user,
        uint32 gameId,
        address impl
    ) private {
        // AUDIT B-1. The adapter is UNTRUSTED and permissionlessly registered
        // (SatoriHub.registerCommunityGameAdapter). docs/narratives/A_game_adapters.md
        // requires that `score` never revert and signal "pending" with
        // scored=false — but a rule cannot bind code we do not control, and this
        // used to be a plain external call. Any revert therefore jammed
        // settlePrediction FOREVER: the bet could never finalize, so the victim's
        // _unsettledPredictionCount stayed non-zero permanently, and for a
        // delegate that left an openRounds entry that could never be popped,
        // taxing every delegator's future claim.
        //
        // So make the call raw and treat a failed call or a short buffer as the
        // pending signal the narrative already defines. The decode below is
        // strict, though: a bool word other than 0/1, or a roundIndex above
        // uint64, makes `abi.decode` revert and that revert is not caught here.
        (bool ok, bytes memory ret) =
            impl.call(abi.encodeCall(IPredictionGame.score, (user, gameId)));
        if (!ok || ret.length < 192) return;
        // `multiplier` and `total` are decoded past, not into locals: they were
        // the mint denominator's inputs, and adapter games have no mint lane
        // (removed 2026-08-23 — see SatoriRewards.scoreAdapterPrediction). The
        // adapter's score() still RETURNS them; IPredictionGame is an untrusted
        // external contract's shape and is unchanged.
        (bool resolved, uint256 userScore, , , uint256 bountyTotal, uint64 roundIdx) =
            abi.decode(ret, (bool, uint256, uint256, uint256, uint256, uint64));
        if (!resolved) return;
        if (_currentRound() <= uint256(roundIdx)) return;
        (bool finalized, bool wasBoosted) = satoriRewards.scoreAdapterPrediction(
            user, gameId, uint256(roundIdx), userScore, bountyTotal
        );
        // Decrement the shared unsettled counter ONLY when a real protocol-
        // recorded pending bet was consumed. An untrusted adapter's score() can
        // report "resolved" for a round the user never bet on this game;
        // finalizing that phantom would strand the victim's shared per-(user,
        // round) counter and permanently brick their other predictions (F1).
        emit AdapterPredictionSettled(user, gameId, uint256(roundIdx), userScore, bountyTotal, finalized);
        if (finalized) _notifyFinalized(user, uint256(roundIdx), wasBoosted);
    }

    function _scorePreviousPrediction(address user, uint32 gameId, uint256 nowRound) internal {
        uint256 slot = userPredictions[user][gameId];

        uint256 predA = _predAt(slot, 0);
        uint256 predB = _predAt(slot, 1);
        bool aUnscored = (_predDir(predA) != 0) && !_predScored(predA);
        bool bUnscored = (_predDir(predB) != 0) && !_predScored(predB);
        if (!aUnscored && !bUnscored) return;

        uint256 idx;
        uint256 pred;
        if (aUnscored && bUnscored) {
            if (_predRoundDelta(predA) <= _predRoundDelta(predB)) { idx = 0; pred = predA; }
            else                                                  { idx = 1; pred = predB; }
        } else if (aUnscored) { idx = 0; pred = predA; }
          else                { idx = 1; pred = predB; }

        uint64  predHour   = _predHour(pred);
        uint64  predRound  = uint64(uint256(predHour) / 24); // pool keying (design 9.4)
        // Pending until its round ends, like adapter games (_scoreAdapterPrediction).
        // Until then the round's bounty boost total (SatoriBounties.applyBoost) and
        // weight totals still grow, and a share scored against a partial total overpays.
        if (uint256(predRound) >= nowRound) return;
        uint8   dir        = _predDir(pred);
        uint32  streamId   = satoriGames.dataStreamId(gameId);
        bool    wasBoosted = _boostedAt(slot, idx);
        // The scoring bands (question 4, decided by the owner), derived live
        // from the stream's cadence and the game's target — nothing stored,
        // nothing to drift (cadence and target are both immutable):
        //   ABC     cadence within one round AND target < 24 x cadence —
        //           anchor and target are the first TWO samples after the
        //           prediction (zero observable slice; horizon starts up to
        //           one cadence late).
        //   plain   everything else — anchored to the predictor's own hour;
        //           the target is the first sample at least the game's target
        //           (less the fixed 30-minute allowance) after it. UNIFORM
        //           across fine and coarse cadences (owner, 2026-09-08): a
        //           next-sample rule for coarse streams was briefly shipped
        //           and reverted — without PredictExpired it allowed a
        //           prediction placed just before a scheduled post to score
        //           minutes later, the horizon-compression exploit the target
        //           rule exists to kill. Since target >= cadence always, an
        //           early-in-period prediction on a coarse stream still
        //           settles on the very next sample; only late-in-period
        //           (compressing) predictions get pushed to the one after.
        (uint24 cadMinutes, bool named) = satoriRegistry.streamScoringInfo(streamId);
        uint256 cadSeconds = uint256(cadMinutes) * 60;
        uint256 tgtMinutes = uint256(satoriGames.targetMinutes(gameId));

        int232 anchor; int232 post; bool found; bool anchorEvicted;
        if (cadSeconds <= SatoriTypes.TIME_UNIT_SECONDS && tgtMinutes < 24 * (cadSeconds / 60)) {
            // ABC.
            (anchor, post, found, anchorEvicted) =
                satoriRegistry.getFirstTwoValuesAfter(streamId, uint256(predHour));
        } else {
            // Moment-anchored: wait ceil((target*60 - 1800) / 3600) hours —
            // the stored target is the ADVERTISED duration, the 30-minute
            // allowance applied here (design section 4).
            uint256 waitHours = (tgtMinutes * 60 - 1800 + 3599) / 3600;
            (anchor, post, found, anchorEvicted) = satoriRegistry.getAnchorFirstAfter(
                streamId, uint256(predHour), uint256(predHour) + waitHours - 1);
        }

        if (!found) {
            if (!anchorEvicted) return;
            slot = _markPredScored(slot, idx);
            // NOTE (audit C-3 — accepted, working-as-intended): an unscoreable
            // prediction ZEROES the streak, while a VOID (anchor == post, a few
            // lines below) LEAVES IT ALONE. That asymmetry looks unfair — both are
            // outcomes the user did not cause — and it is deliberate. Do NOT
            // "fix" it by preserving the streak here.
            //
            // Preserving it would create STREAK INSURANCE. A user who predicts,
            // then realises they are going to be WRONG, could simply stall: never
            // predict on this game again (predicting is what triggers settlement),
            // wait out the 768-slot history ring, and the losing prediction
            // evaporates with the streak intact. They would keep predicting every
            // OTHER game meanwhile, so the only cost is idling one stream for ~32
            // days at hourly cadence — cheap next to a streak whose curve saturates
            // around 13x. Zeroing here makes stalling never better than taking the
            // loss.
            //
            // The cost of the rule is that an honestly-absent user loses a streak
            // they did nothing wrong to earn back. That exposure is a function of
            // how promptly predictions get settled (settlement is permissionless —
            // anyone may call `settlePrediction`), so the lever is a keeper or a
            // dapp nudge, NOT weakening this branch.
            slot = _withStreak(slot, 0);
            userPredictions[user][gameId] = slot;
            _forfeitBounty(user, gameId, uint256(predRound), wasBoosted);
            _notifyFinalized(user, uint256(predRound), wasBoosted);
            emit PredictionUnrecoverable(user, gameId, predRound, anchorEvicted);
            return;
        }

        slot = _markPredScored(slot, idx);

        if (named) {
            // The anchor was snapshotted BEFORE this prediction's own flow landed
            // in the counter; add it back so the question is "did the REST of the
            // network lean my way". Must precede the void check below: with it
            // after, a lone predictor (post == anchor + own) scores a LOSS instead
            // of the void.
            int232 own = int232(int256(_predRaw(pred)));
            anchor = (dir == 1) ? anchor + own : anchor - own;
            // And the flow others added in the prediction's hour before it.
            anchor += _flowBefore[user][gameId][idx];
            delete _flowBefore[user][gameId][idx];
        }

        if (anchor == post) {
            userPredictions[user][gameId] = slot;
            _forfeitBounty(user, gameId, uint256(predRound), wasBoosted);
            _notifyFinalized(user, uint256(predRound), wasBoosted);
            emit PredictionVoided(user, gameId, predRound, dir, anchor);
            return;
        }

        bool correct = (dir == 1) ? (post > anchor) : (post < anchor);
        uint256 scaledWeight = 0;

        if (correct) {
            // NOTE (audit F16 — accepted, working-as-intended): the streak advances
            // on ANY correct prediction, DELIBERATELY without gating on the
            // prediction's power or the stream's eligibility. A streak is a
            // REPUTATION signal, not a stake receipt. Predicting an ineligible
            // (non-paying) stream carries zero reward power by construction (the
            // predict path sets `thisPower = eligible ? perStreamPower : 0`), yet a
            // correct call there must still build reputation — that reputational
            // incentive is precisely how the protocol sources predictions on streams
            // that don't yet pay. Do NOT add a power/eligibility gate here — it would
            // kill ineligible-stream sourcing for no real anti-abuse gain.
            //
            // UPDATED 2026-08-17: this note used to close by saying sybil-farming was
            // impossible upstream because `revert ZeroBalance` refused a zero-power
            // predictor. That was never true — one wei walked past it — and the gate
            // is now gone, so anyone may predict. What actually stops the farm is the
            // threshold test immediately below, which is a different question
            // (the PREDICTOR's total power) from the two this note refuses to gate on
            // (this PREDICTION's power, and the STREAM's eligibility). Both remain
            // ungated, exactly as F16 requires.
            // FARMING THRESHOLD (docs/design/farming-threshold.md). A predictor who
            // was below the threshold when this prediction was made still gets paid
            // for being right, but does not GROW the streak. They do not lose the
            // one they have — only the increment stops.
            //
            // This is what F16 above could not do on its own. F16 correctly refuses
            // to gate on the prediction's POWER or the stream's ELIGIBILITY, since
            // both are zero for a correct call on a non-paying stream and that call
            // must still build reputation. The flag read here is neither: it is a
            // predict-time snapshot of the predictor's TOTAL power against the
            // threshold, so ineligible-stream sourcing is untouched and only the
            // dust fleet is stopped.
            if (_predAboveFloor(pred)) {
                uint256 newStreak = uint256(_slotStreak(slot)) + 1;
                if (newStreak > HDR_STREAK_MASK) newStreak = HDR_STREAK_MASK;
                slot = _withStreak(slot, newStreak);
            }
            userPredictions[user][gameId] = slot;

            uint256 rawPower = _predRaw(pred);
            scaledWeight = _deriveWeight(rawPower, _predMult(pred));
            satoriRewards.scoreCorrectPrediction(user, gameId, uint256(predRound), dir, scaledWeight, wasBoosted, named);
        } else {
            slot = _withStreak(slot, 0);
            userPredictions[user][gameId] = slot;
            _forfeitBounty(user, gameId, uint256(predRound), wasBoosted);
        }

        _notifyFinalized(user, uint256(predRound), wasBoosted);
        emit PredictionScored(user, gameId, uint256(predRound), correct, uint256(_slotStreak(slot)), scaledWeight);
    }

    // ------------------------------------------------------------------
    // Child-call thin wrappers
    // ------------------------------------------------------------------

    function _currentRound() internal view returns (uint256) {
        return token.getCurrentRound();
    }

    function _predictionDelegate(address user) internal view returns (address) {
        (address d, ) = satoriRewards.predictionDelegateInfo(user);
        return d;
    }

    function _predictionPower(address user) internal view returns (uint256) {
        return satoriRewards.getPredictionPower(user);
    }

    function _recordVotes(uint32 gameId, uint256 round) internal {
        satoriVoting.recordGameVotesForRound(gameId, round);
    }


    /// A boosted prediction that finalizes without a win gives its share of the
    /// round's bounty pot back to the pool at once (M26). Wins are paid by
    /// `scoreCorrectPrediction`. Must run before `_notifyFinalized`, which can
    /// clear the user's boosted set.
    function _forfeitBounty(address user, uint32 gameId, uint256 round, bool wasBoosted) internal {
        if (wasBoosted) satoriBounties.releaseForfeit(user, gameId, uint32(round));
    }

    function _notifyFinalized(address user, uint256 roundMade, bool wasBoosted) internal {
        satoriRewards.notifyPredictionFinalized(user, roundMade, wasBoosted);
    }

    // ------------------------------------------------------------------
    // Prediction bit-codec helpers (verbatim from SatoriState)
    // ------------------------------------------------------------------

    function _packPred(uint8 dir, bool elig, uint256 mult, uint64 hourMade, uint256 rawPower, bool aboveFloor)
        internal view returns (uint256 p)
    {
        // NOTE (audit C-5): raw power is COMPRESSED to fit the packed slot, and both
        // steps lose information SILENTLY — no revert, no event. Read `_predRaw` as
        // approximate, never exact.
        //   * the low PR_RAW_SHIFT (40) bits are dropped, so power is rounded DOWN
        //     to the nearest ~1.1e-6 SATORI — dust;
        //   * anything above (2^47-1) << 40 ~= 1.547e26 wei (~154.7M SATORI) is
        //     CLAMPED. At 525,600 SATORI/year of emission that threshold is ~year
        //     294, and only if a single address held the entire supply — so it is
        //     unreachable, but it is a cap on a money quantity with no alarm.
        uint256 scaled = rawPower >> PR_RAW_SHIFT;
        if (scaled > PR_RAW_MASK) scaled = PR_RAW_MASK;
        p = uint256(dir) & PR_DIR_MASK;
        if (elig) p |= (uint256(1) << PR_ELIG_OFFSET);
        p |= (mult & PR_MULT_MASK) << PR_MULT_OFFSET;
        if (aboveFloor) p |= (uint256(1) << PR_ABOVEFLOOR_OFFSET);
        p |= ((uint256(hourMade) - deploymentRound * 24) & PR_ROUND_MASK) << PR_ROUND_OFFSET;
        p |= scaled << PR_RAW_OFFSET;
    }

    function _predAt(uint256 slot, uint256 idx) internal pure returns (uint256) {
        return (slot >> (idx * PR_BITS)) & PR_MASK;
    }

    function _writePredAt(uint256 slot, uint256 idx, uint256 pred) internal pure returns (uint256) {
        uint256 shift = idx * PR_BITS;
        uint256 clearMask = ~(PR_MASK << shift);
        return (slot & clearMask) | ((pred & PR_MASK) << shift);
    }

    function _predDir(uint256 pred)    internal pure returns (uint8)  { return uint8(pred & PR_DIR_MASK); }
    function _predElig(uint256 pred)   internal pure returns (bool)   { return ((pred >> PR_ELIG_OFFSET)  & 1) != 0; }
    function _predScored(uint256 pred) internal pure returns (bool)   { return ((pred >> PR_SCORED_OFFSET)& 1) != 0; }
    function _predMult(uint256 pred)   internal pure returns (uint256){ return (pred >> PR_MULT_OFFSET)   & PR_MULT_MASK; }
    /// Was the predictor above the farming threshold when this was made?
    function _predAboveFloor(uint256 pred) internal pure returns (bool) { return ((pred >> PR_ABOVEFLOOR_OFFSET) & 1) != 0; }
    function _predRaw(uint256 pred)    internal pure returns (uint256){ return ((pred >> PR_RAW_OFFSET) & PR_RAW_MASK) << PR_RAW_SHIFT; }

    function _effectiveRaw(uint256 rawPower) internal pure returns (uint256) {
        // Same lossy compression as `_packPred` (audit C-5); mirror it exactly so
        // the predict-time weight matches the settle-time re-derivation.
        uint256 scaled = rawPower >> PR_RAW_SHIFT;
        if (scaled > PR_RAW_MASK) scaled = PR_RAW_MASK;
        return scaled << PR_RAW_SHIFT;
    }

    function _predRoundDelta(uint256 pred) internal pure returns (uint64) {
        return uint64((pred >> PR_ROUND_OFFSET) & PR_ROUND_MASK);
    }

    /// @dev The absolute HOUR the prediction was made (phase 6; the packed
    ///      field stores the delta from the deployment round's first hour).
    function _predHour(uint256 pred) internal view returns (uint64) {
        return uint64(((pred >> PR_ROUND_OFFSET) & PR_ROUND_MASK) + deploymentRound * 24);
    }

    /// @dev The round the prediction's pool lives in: its hour / 24.
    function _predPoolRound(uint256 pred) internal view returns (uint64) {
        return uint64(uint256(_predHour(pred)) / 24);
    }

    function _slotStreak(uint256 slot)          internal pure returns (uint16) { return uint16((slot >> HDR_OFFSET) & HDR_STREAK_MASK); }

    function _withStreak(uint256 slot, uint256 streak) internal pure returns (uint256) {
        uint256 clearMask = ~(HDR_STREAK_MASK << HDR_OFFSET);
        return (slot & clearMask) | ((streak & HDR_STREAK_MASK) << HDR_OFFSET);
    }


    function _withBoosted(uint256 slot, uint256 idx, bool boosted) internal pure returns (uint256) {
        uint256 mask = uint256(1) << (HDR_BOOSTED_OFFSET + idx);
        return boosted ? (slot | mask) : (slot & ~mask);
    }

    function _boostedAt(uint256 slot, uint256 idx) internal pure returns (bool) {
        return ((slot >> (HDR_BOOSTED_OFFSET + idx)) & 1) != 0;
    }

    function _markPredScored(uint256 slot, uint256 idx) internal pure returns (uint256) {
        return slot | (uint256(1) << ((idx * PR_BITS) + PR_SCORED_OFFSET));
    }

    function _latestPredHour(uint256 slot) internal view returns (uint64) {
        uint256 predA = _predAt(slot, 0);
        uint256 predB = _predAt(slot, 1);
        bool aPop = _predDir(predA) != 0;
        bool bPop = _predDir(predB) != 0;
        if (!aPop && !bPop) return 0;
        uint64 dA = aPop ? _predRoundDelta(predA) : 0;
        uint64 dB = bPop ? _predRoundDelta(predB) : 0;
        uint64 d  = (aPop && bPop) ? (dA > dB ? dA : dB) : (aPop ? dA : dB);
        return uint64(d + deploymentRound * 24);
    }

    function _viewPred(uint256 pred) internal view returns (SatoriTypes.Prediction memory) {
        return SatoriTypes.Prediction({
            direction:          _predDir(pred),
            roundMade:          _predPoolRound(pred),
            rawPredictionPower: uint96(_predRaw(pred)),
            scored:             _predScored(pred),
            eligible:           _predElig(pred),
            multiplier:         uint48(_predMult(pred))
        });
    }
}
