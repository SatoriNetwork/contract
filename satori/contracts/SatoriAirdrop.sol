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
 * @notice The one-time airdrop, in its own contract with no proxy and no
 *         upgrade path. The loader writes a table of allocations in batches and
 *         finalizes it; `CLAIM_DELAY` after finalizing, every recipient can claim
 *         their whole allocation at once. Each claim mints through the token's
 *         separate `airdropMint` door, so the airdrop never touches the
 *         per-round reward cap and the supply identity is
 *         `totalSupply == totalRewardsMinted + airdropMinted`.
 *
 *         Nothing here copies a number the token already holds: the ceiling,
 *         the per-recipient cursor and the running total are all read from the
 *         token, which is the only place they are enforced.
 */
contract SatoriAirdrop {
    ISatoriAirdropToken public immutable token;

    /// Between finalizing and the first claim. Nothing is minted in it and,
    /// until `token.freezeAirdrop`, the token can still be re-pointed, so a
    /// wrong table found in this day is replaced rather than paid.
    uint256 public constant CLAIM_DELAY = 1 days;

    /// Per-recipient allocation. Written once per recipient, never edited,
    /// never removed.
    mapping(address => uint256) public airdropAllocation;
    /// Running sum of every loaded allocation. Nothing on-chain checks it
    /// against the ceiling: the loader verifies `<= AIRDROP_TOTAL_SUPPLY()`
    /// off-chain as it loads, because an over-loaded table does not over-mint
    /// (the token cap holds) but it does lock out the last claimers.
    uint256 public airdropLoadedTotal;
    /// Zero until `finalizeAirdropLoading`; then the moment claims open.
    uint64 public claimsOpenAt;
    /// Who may load and finalize. Seeded at construction; rotated by its holder
    /// or recalled by the token's appoint authority. There is no admin behind
    /// it to fall back to, so zero is rejected.
    address public airdropAuthority;

    event AirdropClaimed(address indexed user, uint256 amount);
    event AirdropAllocated(address indexed recipient, uint256 amount);
    event AirdropLoadingFinalized(uint256 totalLoaded, uint64 claimsOpenAt);
    event AirdropAuthorityChanged(address indexed oldHolder, address indexed newHolder);

    error Unauthorized();
    error BadInput();
    error LengthMismatch();
    error DuplicateRecipient();
    error NothingToClaim();
    error AirdropLoadingClosed();
    error AlreadySet();
    error ClaimsNotOpen();

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
        if (claimsOpenAt != 0) revert AirdropLoadingClosed();
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

    /// One-shot: closes loading forever and opens claims `CLAIM_DELAY` later.
    /// Nothing is claimable until this is called.
    function finalizeAirdropLoading() external {
        if (msg.sender != airdropAuthority) revert Unauthorized();
        if (claimsOpenAt != 0) revert AlreadySet();
        uint64 opens = uint64(block.timestamp + CLAIM_DELAY);
        claimsOpenAt = opens;
        emit AirdropLoadingFinalized(airdropLoadedTotal, opens);
    }

    function airdropLoadingFinalized() external view returns (bool) {
        return claimsOpenAt != 0;
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
        _requireOpen();
        if (_claimAirdrop(msg.sender) == 0) revert NothingToClaim();
    }

    /// Pays `user`'s gas for them. Safe to leave permissionless because the mint
    /// is pinned to `user`: a caller can only move tokens TOWARD the allocated
    /// recipient, never redirect them.
    function claimAirdropFor(address user) external {
        _requireOpen();
        if (_claimAirdrop(user) == 0) revert NothingToClaim();
    }

    /// The sponsored sweep. Skips anyone with nothing owed rather than
    /// reverting, so one already-claimed address cannot fail a batch and a
    /// re-run is harmless. Returns what it minted so a `staticCall` can price
    /// the run first.
    function claimAirdropForMany(address[] calldata users) external returns (uint256 total) {
        _requireOpen();
        for (uint256 i = 0; i < users.length; i++) {
            total += _claimAirdrop(users[i]);
        }
    }

    function _requireOpen() private view {
        uint256 opens = claimsOpenAt;
        if (opens == 0 || block.timestamp < opens) revert ClaimsNotOpen();
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
        uint256 opens = claimsOpenAt;
        if (opens == 0 || block.timestamp < opens) return 0;
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
