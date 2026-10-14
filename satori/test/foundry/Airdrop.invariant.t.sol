// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/next/SatoriToken.sol";
import "../../contracts/SatoriAirdrop.sol";
import "../../contracts/libraries/SatoriTypes.sol";

/**
 * @title Airdrop stateful-invariant handler
 * @notice Loads (loader == this handler) an airdrop table that sums to EXACTLY
 *         AIRDROP_TOTAL_SUPPLY — live from deploy, no finalize — then lets the
 *         fuzzer warp time forward and have random recipients claim their linear
 *         drip. The airdrop needs only the token and its own contract: the
 *         token's `airdrop` pointer is the whole wiring.
 */
contract AirdropHandler is Test {
    SatoriToken public token;
    SatoriAirdrop public airdrop;
    address[] public actors;
    /// Ghost: what each actor was loaded with. The contract SHRINKS an
    /// allocation on an early claim, so the solvency bound has to be checked
    /// against the original, not the live value.
    mapping(address => uint256) public originalAllocation;

    constructor() {
        // 2nd ctor arg = dev-fee recipient; point at address(this) so the whole
        // genesis supply stays on the test contract. address(this) is also every
        // authority slot, so it can wire the airdrop pointer directly.
        token = new SatoriToken(address(this), address(this), block.chainid);
        airdrop = new SatoriAirdrop(address(token), address(this));
        token.setAirdrop(address(airdrop));

        // Five recipients whose allocations sum to EXACTLY the cap (the last
        // absorbs the rounding remainder).
        uint256 total = SatoriTypes.AIRDROP_TOTAL_SUPPLY;
        uint256 n = 5;
        address[] memory who = new address[](n);
        uint256[] memory amt = new uint256[](n);
        uint256 each = total / n;
        uint256 acc;
        for (uint256 i = 0; i < n; i++) {
            who[i] = address(uint160(uint256(keccak256(abi.encode("airdrop-actor", i)))));
            amt[i] = (i == n - 1) ? (total - acc) : each;
            acc += amt[i];
            actors.push(who[i]);
            originalAllocation[who[i]] = amt[i];
        }
        airdrop.loadAirdropBatch(who, amt); // loader == this handler; claims live from deploy
        airdrop.setEarlyClaimEnabled(true);  // ships OFF; the handler opens it (and toggles it below)
    }

    /// @notice Flip the early-claim switch either way — the loader's lever.
    function toggleEarlyClaim(bool on) external {
        airdrop.setEarlyClaimEnabled(on);
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    /// @notice Warp time forward by up to 200 days and have one recipient claim.
    ///         NothingToClaim (no new vesting since last claim) is swallowed.
    function warpAndClaim(uint256 actorSeed, uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 200 days));
        address a = actors[actorSeed % actors.length];
        vm.prank(a);
        try airdrop.claimAirdrop() {} catch {}
    }

    /// @notice Warp forward and have one recipient BUY OUT their remainder
    ///         (docs/issues/airdrop-early-claim.md). NothingToClaim (zero
    ///         payout, or already settled) is swallowed.
    function warpAndClaimEarly(uint256 actorSeed, uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 200 days));
        address a = actors[actorSeed % actors.length];
        vm.prank(a);
        try airdrop.claimAirdropEarly() {} catch {}
    }
}

/**
 * @title Airdrop invariants
 * @notice The airdrop is a SEPARATE emission line; these guard that it stays
 *         solvent and conservation-safe no matter how claims interleave with
 *         time. The per-round reward invariants are unaffected (the airdrop
 *         never touches totalRewardsMinted) and live in the other suites.
 */
contract AirdropInvariantTest is Test {
    AirdropHandler handler;

    function setUp() public {
        handler = new AirdropHandler();
        targetContract(address(handler));
    }

    // The library mirror the suites size tables with MUST equal the token's
    // enforced ceiling; the airdrop contract itself reads the token's.
    function test_capMirrorsLockstep() public view {
        assertEq(handler.token().AIRDROP_TOTAL_SUPPLY(), SatoriTypes.AIRDROP_TOTAL_SUPPLY);
        assertEq(handler.airdrop().AIRDROP_TOTAL_SUPPLY(), SatoriTypes.AIRDROP_TOTAL_SUPPLY);
    }

    // INV-A1: cumulative airdrop minted never exceeds the pre-committed cap.
    function invariant_airdropWithinCap() public view {
        assertLe(handler.token().airdropMinted(), SatoriTypes.AIRDROP_TOTAL_SUPPLY);
    }

    // INV-A2: solvency — each recipient's cumulative claim never exceeds their
    //         LIVE allocation nor the one they were loaded with (an early claim
    //         shrinks the former, never grows it), and the per-recipient sum
    //         equals the token's counter.
    function invariant_airdropSolvency() public view {
        SatoriAirdrop a = handler.airdrop();
        uint256 sum;
        uint256 nn = handler.actorsLength();
        for (uint256 i = 0; i < nn; i++) {
            address who = handler.actors(i);
            assertLe(a.airdropClaimed(who), a.airdropAllocation(who), "claimed > allocation");
            assertLe(a.airdropAllocation(who), handler.originalAllocation(who), "allocation grew");
            assertLe(a.airdropClaimed(who), handler.originalAllocation(who), "claimed > original");
            sum += a.airdropClaimed(who);
        }
        assertEq(sum, a.airdropClaimedTotal(), "sum(claimed) != claimedTotal");
    }

    // INV-A4: a settled recipient stays settled — once the allocation equals
    //         the cursor, nothing is claimable by either door, ever.
    function invariant_settledStaysSettled() public view {
        SatoriAirdrop a = handler.airdrop();
        uint256 nn = handler.actorsLength();
        for (uint256 i = 0; i < nn; i++) {
            address who = handler.actors(i);
            if (a.airdropAllocation(who) == a.airdropClaimed(who)) {
                assertEq(a.claimableAirdrop(who), 0, "settled but drip claimable");
                (uint256 paid, ) = a.earlyClaimQuote(who);
                assertEq(paid, 0, "settled but buyout quoted");
            }
        }
    }

    // INV-A3: the global supply identity holds with the airdrop as a mint site —
    //         totalSupply == totalRewardsMinted + airdropMinted.
    function invariant_supplyIdentityWithAirdrop() public view {
        SatoriToken t = handler.token();
        assertEq(
            t.totalSupply(),
            t.totalRewardsMinted() + t.airdropMinted(),
            "supply != rewardsMinted + airdropMinted"
        );
    }
}
