// A keyed cache whose staleness rules come from the contracts.
//
// The policy lives in docs/design/dapp-cache-invalidation-map.md, derived by
// asking of every read: what has to happen before this answer can change?
// Not "how long is it probably good for" — that is a guess wearing a policy's
// clothes, and for chain data the real trigger is knowable.
//
// Four things this does, in the order they matter:
//   1. one entry per key, so N components asking the same question cost one call
//   2. staleness decided per class, not by one global TTL
//   3. in-flight sharing, so a burst on cold load collapses to one request
//   4. explicit refresh that bypasses everything, because the owner asked for it
//
// It is deliberately NOT a general query library. The whole value here is the
// map, and the map does not transfer to a library any more cheaply than it
// transfers to this file.

import { currentRound, msUntilNextRound } from './round';

/// How a value goes stale. See the map for which read is which.
export type Policy =
  /// Class 1 — nothing can change it. Fetch once per chain, ever.
  | { class: 'immutable' }
  /// Class 2 — frozen within a round; changes only at the boundary.
  | { class: 'round' }
  /// Class 4/5 — someone else can move it. `ms` defaults to the owner's 30s.
  | { class: 'live'; ms?: number };

/// Class 3 has exactly two members (voteDelegation, referral), so it is not a
/// policy — it is `invalidate(key)` on a tx receipt. Everything else that looks
/// like "my data" is `live`, because a stranger can move it: an inbound
/// transfer resyncs delegation, a lender accepts my bounty, my delegate's vote
/// becomes my effective vote. That was the surprise of the derivation.
export const LIVE_MS = 30_000;

interface Entry {
  value?: unknown;
  /// Round the value was fetched in — the epoch for `round` policies.
  round?: number;
  at?: number;
  inflight?: Promise<unknown>;
  subs: Set<() => void>;
}

export interface CacheOptions {
  /// Injected so tests do not depend on the wall clock.
  now?: () => number;
  /// Where `immutable` entries survive a reload. Omit to keep them in memory.
  persist?: Pick<Storage, 'getItem' | 'setItem'>;
  /// Namespaces persisted keys. Pass the chainId — an immutable value is
  /// immutable *per chain*, and reusing Base Sepolia's answer on mainnet would
  /// be a silent, permanent lie.
  namespace?: string | number;
}

/// Persisted-key schema version, part of the storage namespace alongside the
/// chainId. "Immutable" means immutable *per deployment schema*: the 24h
/// redeploy reused the same chainId but changed what the stored numbers MEAN
/// (deploymentRound and every round-class figure halved when rounds went
/// 12h -> 24h), so v1-era entries must be unreachable, not reinterpreted.
/// Bump on any redeploy that changes the meaning of persisted values.
const SCHEMA_VERSION = 'v2';

export class ChainCache {
  private entries = new Map<string, Entry>();
  private policies = new Map<string, Policy>();
  private now: () => number;
  private persist?: Pick<Storage, 'getItem' | 'setItem'>;
  private ns: string;

  constructor(opts: CacheOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.persist = opts.persist;
    this.ns = `satori-cache:${SCHEMA_VERSION}:${opts.namespace ?? 'default'}:`;
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { subs: new Set() };
      this.entries.set(key, e);
    }
    return e;
  }

  /// Is the cached answer still good? The only place a class becomes a decision.
  private fresh(key: string, e: Entry): boolean {
    if (e.at === undefined) return false;
    const p = this.policies.get(key) ?? { class: 'live' as const };
    switch (p.class) {
      case 'immutable':
        return true;
      case 'round':
        // Not a TTL. The value is valid for exactly as long as the round it was
        // read in is the current round — which we know from the clock, because
        // getCurrentRound() is block.timestamp / 86400 and nothing else.
        return e.round === currentRound(this.now());
      case 'live':
        return this.now() - e.at < (p.ms ?? LIVE_MS);
    }
  }

  /// Read through the cache. Concurrent callers for the same key share one
  /// request; a `force` read bypasses freshness but still shares in flight, so
  /// mashing refresh cannot stampede the RPC.
  async read<T>(
    key: string,
    policy: Policy,
    fetcher: () => Promise<T>,
    opts: { force?: boolean } = {},
  ): Promise<T> {
    this.policies.set(key, policy);
    const e = this.entry(key);

    if (!opts.force && this.fresh(key, e)) return e.value as T;
    if (e.inflight) return e.inflight as Promise<T>;

    if (policy.class === 'immutable' && !opts.force && e.at === undefined) {
      const stored = this.readPersisted<T>(key);
      if (stored !== undefined) {
        e.value = stored;
        e.at = this.now();
        return stored;
      }
    }

    const p = (async () => {
      try {
        const v = await fetcher();
        e.value = v;
        e.at = this.now();
        e.round = currentRound(this.now());
        if (policy.class === 'immutable') this.writePersisted(key, v);
        return v;
      } finally {
        // Cleared whichever way it settles: a failure must not poison the key,
        // and the next caller has to be able to try again.
        e.inflight = undefined;
      }
    })();

    e.inflight = p;
    p.then(() => this.notify(e), () => { /* errors reach the caller */ });
    return p;
  }

  /// Drop an entry so the next read refetches. This is the Class 3 mechanism
  /// (a tx from this wallet landed) and also the honest response to any write:
  /// my own action is the most likely reason a value changed, it is simply
  /// never the only one.
  invalidate(keyOrPrefix: string, { prefix = false } = {}): void {
    // forEach rather than for..of: the build targets es5, where iterating a Map
    // needs downlevelIteration.
    this.entries.forEach((e, k) => {
      if (prefix ? k.startsWith(keyOrPrefix) : k === keyOrPrefix) {
        e.at = undefined;
        e.value = undefined;
        e.round = undefined;
        this.notify(e);
      }
    });
  }

  /// Everything a transaction could plausibly have touched. Deliberately blunt:
  /// after a write, correctness beats saving a few reads.
  invalidateAll(): void {
    this.entries.forEach((e, k) => {
      if (this.policies.get(k)?.class === 'immutable') return; // cannot have changed
      e.at = undefined;
      e.value = undefined;
      e.round = undefined;
      this.notify(e);
    });
  }

  /// Subscribe to changes for a key. Returns an unsubscribe.
  subscribe(key: string, fn: () => void): () => void {
    const e = this.entry(key);
    e.subs.add(fn);
    return () => { e.subs.delete(fn); };
  }

  /// Cached value without fetching, if one is fresh.
  peek<T>(key: string): T | undefined {
    const e = this.entries.get(key);
    if (!e || !this.fresh(key, e)) return undefined;
    return e.value as T;
  }

  /// Synchronous read of an `immutable` value, INCLUDING one that only exists in
  /// persisted storage.
  ///
  /// `peek` deliberately cannot do this: it answers "is there a fresh in-memory
  /// entry", and on a cold page load the answer is always no, because the map
  /// starts empty however much is sitting in localStorage. That gap is why the
  /// dashboard printed the raw chain round (41373) on load and corrected itself
  /// to 1 once an async read landed — the right answer was already on disk and
  /// nothing could reach it before first paint.
  ///
  /// Safe without a freshness check precisely because the value is immutable:
  /// nothing can change it, and the key is chain-namespaced, so a stale answer
  /// is not a possible outcome. Only ever call this for `class: 'immutable'`
  /// keys.
  peekImmutable<T>(key: string): T | undefined {
    const inMemory = this.entries.get(key);
    if (inMemory && inMemory.value !== undefined) return inMemory.value as T;
    return this.readPersisted<T>(key);
  }

  /// ms until the current round ends — when `round` entries become stale.
  /// Exact and known in advance, so a single app-wide timer replaces polling.
  msUntilRoundChange(): number {
    return msUntilNextRound(this.now());
  }

  private notify(e: Entry) {
    e.subs.forEach((fn) => { try { fn(); } catch { /* a bad subscriber is not the cache's problem */ } });
  }

  private readPersisted<T>(key: string): T | undefined {
    if (!this.persist) return undefined;
    try {
      const raw = this.persist.getItem(this.ns + key);
      if (raw == null) return undefined;
      return deserialize(raw) as T;
    } catch {
      return undefined;
    }
  }

  private writePersisted(key: string, value: unknown) {
    if (!this.persist) return;
    try {
      this.persist.setItem(this.ns + key, serialize(value));
    } catch {
      // A full or disabled localStorage must never break a read.
    }
  }
}

// bigint is most of what comes back from ethers and JSON.stringify throws on it
// outright, so persisted values carry an explicit tag rather than being coerced
// to Number — which would silently lose precision on any wei-denominated value.
function serialize(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    typeof val === 'bigint' ? { __bigint: val.toString() } : val);
}

function deserialize(raw: string): unknown {
  return JSON.parse(raw, (_k, val) =>
    val && typeof val === 'object' && typeof val.__bigint === 'string'
      ? BigInt(val.__bigint)
      : val);
}

/// Build a cache key. Arguments are part of the identity — `gameWeight(1)` and
/// `gameWeight(2)` are different questions — and bigint/address casing are
/// normalised so two spellings of the same call do not become two entries.
export function cacheKey(contract: string, method: string, args: unknown[] = []): string {
  const norm = args.map((a) => {
    if (typeof a === 'bigint') return a.toString();
    if (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) return a.toLowerCase();
    return String(a);
  });
  return norm.length ? `${contract}.${method}(${norm.join(',')})` : `${contract}.${method}`;
}
