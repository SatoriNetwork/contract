// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPredictionGame.sol";

/// @dev Adversarial adapter for the B-1 regression (block-B audit 2026-07-28).
///      `docs/narratives/A_game_adapters.md` states the adapter's `score` "MUST
///      NOT revert" and concludes a malicious adapter "can never brick the score
///      path with a revert loop" — but nothing enforced it: the engine called
///      `score()` as a plain external call, so any of the modes below made
///      `settlePrediction` revert forever. The victim's prediction could then
///      never finalize, stranding `_unsettledPredictionCount` permanently (and,
///      if the victim was a delegate, leaving an `openRounds` entry that could
///      never be popped, taxing every delegator's future claim).
///
///      Note MODE_MAX_TOTAL / MODE_MAX_BOUNTY: these brick settle WITHOUT ever
///      reverting, so an adapter can obey the documented rule to the letter and
///      still jam the path. They land on the `total + 1` / `bountyTotal + 1`
///      pins, which were unchecked. MODE_GARBAGE returns a short buffer that the
///      ABI decoder cannot destructure — the case a bare `try/catch` does not
///      reliably cover, which is why the engine decodes manually.
contract BrickingGame is IPredictionGame {
    uint8 public constant MODE_OK = 0;
    uint8 public constant MODE_REVERT = 1;
    uint8 public constant MODE_MAX_TOTAL = 2;
    uint8 public constant MODE_MAX_BOUNTY = 3;
    uint8 public constant MODE_GARBAGE = 4;
    uint8 public constant MODE_EMPTY = 5;

    uint8 public mode;
    uint64 public targetRound;

    error Bricked();

    function setMode(uint8 m) external { mode = m; }
    function setTargetRound(uint64 r) external { targetRound = r; }

    function validateForStream(uint32, bytes calldata) external view override {}

    function record(address, uint32, uint256, uint256, bytes calldata) external override {}

    function score(address, uint32)
        external
        view
        override
        returns (bool, uint256, uint256, uint256, uint256, uint64)
    {
        uint8 m = mode;
        if (m == MODE_REVERT) revert Bricked();
        if (m == MODE_GARBAGE) {
            // 32 bytes where the ABI expects 6 static words (192).
            assembly { return(0, 32) }
        }
        if (m == MODE_EMPTY) {
            assembly { return(0, 0) }
        }
        if (m == MODE_MAX_TOTAL) {
            return (true, 1, 1, type(uint256).max, 0, targetRound);
        }
        if (m == MODE_MAX_BOUNTY) {
            return (true, 1, 1, 10, type(uint256).max, targetRound);
        }
        return (true, 1, 1, 10, 0, targetRound);
    }
}
