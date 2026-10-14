// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./Conservation.invariant.t.sol";

/// The Conservation suite again, with the action mix narrowed to the emission
/// levers and the paths that commit, bank or mint against them: under the full
/// handler surface a sequence rarely crosses a step threshold.
contract EmissionInvariantTest is ConservationInvariantTest {
    function setUp() public override {
        super.setUp();
        bytes4[] memory s = new bytes4[](14);
        s[0] = Handler.setEmissionRatio.selector;
        s[1] = Handler.bumpIssued.selector;
        s[2] = Handler.syncEmission.selector;
        s[3] = Handler.setOffchainBudget.selector;
        s[4] = Handler.merkleMint.selector;
        s[5] = Handler.advanceTime.selector;
        s[6] = Handler.predict.selector;
        s[7] = Handler.settlePrediction.selector;
        s[8] = Handler.claim.selector;
        s[9] = Handler.delegatePrediction.selector;
        s[10] = Handler.vote.selector;
        s[11] = Handler.transferTokens.selector;
        s[12] = Handler.updateAdapterValue.selector;
        s[13] = Handler.voteAdapterStreamGame.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s}));
    }

    function afterInvariant() public view {
        (, , uint128 rate, , , uint64 ratio, uint32 steps, ) = handler.satori().emission();
        console.log(
            string.concat(
                "EMISSION_STATS steps=", vm.toString(uint256(steps)),
                " rate=", vm.toString(uint256(rate)),
                " ratio=", vm.toString(uint256(ratio)),
                " notes=", vm.toString(handler.ghostNoteIssuedCalls()),
                " bumps=", vm.toString(handler.callCount_bumpIssued()),
                " splits=", vm.toString(handler.ghostSplitsMatched()),
                " splitsD=", vm.toString(handler.ghostSplitsWithDelegatorShare()),
                " banks=", vm.toString(handler.ghostReserveBanks()),
                " merkleMints=", vm.toString(handler.callCount_merkleMint()),
                " ratioSets=", vm.toString(handler.callCount_setEmissionRatio()),
                " dials=", vm.toString(handler.callCount_setOffchainBudget())
            )
        );
    }
}
