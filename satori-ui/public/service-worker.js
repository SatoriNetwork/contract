/* Satori dapp service worker.
 *
 * Goal: make the static bundle feel instant on repeat visits and survive
 * brief network outages. Strategy:
 *
 *   - HTML / navigations: network-first. Always try fresh; fall back to cache
 *     so a flaky network still serves the last known shell.
 *   - Static assets (JS / CSS / images): cache-first. Hashed filenames mean
 *     "the same URL always means the same content," so caching forever is
 *     safe — a new build emits new filenames.
 *   - Cross-origin (RPC, WalletConnect relay, anything else): pass through.
 *     We never touch chain traffic.
 *
 * Cache invalidation: bump CACHE_NAME to wipe the previous deploy's assets.
 * Without a bump, hashed-filename assets stay cached forever (which is what
 * we want), and the HTML shell auto-refreshes via the network-first path.
 */

// v2: v1 cached the indexer API alongside the static bundle, permanently. The
// bump is what evicts those poisoned entries from browsers that already have
// them — without it, an existing install keeps serving the stale API responses
// forever and the fix below never reaches the people it is for.
//
// v3 (2026-09-02): the D1 -> D3 redeploy. app.satorinet.io moved to a new stack
// with new contract addresses and a new deploymentRound, on the SAME ORIGIN, so
// every prior visitor still had the previous deploy's shell in this cache. The
// navigation path is network-first and so recovers on its own while online, but
// the cached D1 shell stayed as the offline fallback — and that shell is not
// merely out of date, it points at the RETIRED D1 contracts, which are still
// live and readable on Base Sepolia. Symptom seen on the live site: a chart
// full of prediction bars and "round 24" on a stack whose first round had just
// opened, because 41396 - 41373 + 1 = 24 using the OLD deploymentRound. Nothing
// server-side could produce that — the indexer held zero prediction rows.
//
// The bump is the eviction: `activate` deletes every cache whose name is not
// CACHE_NAME, so an existing install drops the D1 shell the first time the new
// worker takes over.
const CACHE_NAME = 'satori-static-v3';

self.addEventListener('install', () => {
  // Take over from any previous version on first install.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Clear caches from prior versions.
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      ),
      // Become controller for already-open clients.
      self.clients.claim(),
    ]),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Pass through cross-origin (RPC, WalletConnect relay, etc.).
  if (url.origin !== self.location.origin) return;

  // Only cache GETs.
  if (req.method !== 'GET') return;

  // NEVER cache the indexer API.
  //
  // It is served from the SAME ORIGIN as the bundle (/satori/api/…), so it fell
  // through to the cache-first branch below — whose entire premise is that a
  // URL's content never changes, because CRA hashes asset filenames. API
  // responses carry no hash and change constantly, so they were cached
  // permanently on first fetch.
  //
  // Observed on the live site: a browser that fetched /api/sentiment/1 while the
  // indexer had no rows kept serving that empty array indefinitely, so the
  // prediction bars never appeared on the chart however many predictions were
  // made. curl showed five rows the whole time, because curl has no service
  // worker. Nothing in the app could detect it — what arrived was a valid,
  // successful, empty response.
  if (url.pathname.includes('/api/')) return;

  // Navigation requests (the HTML shell): network-first, fall back to cache.
  // This is what lets a redeploy be picked up immediately when online.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() =>
          caches.match(req).then((r) => r || caches.match('./index.html')),
        ),
    );
    return;
  }

  // Static assets: cache-first. CRA emits hashed filenames so a cached entry
  // is always exactly the right content for that URL.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Only cache successful, basic (same-origin) responses.
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      });
    }),
  );
});
