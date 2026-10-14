import { ethers } from 'ethers';

// Resilient JSON-RPC provider with multi-URL failover.
//
// Pattern: keep a "current" provider index. Each send() tries the current
// provider first; on transient failure (network/server/timeout), advances to
// the next URL and retries. On success from a different URL, that URL becomes
// the new current. So a single dead RPC doesn't slow every call — only the
// failing call pays the penalty, and only once per outage.
//
// Non-transient errors (revert, invalid params, decoding) propagate immediately
// — those aren't infrastructure problems and trying another RPC won't help.
//
// Per-URL retry within a single attempt is also applied for transient errors,
// so a one-off blip on the active URL doesn't trigger a full failover.

const PER_URL_RETRIES = 2;
const PER_URL_RETRY_DELAY_MS = 500;

// Chain-health signal. Every resilient provider in the app shares this state:
// any successful RPC call flips it true, any "all URLs exhausted" event flips
// it false. Non-transient errors (revert, decode, invalid params) don't touch
// it — those aren't infrastructure problems. Subscribers (a banner, telemetry)
// react to transitions; subscribing also pushes the current state immediately.
type HealthListener = (reachable: boolean) => void;
const healthListeners = new Set<HealthListener>();
let chainReachable = true;

export function onChainHealth(fn: HealthListener): () => void {
  healthListeners.add(fn);
  fn(chainReachable);
  return () => { healthListeners.delete(fn); };
}

function setReachable(r: boolean) {
  if (r === chainReachable) return;
  chainReachable = r;
  healthListeners.forEach((fn) => { try { fn(r); } catch { /* swallow */ } });
}

// Exported for test/rpcProvider.test.ts. The distinction it draws — transport
// failure versus contract revert — decides whether a call is retried or is
// surfaced to the user as an error, so it is worth pinning directly rather than
// through the provider.
export function isTransient(e: any): boolean {
  if (!e) return false;
  return (
    e.code === 'NETWORK_ERROR' ||
    e.code === 'SERVER_ERROR' ||
    e.code === 'TIMEOUT' ||
    e.code === -32603 || // generic JSON-RPC internal
    e.message?.includes('Failed to fetch') ||
    e.message?.includes('ETIMEDOUT') ||
    e.message?.includes('ECONNREFUSED') ||
    e.message?.includes('ECONNRESET') ||
    e.message?.includes('rate limit') ||
    e.message?.includes('429') ||
    // A rate-limited or otherwise body-less eth_call reaches us as a
    // CALL_EXCEPTION, NOT as anything rate-shaped. When the provider answers 429
    // there is no JSON-RPC result to decode, so ethers raises "missing revert
    // data" from getBuiltinCallException — code CALL_EXCEPTION, and none of the
    // checks above match, so we neither retried nor failed over. That is how a
    // throttled public endpoint left the dapp on "Loading streams..." forever
    // against a chain whose data was perfectly fine.
    //
    // A GENUINE revert is distinguishable: it carries `data` ("0x" at minimum,
    // for a bare `revert()`) or a decoded `reason`. Null on both means nothing
    // came back at all, which is transport, not contract.
    (e.code === 'CALL_EXCEPTION' && e.data == null && e.reason == null)
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How many requests this provider will have in flight at once. Everything past
// this waits its turn.
//
// A cold page load starts a dozen hooks simultaneously, each firing several
// reads, and a public RPC answers some and drops the rest. Retrying does not
// help much when the retry rejoins the same stampede — which is exactly what was
// observed: three retries all lost, while pressing the button a second later
// worked first time because nothing was competing with it.
//
// Six is chosen to be well inside what public endpoints tolerate while still
// being wide enough that a full dashboard load feels immediate. Note the queue
// costs nothing when traffic is below the cap, which is the steady state — it
// only engages during the opening burst, which is the only time it is needed.
const MAX_IN_FLIGHT = 6;

/// Gate a send function so no more than `limit` calls are outstanding.
/// Order-preserving, and it never drops anything — a queued call is late, not
/// lost, which is the entire distinction being bought here.
export function withConcurrencyLimit(
  send: (method: string, params: any[]) => Promise<any>,
  limit = MAX_IN_FLIGHT,
): (method: string, params: any[]) => Promise<any> {
  let active = 0;
  const queue: (() => void)[] = [];

  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return (method: string, params: any[]) => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      send(method, params).then(
        (v) => { release(); resolve(v); },
        (e) => { release(); reject(e); },
      );
    };
    if (active < limit) run();
    else queue.push(run);
  });
}

// Methods safe to coalesce. Read-only and idempotent: asking twice at the same
// instant cannot mean anything different from asking once. Deliberately an
// ALLOWLIST — anything that sends, signs, or advances nonces must never be
// deduped, and a denylist would silently include the next method ethers adds.
const DEDUPABLE = new Set([
  'eth_call',
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'net_version',
]);

/// Collapse identical reads that are IN FLIGHT AT THE SAME MOMENT into one
/// request. Not a cache: the entry is dropped the instant the call settles, so
/// nothing is ever served from a previous block. The only thing this removes is
/// the same question being asked twice before either answer has come back.
///
/// Why here rather than at the call sites: `getCurrentRound()` alone is wanted by
/// seven places across five hooks, none of which knows the others exist, and they
/// mount together. Fixing that by threading one shared value through them fixes
/// exactly that one value, and the next widget to want the round re-adds the
/// problem. Coalescing at the transport fixes every caller, including the ones
/// nobody has written yet.
///
/// Measured on a production build against Base Sepolia: 13 calls in the opening
/// batch, 12 of them unique. See docs/issues/dapp-rpc-call-budget-measured.md.
export function withInFlightDedupe(
  send: (method: string, params: any[]) => Promise<any>
): (method: string, params: any[]) => Promise<any> {
  const inFlight = new Map<string, Promise<any>>();
  return (method: string, params: any[]) => {
    if (!DEDUPABLE.has(method)) return send(method, params);

    const key = `${method}|${JSON.stringify(params)}`;
    const existing = inFlight.get(key);
    if (existing) return existing;

    const p = send(method, params);
    // Drop the entry whichever way it settles. Both handlers are supplied so the
    // derived promise is never an unhandled rejection; `p` itself is returned to
    // every caller untouched, so a failure still reaches all of them.
    const done = () => inFlight.delete(key);
    p.then(done, done);
    inFlight.set(key, p);
    return p;
  };
}

export function createResilientProvider(urls: string | string[]): ethers.JsonRpcProvider {
  const urlList = Array.isArray(urls) ? urls.filter(Boolean) : [urls];
  if (urlList.length === 0) throw new Error('createResilientProvider: at least one URL required');

  // Build a provider per URL up-front so we don't reconstruct on every call.
  const providers = urlList.map((u) => {
    const p = new ethers.JsonRpcProvider(u);
    // Review #22: this was `0`, believing it disabled polling. In ethers v6 a
    // 0 interval is legal and means "reschedule the block poll on the next
    // event-loop tick" — continuous back-to-back eth_blockNumber spam whenever
    // ANY event subscription is live (StreamsTab keeps a bounties `.on()`
    // listener mounted). Polling only runs while a subscription exists, so a
    // relaxed positive interval keeps that auto-refresh working at a tiny
    // fraction of the load.
    p.pollingInterval = 12_000;
    return p;
  });

  // Single-URL fast path: just return the provider with retries layered on.
  // Multi-URL path: override `send` on the first provider to do failover.
  const primary = providers[0];
  if (urlList.length === 1) {
    return wrapWithRetries(primary);
  }

  let activeIdx = 0;
  const originalSends = providers.map((p) => p.send.bind(p));

  const failoverSend = async (method: string, params: any[]): Promise<any> => {
    let lastErr: any;
    // Try every URL once, starting with the active one. Sticky on success.
    for (let i = 0; i < providers.length; i++) {
      const idx = (activeIdx + i) % providers.length;

      // Per-URL retries for one-off transient blips.
      for (let attempt = 0; attempt <= PER_URL_RETRIES; attempt++) {
        try {
          const result = await originalSends[idx](method, params);
          if (idx !== activeIdx) {
            // eslint-disable-next-line no-console
            console.warn(`[rpc] failover: ${urlList[activeIdx]} -> ${urlList[idx]}`);
            activeIdx = idx;
          }
          setReachable(true);
          return result;
        } catch (e: any) {
          lastErr = e;
          if (!isTransient(e)) throw e; // bubble revert/decode errors immediately
          if (attempt < PER_URL_RETRIES) {
            await sleep(PER_URL_RETRY_DELAY_MS * (attempt + 1));
          }
        }
      }
      // This URL exhausted retries; try the next one.
    }
    setReachable(false);
    throw lastErr ?? new Error('All RPC providers failed');
  };

  // Dedupe OUTSIDE failover and retries, so a duplicate never enters that
  // machinery at all — it waits on the answer the first caller is already
  // getting, retries and failover included.
  // Order matters. Dedupe OUTERMOST so a duplicate never consumes a queue slot
  // — collapsing it is strictly better than scheduling it. Then the concurrency
  // gate, then retry/failover innermost so a retry does not re-queue behind the
  // stampede it just lost to.
  primary.send = withInFlightDedupe(withConcurrencyLimit(failoverSend));

  return primary;
}

// Wrap a single provider with retry-on-transient. Used when only one URL is
// configured (no failover targets), so we still survive blips.
function wrapWithRetries(provider: ethers.JsonRpcProvider): ethers.JsonRpcProvider {
  const originalSend = provider.send.bind(provider);
  const retryingSend = async (method: string, params: any[]): Promise<any> => {
    let lastErr: any;
    for (let attempt = 0; attempt <= PER_URL_RETRIES; attempt++) {
      try {
        const result = await originalSend(method, params);
        setReachable(true);
        return result;
      } catch (e: any) {
        lastErr = e;
        if (!isTransient(e)) throw e;
        if (attempt === PER_URL_RETRIES) {
          setReachable(false);
          throw e;
        }
        await sleep(PER_URL_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    throw lastErr;
  };
  provider.send = withInFlightDedupe(withConcurrencyLimit(retryingSend));
  return provider;
}
