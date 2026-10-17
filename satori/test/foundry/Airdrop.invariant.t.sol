// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/next/SatoriToken.sol";
import "../../contracts/SatoriAirdrop.sol";
import "../../contracts/libraries/SatoriTypes.sol";

/**
 * @title Airdrop stateful-invariant handler
 * @notice Loads (loader == this handler) an airdrop table that sums to EXACTLY
 *         AIRDROP_TOTAL_SUPPLY, then lets the fuzzer empty and refill the
 *         token's wiring slot, re-point the token's airdrop door at a decoy
 *         and back, load more rows into either contract, freeze the door,
 *         finalize, and have recipients claim through all three doors — before
 *         and after finalize. The airdrop needs only the token and its own
 *         contract: the token's `airdrop` pointer is the whole wiring.
 */
contract AirdropHandler is Test {
    SatoriToken public token;
    SatoriAirdrop public airdrop;
    /// A corrected-table stand-in the door can be pointed at instead.
    SatoriAirdrop public decoy;
    address[] public actors;
    mapping(address => uint256) public originalAllocation;

    /// Ghost: how many finalize calls succeeded.
    uint256 public ghostFinalizeCount;
    /// Ghost: a claim call made before finalize succeeded or minted.
    bool public ghostMintedWhileShut;
    /// Ghost: a load landed after the freeze.
    bool public ghostLoadedAfterFreeze;
    /// Ghosts: each table's loaded total when the door was first frozen.
    uint256 public airdropTotalAtFreeze;
    uint256 public decoyTotalAtFreeze;

    constructor() {
        // 2nd ctor arg = dev-fee recipient; point at address(this) so the whole
        // genesis supply stays on the test contract. address(this) is also every
        // authority slot, so it can wire the airdrop pointer directly.
        token = new SatoriToken(address(this), address(this), block.chainid);
        airdrop = new SatoriAirdrop(address(token), address(this));
        decoy = new SatoriAirdrop(address(token), address(this));
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
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _shut() private view returns (bool) {
        return !airdrop.airdropLoadingFinalized();
    }

    /// @notice Root empties the wiring slot or refills it with this handler.
    ///         An emptied slot is not a lock: root can refill it, so finalize
    ///         must not accept it.
    function wiring(bool empty) external {
        token.setWiringAuthority(empty ? address(0) : address(this));
    }

    /// @notice The wiring authority points the door at the decoy or back.
    ///         Refused once frozen or while the wiring slot is empty; swallowed.
    function repoint(bool toDecoy) external {
        try token.setAirdrop(toDecoy ? address(decoy) : address(airdrop)) {} catch {}
    }

    /// @notice The freeze authority pins the door wherever it points now.
    function freeze() external {
        bool wasFrozen = token.airdropFrozen();
        try token.freezeAirdrop() {
            if (!wasFrozen) {
                airdropTotalAtFreeze = airdrop.airdropLoadedTotal();
                decoyTotalAtFreeze = decoy.airdropLoadedTotal();
            }
        } catch {}
    }

    /// @notice The loader finalizes. AirdropNotFrozen (door not frozen on this
    ///         contract) and AlreadySet are swallowed.
    function finalize() external {
        try airdrop.finalizeAirdropLoading() {
            ghostFinalizeCount++;
        } catch {}
    }

    /// @notice The loader adds a row to either table at any time; it may land
    ///         only before the freeze. The new rows never claim, so the
    ///         actors' allocations always fit under the cap.
    function load(bool intoDecoy, uint256 seed, uint256 amount) external {
        SatoriAirdrop target = intoDecoy ? decoy : airdrop;
        bool frozen = token.airdropFrozen();
        address[] memory who = new address[](1);
        uint256[] memory amt = new uint256[](1);
        who[0] = address(uint160(uint256(keccak256(abi.encode("late", seed)))));
        amt[0] = bound(amount, 1, SatoriTypes.AIRDROP_TOTAL_SUPPLY);
        try target.loadAirdropBatch(who, amt) {
            if (frozen) ghostLoadedAfterFreeze = true;
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
 *         solvent and conservation-safe no matter how the wiring slot,
 *         re-pointing, loading, the freeze, finalize and claims interleave. The
 *         per-round reward invariants are unaffected (the airdrop never
 *         touches totalRewardsMinted) and live in the other suites.
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

    // Finalize waits for the freeze, and the handler's doors pay in the same
    // block once it lands — so the invariants below are not vacuously true of
    // a handler that can never claim.
    function test_handlerDrainsTheTableOnceFinalized() public {
        handler.finalize();
        assertFalse(handler.airdrop().airdropLoadingFinalized());
        handler.freeze();
        handler.finalize();
        assertTrue(handler.airdrop().airdropLoadingFinalized());
        for (uint256 i = 0; i < handler.actorsLength(); i++) handler.claim(i);
        assertEq(handler.token().airdropMinted(), SatoriTypes.AIRDROP_TOTAL_SUPPLY);
        assertFalse(handler.ghostMintedWhileShut());
    }

    // The wiring action does what INV-A6 needs it to: an emptied slot does not
    // finalize, and once refilled the door moves again.
    function test_emptiedWiringSlotIsNotALock() public {
        handler.wiring(true);
        handler.finalize();
        assertFalse(handler.airdrop().airdropLoadingFinalized());
        handler.wiring(false);
        handler.repoint(true);
        assertEq(handler.token().airdrop(), address(handler.decoy()));
    }

    // The load action does what INV-A7 needs it to: rows land in both tables
    // before the freeze and in neither after it.
    function test_freezeClosesBothTables() public {
        SatoriAirdrop a = handler.airdrop();
        SatoriAirdrop d = handler.decoy();
        uint256 before = a.airdropLoadedTotal();
        handler.load(false, 1, 1 ether);
        handler.load(true, 2, 1 ether);
        assertEq(a.airdropLoadedTotal(), before + 1 ether);
        assertEq(d.airdropLoadedTotal(), 1 ether);
        handler.freeze();
        handler.load(false, 3, 1 ether);
        handler.load(true, 4, 1 ether);
        assertEq(a.airdropLoadedTotal(), before + 1 ether);
        assertEq(d.airdropLoadedTotal(), 1 ether);
        assertFalse(handler.ghostLoadedAfterFreeze());
    }

    // A door frozen at the decoy closes this contract's table too, and it can
    // never finalize.
    function test_freezeAtTheDecoyClosesThisTable() public {
        SatoriAirdrop a = handler.airdrop();
        uint256 before = a.airdropLoadedTotal();
        handler.repoint(true);
        handler.freeze();
        handler.load(false, 1, 1 ether);
        assertEq(a.airdropLoadedTotal(), before);
        handler.finalize();
        assertFalse(a.airdropLoadingFinalized());
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

    // INV-A4: nothing is minted before finalize, through any door.
    function invariant_nothingMintedBeforeFinalize() public view {
        assertFalse(handler.ghostMintedWhileShut(), "a door paid before finalize");
        if (!handler.airdrop().airdropLoadingFinalized()) {
            assertEq(handler.token().airdropMinted(), 0, "minted before finalize");
        }
    }

    // INV-A5: finalize is write-once.
    function invariant_finalizeWriteOnce() public view {
        SatoriAirdrop a = handler.airdrop();
        assertLe(handler.ghostFinalizeCount(), 1, "finalized twice");
        assertEq(a.airdropLoadingFinalized(), handler.ghostFinalizeCount() == 1, "finalized flag drifted");
    }

    // INV-A6: finalized means the token's door is frozen on this contract, so
    //         no key and no redeploy can add claimable airdrop after it. An
    //         emptied wiring slot does not count (see `wiring`).
    function invariant_finalizedImpliesDoorPinned() public view {
        if (!handler.airdrop().airdropLoadingFinalized()) return;
        SatoriToken t = handler.token();
        assertTrue(t.airdropFrozen(), "finalized but door not frozen");
        assertEq(t.airdrop(), address(handler.airdrop()), "finalized but door points elsewhere");
    }

    // INV-A7: the freeze closes every table, wherever the door points: once
    //         token.airdropFrozen() is true no loaded total ever changes. With
    //         INV-A6, the table that pays never grows after finalize.
    function invariant_frozenTablesNeverChange() public view {
        assertFalse(handler.ghostLoadedAfterFreeze(), "loaded after the freeze");
        if (!handler.token().airdropFrozen()) return;
        assertEq(handler.airdrop().airdropLoadedTotal(), handler.airdropTotalAtFreeze(), "table changed after the freeze");
        assertEq(handler.decoy().airdropLoadedTotal(), handler.decoyTotalAtFreeze(), "decoy table changed after the freeze");
    }
}
