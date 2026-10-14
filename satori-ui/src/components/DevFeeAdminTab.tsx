import React, { useState } from 'react';
import { ethers } from 'ethers';
import { useDevFee, SplitterNode } from '../hooks/useDevFee';
import { InfoTip } from './InfoTip';
import { SplitterRotation } from './SplitterRotation';
import { explainError } from '../utils/errors';

/// Administrative controls for whoever holds the AUTHORITY on a dev-fee
/// splitter. Gated in App.tsx on `isAuthority`.
///
/// The authority is a narrow role, and it is worth being blunt about how narrow,
/// because "admin" invites the assumption that it can restructure the split. It
/// cannot. `SatoriSplitterImmutable` has no addSlot, no setShares and no
/// addRecipient: the slots and their percentages are fixed in the constructor
/// and there is no function anywhere that changes them. That is the whole point
/// of the contract's name.
///
/// What the authority CAN do is exactly three things:
///   1. redirect this splitter's slot in its parent, alone and without consent
///      (`rotateAt`), which sends all future income somewhere else;
///   2. hand that right to another address (`transferAuthority`);
///   3. give it up forever (`renounceAuthority`), after which only the payees'
///      threshold consent can ever move the slot.
///
/// So the authority is not an administrator of the money. It is a holder of one
/// irreversible redirect, which is why this page reads as a warning more than a
/// control panel.
export function DevFeeAdminTab() {
  const {
    loading, root, nodes, error,
    refresh, readProposal, approveRotation, revokeRotation, rotateAt,
    transferAuthority, renounceAuthority,
  } = useDevFee();
  const [busy, setBusy] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setTxError(null);
    try { await fn(); } catch (e: any) { setTxError(explainError(e)); } finally { setBusy(null); }
  };

  if (loading) {
    return <div className="card-themed p-6 text-center text-gray-500 text-sm">Loading dev fee admin…</div>;
  }

  const mine = nodes.filter((n) => n.iAmAuthority);

  return (
    <div className="space-y-4" data-testid="devfee-admin-tab">
      <div>
        <h3 className="text-lg font-semibold flex items-center gap-1.5">
          Dev fee admin
          <InfoTip>
            The authority on a splitter holds one power: it can redirect that splitter&apos;s
            slot in its parent without asking anyone. It cannot add slots, remove them,
            or change any percentage. Those are sealed when the splitter is built.
          </InfoTip>
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          You hold the authority on {mine.length === 1 ? 'one splitter' : `${mine.length} splitters`}.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-800 dark:text-red-300">
          {error}
        </div>
      )}
      {txError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-800 dark:text-red-300">
          {txError}
        </div>
      )}

      {mine.length === 0 && (
        <div className="card-themed p-4 text-sm text-gray-500">
          Your address is not the authority on any splitter in this tree.
        </div>
      )}

      {mine.map((n) => (
        <AdminNode
          key={n.address}
          node={n}
          busy={busy}
          run={run}
          readProposal={readProposal}
          approve={approveRotation}
          revoke={revokeRotation}
          execute={rotateAt}
          transferAuthority={transferAuthority}
          renounceAuthority={renounceAuthority}
        />
      ))}

      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span className="font-mono truncate" title={root ?? ''}>tree: {root}</span>
        <button onClick={() => run('refresh', refresh)} disabled={busy !== null} className="underline shrink-0 ml-2">
          {busy === 'refresh' ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
        <p>
          <strong>Shares cannot be changed by anyone, ever.</strong> There is no function to
          add a slot, remove one, or alter a percentage. They are fixed when the splitter
          is deployed.
        </p>
        <p>
          <strong>Redirecting does not move money that has already arrived.</strong> Funds
          sitting in a splitter stay claimable by its current slots under the current
          shares. Only future income follows the redirect.
        </p>
      </div>
    </div>
  );
}

function AdminNode({
  node, busy, run, readProposal, approve, revoke, execute,
  transferAuthority, renounceAuthority,
}: {
  node: SplitterNode;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  readProposal: any; approve: any; revoke: any; execute: any;
  transferAuthority: (n: SplitterNode, to: string) => Promise<void>;
  renounceAuthority: (n: SplitterNode) => Promise<void>;
}) {
  const [handOpen, setHandOpen] = useState(false);
  const [handTo, setHandTo] = useState('');
  const [handConfirm, setHandConfirm] = useState('');
  const [giveUpOpen, setGiveUpOpen] = useState(false);
  const [giveUpWord, setGiveUpWord] = useState('');

  const handValid = ethers.isAddress(handTo.trim());
  const handMatches = handValid && handTo.trim().toLowerCase() === handConfirm.trim().toLowerCase();

  return (
    <div className="card-themed p-3 space-y-2" data-testid="devfee-admin-node">
      <div>
        <div className="font-medium text-sm">
          {node.label === 'top' ? 'Top of the tree' : 'Branch'}
        </div>
        <div className="text-xs text-gray-500 font-mono truncate">{node.address}</div>
        <div className="text-xs text-gray-500 mt-1">
          {node.parent
            ? `Its slot sits in ${node.parent.slice(0, 6)}…${node.parent.slice(-4)}`
            : 'Nothing sits above it, so it has no slot to redirect.'}
        </div>
      </div>

      {/* Redirect. Only meaningful for a node that has a parent. */}
      <SplitterRotation
        node={node}
        busy={busy}
        run={run}
        readProposal={readProposal}
        approve={approve}
        revoke={revoke}
        execute={execute}
        asAuthority
      />

      {/* Hand the role over. */}
      {!handOpen ? (
        <button
          onClick={() => setHandOpen(true)}
          className="w-full text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
          data-testid="devfee-admin-hand-open"
        >
          Hand this role to another address
        </button>
      ) : (
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-2" data-testid="devfee-admin-hand">
          <div className="text-xs text-gray-600 dark:text-gray-400">
            The new address gets the power to redirect this splitter on its own. Yours
            loses it immediately. Give it to someone you would give the income to.
          </div>
          <input
            value={handTo}
            onChange={(e) => setHandTo(e.target.value)}
            placeholder="New authority (0x…)"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs font-mono"
            data-testid="devfee-admin-hand-to"
          />
          <input
            value={handConfirm}
            onChange={(e) => setHandConfirm(e.target.value)}
            placeholder="Type it again to confirm"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs font-mono"
            data-testid="devfee-admin-hand-confirm"
          />
          {handTo.trim() !== '' && !handValid && (
            <div className="text-xs text-red-600 dark:text-red-400">Not a valid address.</div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => run(`hand-${node.address}`, async () => {
                await transferAuthority(node, handTo.trim());
                setHandOpen(false); setHandTo(''); setHandConfirm('');
              })}
              disabled={busy !== null || !handMatches}
              className="flex-1 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-xs font-medium rounded transition-colors"
              data-testid="devfee-admin-hand-submit"
            >
              {busy === `hand-${node.address}` ? 'Handing over…' : 'Hand over the role'}
            </button>
            <button
              onClick={() => { setHandOpen(false); setHandTo(''); setHandConfirm(''); }}
              disabled={busy !== null}
              className="px-3 py-1.5 text-xs underline text-gray-500"
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {/* Give it up permanently. The most final action on this page. */}
      {!giveUpOpen ? (
        <button
          onClick={() => setGiveUpOpen(true)}
          className="w-full text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
          data-testid="devfee-admin-renounce-open"
        >
          Give up this role permanently
        </button>
      ) : (
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700 space-y-2" data-testid="devfee-admin-renounce">
          <div className="text-xs text-gray-600 dark:text-gray-400">
            <strong>There is no way back from this.</strong> Nobody can ever hold the
            authority on this splitter again, including you. After it, the only way this
            splitter&apos;s slot can move is {Number(node.rotationThresholdBps) / 100}% of its
            shares agreeing on where.
          </div>
          <div className="text-xs text-gray-500">
            That is often the point: it is how you prove to the other payees that their
            income cannot be redirected out from under them.
          </div>
          {/* A word, not an address, because there is no address to check against.
              The value here is a deliberate pause, not verification. */}
          <input
            value={giveUpWord}
            onChange={(e) => setGiveUpWord(e.target.value)}
            placeholder="Type GIVE UP to confirm"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs"
            data-testid="devfee-admin-renounce-word"
          />
          <div className="flex gap-2">
            <button
              onClick={() => run(`renounce-${node.address}`, async () => {
                await renounceAuthority(node);
                setGiveUpOpen(false); setGiveUpWord('');
              })}
              disabled={busy !== null || giveUpWord.trim().toUpperCase() !== 'GIVE UP'}
              className="flex-1 py-1.5 bg-red-700 hover:bg-red-800 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-xs font-medium rounded transition-colors"
              data-testid="devfee-admin-renounce-submit"
            >
              {busy === `renounce-${node.address}` ? 'Giving up…' : 'Give up the role forever'}
            </button>
            <button
              onClick={() => { setGiveUpOpen(false); setGiveUpWord(''); }}
              disabled={busy !== null}
              className="px-3 py-1.5 text-xs underline text-gray-500"
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
