// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/next/SatoriToken.sol";

/**
 * @title Immutable dev-fee stateful invariants (isolated, token-only)
 * @notice Fuzzes random interleavings of accrueRewards / rewardMint /
 *         mintDevFee across warped rounds (which grow the 1440 x rounds
 *         envelope) and asserts the fee's guarantees directly on the immutable
 *         token. Isolated from the full-stack Conservation handler so the
 *         existing suite is untouched.
 *
 *         The fee is booked at the REPORT (M03, 2026-10-20): the controller
 *         reports general rewards as earned, the token books the dev's share at
 *         its constant rate then, and `rewardMint` pays only what was reported.
 */
contract DevFeeHandler is Test {
    SatoriToken public token;
    address internal constant DEV = address(0xDE7);   // dev-fee recipient (distinct)
    address internal constant GAME = address(0x6A3E); // general-lane mint sink

    /// The fee each successful report booked, recomputed here:
    /// `ceil(g * bps / (10000 - bps))`.
    uint256 public ghostFeeBooked;
    uint256 public ghostReports;

    constructor() {
        token = new SatoriToken(address(this), DEV, block.chainid); // governor & controller = this
        token.setController(address(this));
        ghostFeeBooked = token.devFeeAccrued();
    }

    /// Warp up to ~13 months per call: grows the envelope.
    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 400 days));
    }

    /// Report a bounded general amount as earned; the +slack sometimes
    /// overshoots the envelope to exercise the revert path (swallowed).
    function doAccrue(uint256 amt) external {
        uint256 bps = token.devFeeBps();
        uint256 used = token.generalAccrued() + token.devFeeAccrued();
        uint256 ceiling = token.rewardCeiling();
        uint256 room = ceiling > used ? (ceiling - used) * (10000 - bps) / 10000 : 0;
        amt = bound(amt, 0, room + 5 ether);
        try token.accrueRewards(amt) returns (uint256, uint256) {
            ghostFeeBooked += (amt * bps + (10000 - bps) - 1) / (10000 - bps);
            ghostReports++;
        } catch {}
    }

    /// Mint a bounded amount of what was reported; sometimes a wei past it.
    function doRewardMint(uint256 amt) external {
        uint256 room = token.generalAccrued() - token.generalMinted();
        amt = bound(amt, 0, room + 5 ether);
        try token.rewardMint(GAME, amt) {} catch {}
    }

    /// Permissionless dev-fee pull (anyone can call; always pays the recipient).
    function doMintDevFee() external {
        token.mintDevFee();
    }
}

contract DevFeeInvariantTest is Test {
    DevFeeHandler handler;
    SatoriToken token;

    function setUp() public {
        handler = new DevFeeHandler();
        token = handler.token();
        targetContract(address(handler));
    }

    // INV-D1: the ONE global cap — total reward mint never exceeds rewardCeiling.
    function invariant_totalWithinRewardCeiling() public view {
        assertLe(token.totalRewardsMinted(), token.rewardCeiling());
    }

    // INV-D2: the dev never pulls more than was booked. EXACT: genesis books
    //         the same rounded-up share every report books, so there is no
    //         genesis wei of slack any more.
    function invariant_devFeeWithinAccrued() public view {
        assertLe(token.devFeeMinted(), token.devFeeAccrued());
    }

    // INV-D3: nothing mints that was not reported first. This is what makes a
    //         controller that stops reporting unable to pay anyone, and what
    //         keeps the fee from being dodged: every general wei was booked
    //         before it could exist.
    function invariant_generalWithinAccrued() public view {
        assertLe(token.generalMinted(), token.generalAccrued());
    }

    // INV-D4: the dev fee is monotonic and never below its genesis seed.
    function invariant_devFeeAtLeastGenesis() public view {
        uint256 generalGenesis =
            token.INITIAL_MINT() * (10000 - token.devFeeBps()) / 10000;
        assertGe(token.devFeeMinted(), token.INITIAL_MINT() - generalGenesis);
        assertGe(token.devFeeAccrued(), token.INITIAL_MINT() - generalGenesis);
    }

    // INV-D5: the envelope binds at the report: general plus the fee booked on
    //         it never exceeds 1440 x rounds.
    function invariant_accruedWithinEnvelope() public view {
        assertLe(token.generalAccrued() + token.devFeeAccrued(), token.rewardCeiling());
    }

    // INV-D6: the fee rate is 15%, whatever ran.
    function invariant_devFeeBpsFixed() public view {
        assertEq(token.devFeeBps(), 1500);
    }

    // INV-D7: the fee booked is EXACTLY the rounded-up share of each report —
    //         never short, and never over by a wei beyond the rounding. Compared against an independent ledger kept by the
    //         handler, so a Solidity mistake shows up as a mismatch instead of
    //         two copies agreeing.
    function invariant_feeBookedPerReport() public view {
        assertEq(token.devFeeAccrued(), handler.ghostFeeBooked());
    }

    function afterInvariant() public view {
        console.log(string.concat("DEVFEE_STATS reports=", vm.toString(handler.ghostReports())));
    }

    // INV-D8: every report stays mintable: the room `rewardMint` sees is the
    //         reported stock less what was minted. Stated as a liveness check on state: a mint
    //         of exactly the room succeeds from any reachable state.
    function invariant_everyReportStaysMintable() public {
        uint256 room = token.generalAccrued() - token.generalMinted();
        vm.prank(address(handler));
        token.rewardMint(address(0x6A3E), room);
        assertEq(token.generalMinted(), token.generalAccrued());
    }
}
