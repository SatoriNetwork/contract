// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// The owner's self-contained voting path (docs/design/lock-vote-governor.md).

interface ILockVoteToken {
    function balanceOf(address a) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function getCurrentRound() external view returns (uint256);
    function lockUntil(address user, uint8 lane) external view returns (uint24);
}

interface ILockVoteHub {
    function voteLock(address user, uint256 untilRound) external;
}

contract LockVoteGovernor {

    ILockVoteToken public immutable TOKEN;
    ILockVoteHub public immutable HUB;

    uint8 internal constant LANE_B = 1;

    /// Must stay <= the hub's MAX_VOTE_LOCK_ROUNDS (90): a vote at the last
    /// instant locks to `endRound - 1`, which is then at most now + 89.
    uint256 public constant MAX_PROPOSAL_ROUNDS = 90;

    address public proposer;

    enum VoteType { Against, For, Abstain }   // same order as the proof governor

    struct Proposal {
        uint64  endRound;         // voting open while round < endRound
        uint64  createdRound;
        uint16  minTurnoutBps;    // turnout (incl. abstain) vs supplyAtPropose; 0 = no floor
        uint16  approvalBps;      // for-share among for+against must EXCEED this
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 supplyAtPropose;  // frozen denominator; live supply drifts ~1440/day
        bytes32 descriptionHash;  // the words travel in the event; this pins them
        bool    finalized;
        bool    passed;
        uint64  finalizedRound;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) internal _proposals;

    event ProposalCreated(
        uint256 indexed proposalId,
        uint256 endRound,
        uint256 minTurnoutBps,
        uint256 approvalBps,
        string  description
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, VoteType support, uint256 weight);
    event ProposalFinalized(
        uint256 indexed proposalId,
        bool passed,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        uint256 supplyAtPropose
    );
    event ProposerTransferred(address indexed oldProposer, address indexed newProposer);

    error NotProposer();
    error BadEndRound();
    error BadBar();
    error UnknownProposal();
    error VotingClosed();
    error VoteLockActive();
    error NoVotingPower();
    error VotingNotOver();
    error AlreadyFinalized();

    constructor(address token_, address hub_, address proposer_) {
        require(token_ != address(0) && hub_ != address(0) && proposer_ != address(0));
        TOKEN = ILockVoteToken(token_);
        HUB = ILockVoteHub(hub_);
        proposer = proposer_;
    }

    function transferProposer(address newProposer) external {
        if (msg.sender != proposer) revert NotProposer();
        require(newProposer != address(0));
        emit ProposerTransferred(proposer, newProposer);
        proposer = newProposer;
    }

    // ------------------------------------------------------------------

    function propose(
        string calldata description,
        uint256 endRound,
        uint16 minTurnoutBps,
        uint16 approvalBps
    ) external returns (uint256 proposalId) {
        if (msg.sender != proposer) revert NotProposer();
        uint256 nowRound = TOKEN.getCurrentRound();
        if (endRound <= nowRound || endRound > nowRound + MAX_PROPOSAL_ROUNDS) revert BadEndRound();
        if (minTurnoutBps > 10000 || approvalBps >= 10000) revert BadBar();

        proposalId = ++proposalCount;
        Proposal storage p = _proposals[proposalId];
        p.endRound = uint64(endRound);
        p.createdRound = uint64(nowRound);
        p.minTurnoutBps = minTurnoutBps;
        p.approvalBps = approvalBps;
        p.supplyAtPropose = TOKEN.totalSupply();
        p.descriptionHash = keccak256(bytes(description));

        emit ProposalCreated(proposalId, endRound, minTurnoutBps, approvalBps, description);
    }

    /// A lane-A (prediction) lock does NOT block voting — those tokens cannot
    /// move either — but lane B is still written, because lane A might expire
    /// before this vote ends.
    function castVote(uint256 proposalId, VoteType support) external returns (uint256 weight) {
        Proposal storage p = _proposals[proposalId];
        if (p.endRound == 0) revert UnknownProposal();
        uint256 nowRound = TOKEN.getCurrentRound();
        if (nowRound >= p.endRound) revert VotingClosed();
        if (TOKEN.lockUntil(msg.sender, LANE_B) >= nowRound) revert VoteLockActive();

        weight = TOKEN.balanceOf(msg.sender);
        if (weight == 0) revert NoVotingPower();

        if (support == VoteType.For) p.forVotes += weight;
        else if (support == VoteType.Against) p.againstVotes += weight;
        else p.abstainVotes += weight;

        // Locked for exactly the remainder of the window and not one round
        // longer: transfers are blocked while lockB >= round, voting is open
        // while round < endRound.
        HUB.voteLock(msg.sender, p.endRound - 1);

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    function finalize(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        if (p.endRound == 0) revert UnknownProposal();
        if (TOKEN.getCurrentRound() < p.endRound) revert VotingNotOver();
        if (p.finalized) revert AlreadyFinalized();

        p.finalized = true;
        p.passed = _evaluate(p);
        p.finalizedRound = uint64(TOKEN.getCurrentRound());

        emit ProposalFinalized(
            proposalId, p.passed, p.forVotes, p.againstVotes, p.abstainVotes, p.supplyAtPropose);
    }

    function _evaluate(Proposal storage p) internal view returns (bool) {
        uint256 counted = p.forVotes + p.againstVotes;
        uint256 turnout = counted + p.abstainVotes;
        if (p.minTurnoutBps > 0) {
            if (turnout * 10000 < uint256(p.minTurnoutBps) * p.supplyAtPropose) return false;
        }
        if (counted == 0) return false;
        return p.forVotes * 10000 > uint256(p.approvalBps) * counted;
    }

    // ------------------------------------------------------------------

    function proposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    struct Result {
        bool finalized;
        bool passed;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 forBps;        // among for+against; 0 when nothing counted
        uint256 turnoutBps;    // of supplyAtPropose, incl. abstain
        uint256 supplyAtPropose;
        uint256 endRound;
    }

    function result(uint256 proposalId) external view returns (Result memory r) {
        Proposal storage p = _proposals[proposalId];
        if (p.endRound == 0) revert UnknownProposal();
        uint256 counted = p.forVotes + p.againstVotes;
        r = Result({
            finalized: p.finalized,
            passed: p.passed,
            forVotes: p.forVotes,
            againstVotes: p.againstVotes,
            abstainVotes: p.abstainVotes,
            forBps: counted == 0 ? 0 : (p.forVotes * 10000) / counted,
            turnoutBps: p.supplyAtPropose == 0
                ? 0 : ((counted + p.abstainVotes) * 10000) / p.supplyAtPropose,
            supplyAtPropose: p.supplyAtPropose,
            endRound: p.endRound
        });
    }
}
