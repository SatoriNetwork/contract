// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// The slice of the immutable token the airdrop reads and the one door it
/// writes through. `airdropMint` is gated on the token's `airdrop` pointer,
/// which the wiring authority sets to this contract and the freeze authority
/// can pin forever (docs/issues/airdrop-own-contract.md).
interface ISatoriAirdropToken {
    function airdropMint(address to, uint256 amount) external;
    function airdropMintedTo(address recipient) external view returns (uint256);
    function airdropMinted() external view returns (uint256);
    function AIRDROP_TOTAL_SUPPLY() external view returns (uint256);
    function appointAuthority() external view returns (address);
}

/**
 * @title SatoriAirdrop
 * @notice The one-time vesting drip, in its own contract with no proxy and no
 *         upgrade path. A table of allocations vests linearly over five years
 *         from the construction block; each claim mints the newly-vested slice
 *         through the token's separate `airdropMint` door, so the airdrop
 *         never touches the per-round reward cap and the supply identity is
 *         `totalSupply == totalRewardsMinted + airdropMinted`.
 *
 *         Nothing here copies a number the token already holds: the ceiling,
 *         the per-recipient cursor and the running total are all read from the
 *         token, which is the only place they are enforced.
 */
contract SatoriAirdrop {
    ISatoriAirdropToken public immutable token;

    /// The single vest anchor for every recipient: the construction block. A
    /// recipient loaded later is back-vested off it. An immutable, because
    /// there is no proxy to re-anchor it on.
    uint64 public immutable airdropStart;

    uint256 public constant AIRDROP_VEST = 1825 days;
    /// The share available the moment an allocation exists: one sixth.
    uint256 public constant UPFRONT_DIVISOR = 6;

    /// Per-recipient lifetime allocation. Written once per recipient, never
    /// edited, never removed.
    mapping(address => uint256) public airdropAllocation;
    /// Running sum of every loaded allocation. Nothing on-chain checks it
    /// against the ceiling: the loader verifies `<= AIRDROP_TOTAL_SUPPLY()`
    /// off-chain as it loads, because an over-loaded table does not over-mint
    /// (the token cap holds) but it does lock out the last claimers.
    uint256 public airdropLoadedTotal;
    bool public airdropLoadingFinalized;
    /// Who may load and finalize. Seeded at construction; rotated by its holder
    /// or recalled by the token's appoint authority. There is no admin behind
    /// it to fall back to, so zero is rejected.
    address public airdropAuthority;
    /// The early-claim door, OFF by default. A reversible switch held by the
    /// loader role — the one mutable lever in this contract, and it gates a
    /// feature, never the schedule: switching it off strands nobody, it only
    /// returns them to the plain drip.
    bool public earlyClaimEnabled;

    event AirdropClaimed(address indexed user, uint256 amount, uint256 vestedToDate);
    event AirdropAllocated(address indexed recipient, uint256 amount);
    /// `newAllocation` is the shrunk allocation, equal to everything ever minted to `user`.
    event AirdropClaimedEarly(address indexed user, uint256 paid, uint256 forfeited, uint256 newAllocation);
    event EarlyClaimEnabledSet(bool enabled);
    event AirdropLoadingFinalized(uint256 totalLoaded);
    event AirdropAuthorityChanged(address indexed oldHolder, address indexed newHolder);

    error Unauthorized();
    error BadInput();
    error LengthMismatch();
    error DuplicateRecipient();
    error NothingToClaim();
    error AirdropLoadingClosed();
    error AlreadySet();
    error EarlyClaimDisabled();

    constructor(address token_, address authority_) {
        if (token_ == address(0) || authority_ == address(0)) revert BadInput();
        token = ISatoriAirdropToken(token_);
        airdropStart = uint64(block.timestamp);
        airdropAuthority = authority_;
        emit AirdropAuthorityChanged(address(0), authority_);
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    function loadAirdropBatch(address[] calldata recipients, uint256[] calldata amounts) external {
        if (msg.sender != airdropAuthority) revert Unauthorized();
        if (airdropLoadingFinalized) revert AirdropLoadingClosed();
        if (recipients.length != amounts.length) revert LengthMismatch();
        uint256 added;
        for (uint256 i = 0; i < recipients.length; i++) {
            address r = recipients[i];
            if (r == address(0)) revert BadInput();
            if (airdropAllocation[r] != 0) revert DuplicateRecipient();
            uint256 amt = amounts[i];
            if (amt == 0) revert BadInput();
            airdropAllocation[r] = amt;
            added += amt;
            emit AirdropAllocated(r, amt);
        }
        airdropLoadedTotal += added;
    }

    /// Optional one-shot: close loading forever so the world can know the
    /// table is complete. Claiming never reads this.
    function finalizeAirdropLoading() external {
        if (msg.sender != airdropAuthority) revert Unauthorized();
        if (airdropLoadingFinalized) revert AlreadySet();
        airdropLoadingFinalized = true;
        emit AirdropLoadingFinalized(airdropLoadedTotal);
    }

    function setEarlyClaimEnabled(bool enabled) external {
        if (msg.sender != airdropAuthority) revert Unauthorized();
        earlyClaimEnabled = enabled;
        emit EarlyClaimEnabledSet(enabled);
    }

    function setAirdropAuthority(address who) external {
        if (msg.sender != airdropAuthority && msg.sender != token.appointAuthority()) {
            revert Unauthorized();
        }
        if (who == address(0)) revert BadInput();
        emit AirdropAuthorityChanged(airdropAuthority, who);
        airdropAuthority = who;
    }

    // ------------------------------------------------------------------
    // Claiming
    // ------------------------------------------------------------------

    function claimAirdrop() external {
        if (_claimAirdrop(msg.sender) == 0) revert NothingToClaim();
    }

    /// Pays `user`'s gas for them. Safe to leave permissionless because the mint
    /// is pinned to `user`: a caller can only move tokens TOWARD the allocated
    /// recipient, never redirect them.
    function claimAirdropFor(address user) external {
        if (_claimAirdrop(user) == 0) revert NothingToClaim();
    }

    /// The sponsored sweep. Skips anyone with nothing owed rather than
    /// reverting, so one already-claimed address cannot fail a batch and a
    /// re-run is harmless. Returns what it minted so a `staticCall` can price
    /// the run first.
    function claimAirdropForMany(address[] calldata users) external returns (uint256 total) {
        for (uint256 i = 0; i < users.length; i++) {
            total += _claimAirdrop(users[i]);
        }
    }

    function _claimAirdrop(address user) private returns (uint256 claimable) {
        uint256 vested = airdropVested(user);
        uint256 already = token.airdropMintedTo(user);
        if (vested <= already) return 0;
        claimable = vested - already;
        token.airdropMint(user, claimable);
        emit AirdropClaimed(user, claimable, vested);
    }

    /// Take everything now: the drip slice at full value, then the locked
    /// remainder at the elapsed fraction of the window, forfeiting the rest
    /// forever (docs/issues/airdrop-early-claim.md). Only while the loader has
    /// switched it on. Self-only — it destroys value, so no on-behalf door.
    /// Reverts rather than forfeit for a zero payout. Afterwards the allocation IS what was minted, so the drip
    /// formula saturates and nothing more ever vests.
    function claimAirdropEarly() external returns (uint256 paid) {
        if (!earlyClaimEnabled) revert EarlyClaimDisabled();
        _claimAirdrop(msg.sender);
        uint256 forfeited;
        (paid, forfeited) = earlyClaimQuote(msg.sender);
        if (paid == 0) revert NothingToClaim();
        uint256 newAllocation = token.airdropMintedTo(msg.sender) + paid;
        airdropAllocation[msg.sender] = newAllocation;
        token.airdropMint(msg.sender, paid);
        emit AirdropClaimedEarly(msg.sender, paid, forfeited, newAllocation);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function claimableAirdrop(address user) external view returns (uint256) {
        uint256 vested = airdropVested(user);
        uint256 already = token.airdropMintedTo(user);
        return vested > already ? vested - already : 0;
    }

    /// One sixth at once, the rest linear: `alloc/6 + (alloc - alloc/6) *
    /// min(elapsed, VEST) / VEST`, saturating to `alloc` DIRECTLY past the
    /// window so no wei is ever stranded by the divisions
    /// (docs/issues/airdrop-upfront-sixth.md). Measured off the single
    /// construction anchor, so the sixth is claimable the block after a load.
    function airdropVested(address user) public view returns (uint256) {
        uint256 alloc = airdropAllocation[user];
        if (alloc == 0) return 0;
        uint256 elapsed = block.timestamp - airdropStart;
        if (elapsed >= AIRDROP_VEST) return alloc;
        uint256 upfront = alloc / UPFRONT_DIVISOR;
        return upfront + (alloc - upfront) * elapsed / AIRDROP_VEST;
    }

    /// What `claimAirdropEarly` would pay and forfeit right now, on top of the
    /// ordinary drip slice. The remainder is taken against the LARGER of the
    /// vested figure and the minted cursor: before a buyout they agree (a
    /// claim never mints past vested); after one the cursor equals the shrunk
    /// allocation, so the remainder is zero and a second buyout is impossible.
    function earlyClaimQuote(address user) public view returns (uint256 paid, uint256 forfeited) {
        uint256 alloc = airdropAllocation[user];
        uint256 settled = airdropVested(user);
        uint256 already = token.airdropMintedTo(user);
        if (already > settled) settled = already;
        if (alloc <= settled) return (0, 0);
        uint256 remainder = alloc - settled;
        uint256 elapsed = block.timestamp - airdropStart;
        if (elapsed >= AIRDROP_VEST) return (0, 0);
        paid = remainder * elapsed / AIRDROP_VEST;
        forfeited = remainder - paid;
    }

    function airdropClaimed(address user) external view returns (uint256) {
        return token.airdropMintedTo(user);
    }

    function airdropClaimedTotal() external view returns (uint256) {
        return token.airdropMinted();
    }

    function AIRDROP_TOTAL_SUPPLY() external view returns (uint256) {
        return token.AIRDROP_TOTAL_SUPPLY();
    }
}
