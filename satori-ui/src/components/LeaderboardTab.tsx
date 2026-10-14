import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { useGasless } from '../hooks/useGasless';
import { StreamBasic } from '../hooks/useStreamList';
import { useGames, gameDisplayName } from '../hooks/useGames';
import { ethAddressName } from '../utils/ethName';
import { loadEventsCached } from '../utils/eventCache';
import { indexerLeaderboard } from '../utils/indexerClient';
import { explainError, sendPreflighted } from '../utils/errors';
import { InfoTip } from './InfoTip';
import { getDeploymentBlock } from '../lib/chainValues';
import { afterTx } from '../lib/afterTx';

interface StreakRow {
  address: string;
  gameId: number;
  gameName: string;
  streak: number;
}

interface LeaderboardTabProps {
  streams: StreamBasic[];
}

const PAGE_SIZE = 25;

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function LeaderboardTab({ streams }: LeaderboardTabProps) {
  const { contracts } = useContracts();
  const { address: myAddress } = useWallet();
  const { sendOrRelay } = useGasless();
  const { getGameMetas } = useGames();
  const streamsRef = useRef(streams);
  streamsRef.current = streams;
  const [rows, setRows] = useState<StreakRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expandedAddr, setExpandedAddr] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [myDelegate, setMyDelegate] = useState<string>('0x0000000000000000000000000000000000000000');
  const [delegating, setDelegating] = useState<string | null>(null);
  const [delegateAction, setDelegateAction] = useState<{ to: string; status: 'success' | 'error'; message?: string } | null>(null);

  const loadMyDelegate = useCallback(async () => {
    if (!contracts || !myAddress) return;
    try {
      const info = await contracts.cached.live.rewards.predictionDelegateInfo(myAddress);
      setMyDelegate(info.delegate);
    } catch {}
  }, [contracts, myAddress]);

  useEffect(() => { loadMyDelegate(); }, [loadMyDelegate]);

  const handleDelegate = useCallback(async (predictor: string) => {
    if (!contracts) return;
    setDelegating(predictor);
    setDelegateAction(null);
    try {
      const tx = await sendOrRelay(
        { kind: 'delegatePrediction', delegate: predictor },
        () => sendPreflighted(contracts.reads.satori, contracts.satori, 'delegatePredictionPower', [predictor], myAddress),
      );
      await afterTx(tx);
      setDelegateAction({ to: predictor, status: 'success', message: 'Prediction power delegated' });
      await loadMyDelegate();
    } catch (e: any) {
      setDelegateAction({ to: predictor, status: 'error', message: explainError(e) });
    } finally {
      setDelegating(null);
    }
  }, [contracts, loadMyDelegate, myAddress, sendOrRelay]);

  const load = useCallback(async () => {
    if (!contracts) return;
    setLoading(true);
    try {
      // Indexer fast path: the server view IS this reduction (latest
      // PredictionScored per (user, game), streak > 0) — one HTTP call
      // instead of an event walk. Null (unconfigured/down/syncing) → scan.
      let positives = await indexerLeaderboard();
      if (!positives) {
        // PredictionScored carries `streak` directly in its payload, set to the
        // post-score value (0 if the prediction was wrong, the new run length
        // otherwise). The most recent event per (user, streamId) pair is the
        // current streak — no follow-up `streaks(addr, streamId)` reads needed.
        // Cached in IndexedDB; cold-load walks from deploymentBlock in chunks,
        // warm-load fetches only events since the last cache high-water mark.
        const fromBlock = Number(await getDeploymentBlock(contracts.reads));
        const events = await loadEventsCached({
          // PredictionScored is emitted by the engine (not the hub) — query the
          // engine contract directly. The facade routes .filters/.queryFilter/
          // .target to the hub, which never emits this event, so passing the
          // facade here would build an undefined filter and throw.
          contract: contracts.engine,
          eventName: 'PredictionScored',
          fromBlock,
        });

        // For each (user, gameId), keep the latest event by block / logIndex.
        // (PredictionScored's 2nd topic is honestly named gameId now — review #10.)
        const latest = new Map<string, { user: string; gameId: number; streak: number; block: number; logIdx: number }>();
        for (const ev of events) {
          const args = ev.args ?? {};
          const user = args.user as string;
          const gameId = Number(args.gameId);
          const streak = Number(args.streak);
          const block = ev.blockNumber;
          const logIdx = ev.index;
          if (!user || !Number.isFinite(gameId)) continue;
          const key = `${user.toLowerCase()}:${gameId}`;
          const prev = latest.get(key);
          if (!prev || block > prev.block || (block === prev.block && logIdx > prev.logIdx)) {
            latest.set(key, { user, gameId, streak, block, logIdx });
          }
        }
        positives = Array.from(latest.values()).filter((r) => r.streak > 0);
      }

      // Surface only rows with a current streak > 0. Resolve display names via
      // games.gameMeta (the games are the primary id-space here). The default
      // binary game has an empty on-chain name, so fall back to the bound
      // stream's name from the parent's loaded streams set (keyed by gameMeta's
      // dataStreamId), then to a "Game #" placeholder.
      const streamNameById = new Map<number, string>();
      for (const s of streamsRef.current) streamNameById.set(s.id, s.name);
      const gameIds = Array.from(new Set(positives.map((r) => r.gameId)));
      const metas = await getGameMetas(gameIds);
      const gameNames = new Map<number, string>();
      for (const gid of gameIds) {
        const meta = metas.get(gid);
        const streamName = meta ? streamNameById.get(meta.dataStreamId) : undefined;
        const name = gameDisplayName(meta?.name, streamName);
        gameNames.set(gid, name || `Game #${gid}`);
      }

      const out: StreakRow[] = positives.map((r) => ({
        address: r.user,
        gameId: r.gameId,
        gameName: gameNames.get(r.gameId) ?? `Game #${r.gameId}`,
        streak: r.streak,
      }));
      setRows(out);
    } catch (e) {
      console.error('Leaderboard load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [contracts, getGameMetas]);

  useEffect(() => { load(); }, [load]);

  // Filter rows by search (matches predictor address, derived name, or game name).
  const q = search.trim().toLowerCase();
  const filteredRows = q
    ? rows.filter((r) => {
      const addrMatch = r.address.toLowerCase().includes(q);
      const nameMatch = ethAddressName(r.address).toLowerCase().includes(q);
      const gameMatch = r.gameName.toLowerCase().includes(q);
      return addrMatch || nameMatch || gameMatch;
    })
    : rows;

  // Group by predictor with total streak summed across whatever rows passed
  // the filter. Tap-to-expand reveals the per-game breakdown for that
  // predictor — same filtered set.
  const byPredictor = new Map<string, { address: string; total: number; perGame: StreakRow[] }>();
  for (const r of filteredRows) {
    const g = byPredictor.get(r.address);
    if (g) {
      g.total += r.streak;
      g.perGame.push(r);
    } else {
      byPredictor.set(r.address, { address: r.address, total: r.streak, perGame: [r] });
    }
  }
  const ranked = Array.from(byPredictor.values()).sort((a, b) => b.total - a.total);

  // Reset page on search change so the user always sees the new top.
  useEffect(() => { setPage(0); }, [q]);

  const visible = ranked.slice(0, (page + 1) * PAGE_SIZE);
  const hasMore = ranked.length > visible.length;

  if (loading) {
    return <div className="card-themed p-6 text-center text-gray-400 text-sm">Loading leaderboard...</div>;
  }

  return (
    <div className="space-y-4" data-testid="leaderboard-tab">
      {/* Page intro */}
      <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center justify-between gap-1.5">
        <span>See who's on the hottest streak, and team up with them.</span>
        <InfoTip>The Leaderboard ranks predictors by their highest current streak. Tap on a predictor to see their per-game breakdown and delegate your prediction power to them, so they predict on your behalf.</InfoTip>
      </p>

      {/* Search bar */}
      <div className="relative">
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none"
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, address, or game"
          className="w-full bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded pl-8 pr-3 py-1.5 text-sm"
          data-testid="leaderboard-search"
        />
      </div>

      {/* Single ranked list of predictors */}
      <div className="space-y-1.5">
        {visible.map((p, i) => {
          const expanded = expandedAddr === p.address;
          const rank = i + 1;
          return (
            <div
              key={p.address}
              className="card-themed !p-0 overflow-hidden"
              data-testid={`leaderboard-row-${i}`}
            >
              <div
                className="px-3 py-2 flex items-center gap-3 cursor-pointer"
                onClick={() => setExpandedAddr(expanded ? null : p.address)}
              >
                <span className={`text-lg font-bold w-10 flex-shrink-0 text-center
                  ${rank === 1 ? 'text-yellow-400' : rank === 2 ? 'text-gray-300' : rank === 3 ? 'text-amber-600' : 'text-gray-500'}`}>
                  #{rank}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate capitalize">{ethAddressName(p.address) || shortAddress(p.address)}</span>
                    {myAddress && p.address.toLowerCase() === myAddress.toLowerCase() && (
                      <span className="text-xs text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded">you</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 font-mono truncate">{p.address.toLowerCase()}</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className={`text-lg font-bold ${p.total >= 10 ? 'text-red-400' : p.total >= 5 ? 'text-orange-400' : 'text-yellow-400'}`}>
                    {p.total}
                  </div>
                  <div className="text-xs text-gray-500">
                    {p.perGame.length} game{p.perGame.length !== 1 ? 's' : ''}
                  </div>
                </div>
              </div>

              {expanded && (
                <div className="px-3 pb-3 space-y-2">
                  <div className="space-y-1">
                    {p.perGame
                      .sort((a, b) => b.streak - a.streak)
                      .map((row) => (
                        <div
                          key={row.gameId}
                          className="flex items-center justify-between text-sm py-1 border-t border-gray-200 dark:border-gray-600 pt-2"
                        >
                          <span className="text-gray-700 dark:text-gray-300">{row.gameName}</span>
                          <span className="font-medium text-yellow-500 dark:text-yellow-400">{row.streak}</span>
                        </div>
                      ))}
                  </div>

                  {/* Delegate prediction power to this predictor */}
                  {myAddress && p.address.toLowerCase() === myAddress.toLowerCase() ? (
                    <p className="text-xs text-gray-500 pt-1">This is you.</p>
                  ) : myDelegate.toLowerCase() === p.address.toLowerCase() ? (
                    <button
                      disabled
                      className="w-full py-2 bg-gray-300 dark:bg-gray-600 !text-white text-sm font-medium rounded"
                      data-testid={`btn-use-predictor-${p.address}`}
                    >
                      Currently staked with this predictor
                    </button>
                  ) : (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelegate(p.address); }}
                      disabled={delegating === p.address}
                      className="w-full py-2 bg-blue-400 hover:bg-blue-500 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                      data-testid={`btn-use-predictor-${p.address}`}
                    >
                      {delegating === p.address ? 'Delegating…' : 'Stake with this predictor and earn'}
                    </button>
                  )}
                  {delegateAction?.to === p.address && delegateAction.status === 'success' && delegateAction.message && (
                    <div className="p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-xs text-green-800 dark:text-green-300">
                      {delegateAction.message}
                    </div>
                  )}
                  {delegateAction?.to === p.address && delegateAction.status === 'error' && delegateAction.message && (
                    <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-300">
                      {delegateAction.message}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {ranked.length === 0 && (
          <div className="card-themed p-6 text-center text-sm text-gray-500">
            {q ? `No predictors match "${search}".` : 'No streaks recorded yet. Predict correctly to appear here!'}
          </div>
        )}

        {hasMore && (
          <button
            onClick={() => setPage((p) => p + 1)}
            className="w-full py-3 mt-2 text-sm text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700/30 hover:bg-gray-200 dark:hover:bg-gray-700/50 rounded-lg transition-colors"
            data-testid="leaderboard-load-more"
          >
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
