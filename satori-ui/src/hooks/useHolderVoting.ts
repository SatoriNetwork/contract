import { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { useWallet } from './useWallet';
import { getHolderGovernor, getProofsUrl, DEFAULT_CHAIN_ID } from '../contracts/addresses';

/// Holder voting (HistoricalBalanceGovernor + satori-proof-pipeline).
///
/// The division of labor mirrors the trust design exactly:
///  - the PIPELINE is convenience: it names which proposals exist, holds the
///    words (verified against the on-chain hash HERE, in the browser — the
///    pipeline is not trusted with them), and hands each voter a ready ballot;
///  - the CHAIN is truth: tallies, deadlines, outcomes, and the vote itself.
///    A ballot is a Merkle proof of the voter's snapshot balance; castVote
///    verifies it against the snapshot's own storage root, so the pipeline
///    could at worst fail to serve — never miscount.
const GOVERNOR_ABI = [
  'function proposal(uint256) view returns (tuple(uint64 snapshotBlock, bytes32 snapshotBlockHash, bytes32 stateRoot, bytes32 tokenStorageRoot, uint48 voteStart, uint48 voteEnd, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, bytes32 actionsHash, bytes32 descriptionHash, uint64 createdAtBlock, bool activated, uint16 minTurnoutBps, uint16 approvalBps, uint256 snapshotTotalSupply, bool finalized, bool passed, uint64 finalizedAt))',
  'function hasVoted(uint256, address) view returns (bool)',
  'function castVote(uint256 proposalId, uint8 support, bytes[] balanceProof) returns (uint256)',
  'function finalize(uint256 proposalId)',
];

// enum VoteType { Against, For, Abstain } — order is the contract's.
export const AGAINST = 0;
export const FOR = 1;
export const ABSTAIN = 2;

export type ProposalStatus =
  | 'pending'      // seen, not yet activated (pipeline is on it)
  | 'dead'         // activation window closed unactivated
  | 'open'         // voting now
  | 'closed'       // voting over, awaiting finalize
  | 'passed'
  | 'failed';

export interface ProposalRow {
  id: string;
  description: string | null;     // null = words not posted / hash mismatch
  snapshotBlock: number;
  voteStart: number;
  voteEnd: number;
  forVotes: bigint;
  againstVotes: bigint;
  abstainVotes: bigint;
  snapshotTotalSupply: bigint;
  minTurnoutBps: number;
  approvalBps: number;
  status: ProposalStatus;
  hasVoted: boolean;
  /// Snapshot balance per the pipeline's ballot; null until known, BigInt(0) = no vote.
  myWeight: bigint | null;
}

function deriveStatus(p: any, dead: boolean, now: number): ProposalStatus {
  if (p.finalized) return p.passed ? 'passed' : 'failed';
  if (!p.activated) return dead ? 'dead' : 'pending';
  if (now < Number(p.voteEnd)) return 'open';
  return 'closed';
}

export function useHolderVoting() {
  const { provider, signer, address, chainId } = useWallet();
  const cid = chainId ?? DEFAULT_CHAIN_ID;
  const governorAddr = getHolderGovernor(cid);
  const proofsUrl = getProofsUrl(cid);
  const enabled = !!governorAddr && !!proofsUrl;

  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const governor = useMemo(() => {
    if (!enabled || !provider) return null;
    return new ethers.Contract(governorAddr!, GOVERNOR_ABI, signer ?? provider);
  }, [enabled, governorAddr, provider, signer]);

  const refresh = useCallback(async () => {
    if (!enabled || !governor) { setLoading(false); return; }
    setError(null);
    try {
      const listRes = await fetch(`${proofsUrl}/proposals`);
      if (!listRes.ok) throw new Error(`pipeline answered ${listRes.status}`);
      const list: Array<{ id: string; dead: string | null }> = await listRes.json();
      // "Voting over" is judged by the CHAIN's clock, not the browser's —
      // castVote and finalize both compare block.timestamp to voteEnd, so a
      // status derived from Date.now() can disagree with what a transaction
      // would actually do (clock skew, or a warped dev chain).
      const now = (await provider!.getBlock('latest'))!.timestamp;

      const rows = await Promise.all(list.map(async (item): Promise<ProposalRow> => {
        const [meta, p, voted, ballot] = await Promise.all([
          fetch(`${proofsUrl}/proposals/${item.id}`).then((r) => (r.ok ? r.json() : null)),
          governor.proposal(item.id),
          address ? governor.hasVoted(item.id, address) : Promise.resolve(false),
          address
            ? fetch(`${proofsUrl}/proposals/${item.id}/proof/${address}`)
                .then((r) => (r.ok ? r.json() : r.status === 404 ? { balance: '0' } : null))
                .catch(() => null)
            : Promise.resolve(null),
        ]);

        // The words are DISPLAYED only if they hash to the chain's commitment.
        // The pipeline already enforces this, but the pipeline is convenience,
        // not truth — so the browser checks again and shows nothing otherwise.
        let description: string | null = null;
        if (meta?.description != null) {
          const h = ethers.keccak256(ethers.toUtf8Bytes(meta.description));
          if (h.toLowerCase() === p.descriptionHash.toLowerCase()) description = meta.description;
        }

        return {
          id: item.id,
          description,
          snapshotBlock: Number(p.snapshotBlock),
          voteStart: Number(p.voteStart),
          voteEnd: Number(p.voteEnd),
          forVotes: p.forVotes,
          againstVotes: p.againstVotes,
          abstainVotes: p.abstainVotes,
          snapshotTotalSupply: p.snapshotTotalSupply,
          minTurnoutBps: Number(p.minTurnoutBps),
          approvalBps: Number(p.approvalBps),
          status: deriveStatus(p, !!(meta && meta.dead) || !!item.dead, now),
          hasVoted: voted,
          myWeight: ballot ? BigInt(ballot.balance) : null,
        };
      }));

      rows.sort((a, b) => b.snapshotBlock - a.snapshotBlock);
      setProposals(rows);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [enabled, governor, proofsUrl, address, provider]);

  useEffect(() => { refresh(); }, [refresh]);

  /// Cast with the pipeline's ready ballot. The chain re-verifies the proof
  /// and reads the weight OUT OF IT — nothing the pipeline says is trusted.
  const vote = useCallback(async (id: string, support: 0 | 1 | 2) => {
    if (!governor || !signer || !address) throw new Error('connect a wallet to vote');
    const r = await fetch(`${proofsUrl}/proposals/${id}/proof/${address}`);
    if (r.status === 404) {
      throw new Error('This account held no SATORI at the snapshot block, so it has no vote on this proposal.');
    }
    if (!r.ok) throw new Error(`ballot fetch failed (${r.status})`);
    const ballot = await r.json();
    const tx = await governor.castVote(id, support, ballot.proof);
    await tx.wait();
    await refresh();
  }, [governor, signer, address, proofsUrl, refresh]);

  /// Permissionless close-out: computes the verdict from the frozen tallies
  /// and publishes it. Anyone may press this; someone has to.
  const finalize = useCallback(async (id: string) => {
    if (!governor || !signer) throw new Error('connect a wallet to finalize');
    const tx = await governor.finalize(id);
    await tx.wait();
    await refresh();
  }, [governor, signer, refresh]);

  return { enabled, loading, error, proposals, refresh, vote, finalize };
}
