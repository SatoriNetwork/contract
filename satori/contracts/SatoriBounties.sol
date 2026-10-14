// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./libraries/SatoriTypes.sol";
import "./interfaces/ISatoriBounties.sol";
import "./interfaces/ISatoriCore.sol";
import "./interfaces/ISatoriGames.sol";
import "./interfaces/ISatoriRewards.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "./next/SatoriUUPS.sol";

/// @dev `anchorEvicted` is true only once the round's anchor entry has been
///      pushed out of the hour-keyed history ring — after which no prediction
///      from that round can ever score a win again (design 9.5).
interface IRegistryForBounties {
    function getFirstValueAfter(uint32 streamId, uint256 afterHour)
        external view returns (int232 valueB, bool found, bool anchorEvicted);
}

/// @dev SATORI's ERC-1271 permit overload (arbitrary-length signature), distinct
///      from `IERC20Permit` which an arbitrary bounty-funding token implements.
interface ISatoriPermitToken {
    function permit(
        address owner, address spender, uint256 value, uint256 deadline, bytes calldata signature
    ) external;
}

/**
 * @title SatoriBounties
 * @notice Bounty subsystem extracted from SatoriRewards so SatoriRewards fits
 *         under EIP-170. Bounties are keyed by gameId, not streamId; many games
 *         can share one stream, each with its own independent pool.
 */
contract SatoriBounties is ISatoriBounties, ReentrancyGuard, SatoriUUPS {
    using SafeERC20 for IERC20;

    // ========== Wiring ==========

    address private deployer;

    address public satoriCore;

    /// @notice The authorized caller (`onlyRewards`) of `creditBountyForWin` /
    ///         `creditAdapterBounty` / `clearRoundBountyList`.
    address public satoriRewards;

    // ========== Constants ==========

    /// @notice Adapter active-token pin meaning "pinned to no token". Distinct
    ///         from address(0), which means "not yet pinned".
    address private constant SENTINEL_NONE = address(1);

    /// @notice Scaling factor for `ratePerRound` (stored rates are
    ///         `actualRate × RATE_SCALE`). The floored sub-base-unit remainder is
    ///         NOT lost: it stays in `pool` and drains via the `min(rate, pool)`
    ///         tail, so the FULL pool always drains. Forward progress is
    ///         guaranteed: when `rate > 0` and `pool > 0` the drip is at least 1
    ///         base unit, so a bounty can never lock its pool with a stuck zero drip.
    uint256 public constant RATE_SCALE = 1e18;

    // ========== Bounty State (merged per-(game, token) pool) ==========

    /// @notice Remaining bounty reserve per (game, token). Funded irrevocably —
    ///         there is NO recover path.
    mapping(uint32 => mapping(address => uint256)) public pool;

    /// @notice Per-round drip rate per (game, token), stored as `actualRate × RATE_SCALE`.
    mapping(uint32 => mapping(address => uint256)) public ratePerRound;

    /// @notice Append-only list of tokens ever funded on a game; drained entries
    ///         removed only via `cleanupDrainedBountyToken`.
    mapping(uint32 => address[]) public gameBountyTokens;

    mapping(uint32 => mapping(address => bool)) internal _gameTokenSeen;

    mapping(uint32 => mapping(uint32 => mapping(address => bool))) internal _dripFiredForRound;

    mapping(uint32 => mapping(uint32 => mapping(address => uint256))) public roundBountyPot;

    /// @notice Paid out of `roundBountyPot` so far. The unclaimed remainder is
    ///         swept back to `pool` by `reclaimStrandedPot` once the round's
    ///         scoring window has evicted (review A5).
    mapping(uint32 => mapping(uint32 => mapping(address => uint256))) public roundBountyPotClaimed;

    /// @notice Round the CURRENT funding epoch for a (game, token) began. A
    ///         round's drip is refused when `round < _fundingEpochStartRound` so
    ///         a stale winner from a PRIOR epoch cannot drip against a re-funded
    ///         pool (audit H2 — cross-epoch fund leak).
    mapping(uint32 => mapping(address => uint32)) internal _fundingEpochStartRound;


    // ========== v5 Auto-Boost State ==========

    mapping(address => mapping(address => uint256)) public bountyStake;

    mapping(address => address[]) public userStakedTokens;

    /// @notice Stake-weighted boost accumulator per (game, round, key, token) —
    ///         the pari-mutuel denominator for the winning key. `key` is the
    ///         outcome group (binary games pass `uint96(direction)`); adapter
    ///         games use `_adapterBountyTotal` instead.
    mapping(uint32 =>
        mapping(uint32 =>
            mapping(uint96 =>
                mapping(address => uint256))))
        internal _totalBoostStakeByKey;

    mapping(address =>
        mapping(uint32 =>
            mapping(uint256 =>
                mapping(address => uint256))))
        public boostStakeForPrediction;

    // ========== Adapter bounty (score/total, single active token) ==========

    /// @notice Pinned active token per (game, round). 0 = unpinned;
    ///         SENTINEL_NONE = pinned-to-none. Frozen for the round at first predict.
    mapping(uint32 => mapping(uint256 => address)) internal _adapterActiveToken;

    /// @notice Pinned `bountyTotal` (+1; 0 = unset) per (game, round).
    mapping(uint32 => mapping(uint256 => uint256)) internal _adapterBountyTotal;

    /// @notice Running paid numerator per (game, round), capped at the pinned
    ///         `bountyTotal` so Σ paid ≤ one pot.
    mapping(uint32 => mapping(uint256 => uint256)) internal _adapterBountyPaid;

    /// @notice Per-(user, round) set of tokens the user snapshotted that round.
    ///         Iterated by `creditBountyForWin` so payout survives an unstake
    ///         after the 1-round lock lifts (paying from the live
    ///         `userStakedTokens` would strand a withdrawer's earned share).
    ///         Bounded by the user's OWN stake, so griefing-immune. Cleared by
    ///         `clearRoundBountyList`.
    mapping(address => mapping(uint256 => address[])) public boostedTokensInRound;

    /// @notice Per-(user, token) unstake lock. Set by `applyBoost` to
    ///         `predictRound + 1`. Prevents the cycle attack: predict → unstake
    ///         mid-round → send to a friend who stakes-and-predicts the same
    ///         round, double-counting the boost. Per-token; `>` semantics match
    ///         the prediction-side `lockedUntil`.
    mapping(address => mapping(address => uint64)) public stakeLockedUntil;

    // ========== Events ==========

    event SatoriCoreSet(address indexed newCore);

    // Every write to `pool` / `ratePerRound` emits the pair it left behind, and
    // every write to `bountyStake` emits the new stake: a reader folds the latest
    // event instead of reading storage. Rates are scaled by RATE_SCALE.
    event BountyFunded(
        address indexed funder,
        uint32 indexed gameId,
        address indexed token,
        uint256 received,
        uint256 proposedRate,
        uint256 newRate,
        uint256 newPool
    );
    event BountyDripped(
        uint32 indexed gameId, uint32 indexed round, address indexed token,
        uint256 amount, uint256 newPool, uint256 newRate
    );
    event BountyTokenCleaned(uint32 indexed gameId, address indexed token, address caller);
    event StrandedPotReclaimed(
        uint32 indexed gameId, uint32 indexed round, address indexed token,
        uint256 amount, uint256 newPool, uint256 newRate
    );
    /// @notice A deposit. Winnings are `BountyPaid`, never this.
    event BountyTokenStaked(address indexed user, address indexed token, uint256 amount, uint256 newStake);
    /// @notice A winning prediction's share of a round's pot, auto-compounded into stake.
    event BountyPaid(
        address indexed user, uint32 indexed gameId, address indexed token,
        uint32 round, uint256 share, uint256 newStake
    );
    event BountyTokenUnstaked(
        address indexed user, address indexed token, address indexed recipient, uint256 amount, uint256 newStake
    );

    // ========== Custom Errors ==========

    error BadInput();
    error Unauthorized();
    error AlreadySet();
    error UnknownStream();
    error ZeroReceived();
    error RateTooHigh();
    error RateBelowFloor();
    error InsufficientStake();
    error NotDrained();
    error TokenNotFunded();
    error NothingToReclaim();
    error RoundNotEvicted();
    error StakeLocked();

    // ========== Modifiers ==========

    function setSatoriEngine(address _engine) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (satoriEngine != address(0)) revert AlreadySet();
        if (_engine == address(0)) revert BadInput();
        satoriEngine = _engine;
    }

    function setSatoriToken(address _token) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (satoriToken != address(0)) revert AlreadySet();
        if (_token == address(0)) revert BadInput();
        satoriToken = _token;
    }

    function _tokenAddr() internal view returns (address) {
        return satoriToken == address(0) ? satoriCore : satoriToken;
    }

    modifier onlyRewards() {
        if (msg.sender != satoriRewards) revert Unauthorized();
        _;
    }

    /// @dev `applyBoost` / `snapshotAdapterStake` are predict-time snapshots
    ///      called by SatoriEngine directly. The modifier still admits
    ///      satoriRewards for the historical adapter path.
    modifier onlyCoreOrRewards() {
        if (msg.sender != satoriCore && msg.sender != satoriRewards && msg.sender != satoriEngine) revert Unauthorized();
        _;
    }

    // ========== Constructor + Wiring ==========

    constructor() {
        deployer = msg.sender;
        _initialized = true;
    }

    /// @dev Proxy initializer; the constructor path locks the raw implementation
    ///      and keeps the one-shot setSatoriToken wiring.
    function initialize(address _token) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        deployer = msg.sender;
        _requireGovernorSource(_token);
        satoriToken = _token;
    }

    function setSatoriCore(address _core) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (satoriCore != address(0)) revert AlreadySet();
        if (_core == address(0)) revert BadInput();
        satoriCore = _core;
        emit SatoriCoreSet(_core);
    }

    /// @dev Separate from `setSatoriCore` because the deploy order is
    ///      rewards → bounties → core, and rewards needs bounties' address
    ///      before SATORI core is constructed.
    function setSatoriRewards(address _rewards) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (satoriRewards != address(0)) revert AlreadySet();
        if (_rewards == address(0)) revert BadInput();
        satoriRewards = _rewards;
    }

    // ========== Bounty Funding (merged per-(game, token) pool) ==========

    /**
     * @notice Irrevocably fund a (game, token) bounty at a pledged per-round
     *         drip rate. No recover path; the only egress is the drip to winners.
     * @dev Additive across funders — a second call merges into the pool and
     *      weights the rate by contribution^2 (quadratic), so a hostile late
     *      funder cannot dilute the rate via many tiny floor-edge calls. Rate
     *      constraints: `0 < proposedRate <= received`, and
     *      `proposedRate >= max(currentRate / RATE_SCALE / 10, 1)` when
     *      `currentRate > 0` (virgin pool skips the floor).
     */
    // Capability gate: bounty funding/staking gated by CAP_BOUNTY; the flags +
    // admin bypass live on SatoriRewards.
    uint8 private constant CAP_BOUNTY = 4; // must match SatoriHub.CAP_BOUNTY
    error CapabilityDisabled();

    function _requireBountyEnabled() private view {
        if (!ISatoriRewards(satoriRewards).capabilityAllowed(CAP_BOUNTY, msg.sender)) revert CapabilityDisabled();
    }

    function fundBounty(
        uint32 gameId,
        address token,
        uint256 amount,
        uint256 proposedRate
    ) external nonReentrant {
        _fundBounty(gameId, token, amount, proposedRate);
    }

    /// @notice `fundBounty`, both allowances granted by signature in the same tx.
    /// @dev TWO permits: `amount` of `token` to THIS contract, and — when posting
    ///      the first bounty of a `(game, token)` pair in a non-SATORI token — the
    ///      SATORI posting burn to the HUB, which is what `chargeBountyBurn` pulls.
    ///      Both advisory (`deadline == 0` skips); the token pull and fee pull are
    ///      the enforcement points, so a front-run or phantom permit is harmless.
    /// @param tokenPermit Signed ERC-2612 authorization for `token` -> this contract.
    /// @param feePermit   Signed SATORI authorization for the posting fee -> the hub.
    function fundBountyWithPermit(
        uint32 gameId,
        address token,
        uint256 amount,
        uint256 proposedRate,
        SatoriTypes.TokenPermit calldata tokenPermit,
        SatoriTypes.SatoriPermit calldata feePermit
    ) external nonReentrant {
        _tryTokenPermit(token, address(this), tokenPermit);
        _trySatoriPermit(feePermit);
        _fundBounty(gameId, token, amount, proposedRate);
    }

    /// @dev Attempt an ERC-2612 permit and discard the result; never reverts, so
    ///      a missing/reverting/front-run permit all land identically and the
    ///      transfer decides.
    function _tryTokenPermit(address token, address spender, SatoriTypes.TokenPermit calldata p) private {
        if (p.deadline == 0) return;
        try IERC20Permit(token).permit(msg.sender, spender, p.value, p.deadline, p.v, p.r, p.s) {} catch {}
    }

    /// @dev The spender is the HUB, not this contract: `SatoriHub.chargeBountyBurn`
    ///      performs the pull.
    function _trySatoriPermit(SatoriTypes.SatoriPermit calldata p) private {
        if (p.deadline == 0) return;
        try ISatoriPermitToken(_tokenAddr()).permit(
            msg.sender, satoriCore, p.value, p.deadline, p.signature
        ) {} catch {}
    }

    function _fundBounty(
        uint32 gameId,
        address token,
        uint256 amount,
        uint256 proposedRate
    ) private {
        _requireBountyEnabled();
        if (amount == 0) revert BadInput();
        if (token == address(0)) revert BadInput();

        address games = ISatoriCore(satoriCore).satoriGames();
        if (!ISatoriGames(games).gameExists(gameId)) revert UnknownStream();

        bool isFirstFundForToken = !_gameTokenSeen[gameId][token];

        // POSTING (first fund of a pair) in a NON-SATORI token costs a heavy
        // SATORI burn; posting in SATORI and later top-ups are free. Charged
        // before the token pull so a funder short on SATORI reverts fast.
        if (isFirstFundForToken && token != _tokenAddr()) {
            ISatoriCore(satoriCore).chargeBountyBurn(msg.sender);
        }

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received == 0) revert ZeroReceived();

        if (proposedRate > received) revert RateTooHigh();
        if (proposedRate == 0) revert RateBelowFloor();

        uint256 oldPool = pool[gameId][token];
        uint256 currentRate = ratePerRound[gameId][token]; // scaled

        if (currentRate > 0) {
            uint256 minRate = currentRate / RATE_SCALE / 10;
            if (minRate == 0) minRate = 1;
            if (proposedRate < minRate) revert RateBelowFloor();
        }

        uint256 oldWeight = oldPool * oldPool;
        uint256 newWeight = received * received;
        uint256 totalWeight = oldWeight + newWeight;

        uint256 newPool = oldPool + received;
        uint256 newRate;
        if (oldWeight == 0) {
            newRate = proposedRate * RATE_SCALE;
            // Fresh funding epoch: rounds before now can no longer drip against
            // this pool, so a prior-epoch winner can't siphon this capital (H2).
            _fundingEpochStartRound[gameId][token] = uint32(_currentRound());
        } else {
            newRate = Math.mulDiv(oldWeight, currentRate, totalWeight)
                    + Math.mulDiv(newWeight, proposedRate * RATE_SCALE, totalWeight);
        }

        pool[gameId][token] = newPool;
        ratePerRound[gameId][token] = newRate;

        if (isFirstFundForToken) {
            _gameTokenSeen[gameId][token] = true;
            gameBountyTokens[gameId].push(token);
        }

        emit BountyFunded(msg.sender, gameId, token, received, proposedRate, newRate, newPool);
    }

    // ========== Bounty Token Cleanup ==========

    /// @notice Whether `fundBounty` would charge the one-off SATORI posting burn
    ///         for this `(gameId, token)` pair right now.
    /// @dev Reads the same `_gameTokenSeen` flag `fundBounty` branches on, so the
    ///      two cannot disagree. The fee is charged by `SatoriHub.chargeBountyBurn`,
    ///      so the allowance it needs is SATORI approved to the HUB, amount
    ///      `bountyBurn()`. `pool == 0` is NOT a substitute: a drained pair keeps
    ///      its seen flag until `cleanupDrainedBountyToken`, and re-funding then is free.
    function postingFeeApplies(uint32 gameId, address token) external view returns (bool) {
        return !_gameTokenSeen[gameId][token] && token != _tokenAddr();
    }

    /// @notice Permissionless removal of a fully-drained (game, token) entry.
    ///         Cannot strand a pending payout: score-time credit is gated by the
    ///         prediction's "boosted" bit and captured `roundBountyPot`.
    function cleanupDrainedBountyToken(uint32 gameId, address token) external nonReentrant {
        if (pool[gameId][token] != 0) revert NotDrained();
        if (ratePerRound[gameId][token] != 0) revert NotDrained();
        if (!_gameTokenSeen[gameId][token]) revert TokenNotFunded();
        _removeGameBountyToken(gameId, token, msg.sender);
    }

    /**
     * @notice Permissionlessly sweep the UNCLAIMED remainder of a round's bounty
     *         pot back into `pool` once that round can never be settled again
     *         (review A5). A winner who never settles before their scoring window
     *         evicts leaves their share locked forever; this returns it.
     * @dev SAFE TRIGGER: `anchorEvicted` is true only when the round's anchor has
     *      left the ring, so no future settle can score a win and `pot - claimed`
     *      is final. Reclaiming earlier could rob a slow-but-valid winner. A late
     *      settle cannot happen: once the anchor evicts, the engine force-finalizes
     *      as `PredictionUnrecoverable` and never reaches `creditBountyForWin`.
     *
     *      RATE REVIVAL: a fully-drained pool has rate 0 (and may have been swept
     *      from `gameBountyTokens`). Returning residue without a rate would strand
     *      it again, so when rate is 0 this treats the residue as a virgin re-fund
     *      of itself (rate = residue/round, fresh epoch (H2), re-register if cleaned).
     */
    function reclaimStrandedPot(uint32 gameId, uint32 round, address token) external nonReentrant {
        uint256 pot = roundBountyPot[gameId][round][token];
        uint256 claimed = roundBountyPotClaimed[gameId][round][token];
        uint256 residue = pot > claimed ? pot - claimed : 0;
        if (residue == 0) revert NothingToReclaim();

        uint32 streamId = ISatoriGames(ISatoriCore(satoriCore).satoriGames()).dataStreamId(gameId);
        address registry = ISatoriCore(satoriCore).satoriRegistry();
        // A round-r prediction's hour is within [r*24, r*24+23], so its anchor
        // survives while any entry at or before the round's LAST hour does — the
        // conservative gate.
        (, , bool anchorEvicted) =
            IRegistryForBounties(registry).getFirstValueAfter(streamId, uint256(round) * 24 + 23);
        if (!anchorEvicted) revert RoundNotEvicted();

        roundBountyPotClaimed[gameId][round][token] = pot; // residue -> 0, no re-reclaim
        uint256 newPool = pool[gameId][token] + residue;
        pool[gameId][token] = newPool;
        uint256 rate = ratePerRound[gameId][token];
        if (rate == 0) {
            rate = residue * RATE_SCALE;
            ratePerRound[gameId][token] = rate;
            _fundingEpochStartRound[gameId][token] = uint32(_currentRound());
            if (!_gameTokenSeen[gameId][token]) {
                _gameTokenSeen[gameId][token] = true;
                gameBountyTokens[gameId].push(token);
            }
        }
        emit StrandedPotReclaimed(gameId, round, token, residue, newPool, rate);
    }

    /// @dev Payout is independent of eviction (per-prediction "boosted" bit +
    ///      snapshot), so cleanup is always safe.
    function _removeGameBountyToken(uint32 gameId, address token, address caller) internal {
        address[] storage list = gameBountyTokens[gameId];
        uint256 len = list.length;
        for (uint256 i = 0; i < len; i++) {
            if (list[i] == token) {
                if (i != len - 1) {
                    list[i] = list[len - 1];
                }
                list.pop();
                _gameTokenSeen[gameId][token] = false;
                emit BountyTokenCleaned(gameId, token, caller);
                return;
            }
        }
        // Unreachable under the seen-flag invariant; defensive sentinel.
        revert TokenNotFunded();
    }

    // ========== Bounty Score-time Credit ==========

    /**
     * @notice Per-token bounty payout at score time. Called from
     *         `SatoriRewards.scoreCorrectPrediction` only when the prediction's
     *         "boosted" bit is set. Iterates the user's predict-time boosted-token
     *         set for the round (NOT the live `userStakedTokens`, which the user
     *         can empty by unstaking once the lock lifts).
     */
    function creditBountyForWin(
        address user,
        uint32 gameId,
        uint32 round,
        uint96 key
    ) external override onlyRewards {
        address[] storage toks = boostedTokensInRound[user][round];
        uint256 n = toks.length;
        if (n == 0) return;

        for (uint256 i = 0; i < n; i++) {
            address tk = toks[i];
            // No `_gameTokenSeen` gate: a captured `roundBountyPot` belongs to
            // that round's predictors regardless of later eviction, and gating on
            // it would let a permissionless cleanup between two same-round settlers
            // strand the later one. The real gates are downstream:
            // `_dripTokenForRound` no-ops on rate 0, and `_accrueBountyForWinToken`
            // returns when this game's snapshot is zero (so a token snapshotted
            // for a DIFFERENT game this round is skipped there).
            _dripTokenForRound(gameId, round, tk);
            _accrueBountyForWinToken(user, gameId, round, key, tk);
        }
    }

    /// @dev Lazy per-token drip-capture. Idempotent per (game, round, token).
    function _dripTokenForRound(uint32 gameId, uint32 round, address tk) internal {
        if (_dripFiredForRound[gameId][round][tk]) return;

        // H2 (cross-epoch fund leak): refuse to drip a round older than the
        // current funding epoch, else a stale unsettled winner from a prior epoch
        // could drip against a later epoch's re-funded pool.
        if (round < _fundingEpochStartRound[gameId][tk]) return;

        uint256 r = ratePerRound[gameId][tk];
        if (r == 0) return;
        uint256 p = pool[gameId][tk];
        if (p == 0) return;

        _dripFiredForRound[gameId][round][tk] = true;

        uint256 actualDrip = r / RATE_SCALE;
        // Forward-progress floor: the quadratic merge can store a rate of
        // RATE_SCALE−1 (< 1 base unit), which would drip 0 forever and STRAND the
        // pool. r>0 and p>0 here, so guarantee at least 1 base unit.
        if (actualDrip == 0) actualDrip = 1;
        if (actualDrip > p) actualDrip = p;

        uint256 newPool = p - actualDrip;
        pool[gameId][tk] = newPool;
        // Conservation (Σ payout shares ≤ pot): every correct prediction for a
        // (game, round) shares ONE winning direction, so Σ userBoost ≤ totalBoost
        // for that direction, and the rewards side only credits the winning
        // direction's total.
        roundBountyPot[gameId][round][tk] += actualDrip;

        if (newPool == 0) {
            ratePerRound[gameId][tk] = 0;
            r = 0;
        }

        emit BountyDripped(gameId, round, tk, actualDrip, newPool, r);
    }

    /// @dev share = pot × userStake / totalStake, on predict-time snapshots
    ///      (already streak-multiplied in `applyBoost`). No payout fee.
    function _accrueBountyForWinToken(
        address user,
        uint32 gameId,
        uint32 round,
        uint96 key,
        address tk
    ) internal {
        uint256 pot = roundBountyPot[gameId][round][tk];
        if (pot == 0) return;

        uint256 userBoost = boostStakeForPrediction[user][gameId][round][tk];
        if (userBoost == 0) return;

        uint256 totalBoost = _totalBoostStakeByKey[gameId][round][key][tk];
        if (totalBoost == 0) return;

        uint256 share = Math.mulDiv(pot, userBoost, totalBoost);
        if (share == 0) return;

        // The pot stays constant (the fixed proportional denominator); `claimed`
        // tracks what winners took, and `reclaimStrandedPot` sweeps `pot - claimed`
        // once the round evicts (review A5).
        roundBountyPotClaimed[gameId][round][tk] += share;
        _payBounty(user, gameId, round, tk, share);
    }

    /// @dev The one place a win reaches stake, for both rails.
    function _payBounty(address user, uint32 gameId, uint32 round, address tk, uint256 share) private {
        uint256 newStake = bountyStake[user][tk] + share;
        if (newStake == share) userStakedTokens[user].push(tk);
        bountyStake[user][tk] = newStake;
        emit BountyPaid(user, gameId, tk, round, share, newStake);
    }

    // Winnings auto-compound into `bountyStake` and are cashed out by unstaking —
    // no separate withdraw path (the dead `unclaimedBounty` path was removed, A4).

    // ========== Bounty Stake / Unstake ==========

    /// @notice Lock ERC20 tokens to use as boost on future predictions.
    function stakeBountyToken(address token, uint256 amount) external nonReentrant {
        _stakeBountyToken(token, amount);
    }

    /// @notice `stakeBountyToken`, allowance granted by signature in the same tx.
    /// @dev One permit only (staking moves the staker's own token, no SATORI fee).
    function stakeBountyTokenWithPermit(
        address token, uint256 amount, SatoriTypes.TokenPermit calldata p
    ) external nonReentrant {
        _tryTokenPermit(token, address(this), p);
        _stakeBountyToken(token, amount);
    }

    function _stakeBountyToken(address token, uint256 amount) private {
        _requireBountyEnabled();
        if (amount == 0) revert BadInput();
        if (token == address(0)) revert BadInput();
        address user = msg.sender;

        // Deliberately NOT marked as a participant: staking a bounty token does
        // not delegate prediction power, and the transfer hook syncs prediction
        // delegation only, so a staker's SATORI balance moves need no sync.
        // Only delegating out marks you (rewards.delegatePredictionPower).

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(user, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;
        if (received == 0) revert ZeroReceived();

        uint256 prior = bountyStake[user][token];
        bountyStake[user][token] = prior + received;

        if (prior == 0) {
            userStakedTokens[user].push(token);
        }

        emit BountyTokenStaked(user, token, received, prior + received);
    }

    /**
     * @notice Unlock a previously-staked token. Blocked until round R+1 if the
     *         caller used this token's stake to boost a prediction in round R
     *         (see `stakeLockedUntil`) — this prevents the cycle attack. The
     *         predict-time snapshot still pays out independently of this gate.
     */
    function unstakeBountyToken(address token, uint256 amount, address recipient) external nonReentrant {
        if (recipient == address(0)) revert BadInput();
        if (amount == 0) revert BadInput();
        if (stakeLockedUntil[msg.sender][token] > ISatoriCore(satoriCore).getCurrentRound()) revert StakeLocked();
        uint256 current = bountyStake[msg.sender][token];
        if (amount > current) revert InsufficientStake();
        uint256 remaining = current - amount;
        bountyStake[msg.sender][token] = remaining;

        if (remaining == 0) {
            _popUserStakedToken(msg.sender, token);
        }

        IERC20(token).safeTransfer(recipient, amount);
        emit BountyTokenUnstaked(msg.sender, token, recipient, amount, remaining);
    }

    function _popUserStakedToken(address user, address token) internal {
        address[] storage tokens = userStakedTokens[user];
        uint256 len = tokens.length;
        for (uint256 i = 0; i < len; i++) {
            if (tokens[i] == token) {
                tokens[i] = tokens[len - 1];
                tokens.pop();
                return;
            }
        }
    }

    // ========== Predict-time Auto-Boost ==========

    /**
     * @notice Apply the auto-boost step. Called by `SatoriEngine._makePrediction`
     *         at predict time. Snapshots boost stake per (user, game, round, T)
     *         for every token T the user has staked AND the game has a live bounty in.
     */
    function applyBoost(
        address user,
        uint32 gameId,
        uint256 round,
        uint96 key,
        uint256 multiplier
    ) external override onlyCoreOrRewards returns (bool boosted) {
        if (gameBountyTokens[gameId].length == 0) return false;
        if (multiplier == 0) return false;

        address[] storage staked = userStakedTokens[user];
        uint256 n = staked.length;
        uint32 r = uint32(round);
        for (uint256 i = 0; i < n; i++) {
            address tk = staked[i];
            if (!_gameTokenSeen[gameId][tk]) continue;
            uint256 boost = bountyStake[user][tk];
            if (boost == 0) continue;
            if (pool[gameId][tk] == 0 || ratePerRound[gameId][tk] == 0) continue;
            uint256 weightedBoost = boost * multiplier;
            _totalBoostStakeByKey[gameId][r][key][tk] += weightedBoost;
            // Asymmetry: the key-keyed total accumulates (+=) across predictors,
            // while this per-user snapshot is key-LESS and ASSIGNED (=). Safe: at
            // settle only the WINNING key is credited, so a user's snapshot can
            // only match the one key total it contributed to.
            boostStakeForPrediction[user][gameId][round][tk] = weightedBoost;
            boosted = true;
            // Record tk in this round's boosted-token set so score-time payout
            // survives an unstake after the lock. Dedup so a token predicted
            // across several games in one round is paid once.
            address[] storage roundToks = boostedTokensInRound[user][round];
            uint256 m = roundToks.length;
            bool seen = false;
            for (uint256 j = 0; j < m; j++) {
                if (roundToks[j] == tk) { seen = true; break; }
            }
            if (!seen) roundToks.push(tk);
            // Cycle-attack guard: lock this token's stake until round R+1.
            uint64 nextRound = uint64(round + 1);
            if (stakeLockedUntil[user][tk] < nextRound) {
                stakeLockedUntil[user][tk] = nextRound;
            }
        }
    }

    // ========== Finalize-time bookkeeping ==========

    /**
     * @notice Clear the per-(user, round) boosted-token set once the user's LAST
     *         prediction for `round` has finalized (no further `creditBountyForWin`
     *         can read it). Called by `SatoriRewards.notifyPredictionFinalized`.
     */
    function clearRoundBountyList(address user, uint256 round) external override onlyRewards {
        delete boostedTokensInRound[user][round];
    }

    // ========== Adapter bounty (score/total, single active token) ==========

    /// @notice Adapter predict-time stake snapshot for the round's single ACTIVE
    ///         bounty token. Snapshots + locks the caller's stake; returns it so
    ///         the core can fold it into the adapter's bountyTotal. 0 ⇒ no live
    ///         bounty or no stake.
    function snapshotAdapterStake(address user, uint32 gameId, uint256 round)
        external override onlyCoreOrRewards returns (uint256 stake)
    {
        address T = _adapterActiveToken[gameId][round];
        if (T == address(0)) {
            T = _firstFundedToken(gameId);
            _adapterActiveToken[gameId][round] = (T == address(0)) ? SENTINEL_NONE : T;
        }
        if (T == SENTINEL_NONE) return 0;
        uint256 s = bountyStake[user][T];
        if (s == 0) return 0;
        boostStakeForPrediction[user][gameId][round][T] = s;
        uint64 nextRound = uint64(round + 1);
        if (stakeLockedUntil[user][T] < nextRound) stakeLockedUntil[user][T] = nextRound;
        return s;
    }

    function _firstFundedToken(uint32 gameId) internal view returns (address) {
        address[] storage list = gameBountyTokens[gameId];
        uint256 n = list.length;
        for (uint256 i = 0; i < n; i++) {
            address tk = list[i];
            if (pool[gameId][tk] != 0 && ratePerRound[gameId][tk] != 0) return tk;
        }
        return address(0);
    }

    /// @notice Adapter score-time bounty credit (score/total, single token).
    /// @dev Bounty num computed SATURATING so a hostile adapter can't brick settle
    ///      nor exceed the pot.
    function creditAdapterBounty(address user, uint32 gameId, uint256 round, uint256 userScore, uint256 bountyTotal)
        external override onlyRewards
    {
        address T = _adapterActiveToken[gameId][round];
        if (T == address(0) || T == SENTINEL_NONE) return;
        if (userScore == 0) return;

        uint256 pinnedPlus1 = _adapterBountyTotal[gameId][round];
        uint256 bt;
        if (pinnedPlus1 == 0) {
            // AUDIT B-1. `bountyTotal` arrives verbatim from the UNTRUSTED adapter.
            // The +1 is the "0 means unset" encoding; at type(uint256).max it
            // overflowed and reverted, bricking settle forever while satisfying
            // "score must not revert". Saturate: max clamps down one (harmless —
            // the value is only a denominator) and keeps the encoding total.
            bt = bountyTotal == type(uint256).max ? type(uint256).max - 1 : bountyTotal;
            _adapterBountyTotal[gameId][round] = bt + 1;
        }
        else { bt = pinnedPlus1 - 1; }
        if (bt == 0) return;

        uint256 paid = _adapterBountyPaid[gameId][round];
        if (paid >= bt) return;
        uint256 room = bt - paid;

        uint256 stake = boostStakeForPrediction[user][gameId][round][T];
        if (stake == 0) return;

        uint256 bountyNum;
        if (userScore > type(uint256).max / stake) { bountyNum = room; }
        else { uint256 prod = userScore * stake; bountyNum = prod > room ? room : prod; }
        _adapterBountyPaid[gameId][round] = paid + bountyNum;

        _dripTokenForRound(gameId, uint32(round), T);
        _accrueAdapterBounty(user, gameId, round, T, bountyNum, bt);
    }

    /// @dev share = pot × num/denom; winnings auto-restake. No payout fee.
    function _accrueAdapterBounty(address user, uint32 gameId, uint256 round, address tk, uint256 num, uint256 denom) internal {
        uint256 pot = roundBountyPot[gameId][uint32(round)][tk];
        if (pot == 0) return;
        uint256 share = Math.mulDiv(pot, num, denom);
        if (share == 0) return;
        // Mirror the binary rail: without recording `claimed`, reclaimStrandedPot
        // would later sweep the ENTIRE already-paid pot back to `pool`,
        // double-spending it (audit F2).
        roundBountyPotClaimed[gameId][uint32(round)][tk] += share;
        _payBounty(user, gameId, uint32(round), tk, share);
    }

    // ========== Bounty Views ==========

    function userStakedTokenCount(address user) external view returns (uint256) {
        return userStakedTokens[user].length;
    }

    function boostedTokenCountInRound(address user, uint256 round) external view returns (uint256) {
        return boostedTokensInRound[user][round].length;
    }

    function gameBountyTokenCount(uint32 gameId) external view returns (uint256) {
        return gameBountyTokens[gameId].length;
    }

    // ========== Internal Helpers ==========

    function _currentRound() private view returns (uint256) {
        return ISatoriCore(satoriCore).getCurrentRound();
    }

    // ---- Restructure-era additions. ----
    /// @notice The SatoriEngine, a second authorized caller of onlyCoreOrRewards.
    address public satoriEngine;
    /// @notice The SATORI token (falls back to satoriCore when address(0)).
    address public satoriToken;

    // ========== Phase-2 proxy plumbing (appended — append-only layout) ==========

    bool private _initialized;

    /// @dev Pinned by SatoriUUPS.upgradeTo so only another SatoriBounties
    ///      implementation can ever be installed here.
    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriBounties");
    }

    function _upgradeGovernor() internal view override returns (address) {
        return ISatoriUpgradeAuthority(satoriToken).upgradeAuthority();
    }
}
