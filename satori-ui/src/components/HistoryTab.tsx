import React, { useMemo, useState, useEffect, useRef } from 'react';
import { useHistory, HistoryKind, HistoryRow } from '../hooks/useHistory';
import { useStreamList } from '../hooks/useStreamList';
import { useGames } from '../hooks/useGames';
import { InfoTip } from './InfoTip';
import { useDeploymentRound, formatElapsedRound } from '../hooks/useDeploymentRound';
import { currentRound } from '../lib/round';

// Hours until the current round closes (next UTC midnight). A prediction made in
// the current round cannot be settled until the round closes, so — like the
// dashboard — History shows this wait instead of a Settle button that would just
// revert. (Rounds close at midnight UTC; round = timestamp / 86400.)
function hoursUntilRoundClose(): number {
  const now = Date.now();
  const msLeft = Math.ceil(now / 86_400_000) * 86_400_000 - now;
  return Math.max(1, Math.round(msLeft / 3_600_000));
}

/// How many rows to show at once, and how many more each time the list is
/// extended. The whole event set is already local (see
/// docs/design/dapp-history-tab.md §4) — paging is a slice over it, not a fetch,
/// so this is purely about not rendering thousands of nodes at once.
const PAGE = 25;

const FILTERS: { key: HistoryKind | 'all'; label: string }[] = [
  { key: 'prediction', label: 'predictions' },
  { key: 'reward', label: 'rewards' },
  { key: 'delegation', label: 'delegation' },
  { key: 'vote', label: 'voting' },
  { key: 'bounty', label: 'bounties' },
  // Referrals and airdrops were showing up under "all" with no chip that could
  // select them — visible but unfilterable, which reads as an oversight because
  // it was one. Every kind in HistoryKind gets a chip.
  { key: 'referral', label: 'referrals' },
  { key: 'airdrop', label: 'airdrops' },
  { key: 'all', label: 'all' },
];

/// Outcome badge. `pending` is deliberately neutral rather than a warning colour:
/// it is the normal state of a prediction whose stream has not produced its next
/// value yet, and on a slow-cadence stream it can stay that way for a long time.
function OutcomeBadge({ outcome }: { outcome?: string }) {
  const map: Record<string, { text: string; cls: string; tip?: string }> = {
    won: { text: 'won', cls: 'bg-emerald-600/20 text-emerald-400 border-emerald-600/40' },
    lost: { text: 'lost', cls: 'bg-red-600/20 text-red-400 border-red-600/40' },
    pending: {
      text: 'not scored yet', cls: 'bg-gray-600/20 text-gray-400 border-gray-600/40',
      tip: 'Waiting on this stream to produce its next value. Normal: a slow-cadence stream can take a while.',
    },
    void: {
      text: 'void', cls: 'bg-gray-600/20 text-gray-400 border-gray-600/40',
      tip: 'The value did not move between the two readings, so there was no up or down to be right about. Your streak is untouched.',
    },
    unrecoverable: {
      text: 'unscoreable', cls: 'bg-amber-600/20 text-amber-400 border-amber-600/40',
      tip: 'The reference value aged out of the stream history before anyone settled this, so it can never be scored. It zeroes the streak.',
    },
    displaced: {
      text: 'displaced', cls: 'bg-amber-600/20 text-amber-400 border-amber-600/40',
      tip: 'A later prediction on this game pushed this one out of the two slots kept per game.',
    },
  };
  const m = map[outcome ?? 'pending'] ?? map.pending;
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap ${m.cls}`}>
      {m.text}
      {m.tip && <InfoTip>{m.tip}</InfoTip>}
    </span>
  );
}

const ICON: Record<HistoryKind, string> = {
  prediction: '◈', reward: '✦', delegation: '⇄',
  vote: '▲', bounty: '❖', referral: '↗', airdrop: '⬦',
};

interface HistoryTabProps {
  /// Settle a pending prediction. Resolves to null on success, or to a
  /// human-readable reason on failure. Optional: the tab renders fine without
  /// it (read-only history), it just offers no Settle action.
  ///
  /// The button lived on the dashboard until 2026-08-22. It was moved here
  /// because settling is a chore you do while reviewing what is outstanding,
  /// not something to put in front of someone checking their balance.
  onSettle?: (gameId: number) => Promise<string | null>;
}

export function HistoryTab({ onSettle }: HistoryTabProps = {}) {
  const { rows, loading, error, viaIndexer, complete, loadOlder, reload } = useHistory();
  const deploymentRound = useDeploymentRound();
  const { streams } = useStreamList();
  const [filter, setFilter] = useState<HistoryKind | 'all'>('prediction');
  const [shown, setShown] = useState(PAGE);
  /// Which gameId is mid-settle, and why the last attempt failed. Per-game
  /// rather than global so the message sits under the row it belongs to.
  const [settlingGame, setSettlingGame] = useState<number | null>(null);
  const [settleError, setSettleError] = useState<{ gameId: number; message: string } | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);

  // gameId -> stream name, so a row reads "BTC/USD" rather than "game #5".
  //
  // StreamBasic is stream-keyed and carries no gameId, so resolve the stream ->
  // game direction the app already uses and invert it. Falls back to "game #N"
  // for anything unresolved, which is correct for a game whose stream is not in
  // the current list rather than a reason to show nothing.
  const { resolveGameIds } = useGames();
  const [nameByGame, setNameByGame] = useState<Map<number, string>>(new Map());
  useEffect(() => {
    let live = true;
    const list = streams ?? [];
    if (list.length === 0) return;
    resolveGameIds(list.map((s) => s.id)).then((map) => {
      if (!live) return;
      const out = new Map<number, string>();
      for (const s of list) {
        const g = map.get(s.id);
        if (g) out.set(Number(g), s.name);
      }
      setNameByGame(out);
    }).catch(() => {});
    return () => { live = false; };
  }, [streams, resolveGameIds]);

  const filtered = useMemo(
    () => (filter === 'all' ? rows : rows.filter((r) => r.kind === filter)),
    [rows, filter],
  );
  useEffect(() => { setShown(PAGE); }, [filter]);

  // Extend on scroll. IntersectionObserver rather than a scroll handler so it
  // costs nothing until the sentinel is actually near the viewport.
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setShown((n) => (n < filtered.length ? n + PAGE : n));
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [filtered.length]);

  const visible = filtered.slice(0, shown);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const r of rows) c[r.kind] = (c[r.kind] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div className="space-y-3" data-testid="history-tab">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold flex items-center gap-1.5">
          History
          <InfoTip>
            Everything this account has done, newest first. Read from chain events and
            cached on this device, so the first load is the slow one.
          </InfoTip>
        </h2>
        <button
          onClick={reload}
          disabled={loading}
          className="text-xs px-2 py-1 rounded border border-gray-600 text-gray-400 hover:text-gray-200 disabled:opacity-50"
        >
          {loading ? 'loading…' : 'refresh'}
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5" data-testid="history-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-2.5 py-1 rounded text-xs transition-colors ${
              filter === f.key
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {f.label}
            {counts[f.key] ? <span className="opacity-60"> {counts[f.key]}</span> : null}
          </button>
        ))}
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      {!loading && filtered.length === 0 && (
        <div className="card-themed p-4 text-sm text-gray-400 text-center">
          {rows.length === 0
            ? 'Nothing here yet. Predictions, votes, claims and delegations all show up on this tab.'
            : 'No activity of this kind.'}
        </div>
      )}

      <div className="space-y-1.5" data-testid="history-list">
        {visible.map((r: HistoryRow, i) => (
          <div
            key={`${r.tx ?? r.block}-${r.block}-${r.index}-${i}`}
            className="card-themed !p-0 overflow-hidden"
            data-testid={`history-row-${r.kind}`}
          >
            <div className="px-3 py-2 flex items-start gap-3">
              <div className="text-gray-500 text-sm pt-0.5 w-4 text-center shrink-0">{ICON[r.kind]}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm flex items-center gap-2 flex-wrap">
                  <span className="font-medium">
                    {r.gameId != null
                      ? `${r.title}${r.kind === 'prediction' ? ' on' : ''} ${
                          nameByGame.get(r.gameId) ?? `game #${r.gameId}`}`
                      : r.title}
                  </span>
                  {r.kind === 'prediction' && <OutcomeBadge outcome={r.outcome} />}
                  {onSettle && r.kind === 'prediction' && r.gameId != null
                    && (r.outcome == null || r.outcome === 'pending') && (
                    (r.round != null && r.round >= currentRound()) ? (
                      // Round still open: genuinely not settleable yet (settling
                      // would revert). Show the wait, matching the dashboard.
                      <span className="text-xs text-gray-500" data-testid={`settle-wait-${r.gameId}`}>
                        settles in ~{hoursUntilRoundClose()}h
                      </span>
                    ) : (
                      <button
                        onClick={async () => {
                          const gameId = r.gameId as number;
                          setSettlingGame(gameId);
                          setSettleError(null);
                          try {
                            const why = await onSettle(gameId);
                            if (why) setSettleError({ gameId, message: why });
                            else reload();
                          } finally { setSettlingGame(null); }
                        }}
                        disabled={settlingGame !== null}
                        className="text-xs px-1.5 py-0.5 rounded bg-blue-700 hover:bg-blue-600 disabled:bg-gray-600 !text-white"
                        title="Score this prediction now (permissionless, anyone can call)"
                        data-testid={`btn-settle-${r.gameId}`}
                      >
                        {settlingGame === r.gameId ? 'Settling…' : 'Settle'}
                      </button>
                    )
                  )}
                </div>
                <div className="text-xs text-gray-500 flex gap-2 flex-wrap">
                  {r.round != null && <span>round {formatElapsedRound(r.round, deploymentRound)}</span>}
                  {r.kind === 'prediction' && r.power && <span>· {r.power} power</span>}
                  {r.kind === 'prediction' && r.streak != null && <span>· streak {r.streak}</span>}
                  {r.detail && <span>· {r.detail}</span>}
                </div>
                {settleError != null && settleError.gameId === r.gameId && (
                  <div className="text-xs text-red-400 mt-0.5" data-testid={`settle-error-${r.gameId}`}>
                    {settleError.message}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Extends the slice when scrolled near. */}
      <div ref={sentinel} className="h-4" />

      {shown < filtered.length ? (
        <button
          onClick={() => setShown((n) => n + PAGE)}
          className="w-full py-2 text-sm text-gray-400 hover:text-gray-200 border border-gray-700 rounded"
          data-testid="history-show-more"
        >
          Show more ({filtered.length - shown} older)
        </button>
      ) : !complete ? (
        // Everything fetched is on screen. Going further back means actually
        // reading more chain, so it takes a click — scrolling extends the slice,
        // it does not spend the user's bandwidth for them (design §4).
        <button
          onClick={loadOlder}
          disabled={loading}
          className="w-full py-2 text-sm text-gray-400 hover:text-gray-200 border border-gray-700 rounded disabled:opacity-50"
          data-testid="history-load-older"
        >
          {loading ? 'reading older blocks…' : 'Load older history'}
        </button>
      ) : rows.length > 0 ? (
        <div className="text-xs text-gray-600 text-center py-2" data-testid="history-complete">
          That's everything, back to launch.
        </div>
      ) : null}

      {loading && rows.length > 0 && (
        <div className="text-xs text-gray-500 text-center">
          {viaIndexer ? 'showing indexed predictions, loading full history…' : 'loading…'}
        </div>
      )}
    </div>
  );
}
