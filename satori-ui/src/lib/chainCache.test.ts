import { ChainCache, cacheKey, LIVE_MS } from './chainCache';
import { TIME_UNIT_SECONDS } from './round';

// Cache invalidation is where the subtle bugs live, so every rule in the map
// gets a test that fails if the rule is wrong in EITHER direction: serving a
// stale answer, or refetching one that could not have changed.

/// Controllable clock, so nothing here depends on wall-clock timing.
function clock(startMs: number) {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/// A start time sitting comfortably inside a round rather than near a boundary.
const ROUND_MS = TIME_UNIT_SECONDS * 1000;
const MID_ROUND = ROUND_MS * 41337 + ROUND_MS / 2;

function counted<T>(value: T) {
  let calls = 0;
  return { fn: async () => { calls++; return value; }, calls: () => calls };
}

describe('policy: immutable', () => {
  it('fetches once and never again', async () => {
    const c = clock(MID_ROUND);
    const cache = new ChainCache({ now: c.now });
    const f = counted('0xdeploymentBlock');

    await cache.read('k', { class: 'immutable' }, f.fn);
    c.advance(ROUND_MS * 10);            // ten rounds later
    await cache.read('k', { class: 'immutable' }, f.fn);

    expect(f.calls()).toBe(1);
  });

  it('survives a reload via persistence, including bigint', async () => {
    // deploymentBlock and PLATFORM_FEE_RECIPIENT should cost one fetch per
    // browser per chain, not one per session.
    const store = new Map<string, string>();
    const persist = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    const f = counted(BigInt('44928212'));

    const first = new ChainCache({ now: () => MID_ROUND, persist, namespace: 84532 });
    expect(await first.read('block', { class: 'immutable' }, f.fn)).toBe(BigInt('44928212'));

    // A fresh cache, as after a page reload.
    const second = new ChainCache({ now: () => MID_ROUND, persist, namespace: 84532 });
    const got = await second.read('block', { class: 'immutable' }, f.fn);

    expect(got).toBe(BigInt('44928212'));   // bigint, not 44928212 as a Number
    expect(typeof got).toBe('bigint');
    expect(f.calls()).toBe(1);              // the reload cost nothing
  });

  it('does NOT share persisted values across chains', async () => {
    // The failure this prevents is permanent and silent: Base Sepolia's
    // deploymentBlock served on mainnet, forever, with no way to notice.
    const store = new Map<string, string>();
    const persist = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    const sepolia = new ChainCache({ now: () => MID_ROUND, persist, namespace: 84532 });
    const mainnet = new ChainCache({ now: () => MID_ROUND, persist, namespace: 8453 });

    await sepolia.read('block', { class: 'immutable' }, async () => 'sepolia-value');
    const onMainnet = await mainnet.read('block', { class: 'immutable' }, async () => 'mainnet-value');

    expect(onMainnet).toBe('mainnet-value');
  });

  it('cannot see values persisted under the pre-24h key schema', async () => {
    // The 24h redeploy reused the SAME chainId, so chain-namespacing alone
    // would happily serve a 12h-era deploymentRound (double today's numbers)
    // forever. The schema version in the namespace orphans those entries.
    const store = new Map<string, string>();
    const persist = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
    // What the v1 cache wrote: no schema segment in the key.
    store.set('satori-cache:84532:satori.deploymentRound', JSON.stringify(41373));

    const cache = new ChainCache({ now: () => MID_ROUND, persist, namespace: 84532 });
    const got = await cache.read('satori.deploymentRound', { class: 'immutable' }, async () => 20687);

    expect(got).toBe(20687);                 // fetched fresh, not the 12h-era value
    // And the fresh value went under a versioned key, leaving the orphan alone.
    expect(store.get('satori-cache:84532:satori.deploymentRound')).toBe(JSON.stringify(41373));
  });
});

describe('policy: round', () => {
  it('holds for the whole 24h round, then refetches exactly once at the boundary', async () => {
    const c = clock(MID_ROUND);
    const cache = new ChainCache({ now: c.now });
    const f = counted('frozen-snapshot');

    // Starting at the midpoint, so two eighths of a round stays inside it.
    // (An earlier draft advanced by quarters and landed exactly ON the
    // boundary, then blamed the cache for refetching. It was right to.)
    await cache.read('k', { class: 'round' }, f.fn);
    c.advance(ROUND_MS / 8);
    await cache.read('k', { class: 'round' }, f.fn);
    c.advance(ROUND_MS / 8);
    await cache.read('k', { class: 'round' }, f.fn);
    expect(f.calls()).toBe(1);            // nothing could have changed it

    c.advance(ROUND_MS);                  // over the boundary
    await cache.read('k', { class: 'round' }, f.fn);
    expect(f.calls()).toBe(2);
  });

  it('is keyed on the ROUND, not on elapsed time', async () => {
    // The distinction that makes this better than a 24h TTL. A value read one
    // minute before the boundary is stale one minute later, NOT a full day
    // later. A TTL cannot express that and would serve the previous round's
    // eligible set for almost a whole round.
    const c = clock(ROUND_MS * 41337 + ROUND_MS - 60_000);   // 1 min before rollover
    const cache = new ChainCache({ now: c.now });
    const f = counted('x');

    await cache.read('k', { class: 'round' }, f.fn);
    c.advance(120_000);                   // 2 min later — new round
    await cache.read('k', { class: 'round' }, f.fn);

    expect(f.calls()).toBe(2);
  });

  it('reports the exact time until the round changes', () => {
    const cache = new ChainCache({ now: () => ROUND_MS * 41337 + ROUND_MS - 5_000 });
    // 5s of round left, plus the grace period that keeps a refresh from racing
    // a block whose timestamp has not crossed yet.
    expect(cache.msUntilRoundChange()).toBe(20_000);
  });
});

describe('policy: live', () => {
  it('serves within 30s and refetches after', async () => {
    const c = clock(MID_ROUND);
    const cache = new ChainCache({ now: c.now });
    const f = counted(42);

    await cache.read('k', { class: 'live' }, f.fn);
    c.advance(LIVE_MS - 1);
    await cache.read('k', { class: 'live' }, f.fn);
    expect(f.calls()).toBe(1);

    c.advance(2);
    await cache.read('k', { class: 'live' }, f.fn);
    expect(f.calls()).toBe(2);
  });

  it('an explicit refresh bypasses freshness immediately', async () => {
    // The owner's rule: if the user asks, they get a real answer, not a cached
    // one. Otherwise "refresh" becomes a button that appears to do nothing.
    const c = clock(MID_ROUND);
    const cache = new ChainCache({ now: c.now });
    const f = counted('v');

    await cache.read('k', { class: 'live' }, f.fn);
    await cache.read('k', { class: 'live' }, f.fn, { force: true });

    expect(f.calls()).toBe(2);
  });
});

describe('sharing and failure', () => {
  it('collapses a concurrent burst into ONE request', async () => {
    // The cold-load case: a dozen hooks mount together and all want the round.
    let calls = 0;
    let release: (v: unknown) => void = () => {};
    const cache = new ChainCache({ now: () => MID_ROUND });
    const slow = () => { calls++; return new Promise((r) => { release = r; }); };

    const all = Promise.all([1, 2, 3, 4, 5].map(() =>
      cache.read('k', { class: 'live' }, slow)));
    expect(calls).toBe(1);

    release('shared');
    expect(await all).toEqual(['shared', 'shared', 'shared', 'shared', 'shared']);
  });

  it('shares in flight even when forced, so mashing refresh cannot stampede', async () => {
    let calls = 0;
    let release: (v: unknown) => void = () => {};
    const cache = new ChainCache({ now: () => MID_ROUND });
    const slow = () => { calls++; return new Promise((r) => { release = r; }); };

    const a = cache.read('k', { class: 'live' }, slow, { force: true });
    const b = cache.read('k', { class: 'live' }, slow, { force: true });
    const c = cache.read('k', { class: 'live' }, slow, { force: true });
    expect(calls).toBe(1);

    release('one');
    expect(await Promise.all([a, b, c])).toEqual(['one', 'one', 'one']);
  });

  it('a failure reaches every caller and does not poison the key', async () => {
    const cache = new ChainCache({ now: () => MID_ROUND });
    let n = 0;
    const boom = () => { n++; return Promise.reject(new Error('rate limited')); };

    await expect(cache.read('k', { class: 'live' }, boom)).rejects.toThrow('rate limited');
    // A cached rejection would wedge the dapp for 30s on one unlucky call.
    await expect(cache.read('k', { class: 'live' }, boom)).rejects.toThrow('rate limited');
    expect(n).toBe(2);
  });

  it('never serves a value from a failed fetch', async () => {
    const cache = new ChainCache({ now: () => MID_ROUND });
    await cache.read('k', { class: 'live' }, async () => 'good');
    await expect(cache.read('k', { class: 'live' }, async () => { throw new Error('x'); },
      { force: true })).rejects.toThrow('x');
    // The previous good value is still there and still correct to serve.
    expect(cache.peek('k')).toBe('good');
  });
});

describe('invalidation', () => {
  it('invalidate() forces the next read to refetch', async () => {
    const cache = new ChainCache({ now: () => MID_ROUND });
    const f = counted('v');
    await cache.read('k', { class: 'round' }, f.fn);
    cache.invalidate('k');
    await cache.read('k', { class: 'round' }, f.fn);
    expect(f.calls()).toBe(2);
  });

  it('invalidates by prefix', async () => {
    const cache = new ChainCache({ now: () => MID_ROUND });
    const a = counted('a'); const b = counted('b');
    await cache.read('voting.gameWeight(1)', { class: 'live' }, a.fn);
    await cache.read('token.balanceOf(0x1)', { class: 'live' }, b.fn);

    cache.invalidate('voting.', { prefix: true });

    await cache.read('voting.gameWeight(1)', { class: 'live' }, a.fn);
    await cache.read('token.balanceOf(0x1)', { class: 'live' }, b.fn);
    expect(a.calls()).toBe(2);
    expect(b.calls()).toBe(1);
  });

  it('invalidateAll() spares immutables, because a tx cannot change them', async () => {
    const cache = new ChainCache({ now: () => MID_ROUND });
    const imm = counted('0xfee'); const live = counted(1);
    await cache.read('PLATFORM_FEE_RECIPIENT', { class: 'immutable' }, imm.fn);
    await cache.read('gameWeight', { class: 'live' }, live.fn);

    cache.invalidateAll();

    await cache.read('PLATFORM_FEE_RECIPIENT', { class: 'immutable' }, imm.fn);
    await cache.read('gameWeight', { class: 'live' }, live.fn);
    expect(imm.calls()).toBe(1);
    expect(live.calls()).toBe(2);
  });

  it('notifies subscribers on invalidation', async () => {
    const cache = new ChainCache({ now: () => MID_ROUND });
    let hits = 0;
    const off = cache.subscribe('k', () => { hits++; });
    await cache.read('k', { class: 'live' }, async () => 1);
    expect(hits).toBe(1);                 // fetch resolved
    cache.invalidate('k');
    expect(hits).toBe(2);
    off();
    cache.invalidate('k');
    expect(hits).toBe(2);                 // unsubscribed
  });
});

describe('cacheKey', () => {
  it('separates different arguments', () => {
    expect(cacheKey('voting', 'gameWeight', [1]))
      .not.toBe(cacheKey('voting', 'gameWeight', [2]));
  });

  it('treats bigint and number arguments as the same question', () => {
    expect(cacheKey('voting', 'getGameVotesAtRound', [1, BigInt(41335)]))
      .toBe(cacheKey('voting', 'getGameVotesAtRound', [1, 41335]));
  });

  it('normalises address casing', () => {
    // Checksummed from one call site, lowercase from another, one entry.
    expect(cacheKey('rewards', 'referral', ['0xAbC0000000000000000000000000000000000123']))
      .toBe(cacheKey('rewards', 'referral', ['0xabc0000000000000000000000000000000000123']));
  });

  it('does not collide across contracts', () => {
    expect(cacheKey('voting', 'admin')).not.toBe(cacheKey('rewards', 'admin'));
  });
});
