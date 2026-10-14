import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useGames } from './useGames';
import { loadEventsCached } from '../utils/eventCache';
import { indexerSentimentSplit } from '../utils/indexerClient';
import { DEFAULT_CHAIN_ID } from '../contracts/addresses';
import { chainCache } from './useChainRead';
import { cacheKey } from '../lib/chainCache';
import { getDeploymentBlock, getCurrentRound, getDeploymentRound } from '../lib/chainValues';
import { shiftToDescribedRound, DEFAULT_STREAM_ID } from '../lib/defaultStreamSeries';

// DEFAULT_STREAM_ID comes from lib/defaultStreamSeries — stream 1 is the
// protocol's own stream and the ONLY one whose value describes the previous
// round rather than its own.

export interface StreamDetail {
  id: number;
  // One row per ring entry, keyed by the absolute HOUR the value was stamped
  // (the registry ring is hour-keyed, 768 slots deep).
  // up/down = total prediction POWER per direction; upCount/downCount = number
  // of predictions per direction. The chart overlays both (thick power bar +
  // thin count bar) so a power/count divergence (a whale) is visible. The
  // tallies are ROUND-keyed on chain, so every row in the same 24h round
  // carries that round's totals.
  history: { value: number; hour: number; up: number; down: number; upCount: number; downCount: number }[];
  // The ring entry just before history[0], when the ring holds one: a named
  // stream's chart reads every point against its predecessor, and the window's
  // first point has one too. Undefined when history[0] is the first ever entry.
  prevOfFirst?: number;
}

/**
 * Loads history + prediction counts for a single stream on demand.
 * Only fetches when streamId changes — avoids loading all streams upfront.
 */
export function useStreamDetail(streamId: number | null) {
  const { contracts } = useContracts();
  const { resolveGameId } = useGames();
  const [detail, setDetail] = useState<StreamDetail | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!contracts || !streamId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    try {
      // Paged read: the full ring is 768 hourly entries (a 24x payload); the
      // chart shows the most recent week. getHistoryPage returns the window
      // oldest -> newest plus the ring's total for pagers.
      // One entry more than the window: the predecessor of the first plotted
      // point, kept out of the series and handed over as `prevOfFirst`.
      const CHART_WINDOW_HOURS = 168;
      const historyData = await contracts.cached.live.registry.getHistoryPage(streamId, 0, CHART_WINDOW_HOURS + 1);
      const extra = historyData[0].length > CHART_WINDOW_HOURS ? 1 : 0;
      const values = historyData[0].slice(extra);
      const dates = historyData[1].slice(extra);
      const prevOfFirst = extra ? Number(historyData[0][0]) : undefined;
      const histCount = values.length;

      // Per-round UP/DOWN tallies are derived from the PredictionMade event
      // log (per-round storage was removed; the event is the source of truth
      // for per-round prediction direction counts). Scan the event log filtered
      // by the stream's 1:1 binary gameId via IndexedDB-cached fetch, then
      // bucket by round + direction. Cold-load walks from deploymentBlock in
      // chunks; warm calls only fetch the delta.
      //
      // getHistory stamps are absolute HOURS; the tallies are ROUND-keyed
      // (PredictionMade carries the 24h round). The join below buckets
      // hour -> round via Math.floor(hour / 24) — joining on the raw hour
      // would miss every round key and blank the sentiment overlay.
      const hours: number[] = [];
      for (let i = 0; i < histCount; i++) hours.push(Number(dates[i]));
      const roundOfHour = (h: number) => Math.floor(h / 24);
      const counts = new Map<number, { up: number; down: number; upCount: number; downCount: number }>();
      try {
        // Predictions are GAME-keyed: PredictionMade's 2nd indexed topic is
        // the gameId (honestly named since review #10). Resolve the stream's
        // 1:1 binary gameId and filter on that, not the streamId. gameId 0
        // (no game) yields no events — harmless.
        const gameId = await resolveGameId(streamId);
        // Indexer fast path: the server view is this same per-round
        // reduction (power-weighted UP/DOWN + counts). Null → scan.
        //
        // Class 4 (live): the CURRENT round's tallies move as people predict, so
        // this must not be held long. 30s — and a page load starts a fresh
        // session with an empty cache, so a refresh always re-pulls, which is the
        // behaviour wanted.
        //
        // Keyed on the ROUND as well as the game, so a rollover invalidates at
        // once rather than serving the previous round's live row for up to 30
        // more seconds. Within a round it collapses repeat mounts and stream
        // switches to a single fetch; before this, every mount refetched.
        //
        // Closed rounds are served from localStorage and never refetched; only
        // the live tail crosses the network. See indexerSentimentSplit.
        const nowRound = Number(await getCurrentRound());
        const indexed = await chainCache.read(
          cacheKey('indexer', 'sentiment', [gameId, nowRound]),
          { class: 'live' },
          () => indexerSentimentSplit(DEFAULT_CHAIN_ID, gameId, nowRound),
        );
        if (indexed) {
          indexed.forEach((c, round) => counts.set(round, c));
        } else {
          const fromBlock = Number(await getDeploymentBlock(contracts.reads));
          const events = await loadEventsCached({
            // PredictionMade is emitted by the engine (not the hub) — query the
            // engine directly. The facade routes .filters/.queryFilter/.target to
            // the hub, which never emits this event, so passing the facade here
            // would build an undefined filter and throw.
            contract: contracts.engine,
            eventName: 'PredictionMade',
            // PredictionMade(predictor, gameId, round, direction, streak, power).
            // The 2nd indexed topic is the gameId — filterArgs [null, gameId].
            filterArgs: [null, gameId],
            fromBlock,
          });
          const roundSet = new Set(hours.map(roundOfHour));
          for (const ev of events) {
            const round = Number(ev.args?.round ?? 0);
            if (!roundSet.has(round)) continue;
            const direction = Number(ev.args?.direction ?? 0);
            // Weight sentiment by each predictor's prediction power (token-weighted),
            // not a raw headcount — a bigger predictor moves the bar more than a
            // smaller one. predictionPower is uint256 wei; convert to token units.
            const pw = ev.args?.predictionPower;
            const power = pw ? Number(ethers.formatEther(pw)) : 0;
            const cur = counts.get(round) ?? { up: 0, down: 0, upCount: 0, downCount: 0 };
            if (direction === 1) { cur.up += power; cur.upCount += 1; }
            else if (direction === 2) { cur.down += power; cur.downCount += 1; }
            counts.set(round, cur);
          }
        }
      } catch (e) {
        // Event scan is best-effort; chart's `hasCounts` short-circuit means
        // a failed scan just hides the sentiment overlay, not the chart.
        console.warn('PredictionMade scan failed:', e);
      }

      const history = [];
      for (let i = 0; i < histCount; i++) {
        const h = Number(dates[i]);
        // Round-keyed tallies joined onto an hour-keyed row — bucket first.
        const c = counts.get(roundOfHour(h)) ?? { up: 0, down: 0, upCount: 0, downCount: 0 };
        history.push({
          value: Number(values[i]),
          hour: h,
          up: c.up,
          down: c.down,
          upCount: c.upCount,
          downCount: c.downCount,
        });
      }

      // The default stream reports the PREVIOUS round's prediction count, so
      // its stamped rounds are one ahead of the rounds they describe, and its
      // newest value is not written until somebody predicts. Correct both, for
      // stream 1 only — see lib/defaultStreamSeries.ts. The helpers are
      // ROUND-keyed; stream 1 is written once per 24h round, so its hour
      // stamps are exact multiples of 24 and hour/24 is lossless both ways.
      let series = history;
      if (streamId === DEFAULT_STREAM_ID) {
        try {
          const deploymentRound = Number(await getDeploymentRound(contracts.reads));
          // shiftToDescribedRound's contract: `round` on INPUT is the absolute
          // HOUR stamp (it divides by 24 internally). Passing roundOfHour(hour)
          // here pre-divided it, so the function divided a second time
          // (20721 -> 862), every point then failed the `>= deploymentRound`
          // filter, and the default-stream chart went permanently blank. Hand it
          // the raw hour.
          const roundKeyed = history.map((p) => ({ ...p, round: p.hour }));
          const shifted = shiftToDescribedRound(roundKeyed, deploymentRound);

          // No tail fill. Rounds nobody predicted in are never stamped, and the
          // gap used to be filled from `roundPredictionCount` — correct while
          // the stream carried a COUNT, wrong since it became a 1e18-scaled
          // participation ratio. A headcount of 3 next to 4.2e17 plots as a
          // flat zero. The ratio needs `deployedBalance`, which the engine does
          // not expose, so an unstamped round is now shown as the gap it is.
          // See lib/defaultStreamSeries.
          // Back to the hour-keyed row shape the chart expects, restamping the
          // hour from the (shifted) round.
          series = shifted
            .map(({ round, ...rest }) => ({ ...rest, hour: round * 24 }))
            .sort((a, b) => a.hour - b.hour);
        } catch (e) {
          // A failed read must not blank the chart. Fall back to the raw
          // stamped series — mislabelled by one round, but present.
          console.warn('default-stream series correction failed:', e);
          series = history;
        }
      }

      setDetail({ id: streamId, history: series, prevOfFirst });
    } catch (e) {
      console.error('Failed to load stream detail:', e);
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, [contracts, streamId, resolveGameId]);

  useEffect(() => {
    load();
  }, [load]);

  return { detail, loading, reload: load };
}
