import { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useGames, gameDisplayName } from './useGames';
import { multicallRead } from '../utils/multicall';
import { loadEventsCached } from '../utils/eventCache';
import { indexerBountyPairs, IndexerBountyPair } from '../utils/indexerClient';
import { onDappEvent } from '../utils/events';
import { getCurrentRound, getDeploymentBlock } from '../lib/chainValues';

// A single live (game, token) token-bounty anywhere on the protocol. Discovered
// by scanning every `BountyFunded` event (game + token indexed), deduping the
// pairs, and live-checking `pool > 0 && ratePerRound > 0` so drained pools drop
// out. Each game is mapped back to its stream (1:1) for a display name and
// cross-checked against the current eligible set so the UI can tell whether the
// game is predictable right now.
export interface BountyListing {
  gameId: number;
  streamId: number;
  name: string;         // display name (game name, else stream name)
  token: string;        // lowercase address
  symbol: string;
  decimals: number;
  pool: bigint;         // base token units remaining in the pool
  ratePerRound: bigint; // scaled by RATE_SCALE (1e18); per 24h round now that rounds are daily
  // Whether the game is vote-eligible. This is NOT a predictability gate — you
  // can always predict a bountied game (that is the whole point: bounties
  // incentivize prediction on streams the SATORI vote doesn't reach). It only
  // means a correct prediction ALSO earns SATORI, not just the bounty.
  eligible: boolean;
}

const RATE_SCALE = BigInt('1000000000000000000');

const erc20Iface = new ethers.Interface([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

function shortSym(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/// Per-round (24h) drip in base units = min(ratePerRound / RATE_SCALE, pool).
export function bountyDripPerRound(rate: bigint, pool: bigint): bigint {
  const unscaled = rate / RATE_SCALE;
  return unscaled < pool ? unscaled : pool;
}

export function useAllBounties() {
  const { contracts } = useContracts();
  const { getGameMetas } = useGames();
  const [bounties, setBounties] = useState<BountyListing[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!contracts) { setBounties([]); setLoading(false); return; }
    setLoading(true);
    try {
      // 1. Every (gameId, token) that has ever been funded — indexer fast
      //    path first (server-side dedupe of the same BountyFunded log);
      //    null → unfiltered scan, deduped client-side.
      let pairs = await indexerBountyPairs();
      if (pairs) {
        pairs = pairs.filter((p) => p.gameId > 0 && p.token !== ethers.ZeroAddress);
      } else {
        const fromBlock = Number(await getDeploymentBlock(contracts.reads));
        const events = await loadEventsCached({
          contract: contracts.bounties,
          eventName: 'BountyFunded',
          filterArgs: [null, null, null],
          fromBlock,
        });
        const pairSet = new Map<string, { gameId: number; token: string }>();
        for (const ev of events) {
          const gameId = Number(ev.args?.gameId ?? 0);
          const token = String(ev.args?.token ?? '').toLowerCase();
          if (!gameId || !token || token === ethers.ZeroAddress) continue;
          const key = `${gameId}-${token}`;
          if (!pairSet.has(key)) pairSet.set(key, { gameId, token });
        }
        pairs = Array.from(pairSet.values());
      }
      if (pairs.length === 0) { setBounties([]); setLoading(false); return; }

      // 2. Live pool + rate per pair; keep only funded-and-dripping ones. The
      //    indexer carries both (each pool write emits its post-state); a pair
      //    without them reads pool and ratePerRound on chain.
      const live: { gameId: number; token: string; pool: bigint; ratePerRound: bigint }[] = [];
      const unread: IndexerBountyPair[] = [];
      for (const p of pairs as IndexerBountyPair[]) {
        if (p.pool == null || p.rateScaled == null) { unread.push(p); continue; }
        if (p.pool > BigInt(0) && p.rateScaled > BigInt(0)) {
          live.push({ gameId: p.gameId, token: p.token, pool: p.pool, ratePerRound: p.rateScaled });
        }
      }
      if (unread.length) {
        const reqs = unread.flatMap((p) => [
          { contract: contracts.bounties, fn: 'pool', args: [p.gameId, p.token] },
          { contract: contracts.bounties, fn: 'ratePerRound', args: [p.gameId, p.token] },
        ]);
        const results = await multicallRead(contracts.reads.multicall, reqs);
        unread.forEach((p, i) => {
          const pool = BigInt(results[i * 2].toString());
          const rate = BigInt(results[i * 2 + 1].toString());
          if (pool > BigInt(0) && rate > BigInt(0)) {
            live.push({ gameId: p.gameId, token: p.token, pool, ratePerRound: rate });
          }
        });
      }
      if (live.length === 0) { setBounties([]); setLoading(false); return; }

      // 3. Game meta (name + stream) + current eligible set, in parallel.
      const gameIds = Array.from(new Set(live.map((l) => l.gameId)));
      const [metaById, eligibleRaw] = await Promise.all([
        getGameMetas(gameIds),
        // GOVERNING-round snapshot, not the live heap: a bounty's worth turns
        // on whether the game earns this round, and the chain settles that
        // against the frozen set (normally the previous round). The live heap
        // would mark games that cannot earn — see useStreamList's init().
        getCurrentRound()
          .then((r: bigint) => contracts.cached.round.satori.eligibilityRound(r))
          .then((gov: bigint) => contracts.cached.round.voting.getEligibleGamesAtRound(gov))
          .catch(() => [] as unknown[]),
      ]);
      const eligibleSet = new Set((eligibleRaw as unknown[]).map((g) => Number(g)));

      // 4. Stream display names for the surviving games' streams.
      const streamIds = Array.from(new Set(
        gameIds.map((g) => metaById.get(g)?.dataStreamId ?? 0).filter((s) => s > 0),
      ));
      const nameReqs = streamIds.map((sid) => ({
        contract: contracts.registry, fn: 'getDataStreamInfo', args: [sid], allowFailure: true,
      }));
      const nameResults = nameReqs.length > 0 ? await multicallRead(contracts.reads.multicall, nameReqs) : [];
      const streamNameById = new Map<number, string>();
      streamIds.forEach((sid, i) => {
        // getDataStreamInfo → (name, provider, type, value, valueHour, exists)
        // — the 5th return is the absolute HOUR of the newest value (the
        // registry ring is hour-keyed). Only the name is used here.
        streamNameById.set(sid, String(nameResults[i]?.[0] ?? ''));
      });

      // 5. ERC20 symbol + decimals for the unique tokens.
      const tokens = Array.from(new Set(live.map((l) => l.token)));
      const metaCalls = tokens.flatMap((t) => [
        { target: t, allowFailure: true, callData: erc20Iface.encodeFunctionData('symbol', []) },
        { target: t, allowFailure: true, callData: erc20Iface.encodeFunctionData('decimals', []) },
      ]);
      const metaRes = await contracts.multicall.aggregate3.staticCall(metaCalls);
      const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
      tokens.forEach((t, i) => {
        let symbol = shortSym(t);
        let decimals = 18;
        const s = metaRes[i * 2];
        const d = metaRes[i * 2 + 1];
        if (s?.success) { try { symbol = String(erc20Iface.decodeFunctionResult('symbol', s.returnData)[0]); } catch { /* keep short */ } }
        if (d?.success) { try { decimals = Number(erc20Iface.decodeFunctionResult('decimals', d.returnData)[0]); } catch { /* keep 18 */ } }
        tokenMeta.set(t, { symbol, decimals });
      });

      const next: BountyListing[] = live.map((l) => {
        const meta = metaById.get(l.gameId);
        const streamId = meta?.dataStreamId ?? 0;
        const streamName = streamNameById.get(streamId) ?? '';
        const tm = tokenMeta.get(l.token) ?? { symbol: shortSym(l.token), decimals: 18 };
        return {
          gameId: l.gameId,
          streamId,
          name: gameDisplayName(meta?.name, streamName) || `Game #${l.gameId}`,
          token: l.token,
          symbol: tm.symbol,
          decimals: tm.decimals,
          pool: l.pool,
          ratePerRound: l.ratePerRound,
          eligible: eligibleSet.has(l.gameId),
        };
      });
      // Biggest pool first.
      next.sort((a, b) => (b.pool > a.pool ? 1 : b.pool < a.pool ? -1 : 0));
      setBounties(next);
    } catch (e) {
      console.warn('useAllBounties load failed:', e);
      setBounties([]);
    } finally {
      setLoading(false);
    }
  }, [contracts, getGameMetas]);

  useEffect(() => { load(); }, [load]);

  // Any bounty mutation (by anyone) refreshes the list.
  useEffect(() => {
    const off1 = onDappEvent('bounty-funded', () => load());
    const off2 = onDappEvent('bounty-token-cleaned', () => load());
    return () => { off1(); off2(); };
  }, [load]);

  return { bounties, loading, reload: load };
}
