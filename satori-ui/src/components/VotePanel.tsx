import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { trimZeros } from '../utils/format';
import { useVoting } from '../hooks/useVoting';
import { useGames } from '../hooks/useGames';
import { useWallet } from '../hooks/useWallet';

/// Inline vote composer: pick an amount, approve if needed, burn.
///
/// A vote DESTROYS SATORI. There is no escrow and no refund — so this asks for
/// the amount explicitly rather than spending a default, and says plainly what
/// happens before the button is pressed. The old UI had a bare "Vote" button
/// because a vote used to assign your standing power; under burn voting that
/// button would be a one-click way to destroy tokens.
///
/// THE ONE ESCAPE HATCH: weight sitting on a game that is NOT approved (games
/// are born unapproved; an admin can also disapprove one later) can be
/// re-pointed to a live game with `moveVotes`. It burns nothing — the SATORI
/// was destroyed at vote time; only the weight it bought moves. When this panel
/// is opened on an unapproved game and the connected wallet has weight stranded
/// there, it offers that move (see the section at the bottom).
///
/// ONE PRESS when the wallet can sign. The hub takes the tokens with `burnFrom`,
/// so an allowance has to exist — but `voteWithPermit` carries a signed
/// authorization inside the vote transaction, so there is nothing to approve
/// first. Signing is free, so this removes a confirmation AND a gas payment.
///
/// When signing is NOT available (`canSign` false — a wallet that will not sign
/// typed data, or a token whose EIP-712 domain could not be confirmed) the
/// approve button comes back. The two are then still SEPARATE presses, never
/// chained, for the reason `approveForStream` documents: on mobile a signature
/// request deep-links to the wallet, which unloads the page, and any JavaScript
/// queued to fire the second transaction simply ceases to exist. The user signs,
/// returns to a reloaded page, and nothing happened with no error anywhere.
export interface VotePanelProps {
  streamName: string;
  /// Spendable SATORI, ether units. The burn comes out of this.
  balance: string;
  /// Current allowance to the hub, ether units. One allowance covers both the
  /// stream-creation fee and vote burns — same spender.
  allowance: string;
  busy: boolean;
  error: string | null;
  /// Can the wallet authorize SATORI by signature? When true the approve step is
  /// not shown at all, because the vote carries its own authorization.
  canSign?: boolean;
  onApprove: (amount: string) => void;
  onVote: (amount: string) => void;
  onCancel: () => void;
  testIdSuffix: string | number;
  /// Is this panel's game approved (live)? Defaults true. When FALSE the panel
  /// says so, and — if the connected wallet has weight stranded on the game —
  /// offers the moveVotes escape hatch below the composer.
  approved?: boolean;
  /// The stream whose 1:1 game this panel votes on. Needed to resolve the
  /// source gameId for the moveVotes flow; without it the move section cannot
  /// render.
  sourceStreamId?: number;
  /// Where stranded weight may go: any APPROVED game, named by its stream.
  /// The destination's gameId is resolved at press time.
  moveTargets?: { streamId: number; name: string }[];
  /// A move landed. The parent usually closes the panel and lets its next
  /// reload pick up the shifted weights.
  onMoved?: () => void;
}

const toNum = (s: string): number => {
  const n = parseFloat((s ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

export function VotePanel({
  streamName, balance, allowance, busy, error, canSign = false, onApprove, onVote, onCancel, testIdSuffix,
  approved = true, sourceStreamId, moveTargets, onMoved,
}: VotePanelProps) {
  const [amount, setAmount] = useState('');

  // The moveVotes flow runs on this panel's OWN useVoting instance — the
  // composer's vote/approve handlers come in as props from the app-level
  // instance, but a move is self-contained: source game, destination game,
  // amount, one transaction.
  const voting = useVoting();
  const { resolveGameId } = useGames();
  const { address } = useWallet();
  /// The connected wallet's own burned weight on this (unapproved) game, in
  /// wei — the most it could move. Null until read.
  const [stranded, setStranded] = useState<bigint | null>(null);
  const [sourceGameId, setSourceGameId] = useState<number | null>(null);
  const [moveDest, setMoveDest] = useState('');
  const [moveAmount, setMoveAmount] = useState('');
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);

  useEffect(() => {
    // Only an unapproved game strands weight — the contract rejects moveVotes
    // off a live game (SourceStillApproved) — so don't even read otherwise.
    if (approved || !sourceStreamId || !address) return;
    let live = true;
    (async () => {
      const gid = await resolveGameId(sourceStreamId);
      if (!live || !gid) return;
      setSourceGameId(Number(gid));
      const w = await voting.voterGameWeight(address, Number(gid));
      if (!live) return;
      setStranded(w);
      if (w > BigInt(0)) setMoveAmount(ethers.formatEther(w));
    })();
    return () => { live = false; };
    // voterGameWeight/resolveGameId are stable useCallbacks; keying on the ids
    // avoids a re-read per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approved, sourceStreamId, address]);

  const handleMove = async () => {
    if (!sourceGameId || !moveDest) return;
    setMoveBusy(true);
    setMoveError(null);
    try {
      const destGameId = Number(await resolveGameId(Number(moveDest)));
      if (!destGameId) throw new Error('That stream has no game to receive the weight yet.');
      let wei: bigint;
      try {
        wei = ethers.parseEther((moveAmount ?? '').trim());
      } catch {
        throw new Error(`"${moveAmount}" is not a valid SATORI amount`);
      }
      const ok = await voting.moveVotes(sourceGameId, destGameId, wei);
      if (!ok) {
        // moveVotes already ran the revert through explainError (a still-
        // approved source, more than you burned, ...) — surface its words.
        setMoveError(voting.voteError ?? 'The move did not go through.');
        return;
      }
      setMoved(true);
      const w = await voting.voterGameWeight(address ?? '', sourceGameId);
      setStranded(w);
      onMoved?.();
    } catch (e: any) {
      setMoveError(e?.message ?? String(e));
    } finally {
      setMoveBusy(false);
    }
  };

  const amt = toNum(amount);
  const bal = toNum(balance);
  const allow = toNum(allowance);
  const entered = amount.trim() !== '';
  const overBalance = entered && amt > bal;
  const valid = entered && amt > 0 && !overBalance;
  // Compare in ether units at display precision. The hook re-parses and revalidates
  // in wei before sending, so this only decides which button to show.
  const needsApproval = valid && allow < amt && !canSign;

  const strandedStr = stranded != null ? trimZeros(ethers.formatEther(stranded)) : null;

  return (
    <div
      className="mt-2 p-3 rounded border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800/60 space-y-2"
      onClick={(e) => e.stopPropagation()}
      data-testid={`vote-panel-${testIdSuffix}`}
    >
      <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
        Vote for <span className="font-semibold">{streamName}</span>
      </p>

      {!approved && (
        <p className="text-[11px] text-amber-600 dark:text-amber-400" data-testid={`vote-not-approved-${testIdSuffix}`}>
          This game isn’t approved yet, so you can’t vote for it — an admin has to approve it first.
          (If an approved game later loses approval, weight already on it isn’t lost: it can be moved
          to an approved game.)
        </p>
      )}

      <div className="flex items-center gap-2">
        <input
          type="number"
          min="0"
          step="any"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="SATORI to burn"
          disabled={busy}
          className="flex-1 min-w-0 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm"
          data-testid={`input-vote-amount-${testIdSuffix}`}
        />
        <button
          onClick={() => setAmount(balance)}
          disabled={busy || bal <= 0}
          className="flex-shrink-0 px-2 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
          data-testid={`btn-vote-max-${testIdSuffix}`}
        >
          Max
        </button>
      </div>

      <p className="text-[11px] text-gray-500 dark:text-gray-400">
        Balance {balance} SATORI.{' '}
        <strong className="text-amber-600 dark:text-amber-400">
          Burning is permanent — the tokens are destroyed and never come back. The weight the burn
          bought stays put too, except off a game that loses approval, where it can be moved.
        </strong>
      </p>

      {overBalance && (
        <p className="text-[11px] text-red-600 dark:text-red-400" data-testid={`vote-over-balance-${testIdSuffix}`}>
          More than your balance.
        </p>
      )}
      {error && (
        <p className="text-[11px] text-red-600 dark:text-red-400" data-testid={`vote-error-${testIdSuffix}`}>
          {error}
        </p>
      )}

      <div className="flex items-center gap-2">
        {needsApproval ? (
          <button
            onClick={() => onApprove(amount)}
            disabled={busy || !valid || !approved}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed disabled:opacity-60 !text-white text-sm font-medium rounded transition-colors"
            data-testid={`btn-approve-vote-${testIdSuffix}`}
          >
            {busy ? '…' : `Approve ${amount} SATORI`}
          </button>
        ) : (
          <button
            onClick={() => onVote(amount)}
            disabled={busy || !valid || !approved}
            className="flex-1 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed disabled:opacity-60 !text-white text-sm font-medium rounded transition-colors"
            data-testid={`btn-confirm-vote-${testIdSuffix}`}
          >
            {busy ? '…' : 'Burn and vote'}
          </button>
        )}
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-3 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 disabled:opacity-50"
          data-testid={`btn-cancel-vote-${testIdSuffix}`}
        >
          Cancel
        </button>
      </div>

      {needsApproval && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          Two steps: approve, then vote. They are separate presses on purpose: a wallet
          signature can reload this page, and a queued second transaction would be lost.
        </p>
      )}

      {/* THE ESCAPE HATCH. Only on an unapproved game, and only when the
          connected wallet actually has weight stranded there. Moving burns
          nothing — the SATORI was destroyed at vote time; this re-points the
          weight it bought onto a game that can earn. */}
      {!approved && stranded != null && stranded > BigInt(0) && (
        <div
          className="pt-2 mt-1 border-t border-gray-300 dark:border-gray-600 space-y-2"
          data-testid={`move-votes-${testIdSuffix}`}
        >
          <p className="text-xs text-gray-700 dark:text-gray-300">
            You have <strong>{strandedStr} SATORI</strong> of weight on this game. While it is
            not approved, you can move that weight to another game.
          </p>
          <div className="flex items-center gap-2">
            <select
              value={moveDest}
              onChange={(e) => { setMoveDest(e.target.value); setMoveError(null); }}
              disabled={moveBusy}
              className="flex-1 min-w-0 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm"
              data-testid={`select-move-dest-${testIdSuffix}`}
            >
              <option value="">Move to…</option>
              {(moveTargets ?? [])
                .filter((t) => t.streamId !== sourceStreamId)
                .map((t) => (
                  <option key={t.streamId} value={String(t.streamId)}>{t.name}</option>
                ))}
            </select>
            <input
              type="number"
              min="0"
              step="any"
              value={moveAmount}
              onChange={(e) => setMoveAmount(e.target.value)}
              disabled={moveBusy}
              className="w-24 flex-shrink-0 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm"
              data-testid={`input-move-amount-${testIdSuffix}`}
            />
          </div>
          <button
            onClick={handleMove}
            disabled={moveBusy || !moveDest || toNum(moveAmount) <= 0}
            className="w-full py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-400 disabled:cursor-not-allowed disabled:opacity-60 !text-white text-sm font-medium rounded transition-colors"
            data-testid={`btn-move-votes-${testIdSuffix}`}
          >
            {moveBusy ? '…' : 'Move votes'}
          </button>
          {moveError && (
            <p className="text-[11px] text-red-600 dark:text-red-400" data-testid={`move-error-${testIdSuffix}`}>
              {moveError}
            </p>
          )}
          {moved && !moveError && (
            <p className="text-[11px] text-green-600 dark:text-green-400" data-testid={`move-success-${testIdSuffix}`}>
              Weight moved. It counts for the destination game from now on.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
