import { useCallback, useEffect, useRef, useState } from 'react';
import { ChainCache, Policy } from '../lib/chainCache';
import { DEFAULT_CHAIN_ID, getChainConfig } from '../contracts/addresses';

// The persisted cache is namespaced by chainId AND the token address, not the
// chainId alone. `immutable` entries (deploymentRound, PLATFORM_FEE_RECIPIENT,
// the round-relative burn base…) are immutable only *within one deployment*. On
// testnet the token is REDEPLOYED on the same chainId, which silently changed
// their meaning — a stale deploymentRound made "Current Round" read days off for
// every returning visitor until they cleared site data. Folding the token
// address into the namespace makes a redeploy a cache miss automatically, so the
// values re-read from the new contracts with nothing to remember. (The game
// wallet keystore is stored under its own key, not here, so it survives.)
const deploymentTag = (() => {
  try { return getChainConfig(DEFAULT_CHAIN_ID).token ?? ''; } catch { return ''; }
})();

// One cache for the app. Module scope rather than context on purpose: the point
// is that two components asking the same question share an answer, and a
// per-subtree provider would quietly reintroduce the duplication.
export const chainCache = new ChainCache({
  persist: typeof window !== 'undefined' ? window.localStorage : undefined,
  namespace: `${DEFAULT_CHAIN_ID}:${deploymentTag}`,
});

/// Refetch every round-scoped entry when the round actually turns over.
///
/// One timer for the whole app, scheduled to the exact boundary rather than
/// polling for it — the round is `block.timestamp / 86400`, so the next change
/// is arithmetic. Reschedules itself; nothing here fires every 2 seconds.
if (typeof window !== 'undefined') {
  const scheduleRoundRollover = () => {
    window.setTimeout(() => {
      chainCache.invalidateAll();
      scheduleRoundRollover();
    }, chainCache.msUntilRoundChange());
  };
  scheduleRoundRollover();
}

export interface ChainRead<T> {
  data: T | undefined;
  loading: boolean;
  error: Error | null;
  /// Bypass freshness and fetch now. This is the user-initiated path the owner
  /// asked for: if someone presses refresh, they get a real answer.
  refresh: () => Promise<void>;
}

/// Read one contract value through the cache, sharing it with every other
/// component that wants the same thing.
///
/// `enabled: false` holds off until dependencies exist (a wallet address, a
/// resolved round) instead of firing a call with undefined arguments.
export function useChainRead<T>(
  key: string | null,
  policy: Policy,
  fetcher: () => Promise<T>,
  opts: { enabled?: boolean } = {},
): ChainRead<T> {
  const enabled = opts.enabled !== false && key !== null;
  const [, forceRender] = useState(0);
  const [state, setState] = useState<{ data?: T; loading: boolean; error: Error | null }>(
    { data: key ? chainCache.peek<T>(key) : undefined, loading: false, error: null },
  );

  // The fetcher is a fresh closure every render; holding it in a ref keeps it
  // out of the effect's dependencies so a parent re-render cannot restart a
  // request that is already in flight.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async (force: boolean) => {
    if (!key || !enabled) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const v = await chainCache.read<T>(key, policy, () => fetcherRef.current(), { force });
      setState({ data: v, loading: false, error: null });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e as Error }));
    }
    // policy is a literal at every call site; including it would compare by
    // reference and re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  useEffect(() => {
    if (!key || !enabled) return;
    // Another component (or a tx invalidation) changed this entry — re-read,
    // which is a no-op against the cache when the value is still fresh.
    const off = chainCache.subscribe(key, () => {
      const cached = chainCache.peek<T>(key);
      if (cached !== undefined) setState({ data: cached, loading: false, error: null });
      else { forceRender((n) => n + 1); run(false); }
    });
    run(false);
    return off;
  }, [key, enabled, run]);

  const refresh = useCallback(() => run(true), [run]);
  return { data: state.data, loading: state.loading, error: state.error, refresh };
}
