/// Tiny window-event bus for cross-tab dapp invalidation. Hooks subscribe
/// from one tab; other tabs publish after a state-mutating tx so the
/// listeners can refetch without the user having to click around.
///
/// Implementation: leans on the built-in `window.dispatchEvent` / addEventListener
/// pair with a CustomEvent. No state, no race conditions, no extra deps. Each
/// listener gets the event detail synchronously; publishers don't block.
///
/// Naming convention: kebab-case, prefixed with the contract emitting the
/// underlying truth (`bounty-funded`, `bounty-token-staked`, …) so a reader
/// can pattern-match against on-chain semantics. Listed centrally in
/// `DappEvent` for type-checking.

export type DappEvent =
  | 'bounty-funded'        // a bounty was funded; BountiesTab list/stakes stale
  | 'bounty-token-cleaned' // a drained bounty token was cleaned up; bounty list stale
  | 'bounty-token-staked'  // a bounty token was staked/unstaked; BountiesTab stale
  ;

const PREFIX = 'satori-dapp:';

/// Fire and forget. Detail is optional; subscribers that care about the
/// payload pull it from the CustomEvent's `detail`.
export function publishDappEvent(name: DappEvent, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PREFIX + name, { detail }));
}

/// Subscribe to a single dapp event. Returns the unsubscribe function so
/// React useEffect can return it directly.
export function onDappEvent(
  name: DappEvent,
  handler: (detail?: unknown) => void,
): () => void {
  if (typeof window === 'undefined') return () => {};
  const wrapped = (ev: Event) => handler((ev as CustomEvent).detail);
  window.addEventListener(PREFIX + name, wrapped);
  return () => window.removeEventListener(PREFIX + name, wrapped);
}
