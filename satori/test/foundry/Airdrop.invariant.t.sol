// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/next/SatoriToken.sol";
import "../../contracts/SatoriAirdrop.sol";
import "../../contracts/libraries/SatoriTypes.sol";

/**
 * @title Airdrop stateful-invariant handler
 * @notice Loads (loader == this handler) an airdrop table that sums to EXACTLY
 *         AIRDROP_TOTAL_SUPPLY, then lets the fuzzer finalize it, warp time
 *         (including to the exact seconds around `claimsOpenAt`), try to load
 *         more, and have recipients claim through all three doors — before and
 *         after claims open. The airdrop needs only the token and its own
 *         contract: the token's `airdrop` pointer is the whole wiring.
 */
contract AirdropHandler is Test {
    SatoriToken public token;
    SatoriAirdrop public airdrop;
    address[] public actors;
    mapping(address => uint256) public originalAllocation;
    uint256 public originalLoadedTotal;

    /// Ghost: `claimsOpenAt` as the first finalize set it.
    uint64 public ghostClaimsOpenAt;
    /// Ghost: a claim call made while claims were shut succeeded or minted.
    bool public ghostMintedWhileShut;
    /// Ghost: a load landed after finalize.
    bool public ghostLoadedAfterFinalize;

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
        airdrop.loadAirdropBatch(who, amt); // loader == this handler; NOT finalized
        originalLoadedTotal = acc;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _shut() private view returns (bool) {
        uint64 opens = airdrop.claimsOpenAt();
        return opens == 0 || block.timestamp < opens;
    }

    /// @notice The loader finalizes. Repeats revert AlreadySet and are swallowed.
    function finalize() external {
        try airdrop.finalizeAirdropLoading() {
            if (ghostClaimsOpenAt == 0) ghostClaimsOpenAt = airdrop.claimsOpenAt();
        } catch {}
    }

    /// @notice Warp forward by up to two days — enough to straddle CLAIM_DELAY.
    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
    }

    /// @notice Once finalized and still shut, land on claimsOpenAt-1,
    ///         claimsOpenAt or claimsOpenAt+1 exactly.
    function warpToOpening(uint256 offset) external {
        uint64 opens = airdrop.claimsOpenAt();
        if (opens == 0 || block.timestamp >= opens - 1) return;
        vm.warp(uint256(opens) - 1 + bound(offset, 0, 2));
    }

    /// @notice The loader tries to add a recipient after finalize.
    function loadLate(uint256 seed, uint256 amount) external {
        if (airdrop.claimsOpenAt() == 0) return;
        address[] memory who = new address[](1);
        uint256[] memory amt = new uint256[](1);
        who[0] = address(uint160(uint256(keccak256(abi.encode("late", seed)))));
        amt[0] = bound(amount, 1, SatoriTypes.AIRDROP_TOTAL_SUPPLY);
        try airdrop.loadAirdropBatch(who, amt) {
            ghostLoadedAfterFinalize = true;
        } catch {}
    }

    function claim(uint256 actorSeed) external {
        address a = actors[actorSeed % actors.length];
        bool shut = _shut();
        uint256 before = token.airdropMinted();
        vm.prank(a);
        try airdrop.claimAirdrop() {
            if (shut) ghostMintedWhileShut = true;
        } catch {}
        if (shut && token.airdropMinted() != before) ghostMintedWhileShut = true;
    }

    function claimFor(uint256 callerSeed, uint256 actorSeed) external {
        address a = actors[actorSeed % actors.length];
        bool shut = _shut();
        uint256 before = token.airdropMinted();
        vm.prank(address(uint160(uint256(keccak256(abi.encode("sponsor", callerSeed))))));
        try airdrop.claimAirdropFor(a) {
            if (shut) ghostMintedWhileShut = true;
        } catch {}
        if (shut && token.airdropMinted() != before) ghostMintedWhileShut = true;
    }

    /// @notice A sweep over two (possibly equal) recipients and a stranger.
    function claimForMany(uint256 seed) external {
        uint256 n = actors.length;
        address[] memory list = new address[](3);
        list[0] = actors[seed % n];
        list[1] = actors[(seed / n) % n];
        list[2] = address(0xdead);
        bool shut = _shut();
        uint256 before = token.airdropMinted();
        try airdrop.claimAirdropForMany(list) {
            if (shut) ghostMintedWhileShut = true;
        } catch {}
        if (shut && token.airdropMinted() != before) ghostMintedWhileShut = true;
    }
}

/**
 * @title Airdrop invariants
 * @notice The airdrop is a SEPARATE emission line; these guard that it stays
 *         solvent and conservation-safe no matter how finalize, time and claims
 *         interleave. The per-round reward invariants are unaffected (the
 *         airdrop never touches totalRewardsMinted) and live in the other suites.
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

    // The handler's doors pay once open — so the invariants below are not
    // vacuously true of a handler that can never claim.
    function test_handlerDrainsTheTableAfterTheDelay() public {
        handler.finalize();
        handler.warp(1 days);
        for (uint256 i = 0; i < handler.actorsLength(); i++) handler.claim(i);
        assertEq(handler.token().airdropMinted(), SatoriTypes.AIRDROP_TOTAL_SUPPLY);
        assertFalse(handler.ghostMintedWhileShut());
    }

    // INV-A1: cumulative airdrop minted never exceeds the pre-committed cap.
    function invariant_airdropWithinCap() public view {
        assertLe(handler.token().airdropMinted(), SatoriTypes.AIRDROP_TOTAL_SUPPLY);
    }

    // INV-A2: solvency, all-or-nothing — each recipient's cumulative claim is
    //         either zero or exactly the allocation they were loaded with (which
    //         never changes), a settled recipient has nothing claimable, and the
    //         per-recipient sum equals the token's counter.
    function invariant_airdropSolvency() public view {
        SatoriAirdrop a = handler.airdrop();
        uint256 sum;
        uint256 nn = handler.actorsLength();
        for (uint256 i = 0; i < nn; i++) {
            address who = handler.actors(i);
            uint256 alloc = handler.originalAllocation(who);
            uint256 claimed = a.airdropClaimed(who);
            assertEq(a.airdropAllocation(who), alloc, "allocation changed");
            assertTrue(claimed == 0 || claimed == alloc, "partial claim");
            if (claimed == alloc) assertEq(a.claimableAirdrop(who), 0, "settled but claimable");
            sum += claimed;
        }
        assertEq(sum, a.airdropClaimedTotal(), "sum(claimed) != claimedTotal");
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

    // INV-A4: nothing is minted while claims are shut — never before finalize,
    //         and no door pays before claimsOpenAt.
    function invariant_nothingMintedWhileShut() public view {
        assertFalse(handler.ghostMintedWhileShut(), "a door paid while shut");
        if (handler.airdrop().claimsOpenAt() == 0) {
            assertEq(handler.token().airdropMinted(), 0, "minted before finalize");
        }
    }

    // INV-A5: finalize is write-once — the opening never moves, and the table
    //         never grows after it.
    function invariant_finalizeWriteOnce() public view {
        SatoriAirdrop a = handler.airdrop();
        assertEq(a.claimsOpenAt(), handler.ghostClaimsOpenAt(), "claimsOpenAt moved");
        assertFalse(handler.ghostLoadedAfterFinalize(), "loaded after finalize");
        assertEq(a.airdropLoadedTotal(), handler.originalLoadedTotal(), "table grew");
    }
}
