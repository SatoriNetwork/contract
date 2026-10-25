// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/ISatoriCore.sol";
import "./next/SatoriUUPS.sol";
import "./interfaces/IMerkleLaneView.sol";

/**
 * @title SatoriMerkle
 * @notice The off-chain reward channel: a cumulative Merkle drop that mints
 *         through the Satori core's emission schedule as a SECOND,
 *         isolated mint authority.
 *
 *         Its claim path is runtime-independent of `SatoriRewards`: it reads and
 *         calls only the core, never `satoriRewards`, so a broken or paused rewards
 *         contract cannot disable claims directly. And since Phase 2b shipped, the
 *         two minters no longer merely share the emission budget — the CORE's
 *         `rewardMint` enforces STRICT per-lane reservation: this channel may mint
 *         at most `merkleReserveCumulative` (the accrued sum of the `offchainBudget`
 *         dial), and the on-chain lane gets the complement. So on-chain emission
 *         can't starve Merkle claims, and a compromised `rootPublisher` can never
 *         mint past the off-chain side's accrued reserve. Wired write-once into the
 *         core (`SatoriHub.setSatoriMerkle`, governor-gated) and never repointable.
 *
 *         DORMANT until activated: nothing mints here until an admin dials
 *         `offchainBudget > 0` (so the reserve accrues) AND a root is published.
 *         Before wiring it live (`setSatoriMerkle`), point `rootPublisher` at a
 *         trusted multisig — within its reserved lane a rogue publisher can still
 *         mint the accrued off-chain budget.
 *
 *         UPGRADEABLE since 2026-08-01 (was the one non-token contract with no
 *         upgrade path). It runs behind `SatoriProxy` like the hub and the five
 *         children: `upgradeTo` is gated on `token.upgradeAuthority()` and frozen
 *         forever by `renounceUpgrade()`. The two locks this contract used to
 *         carry have become one — the hub's pointer is STILL write-once, so a
 *         claim can never be redirected to a different contract, but the logic
 *         behind that permanent address can now be fixed. Read the trade that
 *         accepts: docs/issues/closed/merkle-behind-a-proxy-decision.md.
 */
contract SatoriMerkle is ReentrancyGuard, SatoriUUPS {
    address public satoriCore;

    address public rootPublisher;

    address public pendingRootPublisher;

    bytes32 public merkleRoot;

    mapping(address => uint256) public alreadyMintedTo;

    // The per-lane ceiling and the running total of Merkle mints live in the CORE
    // (`merkleMinted ≤ merkleReserveCumulative` in `SatoriHub.rewardMint`); this
    // contract keeps only the per-user cursor.

    event SatoriCoreSet(address indexed core);
    event RootPublisherTransferStarted(address indexed oldPublisher, address indexed pendingPublisher);
    event RootPublisherSet(address indexed oldPublisher, address indexed newPublisher);
    event MerkleRootUpdated(bytes32 indexed newRoot, address indexed publisher);
    event MerkleClaimed(address indexed user, uint256 lifetimeEntitlement, uint256 minted);

    error Unauthorized();
    error AlreadySet();
    error BadInput();
    error InvalidProof();
    error NothingToClaim();

    /// @dev Locks the raw implementation and NOTHING else. Unlike the other five
    ///      children (PHASE2-PROXY-ALL.md) this contract has no dual-mode
    ///      constructor: `initialize` is the only path that sets state, so a
    ///      direct-deployed SatoriMerkle is inert. That is deliberate — a
    ///      working direct deploy would be a fully functional NON-upgradeable
    ///      merkle, the exact shape the proxy decision retires, and the hub
    ///      pointer that wires one in is write-once. The dual mode exists for
    ///      the others because the Foundry suite constructs them directly;
    ///      nothing constructs this one.
    constructor() {
        _initialized = true;
    }

    /// @notice Proxy initializer — runs atomically inside `SatoriProxy`'s
    ///         constructor, so there is no window in which an uninitialized
    ///         merkle is callable.
    /// @param _rootPublisher initial publisher — point it at your multisig; the
    ///        publisher can rotate itself later via `setRootPublisher`.
    /// @param _token the SatoriToken. This is the upgrade ANCHOR: `upgradeTo`
    ///        and `renounceUpgrade` both resolve authority through
    ///        `_token.upgradeAuthority()`, and there is no setter for it, so a
    ///        wrong-but-non-zero value would freeze both forever with no
    ///        symptom until the first attempted upgrade. `_requireGovernorSource`
    ///        probes it once, here, while the deploy can still just be redone.
    function initialize(address _rootPublisher, address _token) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        if (_rootPublisher == address(0)) revert BadInput();
        _requireGovernorSource(_token);
        deployer = msg.sender;
        satoriToken = _token;
        rootPublisher = _rootPublisher;
        emit RootPublisherSet(address(0), _rootPublisher);
    }

    /// @dev `deployer` is STORAGE, set by `initialize`, so this authenticates
    ///      whoever deployed the PROXY. It was `immutable` before the proxy
    ///      conversion; an immutable lives in the implementation's bytecode, so
    ///      behind a proxy it would have held whoever deployed the logic copy —
    ///      wrong quietly rather than loudly.
    function setSatoriCore(address _core) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (satoriCore != address(0)) revert AlreadySet();
        if (_core == address(0)) revert BadInput();
        satoriCore = _core;
        emit SatoriCoreSet(_core);
    }

    /// @notice Publish/replace the cumulative Merkle root. Publisher-only. Roots
    ///         MUST be monotonic non-decreasing per user (a lowered entitlement is
    ///         rejected on claim, never underflows).
    function setMerkleRoot(bytes32 newRoot) external {
        if (msg.sender != rootPublisher) revert Unauthorized();
        merkleRoot = newRoot;
        emit MerkleRootUpdated(newRoot, msg.sender);
    }

    /// @notice Propose a new publisher (e.g. a new multisig). Current-publisher-only.
    ///         Two-step: the nominee must call `acceptRootPublisher`, so a mistyped
    ///         or keyless address can never take — and thus permanently brick — the
    ///         role. There is still no governor, admin, or deployer override on
    ///         this contract itself: a publisher handed to an address nobody
    ///         controls would end the off-chain channel. An `upgradeTo` could
    ///         now repair that — but only while the upgrade authority exists and
    ///         only by the same key that could rewrite the claim logic, and it
    ///         vanishes the instant `renounceUpgrade()` is called. The two-step
    ///         is therefore still the only protection that survives the freeze,
    ///         which is the state this contract is meant to end in. Mirrors
    ///         `SatoriToken.setRootAuthority`/`acceptRootAuthority` (audit LA-1).
    ///         Passing address(0) cancels a pending proposal.
    function setRootPublisher(address newPublisher) external {
        if (msg.sender != rootPublisher) revert Unauthorized();
        pendingRootPublisher = newPublisher;
        emit RootPublisherTransferStarted(rootPublisher, newPublisher);
    }

    /// @notice Accept a pending publisher handoff. Nominee-only — this is the step
    ///         that proves the incoming address is controlled by someone.
    function acceptRootPublisher() external {
        if (msg.sender != pendingRootPublisher) revert Unauthorized();
        emit RootPublisherSet(rootPublisher, pendingRootPublisher);
        rootPublisher = pendingRootPublisher;
        pendingRootPublisher = address(0);
    }

    /// @notice Claim your Merkle drop. `lifetimeEntitlement` is your cumulative
    ///         total in the current root; this mints the delta over what you've
    ///         already received — CLAMPED to the merkle lane's currently-accrued
    ///         reserve — and advances your cursor by what was actually PAID.
    ///         Idempotent (re-claiming a fully-paid root mints 0 → reverts
    ///         `NothingToClaim`) and monotonic (a lower entitlement can never
    ///         underflow — it simply has nothing to claim). Mints only to
    ///         `msg.sender`, through the core's shared cap; CEI-ordered, and
    ///         `rewardMint` is plain ERC20 with no claimer callback
    ///         (nonReentrant is belt-and-braces).
    ///
    ///         PARTIAL PAY (pre-launch review). Claims used to be all-or-nothing
    ///         against the accrued reserve: a claim larger than what had accrued
    ///         reverted entirely, so a large claimant could be starved
    ///         indefinitely by smaller ones draining the reserve first. Now an
    ///         over-sized claim pays out whatever the lane can afford and the
    ///         cursor advances only by that amount — the SAME entitlement and
    ///         proof stay valid, and re-claiming later collects the remainder as
    ///         more reserve accrues. Deliberately, the clamp only engages when
    ///         the lane has SOMETHING to pay: with zero headroom the mint is
    ///         attempted anyway and the core refuses it loudly (`BudgetExceeded`)
    ///         instead of this contract inventing a softer signal for the same
    ///         "nothing available" fact.
    function claimMerkle(uint256 lifetimeEntitlement, bytes32[] calldata proof) external nonReentrant {
        // OZ StandardMerkleTree leaf: double-hashed abi.encode(account, amount).
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, lifetimeEntitlement))));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();

        uint256 already = alreadyMintedTo[msg.sender];
        if (lifetimeEntitlement <= already) revert NothingToClaim(); // monotonic; no underflow
        uint256 claimable = lifetimeEntitlement - already;

        // Partial pay: clamp to the lane's live headroom (computed exactly as
        // SatoriHub.rewardMint will enforce it, same block, no state between).
        uint256 ceiling = IMerkleLaneView(satoriCore).merkleReserveCeiling();
        uint256 minted  = IMerkleLaneView(satoriCore).merkleMinted();
        uint256 available = ceiling > minted ? ceiling - minted : 0;
        if (available > 0 && claimable > available) claimable = available;

        alreadyMintedTo[msg.sender] = already + claimable; // cursor moves by what is PAID (CEI)
        ISatoriCore(satoriCore).rewardMint(msg.sender, claimable); // capped by the lane's banked reserve
        emit MerkleClaimed(msg.sender, lifetimeEntitlement, claimable);
    }

    // ========== Proxy plumbing (appended — append-only layout) ==========
    // Declared at the END: behind a proxy the new code runs on
    // the OLD storage, so only appends are safe. Pinned by
    // storage-layouts/SatoriMerkle.json (test/StorageLayout.test.js).

    /// @notice The SatoriToken — the upgrade-gate anchor. Set by `initialize`,
    ///         never settable again.
    address public satoriToken;

    /// @dev Deployer of the PROXY, for the one-shot wiring of `satoriCore`.
    address private deployer;

    /// @dev Set by the implementation constructor (locking the raw
    ///      implementation) and by `initialize` (making it one-shot).
    bool private _initialized;

    /// Compile-time identity — pinned by `SatoriUUPS.upgradeTo`, so no sibling
    /// implementation can ever be installed on top of live claim state.
    function _contractId() internal pure override returns (bytes32) {
        return keccak256("satori.impl.SatoriMerkle");
    }

    /// Upgrade authority = the token's `upgradeAuthority`, the same slot as
    /// every other proxy in the system, and it dies with `renounceUpgrade()`.
    function _upgradeGovernor() internal view override returns (address) {
        return ISatoriUpgradeAuthority(satoriToken).upgradeAuthority();
    }

    // No `_validateNewImplementation` override: with `deployer` moved to
    // storage this contract carries no immutables, so there is nothing in a
    // candidate's bytecode left to pin.
}
