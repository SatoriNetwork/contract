// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/next/SatoriToken.sol";
import "../../contracts/SatoriAirdrop.sol";

/**
 * @title Airdrop stateful-invariant handler
 * @notice Loads (loader == this handler) an airdrop table that sums to 90% of
 *         AIRDROP_TOTAL_SUPPLY, then lets the fuzzer empty and refill the
 *         token's wiring slot, re-point the token's airdrop door at a decoy
 *         and back, load more rows into either contract, finalize, and have
 *         recipients claim through all three doors at any time: every
 *         allocation is claimable from the block it is loaded in. The airdrop
 *         needs only the token and its own contract: the token's `airdrop`
 *         pointer is the whole wiring.
 */
contract AirdropHandler is Test {
    SatoriToken public token;
    SatoriAirdrop public airdrop;
    /// A replacement-table stand-in the door can be pointed at instead.
    SatoriAirdrop public decoy;
    uint256 public immutable CAP;
    uint256 public immutable seededTotal;
    /// The seeded recipients, then every late row that landed in `airdrop`.
    address[] public actors;
    mapping(address => uint256) public originalAllocation;

    /// Ghost: how many finalize calls succeeded.
    uint256 public ghostFinalizeCount;
    /// Ghost: a load landed in `airdrop` after it was finalized.
    bool public ghostLoadedAfterFinalize;
    /// Ghost: `airdrop`'s loaded total when it was finalized.
    uint256 public totalAtFinalize;
    /// Ghost: a claim reverted while the door pointed here and something was owed.
    bool public ghostUnpaidClaim;

    constructor() {
        // 2nd ctor arg = dev-fee recipient; point at address(this) so the whole
        // genesis supply stays on the test contract. address(this) is also every
        // authority slot, so it can wire the airdrop pointer directly.
        token = new SatoriToken(address(this), address(this), block.chainid);
        airdrop = new SatoriAirdrop(address(token), address(this));
        decoy = new SatoriAirdrop(address(token), address(this));
        token.setAirdrop(address(airdrop));
        CAP = token.AIRDROP_TOTAL_SUPPLY();

        // Five recipients whose allocations sum to 90% of the cap (the last
        // absorbs the rounding remainder), so late rows can fit or overflow.
        uint256 total = CAP - CAP / 10;
        seededTotal = total;
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

    /// @notice Root empties the wiring slot or refills it with this handler.
    function wiring(bool empty) external {
        token.setWiringAuthority(empty ? address(0) : address(this));
    }

    /// @notice The wiring authority points the door at the decoy or back.
    ///         Refused while the wiring slot is empty; swallowed.
    function repoint(bool toDecoy) external {
        try token.setAirdrop(toDecoy ? address(decoy) : address(airdrop)) {} catch {}
    }

    /// @notice The loader finalizes `airdrop`. AlreadySet is swallowed.
    function finalize() external {
        try airdrop.finalizeAirdropLoading() {
            ghostFinalizeCount++;
            totalAtFinalize = airdrop.airdropLoadedTotal();
        } catch {}
    }

    /// @notice The loader adds a row to either table at any time. Up to a
    ///         fifth of the cap, so some rows fit the headroom and some would
    ///         take the table over it (and must be refused). A row that lands in
    ///         `airdrop` becomes a claimer.
    function load(bool intoDecoy, uint256 seed, uint256 amount) external {
        SatoriAirdrop target = intoDecoy ? decoy : airdrop;
        bool finalized = airdrop.airdropLoadingFinalized();
        address[] memory who = new address[](1);
        uint256[] memory amt = new uint256[](1);
        who[0] = address(uint160(uint256(keccak256(abi.encode(intoDecoy ? "late-decoy" : "late", seed)))));
        amt[0] = bound(amount, 1, CAP / 5);
        try target.loadAirdropBatch(who, amt) {
            if (!intoDecoy) {
                if (finalized) ghostLoadedAfterFinalize = true;
                actors.push(who[0]);
                originalAllocation[who[0]] = amt[0];
            }
        } catch {}
    }

    /// Records a claim that reverted while the door pointed at `airdrop` and
    /// `who` was still owed: a stranded claimer.
    function _checkPaid(bool ok, address who) private {
        if (!ok && token.airdrop() == address(airdrop) && airdrop.claimableAirdrop(who) > 0) {
            ghostUnpaidClaim = true;
        }
    }

    function claim(uint256 actorSeed) external {
        address a = actors[actorSeed % actors.length];
        vm.prank(a);
        bool ok;
        try airdrop.claimAirdrop() { ok = true; } catch {}
        _checkPaid(ok, a);
    }

    function claimFor(uint256 callerSeed, uint256 actorSeed) external {
        address a = actors[actorSeed % actors.length];
        vm.prank(address(uint160(uint256(keccak256(abi.encode("sponsor", callerSeed))))));
        bool ok;
        try airdrop.claimAirdropFor(a) { ok = true; } catch {}
        _checkPaid(ok, a);
    }

    /// @notice A sweep over two (possibly equal) recipients and a stranger.
    function claimForMany(uint256 seed) external {
        uint256 n = actors.length;
        address[] memory list = new address[](3);
        list[0] = actors[seed % n];
        list[1] = actors[(seed / n) % n];
        list[2] = address(0xdead);
        bool ok;
        try airdrop.claimAirdropForMany(list) { ok = true; } catch {}
        _checkPaid(ok, list[0]);
        _checkPaid(ok, list[1]);
    }
}

/**
 * @title Airdrop invariants
 * @notice The airdrop is a SEPARATE emission line; these guard that it stays
 *         solvent and conservation-safe no matter how the wiring slot,
 *         re-pointing, loading, finalize and claims interleave. The per-round
 *         reward invariants are unaffected (the airdrop never touches
 *         totalRewardsMinted) and live in the other suites.
 */
contract AirdropInvariantTest is Test {
    AirdropHandler handler;

    function setUp() public {
        handler = new AirdropHandler();
        targetContract(address(handler));
    }

    function test_airdropReadsTheTokensCap() public view {
        assertEq(handler.airdrop().AIRDROP_TOTAL_SUPPLY(), handler.token().AIRDROP_TOTAL_SUPPLY());
    }

    // The owner's figure (2026-10-23). The token cannot change it after deploy.
    function test_capIsOwnersFigure() public view {
        assertEq(handler.CAP(), 1_100_000 ether);
    }

    // Claims are open from the load: the handler's doors drain the seeded
    // table without finalize, so the invariants below are not vacuously true
    // of a handler that can never claim.
    function test_claimsOpenOnLoad() public {
        assertFalse(handler.airdrop().airdropLoadingFinalized());
        for (uint256 i = 0; i < handler.actorsLength(); i++) handler.claim(i);
        assertEq(handler.token().airdropMinted(), handler.seededTotal());
        assertFalse(handler.ghostUnpaidClaim());
    }

    // The load action does what INV-A4 needs it to: a row past the cap is
    // refused, a row within it lands and is paid in full.
    function test_loadRefusesPastTheCap() public {
        SatoriAirdrop a = handler.airdrop();
        uint256 before = a.airdropLoadedTotal();
        handler.load(false, 8, handler.CAP() / 5);
        assertEq(a.airdropLoadedTotal(), before);
        handler.load(false, 9, 1 ether);
        assertEq(a.airdropLoadedTotal(), before + 1 ether);
        for (uint256 i = 0; i < handler.actorsLength(); i++) handler.claim(i);
        assertEq(handler.token().airdropMinted(), handler.seededTotal() + 1 ether);
        assertFalse(handler.ghostUnpaidClaim());
    }

    // The finalize action does what INV-A6 needs it to: loading closes,
    // claims keep paying.
    function test_finalizeClosesLoadingOnly() public {
        SatoriAirdrop a = handler.airdrop();
        handler.finalize();
        assertTrue(a.airdropLoadingFinalized());
        uint256 before = a.airdropLoadedTotal();
        handler.load(false, 3, 1 ether);
        assertEq(a.airdropLoadedTotal(), before);
        assertFalse(handler.ghostLoadedAfterFinalize());
        handler.claim(0);
        assertEq(handler.token().airdropMinted(), handler.originalAllocation(handler.actors(0)));
    }

    // Re-pointing the door pauses this table's claims without stranding
    // anyone; pointing it back resumes them.
    function test_repointPausesAndResumes() public {
        handler.repoint(true);
        handler.claim(0);
        assertEq(handler.token().airdropMinted(), 0);
        assertFalse(handler.ghostUnpaidClaim());
        handler.repoint(false);
        handler.claim(0);
        assertGt(handler.token().airdropMinted(), 0);
    }

    // An emptied wiring slot locks the door; refilling it unlocks it.
    function test_emptiedWiringSlotLocksTheDoor() public {
        handler.wiring(true);
        assertTrue(handler.token().airdropLocked());
        handler.repoint(true);
        assertEq(handler.token().airdrop(), address(handler.airdrop()));
        handler.wiring(false);
        handler.repoint(true);
        assertEq(handler.token().airdrop(), address(handler.decoy()));
    }

    // INV-A1: cumulative airdrop minted never exceeds the pre-committed cap.
    function invariant_airdropWithinCap() public view {
        assertLe(handler.token().airdropMinted(), handler.CAP());
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

    // INV-A4: no table ever holds more than the cap, so every loaded row can
    //         be paid in full.
    function invariant_tablesWithinCap() public view {
        assertLe(handler.airdrop().airdropLoadedTotal(), handler.CAP(), "table over the cap");
        assertLe(handler.decoy().airdropLoadedTotal(), handler.CAP(), "decoy over the cap");
    }

    // INV-A5: finalize is write-once.
    function invariant_finalizeWriteOnce() public view {
        SatoriAirdrop a = handler.airdrop();
        assertLe(handler.ghostFinalizeCount(), 1, "finalized twice");
        assertEq(a.airdropLoadingFinalized(), handler.ghostFinalizeCount() == 1, "finalized flag drifted");
    }

    // INV-A6: nothing loads after finalize: the table's total stands.
    function invariant_finalizedTableNeverGrows() public view {
        assertFalse(handler.ghostLoadedAfterFinalize(), "loaded after finalize");
        if (!handler.airdrop().airdropLoadingFinalized()) return;
        assertEq(handler.airdrop().airdropLoadedTotal(), handler.totalAtFinalize(), "table changed after finalize");
    }

    // INV-A7: no claimer is stranded: while the door points at the table, a
    //         claim never reverts while something is still owed.
    function invariant_noClaimerStranded() public view {
        assertFalse(handler.ghostUnpaidClaim(), "a claimer was owed but could not claim");
    }
}
