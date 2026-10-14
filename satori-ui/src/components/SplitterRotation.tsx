import React, { useState } from 'react';
import { ethers } from 'ethers';
import { SplitterNode, RotationProposal } from '../hooks/useDevFee';

/// Move a whole SPLITTER's slot in its parent to a different address.
///
/// Not to be confused with moving your own slot. That one changes which address
/// collects YOUR share. This one redirects everything the splitter receives from
/// its parent, which is every payee's income at once, and the contract calls it
/// the single most dangerous power it has.
///
/// Two doors, and the chain decides which applies:
///   - the AUTHORITY, alone and without consent; or
///   - ANYONE, once slots holding at least `rotationThresholdBps` of the
///     splitter's shares have approved this exact target.
///
/// Renouncing the authority closes the first door permanently and leaves only
/// the second.
///
/// Proposals are hash-keyed on chain and cannot be listed, so this asks for the
/// candidate address and then looks up where that specific proposal stands.
/// There is no feed of pending rotations to browse without scanning logs.
export function SplitterRotation({
  node, busy, run, readProposal, approve, revoke, execute, asAuthority,
}: {
  node: SplitterNode;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  readProposal: (n: SplitterNode, to: string) => Promise<RotationProposal | null>;
  approve: (n: SplitterNode, to: string) => Promise<void>;
  revoke: (n: SplitterNode, to: string) => Promise<void>;
  execute: (n: SplitterNode, to: string) => Promise<void>;
  /// Render for the authority (who may act alone) rather than for a payee
  /// (who may only add consent).
  asAuthority: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [confirm, setConfirm] = useState('');
  const [prop, setProp] = useState<RotationProposal | null>(null);
  const [checking, setChecking] = useState(false);

  const key = `rot-${node.address}`;
  const valid = ethers.isAddress(to.trim());
  const matches = valid && to.trim().toLowerCase() === confirm.trim().toLowerCase();

  // The top of the tree has no parent, so it has no slot anywhere to move.
  if (!node.parent) return null;

  const check = async () => {
    if (!valid) { setProp(null); return; }
    setChecking(true);
    try { setProp(await readProposal(node, to.trim())); }
    catch { setProp(null); }
    finally { setChecking(false); }
  };

  const pct = (n: bigint, d: bigint) => d === BigInt(0) ? 0 : Number((n * BigInt(1000)) / d) / 10;

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 w-full text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
        data-testid="splitter-rotate-open"
      >
        {asAuthority
          ? 'Redirect this splitter to a different address'
          : 'Vote to redirect this splitter to a different address'}
      </button>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2" data-testid="splitter-rotate">
      <div className="text-xs text-gray-600 dark:text-gray-400">
        <strong>This redirects everyone&apos;s income, not just yours.</strong> Every future
        payment from the parent goes to the new address instead of into this splitter.
        Money already sitting here is untouched and stays claimable by the current slots
        under the current shares.
      </div>

      <div className="text-xs text-gray-500">
        Needs {Number(node.rotationThresholdBps) / 100}% of this splitter&apos;s shares to agree
        {node.authority !== ethers.ZeroAddress
          ? ', or the authority acting alone.'
          : '. The authority was given up, so consent is the only way.'}
      </div>

      <input
        value={to}
        onChange={(e) => { setTo(e.target.value); setProp(null); }}
        onBlur={check}
        placeholder="New address (0x…)"
        spellCheck={false}
        autoComplete="off"
        className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs font-mono"
        data-testid="splitter-rotate-to"
      />
      {to.trim() !== '' && !valid && (
        <div className="text-xs text-red-600 dark:text-red-400">Not a valid address.</div>
      )}

      {checking && <div className="text-xs text-gray-500">Checking…</div>}

      {prop && (
        <div className="text-xs rounded border border-gray-200 dark:border-gray-700 p-2 space-y-1" data-testid="splitter-rotate-tally">
          <div className="flex justify-between">
            <span className="text-gray-500">Agreed so far</span>
            <span className={prop.cleared ? 'text-green-600 dark:text-green-400' : ''}>
              {pct(prop.approvedShares, prop.totalShares)}% of {Number(prop.thresholdBps) / 100}% needed
            </span>
          </div>
          <div className="text-gray-500">
            {prop.cleared
              ? 'Enough agreement. Anyone can carry this out now.'
              : 'Not enough agreement yet.'}
          </div>
          {node.mySlotId !== null && (
            <div className="text-gray-500">
              You have {prop.iApproved ? 'agreed to this' : 'not agreed to this'}.
            </div>
          )}
        </div>
      )}

      {/* A payee's vote. Cheap and reversible while pending, so no double-entry. */}
      {node.mySlotId !== null && valid && (
        <button
          onClick={() => run(`${key}-vote`, async () => {
            if (prop?.iApproved) await revoke(node, to.trim());
            else await approve(node, to.trim());
            await check();
          })}
          disabled={busy !== null}
          className="w-full py-1.5 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400 !text-white text-xs font-medium rounded transition-colors"
          data-testid="splitter-rotate-vote"
        >
          {busy === `${key}-vote`
            ? 'Working…'
            : prop?.iApproved ? 'Take back my agreement' : 'Agree to this move'}
        </button>
      )}

      {/* Carrying it out. Double-entry here and not on the vote, because this is
          the step that cannot be undone. */}
      {(asAuthority || prop?.cleared) && (
        <>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type the address again to carry it out"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs font-mono"
            data-testid="splitter-rotate-confirm"
          />
          {valid && confirm.trim() !== '' && !matches && (
            <div className="text-xs text-red-600 dark:text-red-400">The two addresses do not match.</div>
          )}
          <button
            onClick={() => run(`${key}-exec`, async () => {
              await execute(node, to.trim());
              setOpen(false); setTo(''); setConfirm(''); setProp(null);
            })}
            disabled={busy !== null || !matches}
            className="w-full py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-xs font-medium rounded transition-colors"
            data-testid="splitter-rotate-exec"
          >
            {busy === `${key}-exec`
              ? 'Redirecting…'
              : asAuthority ? 'Redirect it (authority)' : 'Carry out the move'}
          </button>
        </>
      )}

      <button
        onClick={() => { setOpen(false); setTo(''); setConfirm(''); setProp(null); }}
        disabled={busy !== null}
        className="w-full text-xs underline text-gray-500"
      >
        cancel
      </button>
    </div>
  );
}
