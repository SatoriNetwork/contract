// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal surface the upgrade gate needs from the token.
///
/// Reads `upgradeAuthority()`, NOT the old single `governor()`. The token's
/// governor was split into one slot per job (dao-governance.md v2), and upgrades
/// are their own job — so a Safe can hold the upgrade key without also holding
/// the fee, the pointers or the freezes.
///
/// Worth knowing: this is an interface call, so the compiler cannot check that
/// the token actually implements it. A wrong name here compiles cleanly and then
/// reverts on every upgrade forever. `_requireGovernorSource` below is what turns
/// that into a loud failure at init instead.
interface ISatoriUpgradeAuthority {
    function upgradeAuthority() external view returns (address);
}

/// The APPOINT slot — who may replace a protocol role's holder. Declared here
/// beside the upgrade slot so the two are read together and never confused:
/// upgrading a contract and choosing who operates it are different jobs, held by
/// different Safes.
interface ISatoriAppointAuthority {
    function appointAuthority() external view returns (address);
}

/// ERC-1822 UUPS: an implementation reports the storage slot it expects.
interface IERC1822Proxiable {
    function proxiableUUID() external view returns (bytes32);
}

/// Compile-time identity of a Satori implementation (see `_contractId`).
interface ISatoriIdentified {
    function contractId() external pure returns (bytes32);
}

/// Shared UUPS upgrade block for the hub and the five children — the engine's
/// already-reviewed inline block, factored (see
/// docs/design/restructure/PHASE2-PROXY-ALL.md). Runs behind SatoriProxy
/// (ERC-1967): `upgradeTo` swaps the implementation while the proxy's storage
/// — balances, delegation history, bounty custody, stream history — stays.
///
/// Declares ZERO sequential storage: both slots are fixed (the standard
/// ERC-1967 implementation slot and a dedicated keccak-derived renounce
/// flag), so inheriting this base cannot shift an inheriting contract's
/// existing storage layout. That is what makes it safe to add to contracts
/// whose layouts are pinned by slot-level tests (append-only rule).
abstract contract SatoriUUPS {
    /// This implementation's own deployed address, captured at construction and
    /// living in BYTECODE (not storage — the zero-sequential-storage rule above
    /// still holds). Under delegatecall `address(this)` is the proxy while
    /// `__self` stays the impl, which is how `proxiableUUID` detects that it is
    /// being asked through a proxy.
    address private immutable __self = address(this);

    // bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 private constant _IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    // bytes32(uint256(keccak256("satori.uups.renounced")) - 1)
    bytes32 private constant _RENOUNCED_SLOT =
        0x06a3371428a3dab75fc9fb42b3a092bff009b62480ecf55656bf208c947fecdf;

    event Upgraded(address indexed implementation);
    event UpgradesRenounced();

    error UpgradeUnauthorized();
    error UpgradeBadImplementation();
    /// Shared by the inheritors' `initialize` one-shots.
    error AlreadyInitialized();
    error ZeroTokenAddress();

    /// Who may upgrade — each inheritor resolves this from its own token
    /// pointer (`token.upgradeAuthority()`), so upgrade authority is one named
    /// slot rather than a share of one all-powerful key, and emptying that slot
    /// ends upgrades without touching anything else.
    function _upgradeGovernor() internal view virtual returns (address);

    /// Per-contract upgrade validation hook. Default: none. Contracts that
    /// carry consensus-critical IMMUTABLES (which come from the NEW impl's
    /// bytecode, not proxy storage) override this to assert the candidate was
    /// compiled with the SAME immutables as the live one — otherwise an
    /// otherwise-valid upgrade could silently re-point a fee recipient or the
    /// token/engine wiring (phase-2 review, Findings 1 & 2).
    function _validateNewImplementation(address newImplementation) internal view virtual {}

    /// Validate the upgrade ANCHOR at init. `satoriToken` is the only thing that
    /// can ever authorize an upgrade and the children have no setter for it, so a
    /// wrong-but-non-zero value silently kills BOTH `upgradeTo` and
    /// `renounceUpgrade` forever. Probing it once turns that permanent, invisible
    /// freeze into a loud revert while the deploy can still simply be redone.
    function _requireGovernorSource(address _token) internal view {
        if (_token == address(0)) revert ZeroTokenAddress();
        if (ISatoriUpgradeAuthority(_token).upgradeAuthority() == address(0)) revert ZeroTokenAddress();
    }

    modifier onlyUpgradeGovernor() {
        if (msg.sender != _upgradeGovernor()) revert UpgradeUnauthorized();
        _;
    }

    /// ERC-1822: the storage slot this implementation expects to occupy. The
    /// standard UUPS handshake — `upgradeTo` requires a candidate to return
    /// exactly the ERC-1967 slot, which a non-UUPS contract (a plain contract,
    /// or a mistyped token/EOA-wrapper address) cannot, so it can never be
    /// installed and brick the proxy.
    /// MUST revert when reached through a proxy (OZ's `notDelegated`): a proxy
    /// pointing at a proxiable contract is NOT itself proxiable, and installing
    /// one makes the victim delegatecall itself forever. Without this the
    /// handshake below cannot tell an implementation from a SatoriProxy.
    function proxiableUUID() external view returns (bytes32) {
        if (address(this) != __self) revert UpgradeBadImplementation();
        return _IMPL_SLOT;
    }

    /// Compile-time identity: a constant baked into each implementation's
    /// bytecode. PURE on purpose — it answers correctly on a raw, uninitialized
    /// implementation, so pinning it can never brick an upgrade the way a
    /// storage-read pin would (the SatoriRewards MARKETING_FEE_RECIPIENT
    /// near-miss, commit 3d898dd8).
    function _contractId() internal pure virtual returns (bytes32);

    function contractId() external pure returns (bytes32) {
        return _contractId();
    }

    /// UUPS upgrade: governor-only, only while not renounced, only to a
    /// genuine UUPS implementation (ERC-1822 handshake) whose consensus-critical
    /// immutables match the live ones. Runs in the proxy's storage context
    /// (delegatecall) — the direct-deployed (non-proxied) instance can also be
    /// called but the write is to its own irrelevant storage.
    function upgradeTo(address newImplementation) external onlyUpgradeGovernor {
        if (upgradesRenounced()) revert UpgradeUnauthorized();
        if (newImplementation.code.length == 0) revert UpgradeBadImplementation();
        // ERC-1822 handshake: a candidate that is not a compatible UUPS impl
        // (no proxiableUUID, or a different slot) is rejected rather than
        // installed-and-bricked. A missing function reverts the staticcall,
        // which the catch turns into the clean custom error.
        try IERC1822Proxiable(newImplementation).proxiableUUID() returns (bytes32 slot) {
            if (slot != _IMPL_SLOT) revert UpgradeBadImplementation();
        } catch {
            revert UpgradeBadImplementation();
        }
        // Identity handshake: the candidate must be the SAME contract kind as
        // the live one. Stops every sibling-implementation cross-install (and
        // with it the permissionless re-initialize that follows one).
        try ISatoriIdentified(newImplementation).contractId() returns (bytes32 id) {
            if (id != _contractId()) revert UpgradeBadImplementation();
        } catch {
            revert UpgradeBadImplementation();
        }
        _validateNewImplementation(newImplementation);
        assembly { sstore(_IMPL_SLOT, newImplementation) }
        // Liveness: run the NEW code against this proxy's storage and require that
        // it still finds the caller as the upgrade authority. A layout that moved
        // the token pointer would read the wrong slot, and `upgradeTo` and
        // `renounceUpgrade` would then revert for everyone for good. The revert
        // undoes the write above. This protects an upgrade only once the live
        // implementation carries it, so every implementation ships with it (G05).
        if (SatoriUUPS(address(this)).upgradeGovernor() != msg.sender) revert UpgradeBadImplementation();
        emit Upgraded(newImplementation);
    }

    /// The address allowed to upgrade, as this code computes it. Public so
    /// `upgradeTo` can ask the candidate through the proxy.
    function upgradeGovernor() external view returns (address) {
        return _upgradeGovernor();
    }

    /// One-way: freezes this proxy's logic forever. Per contract: renouncing the
    /// root governor does not freeze anything, and this does not touch the root.
    function renounceUpgrade() external onlyUpgradeGovernor {
        assembly { sstore(_RENOUNCED_SLOT, 1) }
        emit UpgradesRenounced();
    }

    function implementation() external view returns (address impl) {
        assembly { impl := sload(_IMPL_SLOT) }
    }

    function upgradesRenounced() public view returns (bool r) {
        assembly { r := sload(_RENOUNCED_SLOT) }
    }
}
