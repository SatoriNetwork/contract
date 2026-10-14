// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {RLPReader} from "./libraries/RLPReader.sol";
import {MerklePatricia} from "./libraries/MerklePatricia.sol";
import {BlockHeaderProof} from "./libraries/BlockHeaderProof.sol";

/// @title Token-holder voting by historical storage proof.
///
/// Phases 3-5 of `docs/design/holder-voting-proposal.txt`: the token account
/// proof, the proposal lifecycle, and voting. Voting weight is a holder's
/// balance at a snapshot block, proved against Ethereum's state trie — so there
/// are no checkpoints, no delegation, no snapshot publisher, and ordinary
/// transfers pay no governance gas at all.
contract HistoricalBalanceGovernor {
    // ------------------------------------------------------------------
    // Immutable configuration
    // ------------------------------------------------------------------

    /// The token whose balances are voting weight. Immutable so a proposal can
    /// never choose which account is being proven (proposal §38.3).
    address public immutable TOKEN;

    /// `_totalSupply` in SatoriToken — VERIFIED against the compiled layout
    /// alongside `_balances`.
    uint256 public constant TOTAL_SUPPLY_SLOT = 2;

    /// `_balances` in SatoriToken — VERIFIED against the compiled storage
    /// layout, not assumed (`holder-voting-review.md` §1).
    uint256 public constant BALANCES_SLOT = 0;

    /// How long a proposal has to be activated before it expires, in blocks.
    ///
    /// THIS EXISTS FOR TWO REASONS, and the second one is measured.
    ///
    /// 1. Without a bound, a proposer picks a snapshot and then chooses WHEN to
    ///    open voting — propose today, wait for a large holder to sell, then
    ///    activate while that holder still carries full snapshot weight.
    /// 2. Activation needs `eth_getProof` at the snapshot block, and public Base
    ///    RPCs serve proofs for hundreds of blocks, not days: measured OK at 512
    ///    blocks deep and failing by 1,000 (review §9). A window wider than the
    ///    proof retention would let proposals be created that can never be
    ///    activated by anyone.
    uint256 public immutable ACTIVATION_WINDOW;

    uint256 public immutable VOTING_PERIOD;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    enum VoteType { Against, For, Abstain }

    struct Proposal {
        uint64  snapshotBlock;
        bytes32 snapshotBlockHash;
        bytes32 stateRoot;
        bytes32 tokenStorageRoot;
        uint48  voteStart;
        uint48  voteEnd;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        bytes32 actionsHash;
        bytes32 descriptionHash;
        uint64  createdAtBlock;
        bool    activated;

        /// `minTurnoutBps`: votes cast (for + against + abstain) must reach this
        /// share of the SNAPSHOT supply. Zero means no floor.
        /// `approvalBps`: the for-share among for + against must EXCEED this.
        /// 5000 is exactly the old strict-majority rule; 6667 is a two-thirds
        /// supermajority. Abstain counts toward turnout, never toward approval —
        /// an abstention is "I showed up" and not "I agree".
        uint16  minTurnoutBps;
        uint16  approvalBps;

        uint256 snapshotTotalSupply;

        bool    finalized;
        bool    passed;
        uint64  finalizedAt;
    }

    uint256 public proposalNonce;
    /// INTERNAL, with a struct-returning accessor below. Solidity's generated
    /// getter for a public mapping returns every field as a separate value, and
    /// at nineteen fields that is stack-too-deep without via-IR. Returning the
    /// struct costs nothing and reads better from a dapp.
    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    // ------------------------------------------------------------------

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        uint256 snapshotBlock,
        bytes32 snapshotBlockHash,
        bytes32 actionsHash,
        bytes32 descriptionHash,
        uint256 minTurnoutBps,
        uint256 approvalBps
    );
    event ProposalActivated(
        uint256 indexed proposalId,
        bytes32 stateRoot,
        bytes32 tokenStorageRoot,
        uint256 voteStart,
        uint256 voteEnd
    );
    event VoteCast(uint256 indexed proposalId, address indexed voter, VoteType support, uint256 weight);
    event ProposalFinalized(
        uint256 indexed proposalId,
        bool passed,
        uint256 forVotes,
        uint256 againstVotes,
        uint256 abstainVotes,
        uint256 snapshotTotalSupply
    );

    error UnknownProposal();
    error AlreadyActivated();
    error ActivationWindowClosed();
    error NotActive();
    error AlreadyVoted();
    error NoVotingPower();
    error BlockhashUnavailable();
    error NoAccount();
    error BadAccountEncoding();
    error BadConfig();
    error VotingStillOpen();
    error BadThresholds();
    error AlreadyFinalized();

    constructor(address token_, uint256 activationWindowBlocks_, uint256 votingPeriodSeconds_) {
        if (token_ == address(0)) revert BadConfig();
        if (activationWindowBlocks_ == 0 || votingPeriodSeconds_ == 0) revert BadConfig();
        // A window wider than the EVM's own BLOCKHASH reach is a promise that
        // cannot be kept: the header could still be presented (the hash is
        // stored), but nothing else about such a window is useful, and the proof
        // retention that really binds is far shorter still.
        if (activationWindowBlocks_ > 256) revert BadConfig();
        TOKEN = token_;
        ACTIVATION_WINDOW = activationWindowBlocks_;
        VOTING_PERIOD = votingPeriodSeconds_;
    }

    // ------------------------------------------------------------------
    // 1. Propose — capture the anchor while the EVM can still see it
    // ------------------------------------------------------------------

    /// The snapshot is the PREVIOUS block, which is what makes an atomic flash
    /// loan useless: a loan taken and repaid inside this transaction cannot have
    /// existed in a block that was already sealed (§33).
    /// @param minTurnoutBps turnout floor as bps of snapshot supply; 0 = none
    /// @param approvalBps    for-share among for+against must EXCEED this;
    ///                       5000 reproduces plain strict majority
    function propose(
        bytes32 actionsHash,
        bytes32 descriptionHash,
        uint256 minTurnoutBps,
        uint256 approvalBps
    )
        external
        returns (uint256 proposalId)
    {
        if (minTurnoutBps > 10_000 || approvalBps > 10_000) revert BadThresholds();

        uint256 snapshotBlock = block.number - 1;
        bytes32 snapshotHash = blockhash(snapshotBlock);
        if (snapshotHash == bytes32(0)) revert BlockhashUnavailable();

        // The bar is part of the id's preimage, so the same actions at a
        // different bar are a DIFFERENT proposal — the two can never be
        // conflated by an indexer or a signature.
        proposalId = uint256(keccak256(abi.encode(
            block.chainid, address(this), ++proposalNonce,
            snapshotBlock, snapshotHash, actionsHash, descriptionHash,
            minTurnoutBps, approvalBps
        )));

        Proposal storage p = _proposals[proposalId];
        p.snapshotBlock = uint64(snapshotBlock);
        p.snapshotBlockHash = snapshotHash;
        p.actionsHash = actionsHash;
        p.descriptionHash = descriptionHash;
        p.createdAtBlock = uint64(block.number);
        p.minTurnoutBps = uint16(minTurnoutBps);
        p.approvalBps = uint16(approvalBps);

        emit ProposalCreated(
            proposalId, msg.sender, snapshotBlock, snapshotHash,
            actionsHash, descriptionHash, minTurnoutBps, approvalBps
        );
    }

    // ------------------------------------------------------------------
    // 2. Activate — authenticate the header, then the token account, once
    // ------------------------------------------------------------------

    /// Permissionless: there is no reason to privilege this. A malicious
    /// activator can only submit data that fails to verify, which reverts.
    ///
    /// The token's account proof is identical for every voter at a snapshot, so
    /// it is verified ONCE here rather than being carried in every ballot.
    /// @param totalSupplyProof storage proof for `_totalSupply` at the snapshot.
    ///        Against the SAME storage root as every balance, so it costs one
    ///        extra proof once rather than anything per voter.
    function activateProposal(
        uint256 proposalId,
        bytes calldata rawHeader,
        bytes[] calldata tokenAccountProof,
        bytes[] calldata totalSupplyProof
    ) external {
        Proposal storage p = _proposals[proposalId];
        if (p.snapshotBlockHash == bytes32(0)) revert UnknownProposal();
        if (p.activated) revert AlreadyActivated();
        if (block.number > uint256(p.createdAtBlock) + ACTIVATION_WINDOW) {
            revert ActivationWindowClosed();
        }

        bytes32 stateRoot = BlockHeaderProof.stateRootOf(
            p.snapshotBlockHash, uint256(p.snapshotBlock), rawHeader
        );

        bytes32 storageRoot = _accountStorageRoot(stateRoot, TOKEN, tokenAccountProof);

        p.snapshotTotalSupply = _storageUint(
            storageRoot, bytes32(TOTAL_SUPPLY_SLOT), totalSupplyProof
        );

        p.stateRoot = stateRoot;
        p.tokenStorageRoot = storageRoot;
        p.voteStart = uint48(block.timestamp);
        p.voteEnd = uint48(block.timestamp + VOTING_PERIOD);
        p.activated = true;

        emit ProposalActivated(proposalId, stateRoot, storageRoot, p.voteStart, p.voteEnd);
    }

    // ------------------------------------------------------------------
    // 3. Vote
    // ------------------------------------------------------------------

    /// The voter never states their balance — it is READ OUT of the proof
    /// (§38.1). And the slot is derived from `msg.sender` here rather than
    /// supplied by the caller (§38.2), which is what stops someone proving
    /// `totalSupply` or any other large number as their weight.
    function castVote(uint256 proposalId, VoteType support, bytes[] calldata balanceProof)
        external
        returns (uint256 weight)
    {
        Proposal storage p = _proposals[proposalId];
        if (!p.activated) revert NotActive();
        if (block.timestamp < p.voteStart || block.timestamp >= p.voteEnd) revert NotActive();
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted();

        weight = _storageUint(p.tokenStorageRoot, balanceSlot(msg.sender), balanceProof);
        if (weight == 0) revert NoVotingPower();

        // Set BEFORE tallying. The flag is the double-vote guard, not proof
        // identity — a differently encoded but equally valid proof must not buy
        // a second ballot (§53).
        hasVoted[proposalId][msg.sender] = true;

        if (support == VoteType.For) p.forVotes += weight;
        else if (support == VoteType.Against) p.againstVotes += weight;
        else p.abstainVotes += weight;

        emit VoteCast(proposalId, msg.sender, support, weight);
    }

    // ------------------------------------------------------------------
    // 4. Finalize — the default "execution"
    // ------------------------------------------------------------------

    function finalize(uint256 proposalId) external {
        Proposal storage p = _proposals[proposalId];
        if (!p.activated) revert NotActive();
        if (block.timestamp < p.voteEnd) revert VotingStillOpen();
        if (p.finalized) revert AlreadyFinalized();

        bool passed_ = _evaluate(proposalId);

        // Effects before the hook, so an overriding subclass cannot re-enter
        // into a second finalization.
        p.finalized = true;
        p.passed = passed_;
        p.finalizedAt = uint64(block.timestamp);

        emit ProposalFinalized(
            proposalId,
            passed_,
            p.forVotes,
            p.againstVotes,
            p.abstainVotes,
            p.snapshotTotalSupply
        );

        _onFinalized(proposalId, passed_);
    }

    function _evaluate(uint256 proposalId) internal view virtual returns (bool) {
        Proposal storage p = _proposals[proposalId];
        uint256 cast = p.forVotes + p.againstVotes + p.abstainVotes;

        // Turnout floor. Abstentions count here and only here: an abstention is
        // "I showed up", not "I agree". A snapshot with no provable supply
        // cannot demonstrate turnout, so a floor against it cannot be met.
        if (p.minTurnoutBps != 0) {
            if (p.snapshotTotalSupply == 0) return false;
            if (cast * 10_000 < p.snapshotTotalSupply * uint256(p.minTurnoutBps)) return false;
        }

        // Approval, strictly EXCEEDING the bar, among for + against only. At
        // 5000 this is algebraically `for > against` — the plain majority the
        // contract used before bars existed — so a tie always fails.
        return p.forVotes * 10_000 > (p.forVotes + p.againstVotes) * uint256(p.approvalBps);
    }

    /// THE OVERRIDE SEAM for the ACTION. Does nothing here, deliberately — the event above is
    /// the default ability, and a governor that should actually *do* something
    /// implements this instead. Kept as a named hook rather than left to a
    /// future rewrite so the extension point is obvious and so a subclass
    /// inherits the vote counting, the proofs and the guards unchanged.
    function _onFinalized(uint256 proposalId, bool passed_) internal virtual {}

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function proposal(uint256 proposalId) external view returns (Proposal memory) {
        return _proposals[proposalId];
    }

    /// The RAW Solidity slot. This is what goes to `eth_getProof`; the trie path
    /// is its hash, applied inside the walk. Conflating the two is §10's trap.
    function balanceSlot(address holder) public pure returns (bytes32) {
        return keccak256(abi.encode(holder, BALANCES_SLOT));
    }

    function succeeded(uint256 proposalId) external view returns (bool) {
        Proposal storage p = _proposals[proposalId];
        if (!p.activated || block.timestamp < p.voteEnd) return false;
        return _evaluate(proposalId);
    }

    /// All bps are out of 10_000.
    /// Returned as a STRUCT rather than twelve named values. Twelve returns is
    /// stack-too-deep without via-IR, and named fields are what a dapp wants anyway.
    struct Result {
        bool finalized;
        bool passed;
        uint256 forVotes;
        uint256 againstVotes;
        uint256 abstainVotes;
        uint256 forBps;               // of votes CAST
        uint256 againstBps;           // of votes CAST
        uint256 abstainBps;           // of votes CAST
        uint256 turnoutBps;           // of SNAPSHOT SUPPLY
        uint256 snapshotTotalSupply;
        uint256 minTurnoutBps;        // the bar this proposal committed to
        uint256 approvalBps;
    }

    function result(uint256 proposalId) external view returns (Result memory r) {
        Proposal storage p = _proposals[proposalId];
        r.finalized = p.finalized;
        r.passed = p.finalized ? p.passed : _evaluate(proposalId);
        r.forVotes = p.forVotes;
        r.againstVotes = p.againstVotes;
        r.abstainVotes = p.abstainVotes;
        r.snapshotTotalSupply = p.snapshotTotalSupply;
        r.minTurnoutBps = p.minTurnoutBps;
        r.approvalBps = p.approvalBps;

        uint256 cast = r.forVotes + r.againstVotes + r.abstainVotes;
        if (cast != 0) {
            r.forBps = (r.forVotes * 10_000) / cast;
            r.againstBps = (r.againstVotes * 10_000) / cast;
            r.abstainBps = (r.abstainVotes * 10_000) / cast;
        }
        if (r.snapshotTotalSupply != 0) {
            r.turnoutBps = (cast * 10_000) / r.snapshotTotalSupply;
        }
    }

    function activationDeadline(uint256 proposalId) external view returns (uint256) {
        return uint256(_proposals[proposalId].createdAtBlock) + ACTIVATION_WINDOW;
    }

    // ------------------------------------------------------------------

    function _accountStorageRoot(bytes32 stateRoot, address account, bytes[] calldata proof)
        private
        pure
        returns (bytes32)
    {
        bytes memory encoded = MerklePatricia.get(
            stateRoot, keccak256(abi.encodePacked(account)), proof
        );
        if (encoded.length == 0) revert NoAccount();
        RLPReader.Item[] memory fields = RLPReader.toList(encoded);
        if (fields.length != 4) revert BadAccountEncoding();
        return RLPReader.toBytes32(fields[2]);   // [nonce, balance, storageRoot, codeHash]
    }

    function _storageUint(bytes32 storageRoot, bytes32 rawSlot, bytes[] calldata proof)
        private
        pure
        returns (uint256)
    {
        bytes memory encoded = MerklePatricia.get(
            storageRoot, keccak256(abi.encodePacked(rawSlot)), proof
        );
        if (encoded.length == 0) return 0;   // proven absent == zero
        return RLPReader.toUint(_item(encoded));
    }

    function _item(bytes memory raw) private pure returns (RLPReader.Item memory) {
        uint256 ptr;
        assembly { ptr := add(raw, 0x20) }
        uint256 prefix = uint8(raw[0]);
        if (prefix < 0x80) return RLPReader.Item(ptr, 1, false);
        if (prefix < 0xb8) return RLPReader.Item(ptr + 1, prefix - 0x80, false);
        uint256 lolen = prefix - 0xb7;
        uint256 len;
        assembly { len := shr(sub(256, mul(8, lolen)), mload(add(ptr, 1))) }
        return RLPReader.Item(ptr + 1 + lolen, len, false);
    }
}
