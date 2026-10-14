// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HistoricalBalanceGovernor} from "../governance/HistoricalBalanceGovernor.sol";

/// Test double proving the two seams of the governor do what they claim:
///
///   * `_evaluate` — the JUDGMENT — replaced with an exotic rule the stored
///     bars cannot express (unanimity among votes cast). This is the "trigger
///     hook" question answered in code: yes, a subclass may put trigger logic
///     in the hook layer, and the per-proposal bars are only the DEFAULT.
///   * `_onFinalized` — the ACTION — records what it was handed, demonstrating
///     that an action hook receives a verdict rather than computing one.
///
/// Deliberately silly rules, so nobody mistakes this for a real governor.
contract TriggeredGovernorMock is HistoricalBalanceGovernor {
    uint256 public lastFinalizedId;
    bool public lastVerdict;
    uint256 public finalizedCount;

    constructor(address token_, uint256 window_, uint256 period_)
        HistoricalBalanceGovernor(token_, window_, period_)
    {}

    /// Unanimity: any vote against sinks it, and silence is not consent.
    /// Note it reads `_proposals` directly — a subclass judging on anything it
    /// can see is exactly the intended latitude.
    function _evaluate(uint256 proposalId) internal view override returns (bool) {
        Proposal storage p = _proposals[proposalId];
        return p.againstVotes == 0 && p.forVotes > 0;
    }

    function _onFinalized(uint256 proposalId, bool passed_) internal override {
        lastFinalizedId = proposalId;
        lastVerdict = passed_;
        ++finalizedCount;
    }
}
