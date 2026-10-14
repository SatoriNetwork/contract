import React, { useState } from 'react';
import { ethers } from 'ethers';
import { useHolderVoting, ProposalRow, FOR, AGAINST, ABSTAIN } from '../hooks/useHolderVoting';
import { InfoTip } from './InfoTip';
import { explainError } from '../utils/errors';

/// Community proposals — holder sentiment, weighed by proven snapshot balance.
///
/// Everything a voter needs to see the point is on the card: the words, the
/// bar the proposal committed to before any vote existed, the live tally as
/// percentages, and — once finalized — the frozen outcome. A vote here MOVES
/// NOTHING on chain by design; it publishes what the holders think, where
/// nobody can edit it.
export function ProposalsTab() {
  const { enabled, loading, error, proposals, refresh, vote, finalize } = useHolderVoting();
  const [busy, setBusy] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setTxError(null);
    try { await fn(); } catch (e: any) { setTxError(explainError(e)); } finally { setBusy(null); }
  };

  if (!enabled) return null;   // no governor on this chain: App hides the tab too
  if (loading) {
    return <div className="card-themed p-6 text-center text-gray-500 text-sm">Loading proposals…</div>;
  }

  return (
    <div className="space-y-4" data-testid="proposals-tab">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-1.5">
            Proposals
            <InfoTip>
              One token, one vote, at a snapshot taken the moment a proposal is
              made. Your ballot is a cryptographic proof of your balance at that
              block — prepared for you automatically — and the contract checks
              it against the chain&apos;s own history, so no list of voters is
              trusted anywhere. Votes here publish what holders think; they do
              not move funds or settings.
            </InfoTip>
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Weighed by your SATORI balance at each proposal&apos;s snapshot.
          </p>
        </div>
        <button onClick={() => refresh()} className="text-xs text-gray-500 hover:text-gray-300 underline">
          refresh
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg text-xs bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300">
          <strong>Could not load proposals.</strong> {error}
        </div>
      )}
      {txError && (
        <div className="p-3 rounded-lg text-xs bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300">
          {txError}
        </div>
      )}

      {proposals.length === 0 && !error && (
        <div className="card-themed p-6 text-center text-gray-500 text-sm">
          No proposals yet.
        </div>
      )}

      {proposals.map((p) => (
        <ProposalCard key={p.id} p={p} busy={busy} run={run} vote={vote} finalize={finalize} />
      ))}
    </div>
  );
}

function ProposalCard({ p, busy, run, vote, finalize }: {
  p: ProposalRow;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  vote: (id: string, support: 0 | 1 | 2) => Promise<void>;
  finalize: (id: string) => Promise<void>;
}) {
  const counted = p.forVotes + p.againstVotes;
  const turnout = counted + p.abstainVotes;
  const pct = (num: bigint, den: bigint) =>
    den === BigInt(0) ? 0 : Number((num * BigInt(10000)) / den) / 100;
  const forPct = pct(p.forVotes, counted);
  const againstPct = pct(p.againstVotes, counted);
  const turnoutPct = pct(turnout, p.snapshotTotalSupply);
  const fmt = (v: bigint) => Number(ethers.formatEther(v)).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });

  const [title, ...rest] = (p.description ?? '').split('\n');
  const body = rest.join('\n').trim();

  const badge: Record<string, [string, string]> = {
    pending: ['activating…', 'bg-gray-100 dark:bg-gray-800 text-gray-500'],
    dead: ['never activated', 'bg-gray-100 dark:bg-gray-800 text-gray-500'],
    open: ['voting open', 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'],
    closed: ['awaiting finalize', 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'],
    passed: ['passed', 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'],
    failed: ['did not pass', 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'],
  };
  const [badgeText, badgeCls] = badge[p.status];
  const canVote = p.status === 'open' && !p.hasVoted && p.myWeight !== null && p.myWeight > BigInt(0);

  return (
    <div className="card-themed p-4 space-y-3" data-testid={`proposal-${p.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium break-words">
            {p.description ? title : <span className="text-gray-500 italic">
              Proposal text not yet published (only its hash is on chain).
            </span>}
          </div>
          {body && (
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 whitespace-pre-wrap break-words">{body}</p>
          )}
        </div>
        <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-medium ${badgeCls}`}>{badgeText}</span>
      </div>

      {/* The bar this proposal committed to before any vote existed. */}
      <div className="text-xs text-gray-500 dark:text-gray-400">
        Needs {p.approvalBps / 100}%+ approval
        {p.minTurnoutBps > 0 && <> and {p.minTurnoutBps / 100}% turnout</>}
        {p.status === 'open' && <> · voting ends {new Date(p.voteEnd * 1000).toLocaleString()}</>}
      </div>

      {(p.status !== 'pending' && p.status !== 'dead') && (
        <div className="space-y-1.5">
          <div className="flex h-2 rounded overflow-hidden bg-gray-200 dark:bg-gray-700">
            <div className="bg-emerald-500" style={{ width: `${forPct}%` }} />
            <div className="bg-red-400" style={{ width: `${againstPct}%` }} />
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-600 dark:text-gray-300">
            <span>For {forPct}% ({fmt(p.forVotes)})</span>
            <span>Against {againstPct}% ({fmt(p.againstVotes)})</span>
            {p.abstainVotes > BigInt(0) && <span>Abstain {fmt(p.abstainVotes)}</span>}
            <span className="text-gray-400">turnout {turnoutPct}% of snapshot supply</span>
          </div>
        </div>
      )}

      {canVote && (
        <div className="flex items-center gap-2 pt-1">
          {([['For', FOR, 'bg-emerald-600 hover:bg-emerald-700'],
             ['Against', AGAINST, 'bg-red-500 hover:bg-red-600'],
             ['Abstain', ABSTAIN, 'bg-gray-500 hover:bg-gray-600']] as const).map(([label, support, cls]) => (
            <button
              key={label}
              disabled={busy !== null}
              onClick={() => run(`${p.id}-${support}`, () => vote(p.id, support))}
              className={`px-3 py-1.5 rounded text-sm font-medium text-white disabled:opacity-50 ${cls}`}
              data-testid={`vote-${label.toLowerCase()}-${p.id}`}
            >
              {busy === `${p.id}-${support}` ? '…' : label}
            </button>
          ))}
          <span className="text-xs text-gray-500 dark:text-gray-400">
            your weight: {fmt(p.myWeight!)} SATORI
          </span>
        </div>
      )}
      {p.status === 'open' && p.hasVoted && (
        <div className="text-xs text-emerald-600 dark:text-emerald-400">You have voted on this proposal.</div>
      )}
      {p.status === 'open' && !p.hasVoted && p.myWeight === BigInt(0) && (
        <div className="text-xs text-gray-500 dark:text-gray-400">
          This account held no SATORI at the snapshot, so it has no vote here.
        </div>
      )}

      {p.status === 'closed' && (
        <button
          disabled={busy !== null}
          onClick={() => run(`${p.id}-fin`, () => finalize(p.id))}
          className="px-3 py-1.5 rounded text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
          data-testid={`finalize-${p.id}`}
        >
          {busy === `${p.id}-fin` ? '…' : 'Finalize result'}
        </button>
      )}
    </div>
  );
}
