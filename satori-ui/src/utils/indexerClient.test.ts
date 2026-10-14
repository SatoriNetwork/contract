import {
  indexerLeaderboard,
  indexerSentiment,
  indexerBountyPairs,
  indexerReferrals,
  indexerGames,
  indexerStreams,
  indexerDelegation,
  indexerRoundBudget,
} from './indexerClient';
import { getAddress } from 'ethers';
import { getAddresses, DEFAULT_CHAIN_ID } from '../contracts/addresses';

// The client's whole contract is: data when the indexer is configured AND
// healthy AND the response validates; null for every other reason, so the
// consumer falls back to the event scan. These tests pin that contract.

const realFetch = (global as any).fetch;

// Each test uses a distinct base URL because the client memoizes the
// /status readiness verdict per URL for 30s.
let urlSeq = 0;
function configureIndexer(): string {
  const base = `http://indexer-${urlSeq++}.test`;
  process.env.REACT_APP_INDEXER_URL = base;
  return base;
}

type Route = { match: string; body?: unknown; status?: number };

function mockFetch(routes: Route[]): jest.Mock {
  const fn = jest.fn(async (input: unknown) => {
    const url = String(input);
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`connection refused: ${url}`);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      json: async () => route.body,
    };
  });
  (global as any).fetch = fn;
  return fn;
}

const READY = { match: '/status', body: { syncing: false } };

afterEach(() => {
  delete process.env.REACT_APP_INDEXER_URL;
  (global as any).fetch = realFetch;
});

test('returns null when no indexer is configured, without touching the network', async () => {
  const fn = mockFetch([]);
  expect(await indexerLeaderboard()).toBeNull();
  expect(await indexerSentiment(4)).toBeNull();
  expect(await indexerBountyPairs()).toBeNull();
  expect(await indexerReferrals('0x' + '1'.repeat(40))).toBeNull();
  expect(fn).not.toHaveBeenCalled();
});

test('returns null while the indexer is still backfilling (partial data is worse than slow data)', async () => {
  configureIndexer();
  const fn = mockFetch([
    { match: '/status', body: { syncing: true } },
    { match: '/leaderboard', body: [{ user: '0xabc', gameId: 1, streak: 5 }] },
  ]);
  expect(await indexerLeaderboard()).toBeNull();
  // The data endpoint must not have been consulted.
  expect(fn.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/leaderboard'))).toBe(false);
});

test('returns null when the indexer is unreachable or errors', async () => {
  configureIndexer();
  mockFetch([]); // every request refused
  expect(await indexerLeaderboard()).toBeNull();

  configureIndexer();
  mockFetch([READY, { match: '/leaderboard', status: 500 }]);
  expect(await indexerLeaderboard()).toBeNull();
});

test('returns null on a malformed response instead of poisoning the UI', async () => {
  configureIndexer();
  mockFetch([READY, { match: '/leaderboard', body: { nope: true } }]);
  expect(await indexerLeaderboard()).toBeNull();

  configureIndexer();
  mockFetch([READY, { match: '/referrals/', body: { totalWei: 12, events: [] } }]); // number, not string
  expect(await indexerReferrals('0x' + '2'.repeat(40))).toBeNull();
});

test('leaderboard: healthy indexer yields the reduced rows', async () => {
  configureIndexer();
  mockFetch([READY, {
    match: '/leaderboard',
    body: [
      { user: '0xaaa0000000000000000000000000000000000001', gameId: 4, streak: 2, round: 41302, block: 99 },
      { user: '0xaaa0000000000000000000000000000000000002', gameId: 2, streak: 1, round: 41293, block: 51 },
    ],
  }]);
  expect(await indexerLeaderboard()).toEqual([
    { user: '0xaaa0000000000000000000000000000000000001', gameId: 4, streak: 2 },
    { user: '0xaaa0000000000000000000000000000000000002', gameId: 2, streak: 1 },
  ]);
});

test('sentiment: rows become the round→tallies map the chart merge expects', async () => {
  configureIndexer();
  mockFetch([READY, {
    match: '/sentiment/4',
    body: [
      { round: 41300, up: 3.5, down: 0, upCount: 2, downCount: 0 },
      { round: 41302, up: 1.25, down: 2, upCount: 1, downCount: 1 },
    ],
  }]);
  const m = await indexerSentiment(4);
  expect(m).not.toBeNull();
  expect(m!.get(41300)).toEqual({ up: 3.5, down: 0, upCount: 2, downCount: 0 });
  expect(m!.get(41302)).toEqual({ up: 1.25, down: 2, upCount: 1, downCount: 1 });
});

test('bounty pairs: token filter hits the per-token route and lowercases', async () => {
  const base = configureIndexer();
  const fn = mockFetch([READY, {
    match: '/bounties/pairs/0xdef',
    body: [{ gameId: 4, token: '0xDEF0000000000000000000000000000000000001' }],
  }]);
  const pairs = await indexerBountyPairs('0xDEF0000000000000000000000000000000000001');
  expect(pairs).toEqual([{ gameId: 4, token: '0xdef0000000000000000000000000000000000001' }]);
  expect(fn).toHaveBeenCalledWith(
    `${base}/bounties/pairs/0xdef0000000000000000000000000000000000001`,
    expect.anything(),
  );
});

test('referrals: exact wei total arrives as BigInt', async () => {
  configureIndexer();
  mockFetch([READY, {
    match: '/referrals/',
    body: { totalWei: '14516508008553249337', events: [{}, {}, {}] },
  }]);
  expect(await indexerReferrals('0x' + '3'.repeat(40))).toEqual({
    total: BigInt('14516508008553249337'),
    count: 3,
  });
});

// --- deployment gate and the read-model fetchers -------------------------

const ADDR = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'));
const mine = getAddresses(DEFAULT_CHAIN_ID);

test('refuses an indexer on another chain or another deployment of this one', async () => {
  configureIndexer();
  mockFetch([{ match: '/status', body: { syncing: false, chainId: DEFAULT_CHAIN_ID + 1 } }, { match: '/games', body: [] }]);
  expect(await indexerGames()).toBeNull();

  configureIndexer();
  mockFetch([
    { match: '/status', body: { syncing: false, chainId: DEFAULT_CHAIN_ID, addresses: { token: ADDR(0xdead), engine: mine.engine.toLowerCase() } } },
    { match: '/games', body: [] },
  ]);
  expect(await indexerGames()).toBeNull();

  configureIndexer();
  mockFetch([
    { match: '/status', body: { syncing: false, chainId: DEFAULT_CHAIN_ID, addresses: { token: mine.token.toLowerCase(), engine: mine.engine.toLowerCase() } } },
    { match: '/games', body: [] },
  ]);
  expect(await indexerGames()).toEqual([]);
});

test('indexerGames shapes rows: current authority checksummed, default binary flagged, dust bar kept', async () => {
  configureIndexer();
  mockFetch([READY, { match: '/games', body: [
    { gameId: 1, streamId: 1, gameTypeId: 0, targetMinutes: 1440, gameConfig: '0x', name: 'BTC', authority: ADDR(0xabc).toLowerCase(),
      creator: ADDR(0xdef), isDefaultBinary: true, dustThreshold: 3, dustBar: 3 },
    { gameId: 2, streamId: 1, gameTypeId: 1, targetMinutes: 60, gameConfig: '0x01', name: 'BTC hourly', authority: ADDR(0xabc),
      creator: ADDR(0xabc), isDefaultBinary: false, dustThreshold: 0, dustBar: null },
  ] }]);
  const g = await indexerGames();
  expect(g).toEqual([
    { gameId: 1, streamId: 1, gameTypeId: 0, targetMinutes: 1440, gameConfig: '0x', name: 'BTC', authority: ADDR(0xabc), isDefaultBinary: true, dustBar: 3 },
    { gameId: 2, streamId: 1, gameTypeId: 1, targetMinutes: 60, gameConfig: '0x01', name: 'BTC hourly', authority: ADDR(0xabc), isDefaultBinary: false, dustBar: null },
  ]);
});

test('indexerStreams shapes rows and rejects a malformed one', async () => {
  configureIndexer();
  mockFetch([READY, { match: '/streams', body: [
    { streamId: 3, name: 'ETH', streamType: 1, adapterId: 2, minCadenceMinutes: 60, config: '0x00', nameKey: null,
      creator: ADDR(1), provider: ADDR(2), lastValue: '-5', lastHour: 10, valueCount: 1, named: false },
  ] }]);
  expect(await indexerStreams()).toEqual([
    { streamId: 3, name: 'ETH', streamType: 1, adapterId: 2, minCadenceMinutes: 60, config: '0x00', nameKey: null,
      creator: ADDR(1), provider: ADDR(2), named: false, lastValue: -BigInt(5), lastHour: 10 },
  ]);

  configureIndexer();
  mockFetch([READY, { match: '/streams', body: [{ streamId: 'x' }] }]);
  expect(await indexerStreams()).toBeNull();
});

test('indexerBountyPairs carries the pool, the scaled rate, liveness and cleanedAfter', async () => {
  configureIndexer();
  mockFetch([READY, { match: '/bounties/pairs', body: [
    { gameId: 5, token: ADDR(9), cleanedAfter: 0, poolWei: '400', rateScaled: '100', live: true },
  ] }]);
  expect(await indexerBountyPairs()).toEqual([
    { gameId: 5, token: ADDR(9).toLowerCase(), cleanedAfter: 0, pool: BigInt(400), rateScaled: BigInt(100), live: true },
  ]);
});

test('indexerDelegation maps an absent delegate to null and the inbound power to bigint', async () => {
  configureIndexer();
  mockFetch([READY, { match: '/delegation/', body: { delegate: ADDR(7).toLowerCase(), activationRound: 12, inboundPowerWei: '32' } }]);
  expect(await indexerDelegation(ADDR(1))).toEqual({ delegate: ADDR(7), activationRound: 12, inboundPower: BigInt(32) });

  configureIndexer();
  mockFetch([READY, { match: '/delegation/', body: { delegate: null, activationRound: null, inboundPowerWei: '0' } }]);
  expect(await indexerDelegation(ADDR(1))).toEqual({ delegate: null, activationRound: null, inboundPower: BigInt(0) });
});

test('indexerRoundBudget is null for a round nothing has touched yet, so the caller computes it', async () => {
  configureIndexer();
  mockFetch([READY, { match: '/rounds/7/budget', body: { round: 7, budgetWei: '719', frozenAtBlock: 3 } }]);
  expect(await indexerRoundBudget(7)).toBe(BigInt(719));

  configureIndexer();
  mockFetch([READY, { match: '/rounds/8/budget', body: { round: 8, budgetWei: null, frozenAtBlock: null } }]);
  expect(await indexerRoundBudget(8)).toBeNull();
});
