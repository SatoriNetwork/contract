// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "../interfaces/ITransferHook.sol";

interface IBridgeAuthority {
    /// `view` is load-bearing: it compiles to STATICCALL, so a hostile registry
    /// cannot reenter the token through this call.
    function isBridge(address bridge) external view returns (bool);
}

interface IERC7802 is IERC165 {
    event CrosschainMint(address indexed to, uint256 amount, address indexed sender);
    event CrosschainBurn(address indexed from, uint256 amount, address indexed sender);

    function crosschainMint(address to, uint256 amount) external;
    function crosschainBurn(address from, uint256 amount) external;
}

/// Immutable: no delegatecall, no upgrade path, no admin surface beyond the
/// authority pointers below. A capability absent from this file never exists.
contract SatoriToken is ERC20, ERC20Burnable, ERC20Permit, IERC7802 {

    uint256 public constant TIME_UNIT_SECONDS = 86400; // must match SatoriTypes

    uint256 public immutable deploymentRound;
    uint256 public immutable deploymentBlock;

    // The one deployment allowed to emit. Off-home every emission path is closed
    // in the BYTECODE, not by deploy config: the controller can never be set
    // there, `rewardCeiling()` reads zero so no accrual fits, and genesis books
    // nothing, so there is no fee to pull. See docs/design/superchain-native-token.md.
    uint256 public immutable HOME_CHAIN_ID;

    /// TIER 1 bridge: the OP Stack predeploy, same address on every OP Stack
    /// chain. Hardcoded with no setter and no slot, so no authority can ever
    /// repoint it. Inert where the predeploy does not exist.
    address internal constant SUPERCHAIN_BRIDGE =
        0x4200000000000000000000000000000000000028;

    uint256 public constant ROUND_REWARD_BUDGET = 1440 ether;
    /// Ceiling over ALL airdropped tokens. SatoriAirdrop refuses to load past
    /// it, so every loaded allocation can be paid in full.
    uint256 public constant AIRDROP_TOTAL_SUPPLY = 1_100_000 ether;
    /// MUST equal `SatoriHub.BASE_EMISSION_PER_ROUND`, the hub's deploy-time
    /// default rate (mirrored constant, pinned by a lockstep test — the token
    /// cannot read the hub at construction): genesis pays the deploy round.
    uint256 public constant INITIAL_MINT = 846621902397116230417;

    // Dev fee = a share of every reward the controller reports as EARNED
    // (`accrueRewards`: on-chain credits and the merkle reserve). EXCLUDES the
    // airdrop and the bridge.
    // Since gross == general + dev, the share is a ratio on the general lane:
    // dev = general * bps / (10000 - bps). `rewardMint` pays only what was
    // reported, so a controller that stops reporting pays nobody.

    /// 15%, forever: a constant, so no authority can ever move it.
    uint256 public constant devFeeBps = 1500;

    address internal constant _PLACEHOLDER = 0x000000000000000000000000000000000000dEaD;

    /// The platform-fee destination. Constructor-set immutable; no setter, ever.
    /// Point at a LOCKED splitter slot for an end-to-end guarantee (design 7.2).
    address public immutable PLATFORM_FEE_RECIPIENT;

    /// General rewards reported as earned (genesis included), and the fee booked
    /// on them. COUNTERS, not timestamps: the fee is a share of what was
    /// earned, not of elapsed time. Only ever grow.
    uint256 public generalAccrued;
    uint256 public devFeeAccrued;
    uint256 public generalMinted;
    uint256 public devFeeMinted;

    uint256 public airdropMinted;
    mapping(address => uint256) public airdropMintedTo;

    /// Every hop burns on one chain and mints on another, so Σburned must equal
    /// Σminted across deployments and the gap is what is in flight. On the home
    /// chain they also GATE: `crosschainMint` reverts `CrosschainLimit` once
    /// minted would pass burned. `totalSupply()` cannot substitute — voting burns
    /// confound it.
    uint256 public crosschainMinted;
    uint256 public crosschainBurned;

    // The authority is SPLIT into one slot per job (dao-governance.md v2). The
    // SHAPE is frozen forever (no upgrade path): slot count and boundaries can
    // never change, only addresses — though a slot may point at a contract that
    // subdivides further. `rootAuthority` is omnipotent in two steps (point any
    // slot at itself, then act); it is contained by its own signers, not here.

    /// Sets every slot below, and its own successor. The association's Safe.
    address public rootAuthority;
    address public pendingRootAuthority;

    /// `upgradeTo` / `renounceUpgrade` on every proxy. Read by SatoriUUPS.
    address public upgradeAuthority;
    /// The pointers on this contract, plus the hub's write-once merkle wiring.
    address public wiringAuthority;
    /// Appoints and recalls the protocol's other roles. Read by the children.
    address public appointAuthority;
    /// The one-way `freeze*` calls.
    address public freezeAuthority;

    address public controller;
    address public hook;
    /// The one caller of `airdropMint`: the SatoriAirdrop contract, which has
    /// no upgrade path. Deliberately NOT the controller, so neither the hub nor
    /// anything behind it can reach the airdrop lane
    /// (docs/issues/airdrop-own-contract.md).
    address public airdrop;

    /// Per-lever freezes: give up one lever forever while the rest keep working.
    /// One-way — nothing sets them back and there is no upgrade path.
    bool public controllerFrozen;
    bool public hookFrozen;
    bool public bridgeAuthorityFrozen;

    /// TIER 2 bridge registry: which third-party bridges are authorized. Zero
    /// (the default) = no third-party transport at all.
    address public bridgeAuthority;

    // ------------------------------------------------------------------
    // Locks & participation
    // ------------------------------------------------------------------

    uint24 public constant LOCK_INDEFINITE = type(uint24).max;

    /// @dev TEN transfer-lock lanes; the transfer path blocks while their max is
    ///      in the future. This is the ONLY place a transfer can be blocked —
    ///      the core enforces; POLICY (how long, why) lives in the controller
    ///      (the hub), the sole `setLock` caller and itself upgradeable, so lock
    ///      reasons can grow without touching this core. Separate lanes stop
    ///      independent writers with different expiries from clobbering each
    ///      other (docs/design/lock-lane-accounting.md):
    ///        0 — prediction / delegation lock.
    ///        1 — proposal vote lock (LockVoteGovernor via hub.voteLock).
    ///        2..9 — RESERVED spares. Audit F37: deliberate, NOT dead code.
    ///      PACKING: all ten lanes + the participation flag are ONE word — lane i
    ///      at bits [i*24, i*24+24) (uint24 round), flag at bit 240. Edit the bit
    ///      math in setLock/lockUntil/transferLockedUntil in lockstep with this.
    uint8 public constant LOCK_LANES = 10;
    uint256 private constant _LANE_MASK = 0xFFFFFF;          // 2^24 - 1

    // Bit 240 is the transfer-hook gate for prediction DELEGATORS: their receipts
    // must re-book onto a delegate's pool, so their transfers must run the hook.
    // rewards.delegatePredictionPower owns it symmetrically — markParticipated on
    // delegate, unmarkParticipated on undelegate — so it is exactly "is a
    // prediction delegator". Named "participated" for history.
    uint256 private constant _PARTICIPATED_BIT = 1 << 240;

    // Bits 241..255 are a HOOK-REASON lane: extra, hub-set reasons that also force
    // the transfer hook to run for a wallet. The delegation hook is the only
    // consumer TODAY, but voting or a future feature may again need to track a
    // balance across transfers; because this token is immutable, the mechanism
    // (a controller setter + these gated bits) is reserved now so such a feature
    // ships as a pure hub upgrade with no token redeploy. Each bit is owned by
    // the feature that sets it, which clears it when the wallet disengages.
    //
    // The lane spans EVERY bit above the participation flag. The gate below is a
    // single mask compare (`& _HOOK_GATE_MASK`), which costs the same regardless
    // of how many bits it covers — so reserving all 15 is free at transfer time.
    // The flip side: these bits are now gate bits, so they must NOT be reused as
    // non-hook per-user state; anything set here fires the hook.
    uint8   private constant _HOOK_REASON_COUNT = 15;                 // bits 241..255
    uint256 private constant _HOOK_REASON_MASK  =
        ((uint256(1) << _HOOK_REASON_COUNT) - 1) << 241;
    /// The complete set of bits whose presence on either side forces the hook.
    uint256 private constant _HOOK_GATE_MASK = _PARTICIPATED_BIT | _HOOK_REASON_MASK;

    /// Packed per-user state: ten uint24 lock lanes (bits 0..239), the delegator
    /// gate (bit 240), and the hook-reason lane (bits 241..255). See the packing
    /// notes above.
    mapping(address => uint256) private _userState;

    // ------------------------------------------------------------------

    event ControllerSet(address indexed controller);
    event HookSet(address indexed hook);
    event AirdropSet(address indexed airdrop);
    event BridgeAuthoritySet(address indexed authority);
    event LockSet(address indexed user, uint8 indexed lane, uint24 untilRound);
    event Participated(address indexed user);
    event ParticipationCleared(address indexed user);
    event HookReasonSet(address indexed user, uint8 indexed reason, bool on);
    event TransferHookFailed(address indexed from, address indexed to, uint256 value);
    event DevFeeMinted(address indexed recipient, uint256 amount, uint256 round);
    /// Running totals included so the counters rebuild from logs alone.
    event RewardsAccrued(uint256 general, uint256 devFee, uint256 generalTotal, uint256 devFeeTotal);

    event AuthoritySet(string slot, address indexed oldHolder, address indexed newHolder);
    event RootAuthorityTransferStarted(address indexed oldRoot, address indexed pendingRoot);
    event RootAuthorityTransferred(address indexed oldRoot, address indexed newRoot);

    event ControllerFrozen(address finalController);
    event HookFrozen(address finalHook);
    event BridgeAuthorityFrozen(address finalAuthority);


    error Unauthorized();
    error BadInput();
    error BudgetExceeded();
    error NotAccrued();
    error Locked();
    error HookFailedWithoutReason();
    error ControllerNotSet();
    error NotHomeChain();
    error CrosschainLimit();
    error Frozen();

    modifier onlyRoot() {
        if (msg.sender != rootAuthority) revert Unauthorized();
        _;
    }

    modifier onlyWiring() {
        if (msg.sender != wiringAuthority) revert Unauthorized();
        _;
    }

    modifier onlyFreeze() {
        if (msg.sender != freezeAuthority) revert Unauthorized();
        _;
    }

    modifier onlyController() {
        if (msg.sender != controller) revert Unauthorized();
        _;
    }

    modifier onlyAirdrop() {
        if (msg.sender != airdrop) revert Unauthorized();
        _;
    }

    /// On `setController` this transitively closes accrueRewards / rewardMint /
    /// setLock / markParticipated (all `onlyController`, so off-home the
    /// controller is never set), and on `setAirdrop` it closes airdropMint the
    /// same way; also gates `mintDevFee`, which has no other gate.
    modifier onlyHomeChain() {
        if (block.chainid != HOME_CHAIN_ID) revert NotHomeChain();
        _;
    }

    /// @param root_ seeds EVERY authority slot, and is part of the CREATE2
    ///        address, so it is root of every copy on every chain. On Base the
    ///        association's Safe, which lends the deployer wiring and appoint
    ///        for the setup calls (deploy.js).
    constructor(address root_, address devRecipient_, uint256 homeChainId_)
        ERC20("Satori", "SATORI") ERC20Permit("Satori")
    {
        if (root_ == address(0)) revert BadInput();
        if (devRecipient_ == address(0) || devRecipient_ == _PLACEHOLDER) revert BadInput();
        if (homeChainId_ == 0) revert BadInput();
        rootAuthority    = root_;
        upgradeAuthority = root_;
        wiringAuthority  = root_;
        appointAuthority = root_;
        freezeAuthority  = root_;
        deploymentRound = block.timestamp / TIME_UNIT_SECONDS;
        deploymentBlock = block.number;
        PLATFORM_FEE_RECIPIENT = devRecipient_;
        HOME_CHAIN_ID = homeChainId_;

        // HOME ONLY: remote deployments share this bytecode and address, so an
        // ungated genesis would mint a fresh INITIAL_MINT on each — real supply
        // outside the schedule that gameplay can never burn back down.
        if (block.chainid == homeChainId_) {
            // GENERAL FIRST, dev takes the remainder: for INITIAL_MINT the
            // remainder equals the rounded-up fee `accrueRewards` books (pinned
            // by a test), so genesis is the same formula as every later report.
            uint256 generalGenesis = INITIAL_MINT * (10000 - devFeeBps) / 10000;
            uint256 devGenesis = INITIAL_MINT - generalGenesis;
            generalAccrued = generalGenesis;
            generalMinted = generalGenesis;
            devFeeAccrued = devGenesis;
            devFeeMinted = devGenesis;
            _mint(devRecipient_, devGenesis);
            _mint(root_, generalGenesis);
            emit RewardsAccrued(generalGenesis, devGenesis, generalGenesis, devGenesis);
            emit DevFeeMinted(devRecipient_, devGenesis, deploymentRound);
        }

        emit RootAuthorityTransferred(address(0), root_);
        emit AuthoritySet("upgrade", address(0), root_);
        emit AuthoritySet("wiring", address(0), root_);
        emit AuthoritySet("appoint", address(0), root_);
        emit AuthoritySet("freeze", address(0), root_);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getCurrentRound() public view returns (uint256) {
        return block.timestamp / TIME_UNIT_SECONDS;
    }

    /// Inclusive of the deploy round (1 at genesis); ZERO off-home, where no
    /// emission path exists. Returns rather than reverts so a batched read
    /// through Multicall3 `aggregate` is not broken.
    function _roundsElapsed() private view returns (uint256) {
        if (block.chainid != HOME_CHAIN_ID) return 0;
        return getCurrentRound() - deploymentRound + 1;
    }

    function rewardCeiling() public view returns (uint256) {
        return ROUND_REWARD_BUDGET * _roundsElapsed();
    }

    /// Both reward lanes plus the fee; excludes the airdrop and the bridge.
    function totalRewardsMinted() public view returns (uint256) {
        return generalMinted + devFeeMinted;
    }

    function lockUntil(address user, uint8 lane) external view returns (uint24) {
        if (lane >= LOCK_LANES) revert BadInput();
        return uint24((_userState[user] >> (uint256(lane) * 24)) & _LANE_MASK);
    }

    function transferLockedUntil(address user) public view returns (uint24) {
        uint256 w = _userState[user];
        // Early-out on the unlocked case (~every transfer); only a locked
        // account pays for the scan.
        uint256 lanes = w & (_PARTICIPATED_BIT - 1);  // low 240 bits = all ten lanes
        if (lanes == 0) return 0;
        uint24 m = 0;
        for (uint256 i = 0; i < LOCK_LANES; ++i) {
            uint24 lane = uint24(lanes & _LANE_MASK);
            if (lane > m) m = lane;
            lanes >>= 24;
        }
        return m;
    }

    function hasParticipated(address user) external view returns (bool) {
        return _userState[user] & _PARTICIPATED_BIT != 0;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC7802).interfaceId
            || interfaceId == type(IERC165).interfaceId;
    }

    // ------------------------------------------------------------------
    // Controller operations
    // ------------------------------------------------------------------

    /// The controller reports `general` rewards as earned; the fee on them is
    /// booked here, at this contract's own rate, never one the caller supplies.
    /// Rounded UP per report so splitting a report into dust cannot round the
    /// fee away. The `1440 x rounds` envelope binds here, on general plus fee;
    /// `rewardMint` then needs no envelope of its own.
    function accrueRewards(uint256 general)
        external onlyController returns (uint256 generalTotal, uint256 fee)
    {
        uint256 bps = devFeeBps;
        uint256 residual = 10000 - bps;
        fee = (general * bps + residual - 1) / residual;
        generalTotal = generalAccrued + general;
        uint256 devFeeTotal = devFeeAccrued + fee;
        if (generalTotal + devFeeTotal > rewardCeiling()) revert BudgetExceeded();
        generalAccrued = generalTotal;
        devFeeAccrued = devFeeTotal;
        emit RewardsAccrued(general, fee, generalTotal, devFeeTotal);
    }

    /// Pays only what `accrueRewards` reported, so the fee on every reward wei
    /// was booked before the wei could exist, and a controller that stops
    /// reporting cannot pay anyone.
    function rewardMint(address to, uint256 amount) external onlyController {
        uint256 minted = generalMinted + amount;
        if (minted > generalAccrued) revert NotAccrued();
        generalMinted = minted;
        _mint(to, amount);
    }

    /// Permissionless: funds only ever reach the immutable PLATFORM_FEE_RECIPIENT,
    /// so no griefing surface. Minting never waits on this: `rewardMint` reads
    /// neither counter below.
    function mintDevFee() external onlyHomeChain returns (uint256 amount) {
        uint256 accrued = devFeeAccrued;
        amount = accrued - devFeeMinted;   // devFeeMinted is only ever set to a past devFeeAccrued
        if (amount == 0) return 0;
        devFeeMinted = accrued;
        _mint(PLATFORM_FEE_RECIPIENT, amount);
        emit DevFeeMinted(PLATFORM_FEE_RECIPIENT, amount, getCurrentRound());
    }

    function airdropMint(address to, uint256 amount) external onlyAirdrop {
        if (airdropMinted + amount > AIRDROP_TOTAL_SUPPLY) revert BudgetExceeded();
        airdropMinted += amount;
        airdropMintedTo[to] += amount;
        _mint(to, amount);
    }

    function setLock(address user, uint8 lane, uint24 untilRound) external onlyController {
        if (user == address(0)) revert BadInput();
        if (lane >= LOCK_LANES) revert BadInput();
        uint256 shift = uint256(lane) * 24;
        uint256 w = _userState[user] & ~(_LANE_MASK << shift);   // clear only this lane
        _userState[user] = w | (uint256(untilRound) << shift);
        emit LockSet(user, lane, untilRound);
    }

    function markParticipated(address user) external onlyController {
        if (user == address(0)) revert BadInput();
        uint256 w = _userState[user];
        if (w & _PARTICIPATED_BIT == 0) {
            _userState[user] = w | _PARTICIPATED_BIT;
            emit Participated(user);
        }
    }

    /// Clears the delegator gate. Called by rewards.delegatePredictionPower on
    /// undelegate — the symmetric partner of markParticipated on delegate — so a
    /// wallet stops running the transfer hook the instant it stops being a
    /// delegator. Idempotent; emits only when the bit was set.
    function unmarkParticipated(address user) external onlyController {
        if (user == address(0)) revert BadInput();
        uint256 w = _userState[user];
        if (w & _PARTICIPATED_BIT != 0) {
            _userState[user] = w & ~_PARTICIPATED_BIT;
            emit ParticipationCleared(user);
        }
    }

    /// Set or clear one hook-reason bit for `user`. Reserved surface: no caller
    /// exists today, but because the token is immutable this is the only place a
    /// future hub feature (e.g. balance-tracked voting) can be given a way to
    /// force the transfer hook without a token redeploy. The controller (hub)
    /// owns the policy; whichever feature sets a reason is responsible for
    /// clearing it when the wallet disengages. See the _HOOK_REASON_MASK note.
    function setHookReason(address user, uint8 reason, bool on) external onlyController {
        if (user == address(0)) revert BadInput();
        if (reason >= _HOOK_REASON_COUNT) revert BadInput();
        uint256 bit = uint256(1) << (241 + uint256(reason));
        if (on) _userState[user] |= bit;
        else    _userState[user] &= ~bit;
        emit HookReasonSet(user, reason, on);
    }

    function hookReason(address user, uint8 reason) external view returns (bool) {
        if (reason >= _HOOK_REASON_COUNT) revert BadInput();
        return _userState[user] & (uint256(1) << (241 + uint256(reason))) != 0;
    }

    // ------------------------------------------------------------------
    // Bridge operations (ERC-7802; disabled until governor sets a bridge)
    // ------------------------------------------------------------------

    /// Denies on every abnormal outcome. `try/catch` cannot rescue a call to a
    /// CODELESS address (the extcodesize check reverts outside the catch), which
    /// is why `setBridgeAuthority` (like `setHook`) rejects codeless addresses.
    function _authorizedTransport(address caller) private view returns (bool) {
        address a = bridgeAuthority;
        if (a == address(0)) return false;
        try IBridgeAuthority(a).isBridge(caller) returns (bool ok) { return ok; }
        catch { return false; }
    }

    /// Tier 1 is checked FIRST and short-circuits, so a broken or hostile tier-2
    /// registry can never take the protocol lane down with it.
    function _authorizedBridge(address caller) private view returns (bool protocol) {
        protocol = (caller == SUPERCHAIN_BRIDGE);
        if (!protocol && !_authorizedTransport(caller)) revert Unauthorized();
    }

    /// HOME IS NET-OUTFLOW-ONLY: it re-mints only what actually left it, so no
    /// transport can create real SATORI on the home chain beyond what departed —
    /// the bound that makes an evolvable tier-2 registry tolerable in an
    /// immutable contract. Remote deployments are deliberately UNBOUNDED (a chain
    /// that cannot mint on arrival is no bridge destination). Never touches the
    /// reward counters: bridging is outside the emission budget.
    function crosschainMint(address to, uint256 amount) external {
        _authorizedBridge(msg.sender);
        if (block.chainid == HOME_CHAIN_ID && crosschainMinted + amount > crosschainBurned) {
            revert CrosschainLimit();
        }
        crosschainMinted += amount;
        emit CrosschainMint(to, amount, msg.sender);
        _mint(to, amount);
    }

    /// Tier 1 (the predeploy, i.e. the chain itself) burns UNCONDITIONALLY —
    /// it calls with no approval, so an allowance gate would make the token
    /// unbridgeable on the Superchain. A tier-2 transport is a third party and
    /// needs an allowance. Transfer locks apply to both via `_update`.
    function crosschainBurn(address from, uint256 amount) external {
        bool protocol = _authorizedBridge(msg.sender);
        if (!protocol && from != msg.sender) _spendAllowance(from, msg.sender, amount);
        crosschainBurned += amount;
        emit CrosschainBurn(from, amount, msg.sender);
        _burn(from, amount);
    }

    // ------------------------------------------------------------------
    // Governor operations
    // ------------------------------------------------------------------

    function setController(address newController) external onlyWiring onlyHomeChain {
        if (controllerFrozen) revert Frozen();
        if (newController == address(0)) revert BadInput();
        controller = newController;
        emit ControllerSet(newController);
    }

    /// Rejects a codeless hook: a call to one reverts via the extcodesize check
    /// OUTSIDE the try/catch in `_update`, which would brick participant
    /// transfers. A hook that reverts with a reason is caught at call time; one
    /// that fails without a reason (out of gas, or no onTokenTransfer) reverts
    /// every transfer that runs it.
    function setHook(address newHook) external onlyWiring {
        if (hookFrozen) revert Frozen();
        if (newHook != address(0) && newHook.code.length == 0) revert BadInput();
        hook = newHook;
        emit HookSet(newHook);
    }

    function setAirdrop(address newAirdrop) external onlyWiring onlyHomeChain {
        if (newAirdrop == address(0)) revert BadInput();
        airdrop = newAirdrop;
        emit AirdropSet(newAirdrop);
    }

    /// Rejects a codeless registry for the same reason `setHook` does (the
    /// extcodesize revert lands outside `_authorizedTransport`'s catch, turning
    /// deny-on-failure into a hard revert). A registry that later selfdestructs
    /// is an accepted residual: tier 1 short-circuits first and the authority
    /// can repoint until renouncement.
    function setBridgeAuthority(address newAuthority) external onlyWiring {
        if (bridgeAuthorityFrozen) revert Frozen();
        if (newAuthority != address(0) && newAuthority.code.length == 0) revert BadInput();
        bridgeAuthority = newAuthority;
        emit BridgeAuthoritySet(newAuthority);
    }

    // PER-LEVER FREEZES. Each stops one pointer moving, forever (one-way, no
    // upgrade path). The value stays where it is, working. The `*Locked` views
    // report either a freeze or the driving slot being emptied.

    /// Freezes mint authority at the current controller. THE VALUABLE ONE:
    /// unreported envelope (1440 x rounds minus the hub's far-lower decaying
    /// issuance) banks up forever, and a re-pointed controller could report and
    /// mint all of it, so setController is the protocol's most valuable call. Does NOT freeze mint
    /// LOGIC — the controller is the hub's PROXY, so hub upgrades still change
    /// minting; only re-pointing to a different address is given up. Refuses an
    /// unset controller, which would brick minting permanently.
    function freezeController() external onlyFreeze onlyHomeChain {
        if (controller == address(0)) revert ControllerNotSet();
        controllerFrozen = true;
        emit ControllerFrozen(controller);
    }

    /// Freezing at `address(0)` ends the delegation sync for good: receipts to
    /// delegators never reach their delegate's power. Freezing a live hook is
    /// permanent too: `_update` swallows a hook that reverts with a reason, but
    /// one that fails without a reason blocks every transfer that runs it. Freeze
    /// only a hook whose sync works and can still be upgraded.
    function freezeHook() external onlyFreeze {
        hookFrozen = true;
        emit HookFrozen(hook);
    }

    function freezeBridgeAuthority() external onlyFreeze {
        bridgeAuthorityFrozen = true;
        emit BridgeAuthorityFrozen(bridgeAuthority);
    }

    /// True when the lever was frozen OR the slot that drives it is empty.
    function controllerLocked() external view returns (bool) {
        return controllerFrozen || wiringAuthority == address(0);
    }
    function hookLocked() external view returns (bool) {
        return hookFrozen || wiringAuthority == address(0);
    }
    function airdropLocked() external view returns (bool) {
        return wiringAuthority == address(0);
    }
    function bridgeAuthorityLocked() external view returns (bool) {
        return bridgeAuthorityFrozen || wiringAuthority == address(0);
    }

    // The slot setters are one-step and immediate: they are RECALL paths, and a
    // pending state an attacker could re-trigger would be worse than severing a
    // bad holder now. `rootAuthority` alone is two-step — nothing can recall IT.

    function setUpgradeAuthority(address who) external onlyRoot {
        emit AuthoritySet("upgrade", upgradeAuthority, who);
        upgradeAuthority = who;
    }

    function setWiringAuthority(address who) external onlyRoot {
        emit AuthoritySet("wiring", wiringAuthority, who);
        wiringAuthority = who;
    }

    function setAppointAuthority(address who) external onlyRoot {
        emit AuthoritySet("appoint", appointAuthority, who);
        appointAuthority = who;
    }

    function setFreezeAuthority(address who) external onlyRoot {
        emit AuthoritySet("freeze", freezeAuthority, who);
        freezeAuthority = who;
    }

    /// Two-step: the successor must call `acceptRootAuthority`, so a mistyped or
    /// keyless address cannot take (and brick) the role that assigns all others.
    /// address(0) cancels a pending transfer.
    function setRootAuthority(address newRoot) external onlyRoot {
        pendingRootAuthority = newRoot;
        emit RootAuthorityTransferStarted(rootAuthority, newRoot);
    }

    function acceptRootAuthority() external {
        if (msg.sender != pendingRootAuthority) revert Unauthorized();
        emit RootAuthorityTransferred(rootAuthority, pendingRootAuthority);
        rootAuthority = pendingRootAuthority;
        pendingRootAuthority = address(0);
    }

    /// Give up reassignment forever; the standing authorities KEEP their powers.
    /// Guards an unwired controller on home: after this nobody can ever set
    /// `wiringAuthority` again, so an unwired mint path would be unrecoverable.
    function renounceRootAuthority() external onlyRoot {
        if (block.chainid == HOME_CHAIN_ID && controller == address(0)) revert ControllerNotSet();
        emit RootAuthorityTransferred(rootAuthority, address(0));
        rootAuthority = address(0);
        pendingRootAuthority = address(0);
    }

    // ERC-1271 permit as an OVERLOAD, not a replacement: the inherited
    // (v,r,s) permit expresses only a 65-byte signature, but ERC-1271 sigs are
    // arbitrary length (a Safe ~195 bytes, a Base Account passkey more), so they
    // cannot pass through (v,r,s) at all. The inherited function is left exactly
    // as OpenZeppelin wrote it, keeping ERC-2612/EOA compliance untouched.

    /// Must match OpenZeppelin's `private` (uninheritable) `PERMIT_TYPEHASH` —
    /// if they diverge, a signature verifies through one door and not the other.
    bytes32 private constant _PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @notice ERC-2612 permit accepting an arbitrary-length signature, so
    ///         smart-contract accounts (ERC-1271) can approve by signature.
    /// @dev Shares `_useNonce(owner)` with the inherited entry point, so a
    ///      signature consumed through either door cannot be replayed through the
    ///      other. Deliberately NOT `virtual`: the token is immutable.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert ERC2612ExpiredSignature(deadline);

        bytes32 structHash = keccak256(
            abi.encode(_PERMIT_TYPEHASH, owner, spender, value, _useNonce(owner), deadline)
        );
        if (!_isValidSignature(owner, _hashTypedDataV4(structHash), signature)) {
            // Signer is unknowable for a contract account; report zero, not a
            // misleading recovered EOA.
            revert ERC2612InvalidSigner(address(0), owner);
        }
        _approve(owner, spender, value);
    }

    /// EOA or ERC-1271 account. Inlined rather than importing OZ's
    /// `SignatureChecker` (needs solc 0.8.24; this token is 0.8.20 and its
    /// CREATE2 address derives from its initCode, so a compiler bump changes the
    /// bytecode). Structural safety: the `code.length` check routes EOAs to
    /// ECDSA so codeless addresses never reach the call; STATICCALL prevents
    /// state mutation/reentrancy; the low-level call turns a reverting account
    /// into `false`; the return is length- and magic-value-checked.
    function _isValidSignature(address signer, bytes32 hash, bytes calldata signature)
        private view returns (bool)
    {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
            return err == ECDSA.RecoverError.NoError && recovered == signer;
        }
        (bool ok, bytes memory result) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (hash, signature))
        );
        return ok
            && result.length >= 32
            && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    // ------------------------------------------------------------------
    // Transfer behavior
    // ------------------------------------------------------------------

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            uint24 l = transferLockedUntil(from);
            if (l != 0) {
                if (l >= getCurrentRound()) revert Locked();
                // SELF-HEAL: l is nonzero but expired, so future transfers would
                // scan for nothing. Zero all lanes (safe — l is their max and it
                // is expired), keeping the participation bit, so the next
                // transfer early-outs. The nonzero lane IS the is-locked flag.
                _userState[from] &= ~(_PARTICIPATED_BIT - 1);
            }
        }

        super._update(from, to, value);

        address h = hook;
        // The hook fires when either side carries a GATE bit: the delegator bit
        // (240) or any hook-reason bit (241..255). Both slots are already loaded
        // by the lock check / gate, so the reason bits cost nothing here. The bit
        // lifecycle is owned by its setter — the delegator bit by
        // rewards.delegatePredictionPower (set on delegate, cleared on
        // undelegate), reason bits by whatever feature set them — so this path
        // never mutates state; it only decides whether to run the hook.
        if (h != address(0) && ((_userState[from] | _userState[to]) & _HOOK_GATE_MASK != 0)) {
            try ITransferHook(h).onTokenTransfer(from, to, value) {}
            catch {
                // Out of gas arrives with no revert data, and the sender picks the
                // gas, so swallowing it would let anyone skip the delegation sync.
                // SatoriHub.onTokenTransfer passes its own empty failures up for
                // this check; keep the two in step.
                uint256 size;
                assembly ("memory-safe") { size := returndatasize() }
                if (size == 0) revert HookFailedWithoutReason();
                emit TransferHookFailed(from, to, value);
            }
        }
    }
}
