// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/next/SatoriToken.sol";

/**
 * @title Immutable dev-fee stateful invariants (isolated, token-only)
 * @notice Fuzzes random interleavings of rewardMint / mintDevFee across warped
 *         rounds — crossing both the 730 and 1460-round tier steps — and asserts
 *         the core carve-out invariants directly on the immutable token. Isolated
 *         from the full-stack Conservation handler so the existing suite is
 *         untouched. Mirrors design §10 ("for any interleaving … totalRewardsMinted
 *         <= rewardCeiling AND devFeeMinted <= devFeeCeiling AND monotonic").
 *
 *         The handler also MOVES THE FEE RATE at random (humble.md 1b). That is
 *         the whole reason this file still earns its keep: the carve-out became
 *         segmented when the rate became movable, and the failure mode it guards
 *         against — a raise revaluing already-minted history and pushing the cap
 *         below `generalMinted`, bricking every reward mint — only appears in an
 *         interleaving of mints and rate changes. Fuzzing mints alone would have
 *         found none of it.
 */
contract DevFeeHandler is Test {
    SatoriToken public token;
    address internal constant DEV = address(0xDE7);   // dev-fee recipient (distinct)
    address internal constant GAME = address(0x6A3E); // general-lane mint sink

    constructor() {
        token = new SatoriToken(address(this), DEV, block.chainid); // governor & controller = this
        token.setController(address(this));
    }

    /// Warp up to ~13 months per call so the fuzzer crosses the tier boundaries.
    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 400 days));
    }

    /// Mint a bounded general-lane amount; the +slack sometimes overshoots the
    /// residual to exercise the carve-out revert path (swallowed).
    function doRewardMint(uint256 amt) external {
        uint256 genCeil = token.rewardCeiling() - token.devFeeCeiling();
        uint256 genMinted = token.totalRewardsMinted() - token.devFeeMinted();
        uint256 room = genCeil > genMinted ? genCeil - genMinted : 0;
        amt = bound(amt, 0, room + 5 ether);
        try token.rewardMint(GAME, amt) {} catch {}
    }

    /// Permissionless dev-fee pull (anyone can call; always pays the recipient).
    function doMintDevFee() external {
        token.mintDevFee();
    }

    /// Move the fee to a random rate inside the band, two-step. `vm.roll` is
    /// required, not decoration: acceptance must land in a LATER block than the
    /// proposal, which is the guard against bundling both atomically.
    function doSetFee(uint256 bps) external {
        bps = bound(bps, token.DEV_FEE_BPS_MIN(), token.DEV_FEE_BPS_MAX());
        try token.proposeDevFeeBps(bps) {} catch { return; }
        vm.roll(block.number + 1);
        try token.acceptDevFeeBps() {} catch {}
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

    // INV-D2: the dev never pulls more than it has accrued.
    //
    // ONE WEI OF SLACK, and it is not laziness. The genesis split floors the
    // GENERAL share onto the hub's cap and hands the dev the REMAINDER, while
    // devFeeCeiling floors the fee's own b/(1-b). Those two roundings need not
    // agree, so on a fresh deployment the fee legitimately sits a wei AHEAD of
    // its ceiling. That is exactly why `mintDevFee` saturates instead of
    // subtracting — a strict `<=` here calls a correct deployment broken.
    //
    // Deliberately +1 and not "roughly": anything beyond a single wei is a real
    // accounting break and must still fail.
    function invariant_devFeeWithinCeiling() public view {
        assertLe(token.devFeeMinted(), token.devFeeCeiling() + 1);
    }

    // INV-D3: the senior carve-out — the general (non-dev) lane never exceeds the
    //         residual rewardCeiling - devFeeCeiling, so the dev slice is always
    //         reserved. (mintDevFee moves totalRewardsMinted and devFeeMinted
    //         together, so this quantity changes only via rewardMint, which
    //         enforces exactly this bound.)
    function invariant_generalWithinResidual() public view {
        assertLe(
            token.totalRewardsMinted() - token.devFeeMinted(),
            token.rewardCeiling() - token.devFeeCeiling()
        );
    }

    // INV-D5: THE CAP NEVER FALLS BELOW WHAT IS ALREADY MINTED — for any
    //         sequence of mints and rate changes the fuzzer can find.
    //
    //         This is the one the segmented `generalCeilingFor` exists for. A
    //         flat `(10000 - bps)` cap applies a RAISE retroactively: the cap
    //         drops under `generalMinted`, `rewardMint` reverts on every call,
    //         and the protocol bricks on a governance action that looked
    //         routine. Stated as an inequality on state rather than as "the next
    //         mint succeeds", so it holds at every single step of every run.
    function invariant_generalCeilingNeverBelowMinted() public view {
        assertLe(
            token.totalRewardsMinted() - token.devFeeMinted(),
            token.generalCeiling()
        );
    }

    // INV-D6: the fee rate never leaves the band, however it was reached.
    function invariant_devFeeBpsInBand() public view {
        assertGe(token.devFeeBps(), token.DEV_FEE_BPS_MIN());
        assertLe(token.devFeeBps(), token.DEV_FEE_BPS_MAX());
    }

    // INV-D4: the dev fee is monotonic and never below its genesis seed.
    //
    // DERIVED, not hardcoded. This said `144 ether` — the tier-1 seed from the
    // 12%-on-720 era, two rate changes ago. The real seed is 288, so the
    // assertion was passing on half the true value and would have sailed
    // straight through a regression that HALVED the fee. That is the
    // characteristic failure of a hardcoded lower bound: it goes quiet in
    // exactly the direction you wanted it to shout.
    function invariant_devFeeAtLeastGenesis() public view {
        // The genesis split floors the GENERAL share onto the cap and gives the
        // dev the remainder, so the seed is `INITIAL_MINT - floor(85% of it)` —
        // which can sit a wei ABOVE a flat 15%. Derived that way rather than as
        // `INITIAL_MINT * bps / 10000`, or the bound would be a wei too high and
        // fire on a correct deployment.
        //
        // DEV_FEE_BPS_DEFAULT, not `devFeeBps()`. The genesis seed was fixed at
        // construction using the default rate and never moves again; reading the
        // LIVE rate re-derives a historical quantity from a value that can now
        // change, so a governor raise to 25% invented a bigger "genesis" than
        // ever existed and the invariant failed on a healthy chain. Found the
        // moment the handler started moving the rate — which is the same bug
        // class the segmented carve-out exists to prevent, showing up in the
        // test file rather than the contract.
        uint256 generalGenesis =
            token.INITIAL_MINT() * (10000 - token.DEV_FEE_BPS_DEFAULT()) / 10000;
        assertGe(token.devFeeMinted(), token.INITIAL_MINT() - generalGenesis);
    }
}
