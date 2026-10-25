// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice The rotation interface a parent splitter (one this splitter holds a
///         slot in) exposes; `rotateAt` is the only place this contract calls it.
interface IRotatableRecipient {
    function rotateRecipient(address newPayee) external;
}

/**
 * @title SatoriSplitterImmutable
 * @notice Frozen-shares splitter for native ETH and any ERC20. The recipient set
 *         and their shares are fixed at construction and can NEVER change. Each
 *         recipient pulls its own cut on demand.
 * @dev This is the ONLY splitter. Two mutable-share designs were explored and
 *      then deleted rather than kept alongside it; see docs/narratives/A_splitter.md.
 *
 *      WHAT IS GONE, AND WHY IT COULD GO
 *      ---------------------------------
 *      A mutable-share splitter exists to answer one question: when the shares
 *      change, how do you avoid rewriting the past? Both answers are expensive.
 *      Pre-dividing funds into buckets on a poke costs O(recipients) per poke and
 *      needs an arrival hook that ERC20 does not provide. An accPerShare
 *      accumulator must be checkpointed across EVERY token the contract has ever
 *      held before any share change — O(tokens) per change — which forces a
 *      curated, manager-gated token registry, because otherwise anyone can make
 *      share changes unaffordable by airdropping junk.
 *
 *      If shares can never change, the question never arises. So:
 *        - no `manager`, `addRecipient`, `setShares`, `removeRecipient`
 *        - no `lockSlot` / `unlockSlot` (a lock binds a manager; there is none)
 *        - no `distribute` / `sync` poke, and no arrival hook problem to solve
 *        - no `bucket` / `accPerShare` / `checkpoint` / `distributed` state
 *        - NO TOKEN REGISTRY AT ALL. `trackToken`, `isTracked`, `_trackedTokens`
 *          and `TokenNotTracked` are all gone. Nothing is ever iterated, so
 *          there is nothing to bound, so there is nothing to gate. Any token
 *          this contract has ever received is withdrawable by name, forever, by
 *          anyone, with no registration step. Junk tokens are inert by
 *          construction rather than by policy.
 *      The orphaned-funds window (audit F13) and registry-griefing (audit F25)
 *      surfaces are structurally absent, not defended against.
 *
 *      ACCOUNTING
 *      ----------
 *      Per token, `received = balance + withdrawn` is everything this contract
 *      has ever taken in. A slot's lifetime entitlement is
 *      `floor(received * shares / totalShares)`, and it has already been paid
 *      `claimed`. Withdrawing pays the difference. That is the whole model —
 *      one division, no poke, no per-recipient loop, O(1) forever.
 *
 *      Entitlement is computed on the CUMULATIVE total, not per-arrival. This is
 *      the one refinement over the obvious formulation ("pay me my share of what
 *      arrived since I last withdrew"), and it matters: flooring the running
 *      total means the rounding remainder is at most `slotCount - 1` wei IN
 *      TOTAL, FOREVER, and is recovered as later funds arrive. Flooring each
 *      arrival separately — what the deleted bucket design did — permanently strands
 *      up to that much on EVERY distribution. Same simplicity, strictly less dust.
 *
 *      SOLVENCY BY CONSTRUCTION
 *      ------------------------
 *        Σ floor(received * sᵢ / S)  <=  received          (since Σ sᵢ == S)
 *        withdrawn == Σ claimedᵢ  <=  Σ entitledᵢ  <=  received
 *        balance == received - withdrawn                    (definition)
 *      Therefore Σ (entitledᵢ - claimedᵢ) <= balance: the contract can never owe
 *      more than it holds, at any instant, with no bookkeeping to get wrong. A
 *      defensive min(owed, balance) clamp on withdraw covers misbehaving
 *      (rebasing-DOWN) tokens, which are unsupported.
 *
 *      ROLES
 *      -----
 *        - Slot payee : rotateRecipient (move its OWN slot's address),
 *                       setWithdrawCaller (who may TRIGGER its own payouts),
 *                       approveRotation / revokeRotation (vote on where THIS
 *                       splitter's slot in a parent points).
 *        - Authority  : rotateAt, unilaterally and without consent — until it
 *                       renounces, after which only the consent path remains.
 *                       It has NO other power: it cannot change shares (nothing
 *                       can), cannot withdraw, cannot touch a payee's address,
 *                       and cannot open or close anyone's withdraw gate.
 *        - Anyone     : withdraw for any slot that has not named a caller (funds
 *                       always go to the slot's payee either way), execute a
 *                       rotation that has already reached consent, all views.
 *
 *      RENEGOTIATION
 *      -------------
 *      Frozen shares mean the split is renegotiated by DEPLOYING A NEW SPLITTER
 *      and repointing the parent's slot at it — which is what `rotateAt` is for.
 *      A splitter has no generic outbound call, so a splitter holding a slot in
 *      another splitter could never move it; that ability has to
 *      be in the bytecode from the start, because retrofitting it would itself
 *      require the ability being retrofitted. `rotateAt` is that escape hatch.
 *
 *      ETH is the sentinel address(0).
 */
contract SatoriSplitterImmutable is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant ETH = address(0);

    /// @notice Shares are basis points and MUST total exactly 100%. Unlike the
    ///         mutable splitters (where a sub-100% total left room to add
    ///         recipients and so a share was only a FLOOR on the effective
    ///         percentage), nothing can ever be added here — so an under-allocated
    ///         total would be behaviourally identical to scaling everyone up,
    ///         while inviting people to misread their bps as their percentage.
    ///         Requiring exactly 10000 makes `shares` literally the percentage,
    ///         permanently and unambiguously.
    uint256 public constant MAX_TOTAL_SHARES = 10000;

    /// @notice The threshold used when the constructor is passed 0. Deliberately
    ///         90% rather than 100%: true unanimity would let a single lost key
    ///         freeze the escape hatch forever, which in an immutable contract is
    ///         unrecoverable. On a table where every holder has an equal large
    ///         share (C's 50/50), 90% still needs both: it is unanimity there.
    uint256 public constant DEFAULT_ROTATION_THRESHOLD_BPS = 9000;

    /// @notice Share weight (of `totalShares`) that must approve a rotation for
    ///         it to execute without the authority. Chosen at construction, fixed
    ///         forever after. Any value from 1 to 10000 is accepted; 10000 is
    ///         true unanimity, with the lost-key caveat above.
    ///
    ///         The only rejected values are 0 (reserved as the "use the default"
    ///         sentinel) and anything above 10000 — which no vote could ever
    ///         reach, and which would therefore seal the consent door forever.
    ///         That is a correctness check, not a policy on how low you may go.
    ///
    ///         Deliberately unopinionated below that, but know the consequence:
    ///         any recipient whose OWN share is >= this threshold can rotate
    ///         ALONE, and a threshold at or under half lets holders of a minority
    ///         of the revenue redirect all of it. Choose it against your actual
    ///         share table, not in the abstract.
    ///
    ///         Note also that approving one proposal does not preclude approving
    ///         another, so two incompatible rotations can both stand approved at
    ///         once regardless of threshold. That is a race, not a flaw: the
    ///         first to execute bumps the epoch and voids the other, whose
    ///         supporters must then re-approve.
    uint256 public immutable rotationThresholdBps;

    struct Slot {
        address payee;   // the ONLY mutable field on a slot (rotateRecipient)
        uint256 shares;  // set at construction, never written again
    }

    // ========== Recipients (fixed at construction) ==========

    /// @dev Fixed length and fixed shares — there is no function that pushes,
    ///      pops, or writes `.shares`. Only `.payee` is ever reassigned.
    Slot[] private _slots;

    /// @notice 1-based slot id for an address (0 == not a recipient).
    mapping(address => uint256) private _slotOfPlusOne;

    /// @notice slotId => the only address allowed to call `withdraw` for that
    ///         slot. `address(0)` — the untouched default for every slot — means
    ///         ANYONE may, which is the behaviour of every earlier revision and
    ///         the behaviour a splitter-to-splitter tree depends on.
    ///
    ///         This gates the TRIGGER, never the DESTINATION. Funds go to
    ///         `_slots[slotId].payee` on every path, so the only thing a gate can
    ///         decide is WHEN someone's own money moves, never whose it is.
    ///
    ///         The payee is always permitted regardless of this value (see
    ///         `withdraw`), and only the payee can write it (see
    ///         `setWithdrawCaller`). Those two together give the invariant the
    ///         design rests on:
    ///
    ///           A NON-ZERO GATE IMPLIES THE CURRENT PAYEE SET IT — AND A PAYEE
    ///           THAT COULD SET IT CAN ALSO CLEAR IT, AND CAN ALWAYS WITHDRAW.
    ///
    ///         So a gate can never strand funds. A payee that cannot originate
    ///         calls — a child splitter — can never acquire one either, which is
    ///         why every internal tier of a tree stays permissionless by
    ///         construction; and `rotateRecipient` clears the gate, which is what
    ///         carries the invariant across a change of hands.
    mapping(uint256 => address) public withdrawCaller;

    /// @notice Σ of all slots' shares — the division denominator. Always
    ///         MAX_TOTAL_SHARES; kept as its own immutable for readability.
    uint256 public immutable totalShares;

    /// @notice May trigger `rotateAt` with no consent, transfer that right, or
    ///         renounce it forever. That is its complete power set.
    address public authority;
    /// The address `transferAuthority` named; it becomes the authority when it accepts.
    address public pendingAuthority;

    // ========== Per-token accounting (lazy, unregistered) ==========

    /// @notice token => cumulative amount ever paid out.
    mapping(address => uint256) public withdrawn;

    /// @notice token => slotId => cumulative amount ever paid to that slot.
    mapping(address => mapping(uint256 => uint256)) public claimed;

    // ========== Rotation consent ==========

    /// @notice parent => how many rotations of our slot in it have executed.
    ///         Folded into the proposal id so a completed rotation consumes its
    ///         approvals and can never be replayed by a later identical one.
    mapping(address => uint256) public rotationEpoch;

    /// @notice proposal id => Σ shares of slots currently approving it.
    mapping(bytes32 => uint256) public approvedShares;

    /// @notice proposal id => slotId => has this slot approved.
    mapping(bytes32 => mapping(uint256 => bool)) public approved;

    // ========== Events ==========

    event Withdrawn(address indexed token, uint256 indexed slotId, address indexed to, uint256 amount);
    event RecipientRotated(uint256 indexed slotId, address indexed oldPayee, address indexed newPayee);
    /// @dev Also emitted for the implicit clear inside `rotateRecipient`, so an
    ///      indexer never has to infer a gate change from a rotation.
    event WithdrawCallerSet(uint256 indexed slotId, address indexed caller);
    event AuthorityTransferred(address indexed previousAuthority, address indexed newAuthority);
    event AuthorityTransferStarted(address indexed currentAuthority, address indexed pendingAuthority);
    event SlotCreated(uint256 indexed slotId, address indexed payee, uint256 shares);
    /// Once, after every SlotCreated. `authority` may be zero (consent-only), which
    /// AuthorityTransferred does not record; the threshold is the resolved one.
    event SplitterCreated(address indexed authority, uint256 slotCount, uint256 rotationThresholdBps);
    event RotationApproved(bytes32 indexed proposal, uint256 indexed slotId, address parent, address newPayee, uint256 approvedSharesNow);
    event RotationRevoked(bytes32 indexed proposal, uint256 indexed slotId, uint256 approvedSharesNow);
    event RotatedAt(address indexed parent, address indexed newPayee, address indexed caller, bool byAuthority, uint256 epoch);

    // ========== Errors ==========

    error ZeroAddress();
    error PayeeIsSelf();
    error ZeroShares();
    error AlreadyRecipient();
    error NotARecipient();
    error UnknownSlot();
    error NothingToWithdraw();
    error EthTransferFailed();
    error NotAuthority();
    error NotPendingAuthority();
    error NotWithdrawCaller();
    error LengthMismatch();
    error NoRecipients();
    error SharesMustTotal100Percent();
    error ThresholdOutOfRange();
    error AlreadyApproved();
    error NotApproved();
    error InsufficientConsent();

    /**
     * @param initialAuthority Address that may rotate this splitter's slot in a
     *                         parent without consent. Pass address(0) to launch
     *                         with no authority at all (consent-only from day
     *                         one).
     * @param payees           Recipient addresses. Fixed forever (each payee may
     *                         later move its own slot via rotateRecipient).
     * @param shares_          Basis points per payee, parallel to `payees`. Must
     *                         total exactly 10000.
     * @param rotationThresholdBps_ Share weight required to pass a rotation
     *                         without the authority. Pass 0 for the 90% default,
     *                         or any value up to 10000. Read the note on
     *                         `rotationThresholdBps` before choosing a low one.
     */
    constructor(
        address initialAuthority,
        address[] memory payees,
        uint256[] memory shares_,
        uint256 rotationThresholdBps_
    ) {
        if (payees.length != shares_.length) revert LengthMismatch();
        if (payees.length == 0) revert NoRecipients();

        uint256 sum;
        for (uint256 i = 0; i < payees.length; i++) {
            address payee = payees[i];
            if (payee == address(0)) revert ZeroAddress();
            if (payee == address(this)) revert PayeeIsSelf(); // see rotateRecipient
            if (shares_[i] == 0) revert ZeroShares();
            if (_slotOfPlusOne[payee] != 0) revert AlreadyRecipient();

            _slots.push(Slot({payee: payee, shares: shares_[i]}));
            _slotOfPlusOne[payee] = i + 1;
            sum += shares_[i];
            emit SlotCreated(i, payee, shares_[i]);
        }
        if (sum != MAX_TOTAL_SHARES) revert SharesMustTotal100Percent();
        totalShares = sum;

        // 0 means "use the default". Only an unreachable threshold is refused:
        // above 10000 no vote could ever pass, which would silently and
        // permanently seal the consent door.
        uint256 threshold = rotationThresholdBps_ == 0
            ? DEFAULT_ROTATION_THRESHOLD_BPS
            : rotationThresholdBps_;
        if (threshold > MAX_TOTAL_SHARES) revert ThresholdOutOfRange();
        rotationThresholdBps = threshold;

        authority = initialAuthority;
        if (initialAuthority != address(0)) emit AuthorityTransferred(address(0), initialAuthority);
        emit SplitterCreated(initialAuthority, payees.length, threshold);
    }

    /// @notice Accept native ETH. No hook needed — entitlement is derived from
    ///         the balance at withdrawal time, so arrival requires no bookkeeping.
    receive() external payable {}

    modifier onlyAuthority() {
        if (msg.sender != authority) revert NotAuthority();
        _;
    }

    // ========== Authority ==========

    /// @notice Offer the rotation right to someone else. Authority-only. The right
    ///         moves only when `newAuthority` calls `acceptAuthority`, so a mistyped
    ///         address cannot take it. The zero address gives it up at once
    ///         (the same as `renounceAuthority`). A new offer replaces the last.
    function transferAuthority(address newAuthority) external onlyAuthority {
        if (newAuthority == address(0)) {
            _renounce();
            return;
        }
        pendingAuthority = newAuthority;
        emit AuthorityTransferStarted(authority, newAuthority);
    }

    /// @notice Take the rotation right the current authority offered to the caller.
    function acceptAuthority() external {
        if (msg.sender != pendingAuthority) revert NotPendingAuthority();
        emit AuthorityTransferred(authority, msg.sender);
        authority = msg.sender;
        pendingAuthority = address(0);
    }

    /// @notice Give up the unilateral rotation right forever. After this, the
    ///         only way this splitter's slot in a parent can move is
    ///         `rotationThresholdBps` share consent of its own recipients. At or
    ///         below 5000 that is not set in stone: a recipient holding that share
    ///         can still move the slot alone, and nobody can undo it.
    function renounceAuthority() external onlyAuthority {
        _renounce();
    }

    function _renounce() private {
        emit AuthorityTransferred(authority, address(0));
        authority = address(0);
        pendingAuthority = address(0);
    }

    // ========== Withdraw (pull) ==========

    /// @notice Amount of `token` currently withdrawable by slot `slotId`.
    /// @dev Lifetime entitlement minus what has already been paid. Works for ANY
    ///      token address with no registration. Reads live balance, so funds that
    ///      arrived one second ago are already reflected — there is no pending or
    ///      undistributed state in this design.
    ///
    ///      The `entitled > paid` guard is not decoration: for a standard token
    ///      `received` only grows so entitlement is monotonic, but a rebasing-DOWN
    ///      token (unsupported) can shrink the balance below what was already
    ///      paid out, and this returns 0 instead of underflowing.
    function releasable(address token, uint256 slotId) public view returns (uint256) {
        if (slotId >= _slots.length) return 0;
        uint256 received = _currentBalance(token) + withdrawn[token];
        uint256 entitled = (received * _slots[slotId].shares) / totalShares;
        uint256 paid = claimed[token][slotId];
        return entitled > paid ? entitled - paid : 0;
    }

    /// @notice Withdraw `token` owed to slot `slotId`. Funds always go to that
    ///         slot's payee, never to `msg.sender`.
    /// @dev Anyone may trigger it unless the slot has named a caller, in which
    ///      case only that address — or the payee itself, always — may. See
    ///      `withdrawCaller`.
    function withdraw(address token, uint256 slotId) public nonReentrant returns (uint256 amount) {
        if (slotId >= _slots.length) revert UnknownSlot();

        // Permission is settled before anything else is read or written, so a
        // call that was never allowed to happen touches nothing at all. The gate
        // is read once, here: a payee that moves it from inside its own receive
        // hook can therefore only ever bind the NEXT withdrawal.
        address to = _slots[slotId].payee;
        address gate = withdrawCaller[slotId];
        if (gate != address(0) && msg.sender != gate && msg.sender != to) revert NotWithdrawCaller();

        uint256 owed = releasable(token, slotId);
        if (owed == 0) revert NothingToWithdraw();

        // Defensive solvency clamp: never attempt to pay more than the contract
        // holds. For standard tokens owed <= balance always (see the solvency
        // proof in the contract header), so this is inert; it only matters for
        // misbehaving tokens, where it stops one slot from bricking and leaves
        // the rest claimable. Any clamped shortfall stays claimable because only
        // `amount` — not `owed` — is added to `claimed`.
        uint256 bal = _currentBalance(token);
        amount = owed <= bal ? owed : bal;
        if (amount == 0) revert NothingToWithdraw();

        // Checks-effects-interactions: update accounting BEFORE paying. Both
        // counters move by the same `amount`, so `received` is invariant across
        // a withdrawal and no one else's entitlement shifts.
        claimed[token][slotId] += amount;
        withdrawn[token] += amount;

        _payOut(token, to, amount);
        emit Withdrawn(token, slotId, to, amount);
    }

    /// @notice Withdraw `token` for the caller's own slot. Never blocked by that
    ///         slot's own gate — a payee is always allowed to trigger itself.
    function withdrawMine(address token) external returns (uint256) {
        return withdraw(token, _slotIdOf(msg.sender));
    }

    /**
     * @notice A payee chooses who may TRIGGER its own slot's payouts.
     * @param caller The only address allowed to call `withdraw` for this slot,
     *               or `address(0)` to reopen it to anyone. Typically the payee's
     *               own address, which simply closes the door to everyone else.
     * @dev Reversible in both directions, and scoped to the caller's own slot:
     *      `_slotIdOf` reverts `NotARecipient`, so nobody can gate a slot they do
     *      not hold and the authority has no path here at all.
     *
     *      The payee stays allowed whatever it sets, because delegating the
     *      trigger is not surrendering it — and refusing the payee would be
     *      theatre anyway, since it can flip this back in one transaction. The
     *      only thing strictness would buy is a `withdrawMine` that reverts on
     *      its owner's own slot.
     *
     *      Deliberately NOT `nonReentrant`. A contract payee can reach this from
     *      its ETH receive hook mid-payout, which is harmless: `withdraw` reads
     *      the gate before touching any accounting, so a later write cannot
     *      affect the in-flight payout, only the next one.
     */
    function setWithdrawCaller(address caller) external {
        uint256 slotId = _slotIdOf(msg.sender);
        withdrawCaller[slotId] = caller;
        emit WithdrawCallerSet(slotId, caller);
    }

    // ========== Slot payee: address rotation ==========

    /**
     * @notice The current payee of a slot moves it to `newPayee`.
     * @dev O(1): all accounting is keyed by slot id, so `claimed` follows the
     *      slot automatically. Cannot create a slot, cannot change shares, and
     *      cannot collide with an existing recipient. Unaffected by the
     *      authority being renounced — freezing governs rotation of the slot
     *      ABOVE, never a payee's control of its own address.
     *
     *      Any rotation votes this slot has cast stay with the SLOT, so the new
     *      payee inherits them and can `revokeRotation` if it disagrees. The
     *      withdraw gate is the one thing that does NOT carry over; the reason is
     *      at the clear below.
     *
     *      `address(this)` is REFUSED, and that guard is load-bearing rather than
     *      hygiene. `received` is defined as `balance + withdrawn`, so paying a
     *      slot whose payee is this contract would leave the balance untouched
     *      while `withdrawn` grew — manufacturing receipts out of nothing. In
     *      testing, one 60% slot pointed at the splitter and self-paid in a loop
     *      inflated `totalReceived` from 10 to ~25 ETH and lifted the other
     *      slots' entitlements from 3/1 to 7.49/2.50. It is not an insolvency
     *      (Σ owed <= received - withdrawn == balance holds by definition, so the
     *      contract still never owes more than it holds) and nothing is stolen —
     *      the self-paying slot destroys its OWN claim and gifts it to the
     *      others. But it silently rewrites the split, corrupts `totalReceived`
     *      for any off-chain reader, and is IRREVERSIBLE: once the slot points
     *      here, only this contract could move it back, and it has no way to
     *      originate that call. The slot would be bricked forever, its future
     *      share burnable by anyone at any time.
     *
     *      Together with the identical check in the constructor this is
     *      exhaustive — those are the only two places `.payee` is ever written.
     */
    function rotateRecipient(address newPayee) external {
        if (newPayee == address(0)) revert ZeroAddress();
        if (newPayee == address(this)) revert PayeeIsSelf();
        uint256 idPlusOne = _slotOfPlusOne[msg.sender];
        if (idPlusOne == 0) revert NotARecipient();
        if (_slotOfPlusOne[newPayee] != 0) revert AlreadyRecipient();

        uint256 slotId = idPlusOne - 1;
        delete _slotOfPlusOne[msg.sender];
        _slotOfPlusOne[newPayee] = idPlusOne;
        _slots[slotId].payee = newPayee;
        emit RecipientRotated(slotId, msg.sender, newPayee);

        // The withdraw gate does NOT follow the slot, and clearing it is what
        // keeps the `withdrawCaller` invariant true across a change of hands.
        // Only a payee can set a gate, so letting one survive would allow a gated
        // slot to be rotated onto a contract that cannot call
        // `setWithdrawCaller` — welding the payout trigger to a third party's key
        // with no way back, and freezing the slot for good the day that key is
        // lost. Clearing fails open instead: the new holder inherits working,
        // permissionless payouts and re-gates in one call if it wants to. The
        // accepted cost is that a routine key rotation reopens the slot until it
        // is re-set, which is recoverable where the freeze would not be.
        if (withdrawCaller[slotId] != address(0)) {
            delete withdrawCaller[slotId];
            emit WithdrawCallerSet(slotId, address(0));
        }
    }

    // ========== Rotating THIS splitter's slot in a parent ==========

    /// @notice Deterministic id for the proposal "move our slot in `parent` to
    ///         `newPayee`". Includes this contract (so an approval can't be
    ///         replayed against a sibling splitter) and the parent's rotation
    ///         epoch (so executing a rotation consumes its approvals).
    function proposalId(address parent, address newPayee) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), parent, newPayee, rotationEpoch[parent]));
    }

    /// @notice A slot payee approves moving this splitter's slot in `parent` to
    ///         `newPayee`. Tally is kept incrementally, so counting is O(1) and
    ///         no loop over recipients is ever needed.
    function approveRotation(address parent, address newPayee) external {
        uint256 slotId = _slotIdOf(msg.sender);
        bytes32 id = proposalId(parent, newPayee);
        if (approved[id][slotId]) revert AlreadyApproved();

        approved[id][slotId] = true;
        uint256 tally = approvedShares[id] + _slots[slotId].shares;
        approvedShares[id] = tally;
        emit RotationApproved(id, slotId, parent, newPayee, tally);
    }

    /// @notice Withdraw a previously cast approval, while it is still pending.
    function revokeRotation(address parent, address newPayee) external {
        uint256 slotId = _slotIdOf(msg.sender);
        bytes32 id = proposalId(parent, newPayee);
        if (!approved[id][slotId]) revert NotApproved();

        approved[id][slotId] = false;
        uint256 tally = approvedShares[id] - _slots[slotId].shares;
        approvedShares[id] = tally;
        emit RotationRevoked(id, slotId, tally);
    }

    /**
     * @notice Tell `parent` to move this contract's slot to `newPayee` — a new
     *         splitter, or any address at all.
     * @dev Two independent doors:
     *        - the AUTHORITY, unilaterally, with no consent; or
     *        - ANYONE, once slots holding >= `rotationThresholdBps` of
     *          `totalShares` have approved this exact (parent, newPayee, epoch).
     *      Renouncing the authority permanently closes the first door and leaves
     *      only the second.
     *
     *      This is the single most dangerous power in the contract: it redirects
     *      ALL FUTURE income from `parent` to `newPayee`, and the slot's
     *      unpulled balance goes with it (accounting is per slot). It cannot touch
     *      what the other slots are owed. Give the
     *      authority to someone you would give the revenue stream to, or pass
     *      address(0) at construction and never have the door at all.
     *
     *      Safety of the outbound call: the selector is fixed at compile time,
     *      so the only thing this call can invoke on `parent` is
     *      `rotateRecipient(address)`. This contract holds no token approvals and
     *      has no generic call path, so a hostile `parent` gains nothing but a
     *      reentry attempt, which `nonReentrant` refuses. The epoch is bumped
     *      before the call (CEI).
     */
    function rotateAt(address parent, address newPayee) external nonReentrant {
        if (parent == address(0) || newPayee == address(0)) revert ZeroAddress();

        bool byAuthority = msg.sender == authority && authority != address(0);
        if (!byAuthority) {
            bytes32 id = proposalId(parent, newPayee);
            // approvedShares / totalShares >= rotationThresholdBps / 10000,
            // cross-multiplied to avoid division. Both sides are bounded by
            // 10000 * 10000, so there is no overflow risk.
            if (approvedShares[id] * MAX_TOTAL_SHARES < totalShares * rotationThresholdBps) {
                revert InsufficientConsent();
            }
        }

        uint256 epoch = rotationEpoch[parent] + 1;
        rotationEpoch[parent] = epoch; // consumes this proposal's approvals
        emit RotatedAt(parent, newPayee, msg.sender, byAuthority, epoch);

        IRotatableRecipient(parent).rotateRecipient(newPayee);
    }

    /// @notice Whether a rotation proposal has cleared the consent threshold.
    function rotationApproved(address parent, address newPayee) external view returns (bool) {
        bytes32 id = proposalId(parent, newPayee);
        return approvedShares[id] * MAX_TOTAL_SHARES >= totalShares * rotationThresholdBps;
    }

    // ========== Internals ==========

    function _slotIdOf(address who) internal view returns (uint256) {
        uint256 idPlusOne = _slotOfPlusOne[who];
        if (idPlusOne == 0) revert NotARecipient();
        return idPlusOne - 1;
    }

    function _currentBalance(address token) internal view returns (uint256) {
        return token == ETH ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function _payOut(address token, address to, uint256 amount) internal {
        if (token == ETH) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ========== Views ==========

    function slotCount() external view returns (uint256) {
        return _slots.length;
    }

    function getSlot(uint256 slotId) external view returns (address payee, uint256 shares) {
        if (slotId >= _slots.length) revert UnknownSlot();
        Slot storage s = _slots[slotId];
        return (s.payee, s.shares);
    }

    function slotOf(address addr) external view returns (uint256) {
        return _slotIdOf(addr);
    }

    function isRecipient(address addr) external view returns (bool) {
        return _slotOfPlusOne[addr] != 0;
    }

    /// @notice Total of `token` this contract has ever taken in.
    function totalReceived(address token) external view returns (uint256) {
        return _currentBalance(token) + withdrawn[token];
    }
}
