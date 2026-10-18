import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { retryRead } from '../utils/retryRead';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';
import { useGasless } from './useGasless';
import { StreamBasic } from './useStreamList';
import { useGames, gameDisplayName } from './useGames';
import { multicallRead } from '../utils/multicall';
import { explainError, sendPreflighted } from '../utils/errors';
import { getCurrentRound } from '../lib/chainValues';
import { afterTx } from '../lib/afterTx';
import { indexerGames, indexerLastPredictions } from '../utils/indexerClient';

export interface PredictionResult {
  gameId: number;
  // The stream behind this game (1:1). Carried so the row can flip its UP/DOWN
  // label for an inverted Uniswap stream — see lib/streamOrientation.
  streamId: number;
  gameName: string;
  direction: number; // 1=UP, 2=DOWN
  roundMade: number;
  /// The clock hour this prediction's window opened on, from the indexer;
  /// null when it could not say.
  hour: number | null;
  scored: boolean;
  // The stream's update cadence in MINUTES (from the already-loaded stream
  // list; no extra reads). Drives the conservative expiry countdown: a pending
  // prediction dies SOONEST when the hour-keyed ring wraps past it —
  // 768 slots x cadence minutes.
  cadence: number;
}

export interface DashboardData {
  balance: string;
  claimable: string;
  lockedUntil: number;
  currentRound: number;
  hasPredictedToday: boolean;
  predictionPower: string;
  streaks: { gameId: number; streamId: number; gameName: string; length: number }[];
  /// The DUST BAR per streamId — the streak at or above which a prediction earns real
  /// weight instead of dust. `h = max(dustFloor, gameStreakState[gameId].threshold)`,
  /// exactly what SatoriEngine computes at predict time.
  ///
  /// Keyed by STREAM for the UI's convenience, but read per GAME: the threshold mapping
  /// is keyed by gameId and predictions resolve stream->game via gameDispatch. They
  /// coincide in test fixtures, which is a trap — never index it by streamId on chain.
  ///
  /// Separate from `streaks` because that list drops zero-length entries, and a player
  /// on streak 0 still needs to see where the bar is.
  barByStream: Record<number, number>;
  recentPredictions: PredictionResult[];
  delegateAddress: string;
  hasDelegated: boolean; // prediction delegation (rewards.predictionDelegateInfo)
  // Prediction-power delegation (rewards.predictionDelegateInfo). When true the
  // user can't predict themselves — their delegate predicts on their behalf.
  hasPredictionDelegate: boolean;
  /// True when the user is currently prediction-delegated AND it has been
  /// more than a year since they last claimed (or since we first observed
  /// them as a delegator on this device). Drives a "claim once a year"
  /// reminder banner. localStorage-backed so it has no contract or RPC
  /// cost — and resets to false the moment they claim.
  delegatorClaimReminder: boolean;
}

const DELEGATOR_LAST_CLAIM_KEY_PREFIX = 'satori:lastDelegatorClaim:';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function readLastClaim(address: string): number {
  try {
    const v = localStorage.getItem(DELEGATOR_LAST_CLAIM_KEY_PREFIX + address.toLowerCase());
    return v ? parseInt(v, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

function writeLastClaim(address: string, ts: number): void {
  try {
    localStorage.setItem(DELEGATOR_LAST_CLAIM_KEY_PREFIX + address.toLowerCase(), String(ts));
  } catch { /* localStorage unavailable — banner just won't track. */ }
}

// Dashboard reads only need the (id, name) pair from the streams list — no
// history, no per-round counts. Accepts `StreamBasic[]` from `useStreamList`
// rather than the legacy `StreamInfo[]` from `useStreamData`. Streaks for
// streams not yet loaded in the paginated list won't appear here; the user
// can click "Load more" on the Streams tab to bring them into view.
export function useDashboard(streams: StreamBasic[]) {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const { sendOrRelay } = useGasless();
  const { resolveGameIds, getGameMetas } = useGames();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimSuccess, setClaimSuccess] = useState(false);
  // Surfaced, not just logged. A failed load leaves `data` null and `loading`
  // false, and the tab renders on one or the other — so without this the whole
  // page is silently blank with the reason hidden in the console.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!contracts || !address) { setLoading(false); return; }
    // No streams yet is a WAITING state, not a failure — but it must still stop
    // pretending to load forever, which is what the bare `return` did.
    if (streams.length === 0) { setLoading(false); setError(null); return; }
    setLoading(true);
    setError(null);

    try {
      // Wrapped: on a cold load this fires alongside every other hook's reads,
      // and a burst against a public RPC loses a few. Before this, one lost call
      // failed the whole dashboard and left the tab blank.
      // `reads`, not `contracts`: these go through the resilient provider, which
      // dedupes identical concurrent calls, caps how many are in flight, retries
      // transport failures and fails over. None of that applied while these read
      // through the wallet's provider.
      const r = contracts.reads;
      const [bal, claimable, locked, round, power, predInfo] = await retryRead(() => Promise.all([
        r.satori.balanceOf(address),
        // getTotalClaimableRewards moved to the read-only lens (review #12) and now
        // returns (uint256 total, bool complete) — audit F28/F29 budgeted the
        // delegator walk, so `complete === false` means `total` is a LOWER BOUND.
        // Take [0]; passing the whole tuple to formatEther threw INVALID_ARGUMENT.
        r.lens.getTotalClaimableRewards(address).then((r: any) => r[0]),
        r.satori.lockedUntil(address),
        getCurrentRound(),
        r.rewards.getPredictionPower(address),
        r.rewards.predictionDelegateInfo(address),
      ]));

      const currentRound = Number(round);
      const predCount = await retryRead(() => r.satori.predictedStreamsCount(address, currentRound));

      // Streaks/predictions are now game-keyed. Stream<->game is 1:1, so resolve
      // each loaded stream to its single binary gameId via the bridge, then query
      // streaks/getLatestPrediction per gameId. Streams without a game (gameId 0)
      // are dropped. We keep the stream as the display-name source (the default
      // binary game carries an empty on-chain name), enriched by gameMeta name
      // when a non-binary game ever supplies one.
      const streamsList = streams;
      const gameIdMap = await resolveGameIds(streamsList.map((s) => s.id));
      const gamed = streamsList
        .map((s) => ({ stream: s, gameId: gameIdMap.get(s.id) ?? 0 }))
        .filter((g) => g.gameId > 0);

      const metas = await getGameMetas(gamed.map((g) => g.gameId));

      // Batch every game's (streaks, getLatestPrediction) read into a single
      // eth_call via Multicall. Was 2N independent reads; now one round-trip.
      const reqs = gamed.flatMap((g) => [
        // `contracts.reads.engine`, NOT `contracts.satori`. The facade dispatches
        // per method when you CALL it, but multicall does not call it — it builds
        // calldata from `.target` + `.interface`, and the facade's `.target` is
        // hardwired to the hub. Routing these through it encoded `streaks` /
        // `getLatestPrediction` against the HUB, where neither exists, and
        // `allowFailure: true` turned the revert into a silent 0. Every streak in
        // the dapp read as 0 for every account, on every chain.
        { contract: contracts.reads.engine, fn: 'streaks', args: [address, g.gameId], allowFailure: true },
        { contract: contracts.reads.engine, fn: 'getLatestPrediction', args: [address, g.gameId], allowFailure: true },
      ]);
      // The dust bar, max(dustFloor, threshold), folded by the indexer from
      // CurveConfigSet and StreakThresholdSet. A game it has no bar for reads
      // the threshold and the floor on chain, as the engine computes it.
      const barByGame = new Map<number, number>();
      for (const ig of await indexerGames() ?? []) if (ig.dustBar != null) barByGame.set(ig.gameId, ig.dustBar);
      const unbarred = gamed.filter((g) => !barByGame.has(g.gameId));
      const gssReqs = unbarred.map((g) => (
        // allowFailure: a game never predicted has no entry; it reads back 0 and the floor covers it.
        { contract: contracts.reads.engine, fn: 'gameStreakState', args: [g.gameId], allowFailure: true }
      ));
      const [batched, gssRes, lastPreds] = await Promise.all([
        multicallRead(contracts.reads.multicall, reqs),
        gssReqs.length ? multicallRead(contracts.reads.multicall, gssReqs) : Promise.resolve([] as any[]),
        indexerLastPredictions(address),
      ]);
      const hourByGame = new Map((lastPreds ?? []).map((l) => [l.gameId, l.hour]));
      if (unbarred.length) {
        let dustFloor = 2;
        try {
          dustFloor = Number((await contracts.cached.round.engine.curveConfig())[0]);
        } catch (e) { console.warn('curveConfig read failed:', e); }
        unbarred.forEach((g, j) => {
          const gss = gssRes[j];
          const rawThreshold = gss != null ? Number(gss.threshold ?? gss[0] ?? 0) : 0;
          barByGame.set(g.gameId, Math.max(dustFloor, rawThreshold));
        });
      }

      const streakResults: { gameId: number; streamId: number; gameName: string; length: number }[] = [];
      const predResults: PredictionResult[] = [];
      const barByStream: Record<number, number> = {};
      gamed.forEach((g, i) => {
        const name = gameDisplayName(metas.get(g.gameId)?.name, g.stream.name);
        const streak = batched[i * 2];
        const pred = batched[i * 2 + 1];
        barByStream[g.stream.id] = barByGame.get(g.gameId)!;
        if (streak != null) {
          const len = Number(streak);
          if (len > 0) streakResults.push({ gameId: g.gameId, streamId: g.stream.id, gameName: name, length: len });
        }
        if (pred != null) {
          const direction = Number(pred.direction);
          if (direction > 0) {
            predResults.push({
              gameId: g.gameId,
              streamId: g.stream.id,
              gameName: name,
              direction,
              roundMade: Number(pred.roundMade),
              hour: hourByGame.get(g.gameId) ?? null,
              scored: pred.scored,
              cadence: Math.max(1, Number(g.stream.minCadenceMinutes ?? 1440)),
            });
          }
        }
      });

      // Sort streaks descending, predictions by round descending
      streakResults.sort((a, b) => b.length - a.length);
      predResults.sort((a, b) => b.roundMade - a.roundMade);

      // (The old "rounds since last claim" maxStreak proxy is gone — review #7.
      // It powered a false-urgency banner and measured consistency, not time.)

      // Prediction-power delegate (tuple: [delegate, ...]). Non-zero, non-self
      // means the user's predictions are made by their delegate.
      const predictionDelegate: string = predInfo[0];
      const hasPredictionDelegate =
        predictionDelegate !== ethers.ZeroAddress &&
        predictionDelegate.toLowerCase() !== address.toLowerCase();

      // `hasDelegated` used to come from voting.getDelegate — VOTE delegation,
      // which no longer exists (burn voting has no delegable vote). It now tracks
      // the PREDICTION delegate, which is what the Dashboard panel it drives has
      // always actually said: "Predictions delegated to ...". The old wiring made
      // that panel show a vote fact under a prediction label; both halves are now
      // the same, live, correct read.
      const hasDelegated = hasPredictionDelegate;

      // Delegator claim-reminder logic. We start the clock the first time
      // we observe this address as a delegator on this device. If they
      // claim, we reset it (see the `claim` callback below). If a year
      // passes without a claim, the banner appears.
      let delegatorClaimReminder = false;
      if (hasDelegated) {
        const now = Date.now();
        let lastClaim = readLastClaim(address);
        if (lastClaim === 0) {
          // First observation — start the clock so first-time delegators
          // don't immediately see the banner.
          writeLastClaim(address, now);
          lastClaim = now;
        }
        delegatorClaimReminder = (now - lastClaim) >= ONE_YEAR_MS;
      }

      setData({
        balance: ethers.formatEther(bal),
        claimable: ethers.formatEther(claimable),
        lockedUntil: Number(locked),
        currentRound,
        hasPredictedToday: Number(predCount) > 0,
        predictionPower: ethers.formatEther(power),
        streaks: streakResults,
        barByStream,
        recentPredictions: predResults,
        delegateAddress: predictionDelegate,
        hasDelegated,
        hasPredictionDelegate,
        delegatorClaimReminder,
      });
    } catch (e: any) {
      console.error('Dashboard load failed:', e);
      setError(e?.shortMessage ?? e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [contracts, address, streams, resolveGameIds, getGameMetas]);

  useEffect(() => {
    load();
  }, [load]);

  const claim = useCallback(async (recipient?: string) => {
    if (!contracts) return;
    setClaiming(true);
    setClaimError(null);
    setClaimSuccess(false);

    try {
      const tx = await sendOrRelay(
        { kind: 'claim', recipient: recipient ?? address! },
        () => recipient
          ? contracts.satori['claim(address)'](recipient)
          : contracts.satori['claim()'](),
      );
      await afterTx(tx);
      setClaimSuccess(true);
      // Reset the delegator claim-reminder clock — they just claimed.
      if (address) writeLastClaim(address, Date.now());
      // Reload dashboard data
      await load();
    } catch (e: any) {
      setClaimError(explainError(e));
    } finally {
      setClaiming(false);
    }
  }, [contracts, address, load, sendOrRelay]);

  /// Permissionless: score the user's stranded prediction on a game.
  /// Useful when scoring hasn't run yet (no later predict/settle has fired
  /// for this user on this game). Returns null on success, else why not.
  const settle = useCallback(async (gameId: number): Promise<string | null> => {
    if (!contracts || !address) return 'Connect a wallet to settle.';
    try {
      // On a binary game, settlePrediction neither reverts nor emits while the
      // prediction's round is open or its values are not posted; it just costs
      // gas. Every branch that does settle rewrites the prediction slot
      // (SatoriEngine._scorePreviousPrediction), so simulate it between two
      // reads of the slot and skip a transaction that would change nothing.
      // Adapter games keep their bets elsewhere, so they are sent as before.
      // The simulation runs at the latest block, which can still be in the
      // round the History tab already shows as ended (an idle node mines no
      // block at midnight). Then only a sent transaction reaches the new round.
      const e = contracts.reads.engine;
      const [dispatch, before, simulated, after, simRound] = await multicallRead(contracts.reads.multicall, [
        { contract: contracts.reads.games, fn: 'gameDispatch', args: [gameId] },
        { contract: e, fn: 'userPredictions', args: [address, gameId] },
        { contract: e, fn: 'settlePrediction', args: [address, gameId], allowFailure: true },
        { contract: e, fn: 'userPredictions', args: [address, gameId] },
        { contract: contracts.reads.token, fn: 'getCurrentRound', args: [] },
      ]);
      if (dispatch[0] === ethers.ZeroAddress && simulated !== null && before === after
          && simRound >= await getCurrentRound()) {
        return 'Nothing to settle yet: a prediction settles after its round ends, once the stream has posted the values it is scored on.';
      }
      // A revert in the simulation falls through, so the preflight below reports its reason.
      const tx = await sendPreflighted(contracts.reads.satori, contracts.satori, 'settlePrediction', [address, gameId], address);
      await afterTx(tx);
      await load();
      return null;
    } catch (e: any) {
      return explainError(e);
    }
  }, [contracts, address, load]);

  return { data, loading, error, reload: load, claim, claiming, claimError, claimSuccess, settle };
}
