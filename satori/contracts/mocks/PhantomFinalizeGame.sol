// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";

/// @dev Adversarial adapter for the F1 regression (audit 2026-07). Its score()
///      reports a "resolved" finalize for a caller-set target round for ANY
///      user — even one who never placed a bet on this game — and arms no
///      protocol-side pending. Pre-fix, SatoriEngine._scoreAdapterPrediction
///      called _notifyFinalized UNCONDITIONALLY, so this phantom finalize
///      decremented a victim's SHARED per-(user, round) unsettled-prediction
///      counter and could drive it to zero, permanently bricking settlement of
///      the victim's REAL predictions. Post-fix, SatoriRewards.scoreAdapterPrediction
///      reports finalized == false (no real pending consumed) and the engine
///      leaves the counter untouched.
contract PhantomFinalizeGame is IPredictionGame {
    uint64 public targetRound;

    function setTargetRound(uint64 r) external {
        targetRound = r;
    }

    function validateForStream(uint32, bytes calldata) external view override {}

    function record(address, uint32, uint256, uint256, bytes calldata) external override {}

    /// Always "resolved" for `targetRound`, regardless of caller or bet — the
    /// essence of the F1 attack. Reads state, so it is non-view (matches the
    /// IPredictionGame declaration used by real caching adapters).
    function score(address, uint32)
        external
        view
        override
        returns (bool resolved, uint256 userScore, uint256 multiplier, uint256 total, uint256 bountyTotal, uint64 roundIndex)
    {
        return (true, 0, 0, 0, 0, targetRound);
    }
}
