// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "../libraries/SatoriTypes.sol";
import "../interfaces/ISatoriVoting.sol";
import "../interfaces/ISatoriRewards.sol";
import "../interfaces/ISatoriRegistry.sol";
import "../interfaces/ISatoriGames.sol";
import "../interfaces/ISatoriBounties.sol";
import "./interfaces/IHubDeps.sol";
import "./interfaces/IEngineDeps.sol";
import "./SatoriUUPS.sol";

interface IHubWiredImmutables {
    function token() external view returns (address);
    function engine() external view returns (address);
}

contract SatoriHub is IEngineGateway, SatoriUUPS {

    ISatoriTokenFull   public immutable token;
    ISatoriEngineView  public immutable engine;

    ISatoriVoting   public voting;
    ISatoriRewards  public rewards;
    ISatoriRegistry public registry;
    ISatoriGames    public games;
    ISatoriBounties public bounties;
    address public merkle;

    /// Flat anti-spam burns (owner-set 2026-09-18), deliberately not scaled
    /// with emission.
    uint256 public constant STREAM_BURN = 0.001 ether;  // data-stream creation / spam deterrent
    uint256 public constant GAME_BURN   = 0.1 ether;    // game authoring + bounty funding
    /// Flat minimum prediction power to GROW a streak (owner-set 2026-09-18).
    uint256 public constant FARMING_FLOOR = 1 ether;
    uint256 public constant ROUND_REWARD_BUDGET = 1440 ether;

    // ==================================================================
    // THE EMISSION SCHEDULE  (docs/issues/emission-issuance-indexed-schedule.md)
    //
    // The rate is stored state, stepped by ISSUANCE rather than the clock:
    // each time `emission.issued` (genesis + every general-lane commit + the
    // banked Merkle reserve, grossed up by the dev fee) crosses `nextStepAt`,
    // the rate is multiplied by `ratioWad` (default φ−1, clamped at
    // ROUND_REWARD_BUDGET) and the next threshold moves STEP_ROUNDS × the new
    // rate further out. The first threshold is FLAT_ROUNDS × base.
    //
    // Every rate change lands at round cur+1 through `_setRateNextRound`, so a
    // round is never split between two rates: SatoriRewards' `_roundGross`
    // freeze, both dial bounds and `devRateNow` all rely on that.
    // ==================================================================

    /// (500000/365)×(φ−1), truncated to wei = 846.621902397116230417 SATORI.
    /// MUST equal `SatoriToken.INITIAL_MINT` (lockstep test).
    uint256 public constant BASE_EMISSION_PER_ROUND = 846621902397116230417;

    /// (φ−1) as 18-decimal fixed point: the default step ratio.
    uint256 public constant PHI_INV = 618033988749894848;

    uint256 public constant STEP_ROUNDS = 730;
    uint256 public constant FLAT_ROUNDS = 1460;
    uint256 private constant MAX_STEPS_PER_BUMP = 32;
    uint256 public constant NO_STEP = type(uint128).max;
    uint32  public constant DEFAULT_STREAM_ID = 1;
    // Token lock lanes (docs/design/lock-lane-accounting.md); the hub is the sole writer.
    uint8   internal constant LANE_A = 0; // prediction / delegation lock
    uint8   internal constant LANE_B = 1; // proposal vote lock (LockVoteGovernor via voteLock)
    /// Ceiling on any vote lock: even a compromised vote-lock governor cannot
    /// freeze a wallet for longer than this past now. 90 rounds = ~90 days.
    uint24  internal constant MAX_VOTE_LOCK_ROUNDS = 90;
    uint24  internal constant LOCK_INDEFINITE = type(uint24).max;

    uint256 public onChainMinted;
    uint256 public merkleMinted;
    uint256 public merkleReserveCumulative;
    uint256 internal _merkleReserveRate;
    uint256 internal _merkleReserveLastRound;

    bool public defaultStreamInitialized;

    uint256 private _guard;
    error Reentrancy();
    modifier nonReentrant() {
        if (_guard == 2) revert Reentrancy();
        _guard = 2; _; _guard = 1;
    }

    event VoteLockGovernorSet(address indexed governor);
    event ChildSyncFailed(address indexed child, address indexed from, address to, uint256 value);
    /// The reserve from `fromRound` grows by `min(newRate, residual - 1)` per round
    /// (`_effDial`), clamped to the reserve cap: rounds before `fromRound` read the
    /// bare cumulative, which already banks the old rate through them.
    /// `MerkleReserveClamped` and `EmissionStepped.reserveCumulative` re-anchor it.
    event MerkleReserveRateSet(uint256 newRate, uint256 fromRound, uint256 cumulativeAtFromRound);
    event MerkleReserveClamped(uint256 cumulative, uint256 atRound);
    event MerkleSet(address indexed merkle);
    event EmissionRatioSet(uint256 ratioWad, uint256 nextStepAt, address indexed setter);
    event EmissionStepped(uint256 stepsTaken, uint256 newRate, uint256 nextStepAt, uint256 issued, uint256 fromRound, uint256 reserveCumulative);
    event EmissionAuthorityChanged(address indexed from, address indexed to);
    event EmissionIssued(uint256 added, uint256 issued);
    event MerkleReserveBanked(uint256 cumulative, uint256 throughRoundExclusive);

    error Unauthorized();
    error BadInput();
    error AlreadySet();
    error BudgetExceeded();
    error UnknownStream();
    error Locked();
    error DelegateActive();
    error DefaultStreamNotFirst();
    /// The schedule is seeded only by `_init`; a proxy upgraded in place from a
    /// pre-schedule hub has none and must be redeployed.
    error EmissionUnseeded();

    // Capability ids are dense with no gaps. Removing one RENUMBERS those above
    // it; fine while nothing is live (the policy is a single stored word that
    // starts at zero on every deployment), but once a bitmap must survive on a
    // live chain the ids must freeze.
    uint8 private constant CAP_CREATE_STREAM           = 0;
    /// Governs AUTHORING a game on an existing stream — choosing its type,
    /// config and name. It does NOT govern the plain built-in binary game that
    /// every stream is created with: that one is part of the stream, is made
    /// internally by the creation path, and is covered by CAP_CREATE_STREAM.
    /// Turning this off stops custom/community game types, not new streams.
    uint8 private constant CAP_AUTHOR_GAME             = 1;
    uint8 private constant CAP_REGISTER_STREAM_ADAPTER = 2;
    uint8 private constant CAP_REGISTER_GAME_ADAPTER   = 3;
    uint8 private constant CAP_BOUNTY                  = 4;
    uint8 private constant CAP_DELEGATE_PREDICTION     = 5;
    uint8 private constant CAP_DELEGATE_CLAIM          = 6;
    uint8 private constant CAP_VOTE                    = 7;
    // The flag bitmap + admin setter (setCapabilities) live on SatoriRewards
    // (it owns `admin`); the hub reads rewards.capabilityAllowed to gate below.
    error CapabilityDisabled();
    /// @notice A delegation was attempted to a predictor who has nominated a
    ///         different sole delegator. See docs/design/allowed-delegator.md.
    error DelegatorNotAllowed();
    /// @notice `predictor` restricted incoming delegation to `allowed`.
    ///         `allowed == address(0)` means reopened to anyone.
    event AllowedDelegatorSet(address indexed predictor, address indexed allowed);

    constructor(
        address _token,
        address _engine,
        address _voting,
        address _rewards,
        address _registry,
        address _games,
        address _bounties
    ) {
        if (_token == address(0) || _engine == address(0)) revert BadInput();
        token = ISatoriTokenFull(_token);
        engine = ISatoriEngineView(_engine);
        _init(_voting, _rewards, _registry, _games, _bounties);
        _initialized = true;
    }

    /// Proxy initializer — the implementation carries token/engine as
    /// immutables (readable through delegatecall; re-stated per upgrade);
    /// proxy storage gets the children and the mint-split anchors
    /// (PHASE2-PROXY-ALL.md).
    function initialize(
        address _voting,
        address _rewards,
        address _registry,
        address _games,
        address _bounties
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _init(_voting, _rewards, _registry, _games, _bounties);
    }

    function _init(
        address _voting,
        address _rewards,
        address _registry,
        address _games,
        address _bounties
    ) private {
        voting = ISatoriVoting(_voting);
        rewards = ISatoriRewards(_rewards);
        registry = ISatoriRegistry(_registry);
        games = ISatoriGames(_games);
        bounties = ISatoriBounties(_bounties);
        onChainMinted = token.totalRewardsMinted() - token.devFeeMinted(); // = INITIAL_MINT - devGenesis (general lane's genesis share)
        uint256 dep = token.deploymentRound();
        _merkleReserveLastRound = dep;
        emission = EmissionSchedule({
            issued: uint128(token.totalRewardsMinted()),
            nextStepAt: uint128(FLAT_ROUNDS * BASE_EMISSION_PER_ROUND),
            rate: uint128(BASE_EMISSION_PER_ROUND),
            prevRate: uint128(BASE_EMISSION_PER_ROUND),
            from: uint64(dep),
            ratioWad: uint64(PHI_INV),
            stepsTaken: 0,
            banked: 0
        });
        emit EmissionRatioSet(PHI_INV, FLAT_ROUNDS * BASE_EMISSION_PER_ROUND, address(0));
        emit EmissionIssued(emission.issued, emission.issued);
        // Anchor the upgrade gate in PROXY STORAGE (not the re-bakeable `token`
        // immutable), matching the five children so a hub upgrade can't migrate
        // its own upgrade authority (phase-2 review, Finding 2).
        satoriToken = address(token);
    }

    /// The WIRING slot, not a general governor. `setSatoriMerkle` is a pointer
    /// binding, which is the wiring authority's job (dao-governance.md v2).
    function _governor() internal view returns (address) {
        return token.wiringAuthority();
    }
    modifier onlyGovernor() {
        if (msg.sender != _governor()) revert Unauthorized();
        _;
    }

    /// Severing (zero) stops NEW locks only; existing ones simply expire.
    function setVoteLockGovernor(address g) external onlyGovernor {
        voteLockGovernor = g;
        emit VoteLockGovernorSet(g);
    }

    /// Lane B ONLY, never shortens a live lock, and capped at now + 90
    /// rounds — the whole blast radius of a buggy or hostile vote governor
    /// is "some wallets stay locked up to a quarter, until it is severed"
    /// (docs/design/lock-vote-governor.md §3).
    function voteLock(address user, uint256 untilRound) external {
        if (msg.sender != voteLockGovernor || voteLockGovernor == address(0)) revert Unauthorized();
        if (untilRound > getCurrentRound() + MAX_VOTE_LOCK_ROUNDS) revert BadInput();
        if (untilRound < token.lockUntil(user, LANE_B)) revert BadInput();
        token.setLock(user, LANE_B, uint24(untilRound));
    }

    function getCurrentRound() public view returns (uint256) { return token.getCurrentRound(); }
    function deploymentRound() external view returns (uint256) { return token.deploymentRound(); }
    function balanceOf(address a) external view returns (uint256) { return token.balanceOf(a); }

    function eligibilityRound(uint256 r) external view returns (uint256) { return engine.eligibilityRound(r); }
    function predictions(address u, uint32 g, uint256 r) external view returns (SatoriTypes.Prediction memory) { return engine.predictions(u, g, r); }

    /// @dev Kept on the hub (NOT moved to the lens): SatoriRegistry calls
    ///      `ISatoriCore(core).satoriRewards()` on-chain during wiring.
    /// @dev Kept on the hub (NOT moved to the lens): this is the ERC-173-style
    ///      "ownerless" signal, and any tool asking who owns Satori queries the
    ///      protocol's identity address — the hub — not a view aggregator.
    function owner() external pure returns (address) { return address(0); }
    function satoriRewards() external view returns (address) { return address(rewards); }
    function satoriRegistry() external view returns (address) { return address(registry); }
    function satoriGames() external view returns (address) { return address(games); }


    /// This round's rate. Frozen for the round: a change made during round R
    /// is stored as `rate` from R+1 while `prevRate` keeps paying R.
    function emissionRateNow() public view returns (uint256) {
        EmissionSchedule storage s = emission;
        return getCurrentRound() >= s.from ? s.rate : s.prevRate;
    }

    function emissionRateNext() public view returns (uint256) { return emission.rate; }

    /// The general-lane residual round cur+1 pays. Both dial bounds check this
    /// (here and SatoriRewards.setOffchainBudget), as a dial is effective next round.
    function residualNext() public view returns (uint256) { return _residual(emission.rate); }

    function emissionHolder() public view returns (address) {
        address a = emissionAuthority;
        return a == address(0) ? rewards.admin() : a;
    }

    /// Counts a general-lane reward commit (`userPortion + committedDelegatorShare`)
    /// and the round's due reserve, then applies any steps crossed.
    function noteIssued(uint256 general) external {
        if (msg.sender != address(rewards)) revert Unauthorized();
        if (_merkleReserveRate != 0) {
            uint256 cur = getCurrentRound();
            if (cur > _merkleReserveLastRound) _addIssued(_bankReserve(cur, _generalCap()));
        }
        _issue(general);
    }

    /// Permissionless: banks the due reserve and applies pending steps (including
    /// any left over by the per-bump cap).
    function syncEmission() external {
        _issue(_bankReserve(getCurrentRound(), _generalCap()));
    }

    /// The holder or the token's appoint authority may reassign; zero returns it
    /// to `rewards.admin()`.
    function setEmissionAuthority(address who) external {
        address holder = emissionHolder();
        if (msg.sender != holder && msg.sender != token.appointAuthority()) revert Unauthorized();
        emissionAuthority = who;
        emit EmissionAuthorityChanged(holder, who);
    }

    /// @notice Sets the multiplier the NEXT emission step applies; never moves
    ///         the current or next round's rate. 1e18 stops steps entirely.
    ///         0 reverts: emission is never ended outright (owner ruling
    ///         2026-10-14); a dust multiplier winds it down instead.
    ///         Leaving 1e18 re-bases the threshold to `issued + STEP_ROUNDS ×
    ///         rate`, so issuance counted while steps were off is not stepped
    ///         through in one burst.
    function setEmissionRatio(uint256 ratioWad) external {
        if (msg.sender != emissionHolder()) revert Unauthorized();
        if (ratioWad == 0 || ratioWad > type(uint64).max) revert BadInput();
        EmissionSchedule storage s = emission;
        if (s.ratioWad == 1e18 && ratioWad != 1e18) {
            uint256 rate = s.rate;
            uint256 next = uint256(s.issued) + STEP_ROUNDS * rate;
            s.nextStepAt = uint128(rate == 0 || next >= NO_STEP ? NO_STEP : next);
        }
        s.ratioWad = uint64(ratioWad);
        emit EmissionRatioSet(ratioWad, s.nextStepAt, msg.sender);
    }

    /// Σ of every round's rate over [deploymentRound, cur], inclusive — the same
    /// count the token's `rewardCeiling()` uses. Checkpointed in `banked` by
    /// `_setRateNextRound`, so it is O(1), monotone and never revalues a past round.
    function emissionCeiling() public view returns (uint256) {
        EmissionSchedule storage s = emission;
        uint256 cur = getCurrentRound();
        uint256 from = s.from;
        if (from == 0) revert EmissionUnseeded();
        if (cur + 1 <= from) return s.banked;
        return s.banked + uint256(s.rate) * (cur + 1 - from);
    }

    function _residual(uint256 rate) internal view returns (uint256) {
        return rate - rate * token.devFeeBps() / 10000;
    }

    function _addIssued(uint256 general) internal {
        if (general == 0) return;
        uint256 old = emission.issued;
        uint256 n = old + general * 10000 / (10000 - token.devFeeBps());
        if (n >= NO_STEP) n = NO_STEP - 1;
        emission.issued = uint128(n);
        emit EmissionIssued(n - old, n);
    }

    function _issue(uint256 general) internal {
        _addIssued(general);
        _applySteps();
    }

    /// The only writer of rate/prevRate/from/banked. Callers bank the reserve
    /// through cur first (`_merkleReserveLastRound >= from` while a dial is set).
    function _setRateNextRound(uint256 newRate, uint256 cur) internal {
        EmissionSchedule storage s = emission;
        uint256 nxt = cur + 1;
        uint256 from = s.from;
        if (nxt > from) {
            s.banked += uint256(s.rate) * (nxt - from);
            s.prevRate = s.rate;
            s.from = uint64(nxt);
        }
        s.rate = uint128(newRate);
    }

    function _applySteps() internal {
        EmissionSchedule storage s = emission;
        if (s.issued < s.nextStepAt) return;
        uint256 ratio = s.ratioWad;
        if (s.from == 0) revert EmissionUnseeded();
        if (ratio == 1e18) return;
        uint256 cur = getCurrentRound();
        _addIssued(_bankReserve(cur + 1, _generalCap()));
        uint256 issued = s.issued;
        uint256 next = s.nextStepAt;
        uint256 rate = s.rate;
        uint256 n = s.stepsTaken;
        uint256 i;
        do {
            rate = rate * ratio / 1e18;
            if (rate > ROUND_REWARD_BUDGET) rate = ROUND_REWARD_BUDGET;
            unchecked { ++n; ++i; }
            if (rate == 0) { next = NO_STEP; break; }
            next += STEP_ROUNDS * rate;
            if (next >= NO_STEP) { next = NO_STEP; break; }
        } while (issued >= next && i < MAX_STEPS_PER_BUMP);
        s.nextStepAt = uint128(next);
        s.stepsTaken = uint32(n);
        _setRateNextRound(rate, cur);
        emit EmissionStepped(n, rate, next, issued, cur + 1, merkleReserveCumulative);
    }

    /// @notice Minimum TOTAL prediction power required to GROW a streak. Below
    ///         this a correct call still pays; it just cannot increase the
    ///         streak, so a fleet of dust wallets cannot manufacture the reward
    ///         multiplier. The engine calls this once per batch through
    ///         IEngineGateway (docs/design/farming-threshold.md).
    function farmingThreshold() external pure returns (uint256) { return FARMING_FLOOR; }

    function streamBurn() internal pure returns (uint256) { return STREAM_BURN; }
    function gameBurn()   internal pure returns (uint256) { return GAME_BURN; }
    function bountyBurn() internal pure returns (uint256) { return GAME_BURN; }

    /// Called by rewards (on-chain path) or merkle (reserve path). The hub
    /// enforces the merkle/on-chain split; the token enforces the global cap.
    function rewardMint(address to, uint256 amount) external {
        uint256 cur = getCurrentRound();
        // A step fired here moves only rounds >= cur+1, so `generalCap` (through
        // cur) is the same before and after `_issue`.
        uint256 generalCap = _generalCap();
        _issue(_bankReserve(cur, generalCap));
        // Senior dev carve-out: the general lanes (on-chain + merkle reserve) may
        // only fill the ceiling net of the token's full dev accrual, so the hub
        // never hands the token a mint its own carve-out would reject near the cap.
        if (msg.sender == address(rewards)) {
            // Addition form: never underflows even if the reserve outgrows the cap.
            if (onChainMinted + amount + merkleReserveCumulative > generalCap) revert BudgetExceeded();
            onChainMinted += amount;
        } else if (merkle != address(0) && msg.sender == merkle) {
            if (merkleMinted + amount > merkleReserveCumulative) revert BudgetExceeded();
            merkleMinted += amount;
        } else {
            revert Unauthorized();
        }
        token.rewardMint(to, amount);
    }

    function lockUntilUndelegation(address user) external {
        if (msg.sender != address(rewards)) revert Unauthorized();
        token.setLock(user, LANE_A, LOCK_INDEFINITE);
    }

    function lockUntilNextRound(address user) external {
        if (msg.sender != address(rewards)) revert Unauthorized();
        token.setLock(user, LANE_A, uint24(getCurrentRound() + 1));
    }

    function markParticipated(address user) external {
        if (msg.sender != address(rewards) && msg.sender != address(voting) &&
            msg.sender != address(registry) && msg.sender != address(games) &&
            msg.sender != address(bounties) && msg.sender != address(engine)) revert Unauthorized();
        token.markParticipated(user);
    }

    /// Only rewards clears the delegator gate (on undelegate); no other child has
    /// a reason to, so this stays tighter than markParticipated.
    function unmarkParticipated(address user) external {
        if (msg.sender != address(rewards)) revert Unauthorized();
        token.unmarkParticipated(user);
    }

    function chargeBountyBurn(address funder) external returns (uint256 fee) {
        if (msg.sender != address(bounties)) revert Unauthorized();
        fee = bountyBurn();
        if (fee > 0) token.transferFrom(funder, address(this), fee);
    }

    // ---- IEngineGateway (only the engine) ----
    function engineLock(address user, uint24 untilRound) external {
        if (msg.sender != address(engine)) revert Unauthorized();
        token.setLock(user, LANE_A, untilRound);
    }

    function onTokenTransfer(address from, address to, uint256 value) external {
        if (msg.sender != address(token)) revert Unauthorized();
        try rewards.syncPredictionDelegation(from, to, value) {}
        catch {
            // Empty is treated as out of gas: pass it up empty so SatoriToken
            // reverts the transfer rather than skipping the sync.
            assembly ("memory-safe") { if iszero(returndatasize()) { revert(0, 0) } }
            emit ChildSyncFailed(address(rewards), from, to, value);
        }
    }

    /// The general lanes' shared cap. Asks the TOKEN for the arithmetic rather
    /// than duplicating it: the fee rate moves and its reservation is segmented
    /// at each change, so a second copy of the formula would drift. The hub
    /// supplies its own stricter ceiling and takes the token's answer.
    function _generalCap() internal view returns (uint256) {
        return token.generalCeilingFor(emissionCeiling());
    }

    /// The most the Merkle reserve may ever hold: the general cap LESS what the
    /// on-chain lane has already minted.
    ///
    /// Not the bare general cap. `onChainMinted` is seeded at initialize() with
    /// the genesis mint's general share, before any reserve exists — so a
    /// reserve clamped at the full cap could still carry the two lanes together
    /// past it by exactly that seed.
    ///
    /// This never strands an already-banked reserve. The on-chain branch of
    /// `rewardMint` enforces `onChainMinted + amount + reserve <= generalCap`,
    /// so after every on-chain mint `generalCap - onChainMinted >= reserve`
    /// already holds: the on-chain lane cannot grow into the reserve, and this
    /// bound therefore only ever moves up.
    function _reserveCap(uint256 generalCap) internal view returns (uint256) {
        uint256 minted = onChainMinted;
        return generalCap > minted ? generalCap - minted : 0;
    }

    /// Banks reserve rounds [last, endExclusive) at the effective dial and
    /// returns the positive change in the cumulative, which counts as issued.
    ///
    /// CLAMPED AT `_reserveCap()`. The rate can fall under a standing dial (a
    /// step or a fee-bps raise), and the merkle branch of `rewardMint` bounds
    /// itself by this cumulative alone, so an unclamped one would let the merkle
    /// lane mint past the general cap. SatoriMerkle's partial-pay clamp mirrors
    /// this exact number. Floored at `merkleMinted`; the cumulative may fall to
    /// that floor after a fee-bps raise, which never underflows the delta.
    function _bankReserve(uint256 endExclusive, uint256 generalCap) internal returns (uint256) {
        uint256 last = _merkleReserveLastRound;
        if (endExclusive <= last) return 0;
        _merkleReserveLastRound = endExclusive;
        if (_merkleReserveRate == 0) return 0;
        uint256 old = merkleReserveCumulative;
        uint256 raw = old + _effDial() * (endExclusive - last);
        uint256 next = _clampReserve(raw, generalCap);
        if (next != raw) emit MerkleReserveClamped(next, endExclusive);
        if (next != old) emit MerkleReserveBanked(next, endExclusive);
        merkleReserveCumulative = next;
        return next > old ? next - old : 0;
    }

    function _clampReserve(uint256 v, uint256 generalCap) internal view returns (uint256) {
        uint256 cap = _reserveCap(generalCap);
        if (v > cap) v = cap;
        uint256 floor = merkleMinted;
        return v < floor ? floor : v;
    }

    /// The reserve yields to residual−1 when the rate falls under the dial,
    /// mirroring the 1-wei on-chain gross floor in SatoriRewards._onChainGrossNow:
    /// the two lanes then still sum to the residual.
    function _effDial() internal view returns (uint256) {
        uint256 d = _merkleReserveRate;
        uint256 res = _residual(emission.rate);
        uint256 lim = res == 0 ? 0 : res - 1;
        return d < lim ? d : lim;
    }

    /// Effective NEXT round, in lockstep with SatoriRewards.setOffchainBudget's
    /// gross freeze: the old dial is banked through the current round first.
    function setMerkleReserveRate(uint256 newRate) external {
        if (msg.sender != address(rewards)) revert Unauthorized();
        uint256 cur = getCurrentRound();
        _issue(_bankReserve(cur + 1, _generalCap()));
        if (newRate >= residualNext()) revert BadInput();
        _merkleReserveRate = newRate;
        emit MerkleReserveRateSet(newRate, cur + 1, merkleReserveCumulative);
    }

    function merkleReserveCeiling() public view returns (uint256) {
        uint256 cur = getCurrentRound();
        uint256 last = _merkleReserveLastRound;
        uint256 cum = merkleReserveCumulative;
        uint256 projected = cur > last ? cum + _effDial() * (cur - last) : cum;
        return _clampReserve(projected, _generalCap());
    }

    /// This round's dev slice: `devFeeBps` of the round's emission.
    ///
    /// Computed HERE, not passed through, because the token no longer knows the
    /// per-round rate — the schedule lives in this contract. The two stay
    /// consistent by construction: 15% of each round's emission, accumulated,
    /// is exactly the 3/17-of-the-general-lane that `token.devFeeCeiling()`
    /// reports.
    ///
    /// The bps is read from the token rather than mirrored here. It is the
    /// authority — its `rewardMint` enforces the same split — and a second copy
    /// of a number that must agree is how copies drift apart. That decision is
    /// what lets the DAO's fee dial flow through this contract untouched.
    function devRateNow() external view returns (uint256) {
        return _devRateNow();
    }

    function _devRateNow() internal view returns (uint256) {
        return emissionRateNow() * token.devFeeBps() / 10000;
    }

    // DELIBERATELY NO child-repoint / setChild lever. Each child
    // (voting/rewards/registry/games/bounties) lives behind its own UUPS proxy
    // and is fixed IN PLACE via that proxy's upgradeTo (governor-gated,
    // storage-preserving). A wholesale repoint would ABANDON the outgoing
    // child's storage — including user-custodied vote-bounty escrow and bounty
    // pools (audit F3) and the reward/delegation ledger (F12) — with no rescue
    // path, so the lever is intentionally absent. See docs/audits.

    function setSatoriMerkle(address m) external onlyGovernor {
        if (merkle != address(0)) revert AlreadySet();
        if (m == address(0)) revert BadInput();
        merkle = m;
        emit MerkleSet(m);
    }

    function initializeDefaultStream() external {
        if (defaultStreamInitialized) revert AlreadySet();
        defaultStreamInitialized = true;
        uint32 defId = registry.createSimpleDataStream(address(this), "Satori Predictions", address(this), 1440);
        if (defId != DEFAULT_STREAM_ID) revert DefaultStreamNotFirst();
        games.createGame(address(this), DEFAULT_STREAM_ID, 0, "", "Satori Predictions");

        // No bootstrap vote: the default game's weight is DERIVED (a floored
        // share of all other burned weight), and `voting.vote` rejects it outright.
        engine.markDefaultStreamInitialized();
        registry.setValueForRound(DEFAULT_STREAM_ID, 0, uint24(getCurrentRound()));
    }

    function _onlyAdmin() private view {
        if (msg.sender != rewards.admin()) revert Unauthorized();
    }

    function _requireCapability(uint8 capId) private view {
        _requireCapabilityFor(capId, msg.sender);
    }

    function _requireCapabilityFor(uint8 capId, address who) private view {
        if (!rewards.capabilityAllowed(capId, who)) revert CapabilityDisabled();
    }

    function registerCommunityAdapter(address impl, string calldata name) external returns (uint16 id) {
        _requireCapability(CAP_REGISTER_STREAM_ADAPTER);
        uint256 fee = streamBurn();
        if (fee > 0) token.transferFrom(msg.sender, address(this), fee);
        id = registry.registerAdapter(impl, name, msg.sender, true);
    }
    function registerCommunityGameAdapter(address impl, string calldata name) external returns (uint16 gameTypeId) {
        _requireCapability(CAP_REGISTER_GAME_ADAPTER);
        uint256 fee = streamBurn();
        if (fee > 0) token.transferFrom(msg.sender, address(this), fee);
        gameTypeId = games.registerGameAdapter(impl, msg.sender, name, true);
    }
    function registerAdapter(address impl, string calldata name) external returns (uint16 id) {
        _onlyAdmin();
        id = registry.registerAdapter(impl, name, msg.sender, false);
    }
    function registerGameAdapter(address impl, string calldata name) external returns (uint16 gameTypeId) {
        _onlyAdmin();
        gameTypeId = games.registerGameAdapter(impl, msg.sender, name, false);
    }

    /// @notice `createSimpleDataStream`, paying the stream fee with a signed
    ///         SATORI authorization instead of a prior approval.
    function createSimpleDataStreamWithPermit(
        string memory name, address provider, uint24 minCadenceMinutes, SatoriTypes.SatoriPermit calldata p
    ) external returns (uint32 streamId) {
        _tryPermit(p);
        return createSimpleDataStream(name, provider, minCadenceMinutes);
    }

    /// @notice `createAdapterDataStream`, paying the stream fee (none for the named
    ///         adapter) with a signed SATORI authorization instead of a prior approval.
    function createAdapterDataStreamWithPermit(
        string memory name, uint16 adapterId, address provider, bytes memory config,
        uint24 minCadenceMinutes, SatoriTypes.SatoriPermit calldata p
    ) external returns (uint32 streamId) {
        _tryPermit(p);
        return createAdapterDataStream(name, adapterId, provider, config, minCadenceMinutes);
    }

    function createSimpleDataStream(string memory name, address provider, uint24 minCadenceMinutes)
        public returns (uint32 streamId)
    {
        _chargeStream();
        streamId = registry.createSimpleDataStream(msg.sender, name, provider, minCadenceMinutes);
        games.createGame(address(this), streamId, 0, "", "");
    }
    function createSimpleDataStream(string memory name, address provider) external returns (uint32) {
        return createSimpleDataStream(name, provider, 1440);
    }

    function createAdapterDataStream(
        string memory name, uint16 adapterId, address provider, bytes memory config, uint24 minCadenceMinutes
    ) public returns (uint32 streamId) {
        // `adapterId != 0`: a registry with no named adapter reports 0, which must not make adapter 0 free.
        if (adapterId != 0 && adapterId == registry.namedAdapterId()) _requireCapability(CAP_CREATE_STREAM);
        else _chargeStream();
        streamId = registry.createAdapterDataStream(msg.sender, name, adapterId, provider, config, minCadenceMinutes);
        games.createGame(address(this), streamId, 0, "", "");
    }
    function createAdapterDataStream(string memory name, uint16 adapterId, address provider, bytes memory config) external returns (uint32) {
        return createAdapterDataStream(name, adapterId, provider, config, 1440);
    }

    function createGame(uint32 streamId, uint16 gameTypeId, bytes memory gameConfig, string memory name) external returns (uint32 gameId) {
        _requireCapability(CAP_AUTHOR_GAME);
        uint256 fee = gameBurn();
        if (fee > 0) token.transferFrom(msg.sender, address(this), fee);
        return games.createGame(msg.sender, streamId, gameTypeId, gameConfig, name);
    }

    /// @notice `createGame` with an EXPLICIT target — the ladder path
    ///         (question 6): weekly/monthly rungs on the same stream.
    function createGame(uint32 streamId, uint16 gameTypeId, bytes memory gameConfig, string memory name, uint24 targetMinutes_) external returns (uint32 gameId) {
        _requireCapability(CAP_AUTHOR_GAME);
        uint256 fee = gameBurn();
        if (fee > 0) token.transferFrom(msg.sender, address(this), fee);
        return games.createGame(msg.sender, streamId, gameTypeId, gameConfig, name, targetMinutes_);
    }

    function _chargeStream() private {
        _requireCapability(CAP_CREATE_STREAM);
        uint256 fee = streamBurn();
        if (fee > 0) token.transferFrom(msg.sender, address(this), fee);
    }


    /// @notice Vote for `gameId` by BURNING `amount` SATORI — destroyed, no
    ///         escrow, no refund, no way to move or revoke the weight after.
    ///         Requires an ERC20 approval to this contract for at least `amount`.
    function vote(uint32 gameId, uint256 amount) external nonReentrant returns (uint256 weightAdded) {
        return _vote(msg.sender, gameId, amount);
    }

    /// @notice `vote`, with the SATORI allowance granted by signature in the same
    ///         transaction. One wallet confirmation instead of two.
    /// @dev Route A — docs/design/permit-entry-points.md. The permit is ADVISORY:
    ///      it is attempted, its outcome is discarded, and `burnFrom` below is the
    ///      only thing that decides. That is what makes a front-run permit
    ///      harmless (the allowance it set is still the one the signer asked for)
    ///      and a phantom permit powerless (no allowance, so the burn reverts).
    /// @param p Signed authorization for SATORI. `p.deadline == 0` skips it and
    ///          falls back to any existing allowance, exactly like `vote`.
    function voteWithPermit(uint32 gameId, uint256 amount, SatoriTypes.SatoriPermit calldata p)
        external nonReentrant returns (uint256 weightAdded)
    {
        _tryPermit(p);
        return _vote(msg.sender, gameId, amount);
    }

    /// Attempt a SATORI permit for `msg.sender` -> this contract, and DISCARD the
    /// result. Never reverts on a failed permit; the caller's subsequent transfer
    /// is the enforcement point. See the design note for why checking the outcome
    /// here would be the bug rather than the fix.
    function _tryPermit(SatoriTypes.SatoriPermit calldata p) private {
        _tryPermitFor(msg.sender, p);
    }

    function _tryPermitFor(address owner_, SatoriTypes.SatoriPermit calldata p) private {
        if (p.deadline == 0) return;
        try token.permit(owner_, address(this), p.value, p.deadline, p.signature) {} catch {}
    }

    function _vote(address user, uint32 gameId, uint256 amount) private returns (uint256 weightAdded) {
        // Deliberately NOT markParticipated: participation exists only to gate
        // the token's transfer hook, and that hook now syncs prediction
        // delegation only. A voter's balance moves cannot affect vote weight —
        // the weight came from tokens that were destroyed — so marking them
        // would buy a hook call on every future transfer for nothing. Anyone
        // who later delegates prediction power is marked by that path.
        _requireCapabilityFor(CAP_VOTE, user);
        if (!games.gameExists(gameId)) revert UnknownStream();

        // ---- 1. If delegated, LEAVE THE POOL FIRST. --------------------------
        // A burn shrinks the caller's balance, and the delegated-power
        // accounting has no correct path for a delegator's balance shrinking:
        // its from-side branch only decrements the live power figure, leaving
        // the deferred RATE pool (what the delegate actually predicts with) and
        // the delegator's checkpoint history untouched. The delegate would go on
        // predicting with power backed by destroyed tokens, indefinitely.
        //
        // Rather than invent that path, reuse the one the protocol already has
        // and has tested: undelegation. It removes exactly this delegator's
        // stake from the rate pool, strips their unactivated pending portion,
        // and closes their delegation period. Then the burn happens with no
        // delegation to corrupt, and we put them straight back afterwards.
        //
        // Undelegating is never blocked — the DelegateActive guard only applies
        // to SWITCHING delegates, not to leaving.
        (address delegate, ) = rewards.predictionDelegateInfo(user);
        if (delegate != address(0)) {
            rewards.delegatePredictionPower(address(0), user, token.balanceOf(user));
        }

        // ---- 2. Burn, stepping around the lane-A lock. -----------------------
        // The token's transfer gate is immutable and blunt: it asks only "is
        // this address locked", not why. Burning routes through it like any
        // transfer, so a locked holder could never vote. The hub IS the token's
        // controller, so it lowers the lock for exactly this burn and restores
        // it in the same transaction — the gap is not observable to anyone else
        // and `nonReentrant` keeps it closed to re-entry.
        //
        // This is safe for BOTH lock reasons now: a prediction lock guards
        // against moving tokens to predict twice (burning destroys them, so it
        // cannot), and the delegation lock no longer applies because step 1
        // already took the caller out of the pool.
        uint24 lockBefore = token.lockUntil(user, LANE_A);
        if (lockBefore != 0) token.setLock(user, LANE_A, 0);
        token.burnFrom(user, amount);
        if (lockBefore != 0) token.setLock(user, LANE_A, lockBefore);

        weightAdded = voting.vote(gameId, user, amount);

        // ---- 3. Put them back, at their now-smaller balance. -----------------
        // Re-delegating in the SAME round is clean: a closed period pays through
        // `endRound - 1`, so the old period and the new one cannot both pay for
        // this round, and the pool nets to exactly minus the burnt amount.
        //
        // The cost the caller pays is one round of delegator yield: their old
        // period stops paying at `endRound - 1`, so the round they voted in
        // earns them nothing from the delegation. That share is simply not
        // claimed — stranded, never re-credited to anyone — so this costs the
        // voter, never the protocol or the other delegators.
        if (delegate != address(0)) {
            rewards.delegatePredictionPower(delegate, user, token.balanceOf(user));
        }
    }

    function claim() external returns (uint256) { return rewards.claim(msg.sender, msg.sender); }
    function claim(address recipient) public returns (uint256) { return rewards.claim(msg.sender, recipient); }
    function claimFor(address ownerAddr, address recipient) external returns (uint256) {
        return rewards.claimFor(ownerAddr, msg.sender, recipient);
    }

    /// @notice Restrict who may delegate prediction power to the caller.
    ///         `address(0)` (the default) leaves it open to anyone.
    /// @dev    Mutable, deliberately: an operator rotating cold wallets must be
    ///         able to re-point it, and to reopen. See
    ///         docs/design/allowed-delegator.md.
    function setAllowedDelegator(address allowed) external {
        _setAllowedDelegator(msg.sender, allowed);
    }

    function _setAllowedDelegator(address user, address allowed) private {
        allowedDelegator[user] = allowed;
        emit AllowedDelegatorSet(user, allowed);
    }

    function delegatePredictionPower(address delegate) external {
        _delegatePredictionPower(msg.sender, delegate);
    }

    function _delegatePredictionPower(address user, address delegate) private {
        // The participation mark is set inside rewards.delegatePredictionPower, on
        // the delegator only, so BOTH this entry and burnForVote's internal
        // re-delegation mark identically. See there.
        if (delegate == user) delegate = address(0);

        // Capability and allowed-delegator gates. AFTER the self-delegation
        // normalisation and scoped to `delegate != 0`, so an EXIT is never
        // gated — neither undelegation nor self-delegation (which became one).
        // Delegating locks the whole balance until the delegator leaves, so a
        // gate on leaving would freeze it.
        //
        // Both sit on this entry point rather than in SatoriRewards:
        // `burnForVote` undelegates and re-delegates the caller around the burn,
        // and that restore is involuntary from the caller's point of view. A
        // delegator already in place when the nomination was made, or when the
        // capability was switched off, must be able to vote and keep its place;
        // in the child, either gate would refuse the restore.
        if (delegate != address(0)) {
            _requireCapabilityFor(CAP_DELEGATE_PREDICTION, user);
            address allowed = allowedDelegator[delegate];
            if (allowed != address(0) && allowed != user) revert DelegatorNotAllowed();
        }

        (address currentDelegate, ) = rewards.predictionDelegateInfo(user);
        uint256 currentRound = getCurrentRound();
        if (currentDelegate == address(0)) {
            if (uint256(token.lockUntil(user, LANE_A)) > currentRound) {
                // RETURNING to the delegate you left THIS round passes the lock.
                // burnForVote already performs this exact same-round
                // undelegate->re-delegate-to-same dance internally and its
                // comments prove it clean; this opens the same door to users.
                // Both halves of the condition are load-bearing: the lock VALUE
                // is identical whether it came from undelegating or from
                // PREDICTING yourself (both round+1), and a self-predictor must
                // not join a pool that could predict later this round — the
                // rewards over-mint guard (audit H1) only defers joins when the
                // delegate has ALREADY predicted. `undelegatedRound ==
                // currentRound` can only be true for an undelegation (a
                // delegated user cannot predict, and an undelegated-this-round
                // user is lock-barred from predicting), so the ambiguity
                // resolves safely.
                LastDelegation storage last = lastPredictionDelegation[user];
                if (delegate == address(0)
                    || delegate != last.delegate
                    || uint256(last.undelegatedRound) != currentRound) revert Locked();
            }
        } else if (delegate != address(0)) {
            if (engine.predictedStreamsCount(currentDelegate, currentRound) != 0) revert DelegateActive();
        }
        rewards.delegatePredictionPower(delegate, user, token.balanceOf(user));

        // Keep the return-door record current. Delegating (fresh, switch, or a
        // same-round return) points it at the new delegate with the sentinel 0
        // round; undelegating stamps who was just left and when. burnForVote's
        // internal dance bypasses this function and nets to "still delegated",
        // which the record already says — no drift.
        if (delegate != address(0)) {
            lastPredictionDelegation[user] = LastDelegation(delegate, 0);
        } else if (currentDelegate != address(0)) {
            lastPredictionDelegation[user] = LastDelegation(currentDelegate, uint24(currentRound));
        }
    }

    function delegateClaimAbility(address delegate) external {
        // Revoking (to 0 or to yourself) is never gated: while a delegate is
        // set, SatoriRewards refuses the owner's own claim.
        if (delegate != address(0) && delegate != msg.sender) _requireCapability(CAP_DELEGATE_CLAIM);
        // Deliberately NOT marked: claim delegation never touches prediction
        // power or balances, so the transfer hook (which syncs prediction
        // delegation only) has nothing to do for a claim delegator. Marking them
        // would buy a hook call on every future transfer for nothing.
        rewards.delegateClaimAbility(delegate, msg.sender);
    }

    // ---- Gasless relay (docs/design/gasless-relay.md) ----------------------

    enum RelayAction { Predict, Claim, Transfer, DelegatePrediction, SetAllowedDelegator, SetPredictorFee, Vote }

    bytes32 private constant RELAY_TYPEHASH = keccak256(
        "RelayRequest(address user,uint8 action,bytes data,uint256 fee,address relayer,uint256 nonce,uint256 deadline)"
    );
    // NOT OZ's EIP712 base, for reasons that hold on a FRESH deployment (the
    // current testnet instance is disposable and is not the concern): its two
    // fallback-string slots would sit ahead of this contract's storage forever,
    // committing every future hub implementation to inherit it (or fake its
    // slots) to keep the layout — a permanent obligation bought for nothing,
    // because behind a proxy its domain cache never matches address(this) and
    // it rebuilds this exact hash every call anyway. Only the domain constants
    // are local; recovery and digest assembly stay OZ (ECDSA/MessageHashUtils).
    // Same pattern as SatoriToken's bytes-permit re-stating PERMIT_TYPEHASH.
    bytes32 private constant _DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant _RELAY_NAME_HASH    = keccak256("SatoriHub");
    bytes32 private constant _RELAY_VERSION_HASH = keccak256("1");

    function relayDomainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            _DOMAIN_TYPEHASH, _RELAY_NAME_HASH, _RELAY_VERSION_HASH, block.chainid, address(this)
        ));
    }

    error RelayExpired();
    error BadRelaySignature();
    event Relayed(address indexed user, address indexed relayer, uint8 indexed action, uint256 nonce, uint256 fee);

    /// @notice Execute one user-signed action, with the caller (the bound
    ///         relayer) paying the gas and receiving `r.fee` SATORI from the
    ///         user. The whole thing is atomic: a failed action takes no fee
    ///         and consumes no nonce.
    /// @param p Optional SATORI permit for `r.user` -> this contract
    ///          (`p.deadline == 0` skips it) — the standing allowance the fee
    ///          and the Transfer/Vote arms spend. Advisory, like every other
    ///          permit entry point: the transfers below are the enforcement.
    function relay(
        SatoriTypes.RelayRequest calldata r,
        bytes calldata sig,
        SatoriTypes.SatoriPermit calldata p
    ) external nonReentrant {
        if (msg.sender != r.relayer) revert Unauthorized();
        if (block.timestamp > r.deadline) revert RelayExpired();
        if (r.nonce != relayNonces[r.user]) revert BadInput();
        unchecked { relayNonces[r.user] = r.nonce + 1; }
        bytes32 digest = MessageHashUtils.toTypedDataHash(relayDomainSeparator(), keccak256(abi.encode(
            RELAY_TYPEHASH, r.user, r.action, keccak256(r.data), r.fee, r.relayer, r.nonce, r.deadline
        )));
        if (ECDSA.recover(digest, sig) != r.user) revert BadRelaySignature();
        _tryPermitFor(r.user, p);
        // A claim pays its fee out of the claim (rewards mints it to the relayer),
        // so a transfer-locked wallet can claim. Every other action pulls the fee
        // first: Predict and DelegatePrediction set the lane-A lock inside the
        // action, and the token's transfer gate would then refuse it.
        RelayAction a = RelayAction(r.action);
        if (a == RelayAction.Claim) {
            rewards.claimWithFee(r.user, abi.decode(r.data, (address)), msg.sender, r.fee);
        } else {
            if (r.fee > 0) token.transferFrom(r.user, msg.sender, r.fee);
            _dispatchRelay(r.user, a, r.data);
        }
        emit Relayed(r.user, msg.sender, r.action, r.nonce, r.fee);
    }

    function _dispatchRelay(address user, RelayAction a, bytes calldata data) private {
        if (a == RelayAction.Predict) {
            (address referrer, SatoriTypes.PredictionRequestWithPayload[] memory reqs) =
                abi.decode(data, (address, SatoriTypes.PredictionRequestWithPayload[]));
            engine.predictMultipleFor(user, referrer, reqs);
        } else if (a == RelayAction.Transfer) {
            (address to, uint256 amount) = abi.decode(data, (address, uint256));
            token.transferFrom(user, to, amount);
        } else if (a == RelayAction.DelegatePrediction) {
            _delegatePredictionPower(user, abi.decode(data, (address)));
        } else if (a == RelayAction.SetAllowedDelegator) {
            _setAllowedDelegator(user, abi.decode(data, (address)));
        } else if (a == RelayAction.SetPredictorFee) {
            rewards.setPredictorFeeFor(user, abi.decode(data, (uint16)));
        } else {
            (uint32 gameId, uint256 amount) = abi.decode(data, (uint32, uint256));
            _vote(user, gameId, amount);
        }
    }

    // APPEND-ONLY storage (proxy safety): add new vars below, never reorder or insert.

    /// @dev Set by BOTH init paths: the implementation constructor and the proxy
    ///      `initialize` (making it one-shot).
    bool private _initialized;

    /// @notice Token pointer in PROXY STORAGE, anchoring the upgrade gate
    ///         (phase-2 review, Finding 2). Equals `address(token)`; set in
    ///         `_init`.
    address public satoriToken;

    /// @notice Optional per-predictor nomination: the ONE address permitted to
    ///         open a delegation to them. `address(0)` (the default) is open to
    ///         anyone. Purely restrictive — it can only narrow who may delegate
    ///         to the caller, never grant the caller anything, which is why it
    ///         needs no capability flag or admin role.
    /// @dev    Checked at delegation time only: setting it never evicts an
    ///         existing delegator (docs/design/allowed-delegator.md §3).
    mapping(address => address) public allowedDelegator;

    /// @notice The one contract allowed to write lane-B vote locks through
    ///         `voteLock` (appended — append-only layout). Zero = severed.
    address public voteLockGovernor;

    /// @notice Per-user sequential relay nonce (appended — append-only layout).
    mapping(address => uint256) public relayNonces;

    /// @notice The delegate a user last pointed prediction power at, and — when
    ///         they have since undelegated — the round they left. `delegate`
    ///         with `undelegatedRound == 0` means that delegation is (or was
    ///         last known) ACTIVE; a nonzero round marks a completed exit.
    ///         Sole consumer: the same-round-return exemption in
    ///         `_delegatePredictionPower`. Appended — append-only layout.
    struct LastDelegation { address delegate; uint24 undelegatedRound; }
    mapping(address => LastDelegation) public lastPredictionDelegation;

    struct EmissionSchedule {
        uint128 issued;
        uint128 nextStepAt;
        uint128 rate;
        uint128 prevRate;
        uint64  from;
        uint64  ratioWad;
        uint32  stepsTaken;
        uint256 banked;
    }
    EmissionSchedule public emission;
    address public emissionAuthority;

    /// Upgrade authority = the token's governor, read from PROXY STORAGE
    /// (`satoriToken`, set once at init) so a hub upgrade compiled with a
    /// different `token` immutable can't reroute upgrade authority (phase-2
    /// review, Finding 2). Same key as the engine; dies with renounceGovernor().
    /// Compile-time identity — pinned by SatoriUUPS.upgradeTo so only another
    /// SatoriHub implementation can ever be installed here.
    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriHub");
    }

    function _upgradeGovernor() internal view override returns (address) {
        return ISatoriUpgradeAuthority(satoriToken).upgradeAuthority();
    }

    /// Pin the TOKEN immutable only, and anchor it on `satoriToken` (proxy
    /// storage) — the same value that grants upgrade authority — so a candidate
    /// hub can never be compiled against a different token (phase-2 Finding 1).
    ///
    /// The `engine` pin is deliberately NOT here. The engine sits behind its own
    /// proxy, so in the happy path this check never fires; but if the engine
    /// proxy ever has to be replaced, pinning it would make the hub permanently
    /// un-upgradeable — the pin would weld the hub to a dead address. A pin that
    /// is a no-op when things go right and fatal when they go wrong is pure
    /// downside, so the engine wiring is reviewed at upgrade time instead.
    function _validateNewImplementation(address newImpl) internal view override {
        if (IHubWiredImmutables(newImpl).token() != satoriToken) revert UpgradeBadImplementation();
    }
}
