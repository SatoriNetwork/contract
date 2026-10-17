import { getAddress } from 'ethers';
import { getIndexerUrl, getAddresses, DEFAULT_CHAIN_ID } from '../contracts/addresses';

// Thin client for the satori-indexer companion service (../../satori-indexer/).
//
// Contract with callers: every fetcher returns `null` for ANY reason the
// indexer can't be used — not configured, unreachable, timed out, mid-backfill,
// HTTP error, or a response that doesn't validate. Callers treat null as
// "use the existing loadEventsCached scan", which stays the source of truth
// for correctness. The indexer is an accelerator, never a dependency.
//
// The fetchers return data already shaped for their consumer so the call
// sites stay one-line swaps; the shapes mirror the client-side reductions
// exactly (see satori-indexer/src/views.ts, which mirrors them back).

const TIMEOUT_MS = 4000;
// A not-configured/down/syncing verdict is remembered briefly so five
// consumers don't each pay a connect timeout on every load.
const READY_TTL_MS = 30_000;

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

let readyCache: { url: string; at: number; ready: boolean } | null = null;

// Gate every read on /status.syncing === false: a mid-backfill indexer would
// answer with PARTIAL history (silently wrong — e.g. a shorter leaderboard),
// which is worse than the slower-but-complete scan path.
async function indexerReady(base: string): Promise<boolean> {
  const now = Date.now();
  if (readyCache && readyCache.url === base && now - readyCache.at < READY_TTL_MS) {
    return readyCache.ready;
  }
  let ready = false;
  try {
    const s = await fetchJson<{ syncing?: boolean; chainId?: number; addresses?: Record<string, string> }>(`${base}/status`);
    ready = s.syncing === false && sameDeployment(s);
  } catch {
    ready = false;
  }
  readyCache = { url: base, at: now, ready };
  return ready;
}

// An indexer still following an older deployment of the same chain answers
// with plausible, wrong games and streams. Fields an older indexer does not
// publish are not held against it.
function sameDeployment(s: { chainId?: number; addresses?: Record<string, string> }): boolean {
  if (s.chainId != null && Number(s.chainId) !== DEFAULT_CHAIN_ID) return false;
  if (!s.addresses) return true;
  const mine = getAddresses(DEFAULT_CHAIN_ID) as unknown as Record<string, string>;
  return ['token', 'engine'].every((k) => !mine[k] || !s.addresses![k] || s.addresses![k] === mine[k].toLowerCase());
}

async function tryIndexer<T>(path: string, fetchAndShape: (base: string) => Promise<T>): Promise<T | null> {
  const base = getIndexerUrl(DEFAULT_CHAIN_ID);
  if (!base) return null;
  try {
    if (!(await indexerReady(base))) return null;
    return await fetchAndShape(base);
  } catch (e) {
    console.warn(`indexer ${path} failed, falling back to scan:`, e);
    return null;
  }
}

// --- Prediction history (HistoryTab) ------------------------------------
// The server view (satori-indexer/src/views.ts `predictionOutcomes`) already does
// the join this needs: PredictionMade LEFT JOINed against scored/voided/
// unrecoverable/displaced, newest first. It has existed for a while and was
// simply never reachable from the dapp — nothing here exposed it.
//
// Same contract as every other accelerator in this file: null on ANY failure, and
// the caller does the full chain scan instead. Never a dependency.

export type PredictionOutcome =
  | 'won' | 'lost' | 'void' | 'unrecoverable' | 'displaced' | 'pending';

export interface IndexerPrediction {
  gameId: number;
  round: number;
  direction: 'UP' | 'DOWN' | string;
  outcome: PredictionOutcome;
  power?: string;
  streak?: number;
  block: number;
  tx?: string;
}

export function indexerPredictions(
  address: string,
  limit = 500,
): Promise<IndexerPrediction[] | null> {
  return tryIndexer(`/predictions/${address}`, async (base) => {
    const rows = await fetchJson<any[]>(
      `${base}/predictions/${address}?limit=${Math.max(1, Math.min(1000, limit))}`,
    );
    if (!Array.isArray(rows)) throw new Error('bad predictions shape');
    return rows.map((r) => {
      const gameId = Number(r.gameId);
      const round = Number(r.round);
      if (!Number.isFinite(gameId) || !Number.isFinite(round)) {
        throw new Error('bad prediction row');
      }
      return {
        gameId,
        round,
        direction: String(r.direction ?? ''),
        outcome: String(r.outcome ?? 'pending') as PredictionOutcome,
        power: r.power != null ? String(r.power) : undefined,
        streak: r.streak != null ? Number(r.streak) : undefined,
        block: Number(r.block ?? 0),
        tx: r.tx != null ? String(r.tx) : undefined,
      };
    });
  });
}

// --- Each game's latest prediction (the predict gate) ----------------------
// `hour` is PredictionMade.hour, the clock hour that prediction's window opened
// on; a named game reopens to the address at hour + 24. Null hour: a row
// indexed before the event carried one.

export interface IndexerLastPrediction {
  gameId: number;
  round: number;
  hour: number | null;
}

export function indexerLastPredictions(address: string): Promise<IndexerLastPrediction[] | null> {
  const path = `/predictions/${address.toLowerCase()}/last`;
  return tryIndexer(path, async (base) => {
    const rows = await fetchJson<Array<Record<string, unknown>>>(`${base}${path}`);
    if (!Array.isArray(rows)) throw new Error('bad last-predictions shape');
    return rows.map((r) => {
      const gameId = Number(r.gameId);
      const round = Number(r.round);
      if (!Number.isFinite(gameId) || !Number.isFinite(round)) throw new Error('bad last-prediction row');
      return { gameId, round, hour: r.hour == null ? null : Number(r.hour) };
    });
  });
}

// --- Leaderboard (LeaderboardTab) ---------------------------------------
// Server view is already the client reduction: latest PredictionScored per
// (user, gameId), streak > 0. limit=1000 is the server-side max; if the
// protocol ever exceeds 1000 concurrently-positive (user, game) streaks,
// raise the cap in satori-indexer/src/server.ts.

export interface IndexerStreak {
  user: string;
  gameId: number;
  streak: number;
}

export function indexerLeaderboard(): Promise<IndexerStreak[] | null> {
  return tryIndexer('/leaderboard', async (base) => {
    const rows = await fetchJson<Array<{ user: unknown; gameId: unknown; streak: unknown }>>(
      `${base}/leaderboard?limit=1000`,
    );
    if (!Array.isArray(rows)) throw new Error('bad leaderboard shape');
    return rows.map((r) => {
      const user = String(r.user);
      const gameId = Number(r.gameId);
      const streak = Number(r.streak);
      if (!user.startsWith('0x') || !Number.isFinite(gameId) || !Number.isFinite(streak)) {
        throw new Error('bad leaderboard row');
      }
      return { user, gameId, streak };
    });
  });
}

// --- Sentiment (useStreamDetail) -----------------------------------------
// Per-round UP/DOWN prediction power (token units) + counts for one game,
// as the round→tallies map the chart merge expects.

export interface SentimentTallies {
  up: number;
  down: number;
  upCount: number;
  downCount: number;
}

/// Per-round UP/DOWN tallies for a game.
///
/// Deliberately NOT cached here, and cached by the CALLER instead — see
/// `useStreamDetail`. The reason is that this one response mixes two different
/// staleness classes:
///
///   * finished rounds are immutable. Once a round closes, nobody can add a
///     prediction to it, so those rows can never change again.
///   * the CURRENT round moves in real time as people predict.
///
/// The endpoint returns both together, so the immutable majority cannot be
/// skipped: asking for the live row means re-receiving every historic row with
/// it. Splitting that would need a `?fromRound=` parameter on the indexer, which
/// is worth doing when the history is long enough for the bytes to matter. Today
/// it is five rows of our own server, so the cost that IS worth removing is the
/// repeat fetch, not the payload.
export function indexerSentiment(
  gameId: number,
  /// Ask only for rounds >= this. Omit for everything.
  fromRound?: number,
): Promise<Map<number, SentimentTallies> | null> {
  return tryIndexer('/sentiment', async (base) => {
    const q = Number.isFinite(fromRound as number) ? `?fromRound=${fromRound}` : '';
    const rows = await fetchJson<
      Array<{ round: unknown; up: unknown; down: unknown; upCount: unknown; downCount: unknown }>
    >(`${base}/sentiment/${gameId}${q}`);
    if (!Array.isArray(rows)) throw new Error('bad sentiment shape');
    const counts = new Map<number, SentimentTallies>();
    for (const r of rows) {
      const round = Number(r.round);
      if (!Number.isFinite(round)) throw new Error('bad sentiment row');
      counts.set(round, {
        up: Number(r.up) || 0,
        down: Number(r.down) || 0,
        upCount: Number(r.upCount) || 0,
        downCount: Number(r.downCount) || 0,
      });
    }
    return counts;
  });
}

// --- Bounty pairs (useAllBounties / useBountyStakes / StreamsTab) ---------
// Every (gameId, token) pair ever funded, deduped server-side, with the pool and
// scaled rate its latest fund, drip or reclaim left. The pool fields are absent
// from an indexer older than v10; callers then keep their on-chain check.

export interface IndexerBountyPair {
  gameId: number;
  token: string; // lowercase
  cleanedAfter?: number;
  pool?: bigint;
  rateScaled?: bigint;
  live?: boolean;
}

export function indexerBountyPairs(token?: string): Promise<IndexerBountyPair[] | null> {
  const path = token ? `/bounties/pairs/${token.toLowerCase()}` : '/bounties/pairs';
  return tryIndexer(path, async (base) => {
    const rows = await fetchJson<Array<Record<string, unknown>>>(`${base}${path}`);
    if (!Array.isArray(rows)) throw new Error('bad pairs shape');
    return rows.map((r) => {
      const gameId = Number(r.gameId);
      const tok = String(r.token).toLowerCase();
      if (!Number.isFinite(gameId) || !tok.startsWith('0x')) throw new Error('bad pair row');
      const pair: IndexerBountyPair = { gameId, token: tok };
      if (r.cleanedAfter != null) pair.cleanedAfter = Number(r.cleanedAfter);
      if (r.poolWei != null && r.rateScaled != null) {
        pair.pool = BigInt(String(r.poolWei));
        pair.rateScaled = BigInt(String(r.rateScaled));
        pair.live = r.live === true;
      }
      return pair;
    });
  });
}

// --- Referral earnings (ReferralTab) --------------------------------------
// Sum + count of ReferralPaid to one address. The server sums wei as BigInt,
// so the total is exact — same arithmetic as the client scan.

export interface IndexerReferralEarnings {
  total: bigint;
  count: number;
}

export function indexerReferrals(address: string): Promise<IndexerReferralEarnings | null> {
  return tryIndexer('/referrals', async (base) => {
    const r = await fetchJson<{ totalWei: unknown; events: unknown }>(
      `${base}/referrals/${address.toLowerCase()}`,
    );
    if (typeof r.totalWei !== 'string' || !Array.isArray(r.events)) {
      throw new Error('bad referrals shape');
    }
    return { total: BigInt(r.totalWei), count: r.events.length };
  });
}

// --- Who I have referred (ReferralTab) ------------------------------------
//
// Separate from indexerReferrals, which answers "what have I earned". This
// answers "who signed up under me", and the two genuinely differ: a referee who
// has registered but never earned appears ONLY here. It cannot be read from the
// contract at all — the `referral` mapping runs referee -> referrer and cannot
// be walked backwards — so this is the indexer's ReferralSet table or nothing.

export interface IndexerReferee {
  address: string;
  block: number;
  /// Wei this referee has earned the referrer. `0n` is normal and expected:
  /// registering is not earning.
  earnedWei: bigint;
  payouts: number;
}

export function indexerReferredBy(address: string): Promise<IndexerReferee[] | null> {
  return tryIndexer('/referred-by', async (base) => {
    const r = await fetchJson<{ referees: unknown }>(
      `${base}/referred-by/${address.toLowerCase()}`,
    );
    if (!Array.isArray(r.referees)) throw new Error('bad referred-by shape');
    return r.referees.map((row: any) => {
      const addr = String(row?.address ?? '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error('bad referee row');
      return {
        address: addr,
        block: Number(row?.block ?? 0),
        earnedWei: BigInt(String(row?.earnedWei ?? '0')),
        payouts: Number(row?.payouts ?? 0),
      };
    });
  });
}

// --- Sentiment, split by staleness ----------------------------------------
//
// A CLOSED round's tallies are final: nobody can add a prediction to a round
// that has ended. The CURRENT round moves continuously. So closed rounds are
// kept in localStorage forever and only the live tail is fetched.
//
// The store is namespaced by chainId, because round numbers are chain-global
// and a testnet round 41339 has nothing to do with a mainnet one. Getting that
// wrong would draw one chain's bars on another's chart.
const SENTIMENT_STORE_VERSION = 2;
const sentimentKey = (chainId: number, gameId: number) =>
  `satori-sentiment:v${SENTIMENT_STORE_VERSION}:${chainId}:${gameId}`;

function readClosed(chainId: number, gameId: number): Map<number, SentimentTallies> {
  try {
    const raw = localStorage.getItem(sentimentKey(chainId, gameId));
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, SentimentTallies>;
    return new Map(Object.entries(obj).map(([r, v]) => [Number(r), v]));
  } catch {
    return new Map();
  }
}

function writeClosed(chainId: number, gameId: number, m: Map<number, SentimentTallies>): void {
  try {
    const obj: Record<string, SentimentTallies> = {};
    m.forEach((v, r) => { obj[String(r)] = v; });
    localStorage.setItem(sentimentKey(chainId, gameId), JSON.stringify(obj));
  } catch {
    // Quota, private mode, disabled storage. Costs a bigger fetch next time and
    // nothing else, so never let it break the read.
  }
}

/// Sentiment with closed rounds served from local storage and only the live tail
/// fetched.
///
/// `currentRound` is the boundary: everything BELOW it is closed and cacheable,
/// everything from it upward is live and always refetched. The request asks for
/// `fromRound = min(currentRound, firstMissing)`, so a client with a full
/// history fetches exactly one round and a cold client fetches everything.
///
/// Returns null only when the indexer is unreachable AND nothing is cached, so
/// the caller's event-scan fallback still triggers on a genuinely cold failure.
/// With a warm cache an outage degrades to stale-but-present bars rather than
/// none, which is the better failure for a chart.
export async function indexerSentimentSplit(
  chainId: number,
  gameId: number,
  currentRound: number,
): Promise<Map<number, SentimentTallies> | null> {
  const closed = readClosed(chainId, gameId);

  // First round we do not already hold. Never ask from above currentRound: the
  // live row must come back every time.
  let firstMissing = currentRound;
  for (let r = currentRound - 1; r >= 0; r--) {
    if (closed.has(r)) break;
    firstMissing = r;
    // A game cannot have predictions before it existed; stop after a reasonable
    // walk-back rather than counting to zero on a cold cache.
    if (currentRound - r > 4096) break;
  }

  const fresh = await indexerSentiment(gameId, firstMissing);
  if (!fresh) return closed.size > 0 ? closed : null;

  const merged = new Map(closed);
  fresh.forEach((v, r) => merged.set(r, v));

  // Persist only what can no longer change.
  const toStore = new Map<number, SentimentTallies>();
  merged.forEach((v, r) => { if (r < currentRound) toStore.set(r, v); });
  writeClosed(chainId, gameId, toStore);

  return merged;
}

// --- The read model: games, streams, delegation, round budget -------------
// One /games or /streams response serves every caller in a load: several hooks
// ask within the same second, and the server caches for 5s anyway.

const MEMO_MS = 5_000;
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function memoized<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.then((v) => { if (v == null) memo.delete(key); }, () => memo.delete(key));
  return value;
}

export interface IndexerGame {
  gameId: number;
  streamId: number;
  gameTypeId: number;
  targetMinutes: number;
  gameConfig: string;
  name: string;           // current, after renames
  authority: string;      // current, checksummed
  isDefaultBinary: boolean;
  dustBar: number | null; // max(dustFloor, threshold); null before the engine logged its curve
}

export function indexerGames(): Promise<IndexerGame[] | null> {
  const base = getIndexerUrl(DEFAULT_CHAIN_ID);
  return memoized(`games:${base}`, () => tryIndexer('/games', async (b) => {
    const rows = await fetchJson<Array<Record<string, unknown>>>(`${b}/games`);
    if (!Array.isArray(rows)) throw new Error('bad games shape');
    return rows.map((r) => {
      const g: IndexerGame = {
        gameId: Number(r.gameId), streamId: Number(r.streamId), gameTypeId: Number(r.gameTypeId),
        targetMinutes: Number(r.targetMinutes), gameConfig: String(r.gameConfig), name: String(r.name),
        authority: getAddress(String(r.authority)), isDefaultBinary: r.isDefaultBinary === true,
        dustBar: r.dustBar == null ? null : Number(r.dustBar),
      };
      if (![g.gameId, g.streamId, g.gameTypeId, g.targetMinutes].every(Number.isFinite)) throw new Error('bad game row');
      return g;
    });
  }));
}

export interface IndexerStream {
  streamId: number;
  name: string;      // current
  streamType: number;
  adapterId: number;
  minCadenceMinutes: number;
  config: string;
  nameKey: string | null;
  creator: string;   // checksummed
  provider: string;  // current, checksummed
  named: boolean;
  lastValue: bigint | null;
  lastHour: number | null;
}

export function indexerStreams(): Promise<IndexerStream[] | null> {
  const base = getIndexerUrl(DEFAULT_CHAIN_ID);
  return memoized(`streams:${base}`, () => tryIndexer('/streams', async (b) => {
    const rows = await fetchJson<Array<Record<string, unknown>>>(`${b}/streams`);
    if (!Array.isArray(rows)) throw new Error('bad streams shape');
    return rows.map((r) => {
      const st: IndexerStream = {
        streamId: Number(r.streamId), name: String(r.name), streamType: Number(r.streamType),
        adapterId: Number(r.adapterId), minCadenceMinutes: Number(r.minCadenceMinutes), config: String(r.config),
        nameKey: r.nameKey == null ? null : String(r.nameKey),
        creator: getAddress(String(r.creator)), provider: getAddress(String(r.provider)), named: r.named === true,
        lastValue: r.lastValue == null ? null : BigInt(String(r.lastValue)),
        lastHour: r.lastHour == null ? null : Number(r.lastHour),
      };
      if (![st.streamId, st.streamType, st.adapterId, st.minCadenceMinutes].every(Number.isFinite)) throw new Error('bad stream row');
      return st;
    });
  }));
}

export interface IndexerDelegation {
  delegate: string | null; // checksummed; null when not delegating
  activationRound: number | null;
  inboundPower: bigint;    // predictionDelegateInfo(address).power
}

export function indexerDelegation(address: string): Promise<IndexerDelegation | null> {
  const path = `/delegation/${address.toLowerCase()}`;
  return tryIndexer(path, async (b) => {
    const r = await fetchJson<Record<string, unknown>>(`${b}${path}`);
    if (r == null || r.inboundPowerWei == null) throw new Error('bad delegation shape');
    return {
      delegate: r.delegate == null ? null : getAddress(String(r.delegate)),
      activationRound: r.activationRound == null ? null : Number(r.activationRound),
      inboundPower: BigInt(String(r.inboundPowerWei)),
    };
  });
}

/// The payable budget `round` froze on its first touch; null when nothing has
/// touched it yet (the caller computes the projection) or on any failure.
export async function indexerRoundBudget(round: number): Promise<bigint | null> {
  const path = `/rounds/${round}/budget`;
  const r = await tryIndexer(path, (b) => fetchJson<{ budgetWei: unknown }>(`${b}${path}`));
  return r?.budgetWei == null ? null : BigInt(String(r.budgetWei));
}

// A stream this client just wrote reads from chain until the indexer has had
// time to see the write; otherwise a reload shows the old value and re-enables
// the tick button.
const WRITE_SHADOW_MS = 60_000;
const recentWrites = new Map<number, number>();
export function noteStreamWrite(streamId: number): void {
  recentWrites.set(streamId, Date.now());
}
export function recentlyWrittenStream(streamId: number): boolean {
  const at = recentWrites.get(streamId);
  return at != null && Date.now() - at < WRITE_SHADOW_MS;
}
