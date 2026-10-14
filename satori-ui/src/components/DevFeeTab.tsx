import React, { useState } from 'react';
import { ethers } from 'ethers';
import { useDevFee, DevFeeSlot, DevFeeUpstream } from '../hooks/useDevFee';
import { InfoTip } from './InfoTip';
import { explainError } from '../utils/errors';
import { SplitterRotation } from './SplitterRotation';

/// Claims for dev-fee recipients. The tab only appears for an address that holds
/// a slot in the splitter tree — see App.tsx, which gates it on `isPayee`.
///
/// That gate is presentational, not a security boundary, and should not be
/// mistaken for one: the splitter is public and anyone can call `withdraw` on it
/// directly. Hiding the tab keeps a page that means nothing to most visitors out
/// of their way. It protects nobody's money, and it does not need to — a withdraw
/// pays the slot's payee whoever triggers it.
export function DevFeeTab() {
  const {
    loading, root, mine, upstream, nodes, error, refresh, claim, pull, rotate, setGate,
    readProposal, approveRotation, revokeRotation, rotateAt,
  } = useDevFee();
  const [busy, setBusy] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);

  const fmt = (v: bigint) => Number(ethers.formatEther(v)).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 6,
  });
  const pct = (bps: bigint) => `${Number(bps) / 100}%`;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setTxError(null);
    try { await fn(); } catch (e: any) { setTxError(explainError(e)); } finally { setBusy(null); }
  };

  if (loading) {
    return <div className="card-themed p-6 text-center text-gray-500 text-sm">Loading dev fee…</div>;
  }

  return (
    <div className="space-y-4" data-testid="devfee-tab">
      <div>
        <h3 className="text-lg font-semibold flex items-center gap-1.5">
          Dev fee
          <InfoTip>
            A share of every round is paid to the splitter contract named in the
            token itself. Your share of it is fixed permanently. It was set when
            the splitter was built and there is no function to change it.
          </InfoTip>
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Nothing arrives on its own. It waits in the splitter until someone claims it.
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

      {/* Money sitting one tier up. Explained rather than hidden, because a
          branch reading "0 claimable" while the top holds funds is the single
          most confusing state a two-tier tree can be in. */}
      {upstream.map((u: DevFeeUpstream) => (
        <div key={`${u.node}-${u.slotId}`} className="card-themed p-3" data-testid="devfee-upstream">
          <div className="font-medium text-sm">Waiting one level up</div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            <strong>{fmt(u.pending)} SATORI</strong> has reached the top of the tree but
            not yet your branch. Move it down first, then your share becomes claimable.
            Anyone may do this and it can only move funds toward the recipients.
          </p>
          {u.gated && (
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
              This step has been restricted to a specific address by the branch, so it may refuse.
            </p>
          )}
          <button
            onClick={() => run(`pull-${u.node}-${u.slotId}`, () => pull(u))}
            disabled={busy !== null}
            className="mt-2 w-full py-2 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400 !text-white text-sm font-medium rounded transition-colors"
            data-testid="devfee-pull-button"
          >
            {busy === `pull-${u.node}-${u.slotId}` ? 'Working…' : `Move ${fmt(u.pending)} down to my branch`}
          </button>
        </div>
      ))}

      {mine.map((s: DevFeeSlot) => (
        <div key={`${s.node}-${s.slotId}`} className="card-themed p-3" data-testid="devfee-slot">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium text-sm">Your share</div>
              <div className="text-xs text-gray-500 font-mono truncate">{s.node}</div>
              <div className="text-xs text-gray-500 mt-1">
                {pct(s.shares)} of this splitter · {pct(s.effectiveBps)} of the whole dev fee
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-lg font-semibold">{fmt(s.claimable)}</div>
              <div className="text-xs text-gray-500">SATORI claimable</div>
            </div>
          </div>

          <button
            onClick={() => run(`claim-${s.node}-${s.slotId}`, () => claim(s))}
            disabled={busy !== null || s.claimable === BigInt(0)}
            className="mt-3 w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
            data-testid="devfee-claim-button"
          >
            {busy === `claim-${s.node}-${s.slotId}`
              ? 'Claiming…'
              : s.claimable === BigInt(0) ? 'Nothing to claim yet' : `Claim ${fmt(s.claimable)} SATORI`}
          </button>

          <WithdrawGate slot={s} busy={busy} run={run} setGate={setGate} />
          <RotateSlot slot={s} busy={busy} run={run} rotate={rotate} />
        </div>
      ))}

      {/* Redirecting the SPLITTER itself, which is a different thing from moving
          your own slot: it sends every payee's future income elsewhere. Shown to
          payees because their agreement is what authorises it when the authority
          is not acting (or has been given up). */}
      {nodes.filter((n) => n.parent && n.mySlotId !== null).map((n) => (
        <div key={`rot-${n.address}`} className="card-themed p-3" data-testid="devfee-splitter-rotation">
          <div className="font-medium text-sm">Redirecting this splitter</div>
          <div className="text-xs text-gray-500 font-mono truncate">{n.address}</div>
          <SplitterRotation
            node={n}
            busy={busy}
            run={run}
            readProposal={readProposal}
            approve={approveRotation}
            revoke={revokeRotation}
            execute={rotateAt}
            asAuthority={false}
          />
        </div>
      ))}

      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span className="font-mono truncate" title={root ?? ''}>tree: {root}</span>
        <button onClick={() => run('refresh', refresh)} disabled={busy !== null} className="underline shrink-0 ml-2">
          {busy === 'refresh' ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
        <p>
          <strong>Your percentage can never change.</strong> Shares are sealed when the
          splitter is built and there is no setter for them.
        </p>
        <p>
          <strong>Your address can.</strong> You can move your slot to a new one from
          your current address. Lose that key and the slot cannot be moved by anyone.
        </p>
      </div>
    </div>
  );
}

/// Hand this slot to a different address.
///
/// Kept collapsed behind a link, and gated behind typing the address a second
/// time, because it is the one control here that cannot be undone. Claiming a
/// zero balance wastes gas; rotating to the wrong address hands away every
/// future payment permanently, and only the new holder could give it back.
///
/// The confirm field asks for the address again rather than for the word
/// "ROTATE": a second reading of the thing that must be right catches a
/// truncated paste or a swapped character, which a ritual word does not.
function RotateSlot({ slot, busy, run, rotate }: {
  slot: DevFeeSlot;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  rotate: (s: DevFeeSlot, newPayee: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [confirm, setConfirm] = useState('');
  const key = `rotate-${slot.node}-${slot.slotId}`;

  const valid = ethers.isAddress(to.trim());
  const matches = valid && to.trim().toLowerCase() === confirm.trim().toLowerCase();

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="mt-2 w-full text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
        data-testid="devfee-rotate-open"
      >
        Move this slot to another address
      </button>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2" data-testid="devfee-rotate">
      <div className="text-xs text-gray-600 dark:text-gray-400">
        <strong>This cannot be undone.</strong> The new address takes over this slot and
        every payment it receives from now on. Your current address stops being a
        recipient immediately, and only the new one can move the slot again.
      </div>

      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="New address (0x…)"
        spellCheck={false}
        autoComplete="off"
        className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs font-mono"
        data-testid="devfee-rotate-to"
      />
      <input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="Type it again to confirm"
        spellCheck={false}
        autoComplete="off"
        className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs font-mono"
        data-testid="devfee-rotate-confirm"
      />

      {to.trim() !== '' && !valid && (
        <div className="text-xs text-red-600 dark:text-red-400">Not a valid address.</div>
      )}
      {valid && confirm.trim() !== '' && !matches && (
        <div className="text-xs text-red-600 dark:text-red-400">The two addresses do not match.</div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => run(key, async () => {
            await rotate(slot, to.trim());
            setOpen(false); setTo(''); setConfirm('');
          })}
          disabled={busy !== null || !matches}
          className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-xs font-medium rounded transition-colors"
          data-testid="devfee-rotate-submit"
        >
          {busy === key ? 'Moving…' : 'Move slot'}
        </button>
        <button
          onClick={() => { setOpen(false); setTo(''); setConfirm(''); }}
          disabled={busy !== null}
          className="px-3 py-1.5 text-xs underline text-gray-500"
        >
          cancel
        </button>
      </div>
    </div>
  );
}

/// Restrict who may TRIGGER this slot's payout.
///
/// Presented far more softly than rotation, because it is a far softer thing:
/// it never moves money or ownership, you can change it as often as you like,
/// and you can always still withdraw for yourself, so a gate cannot lock you
/// out of your own slot. The worst case is a payout nobody else can trigger,
/// which you undo in one call.
///
/// The default (nobody set) is that ANYONE may trigger a payout, and that is
/// safe rather than sloppy: a withdraw pays the slot's payee whoever calls it,
/// so a stranger triggering yours simply sends you your own money.
function WithdrawGate({ slot, busy, run, setGate }: {
  slot: DevFeeSlot;
  busy: string | null;
  run: (key: string, fn: () => Promise<void>) => Promise<void>;
  setGate: (s: DevFeeSlot, caller: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const key = `gate-${slot.node}-${slot.slotId}`;
  const gated = slot.withdrawCaller !== ethers.ZeroAddress;

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setTo(gated ? slot.withdrawCaller : ''); }}
        className="mt-2 w-full text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 underline"
        data-testid="devfee-gate-open"
      >
        {gated
          ? `Payout trigger restricted to ${slot.withdrawCaller.slice(0, 6)}…${slot.withdrawCaller.slice(-4)}`
          : 'Restrict who can trigger this payout'}
      </button>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-2" data-testid="devfee-gate">
      <div className="text-xs text-gray-600 dark:text-gray-400">
        By default anyone can trigger your payout, which is harmless: the money always
        goes to you whoever presses the button. Naming an address here means only that
        address (or you) can trigger it. You can change or clear this at any time.
      </div>

      <input
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="Address allowed to trigger (leave empty for anyone)"
        spellCheck={false}
        autoComplete="off"
        className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-xs font-mono"
        data-testid="devfee-gate-to"
      />
      {to.trim() !== '' && !ethers.isAddress(to.trim()) && (
        <div className="text-xs text-red-600 dark:text-red-400">Not a valid address.</div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => run(key, async () => {
            await setGate(slot, to);
            setOpen(false);
          })}
          disabled={busy !== null || (to.trim() !== '' && !ethers.isAddress(to.trim()))}
          className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-xs font-medium rounded transition-colors"
          data-testid="devfee-gate-submit"
        >
          {busy === key ? 'Saving…' : to.trim() === '' ? 'Allow anyone' : 'Restrict to this address'}
        </button>
        <button
          onClick={() => { setOpen(false); setTo(''); }}
          disabled={busy !== null}
          className="px-3 py-1.5 text-xs underline text-gray-500"
        >
          cancel
        </button>
      </div>

      <div className="text-xs text-gray-500">
        This does not survive a move. If you move the slot to a new address, the
        restriction is cleared so it cannot outlive the address that set it.
      </div>
    </div>
  );
}
