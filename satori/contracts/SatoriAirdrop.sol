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
    function airdrop() external view returns (address);
    function airdropFrozen() external view returns (bool);
}

/**
 * @title SatoriAirdrop
 * @notice The one-time airdrop, in its own contract with no proxy and no
 *         upgrade path. The loader writes a table of allocations in batches;
 *         the token's `freezeAirdrop` closes the table and pins the token's
 *         airdrop door here for good; `finalizeAirdropLoading` then opens
 *         claims, and every recipient can claim their whole allocation at once.
 *         Each claim mints through the token's separate `airdropMint` door, so
 *         the airdrop never touches the per-round reward cap.
 *
 *         Nothing here copies a number the token already holds: the ceiling,
 *         the per-recipient cursor and the running total are all read from the
 *         token, which is the only place they are enforced.
 */
contract SatoriAirdrop {
    ISatoriAirdropToken public immutable token;

    /// Per-recipient allocation. Written once per recipient, never edited,
    /// never removed.
    mapping(address => uint256) public airdropAllocation;
    /// Running sum of every loaded allocation. The token's `freezeAirdrop`
    /// reads it: the freeze passes the total that was checked, and refuses a
    /// total over the cap.
    uint256 public airdropLoadedTotal;
    /// Set once by `finalizeAirdropLoading`: claims open.
    bool public airdropLoadingFinalized;
    /// Who may load and finalize. Seeded at construction; rotated by its holder
    /// or recalled by the token's appoint authority. There is no admin behind
    /// it to fall back to, so zero is rejected.
    address public airdropAuthority;

    event AirdropClaimed(address indexed user, uint256 amount);
    event AirdropAllocated(address indexed recipient, uint256 amount);
    event AirdropLoadingFinalized(uint256 totalLoaded);
    event AirdropAuthorityChanged(address indexed oldHolder, address indexed newHolder);

    error Unauthorized();
    error BadInput();
    error LengthMismatch();
    error DuplicateRecipient();
    error NothingToClaim();
    error AirdropLoadingClosed();
    error AlreadySet();
    error ClaimsNotOpen();
    error AirdropNotFrozen();

    constructor(address token_, address authority_) {
        if (token_ == address(0) || authority_ == address(0)) revert BadInput();
        token = ISatoriAirdropToken(token_);
        airdropAuthority = authority_;
        emit AirdropAuthorityChanged(address(0), authority_);
    }

    // ------------------------------------------------------------------
    // Loading
    // ------------------------------------------------------------------

    function loadAirdropBatch(address[] calldata recipients, uint256[] calldata amounts) external {
        if (msg.sender != airdropAuthority) revert Unauthorized();
        // The freeze closes the table: what was checked before it is exactly
        // what pays.
        if (airdropLoadingFinalized || token.airdropFrozen()) revert AirdropLoadingClosed();
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

    /// One-shot: opens claims at once. Nothing is claimable before it. It
    /// refuses until the token's airdrop door is frozen to this contract
    /// (`freezeAirdrop`), which also closes loading, so by the time anyone can
    /// claim, no key and no redeploy can add claimable airdrop. An emptied
    /// wiring slot does not count: root can refill it. Check the table BEFORE
    /// the freeze: until then a wrong table is fixed by pointing the token at a
    /// corrected contract.
    function finalizeAirdropLoading() external {
        if (msg.sender != airdropAuthority) revert Unauthorized();
        if (airdropLoadingFinalized) revert AlreadySet();
        if (!token.airdropFrozen() || token.airdrop() != address(this)) revert AirdropNotFrozen();
        airdropLoadingFinalized = true;
        emit AirdropLoadingFinalized(airdropLoadedTotal);
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
        if (!airdropLoadingFinalized) revert ClaimsNotOpen();
        if (_claimAirdrop(msg.sender) == 0) revert NothingToClaim();
    }

    /// Pays `user`'s gas for them. Safe to leave permissionless because the mint
    /// is pinned to `user`: a caller can only move tokens TOWARD the allocated
    /// recipient, never redirect them.
    function claimAirdropFor(address user) external {
        if (!airdropLoadingFinalized) revert ClaimsNotOpen();
        if (_claimAirdrop(user) == 0) revert NothingToClaim();
    }

    /// The sponsored sweep. Skips anyone with nothing owed rather than
    /// reverting, so one already-claimed address cannot fail a batch and a
    /// re-run is harmless. Returns what it minted so a `staticCall` can price
    /// the run first.
    function claimAirdropForMany(address[] calldata users) external returns (uint256 total) {
        if (!airdropLoadingFinalized) revert ClaimsNotOpen();
        for (uint256 i = 0; i < users.length; i++) {
            total += _claimAirdrop(users[i]);
        }
    }

    function _claimAirdrop(address user) private returns (uint256 claimable) {
        uint256 alloc = airdropAllocation[user];
        uint256 already = token.airdropMintedTo(user);
        if (alloc <= already) return 0;
        claimable = alloc - already;
        token.airdropMint(user, claimable);
        emit AirdropClaimed(user, claimable);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function claimableAirdrop(address user) external view returns (uint256) {
        if (!airdropLoadingFinalized) return 0;
        uint256 alloc = airdropAllocation[user];
        uint256 already = token.airdropMintedTo(user);
        return alloc > already ? alloc - already : 0;
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
