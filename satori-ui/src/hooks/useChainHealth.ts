import { useEffect, useRef, useState } from 'react';
import { onChainHealth } from '../utils/rpcProvider';

/// How long unreachability has to persist before the UI believes it.
///
/// Exported so the test can reference it rather than hard-coding a duration
/// that would silently stop matching if this changed.
export const UNREACHABLE_GRACE_MS = 2000;

// Chain reachability — `true` when at least one configured RPC is responding,
// `false` when every URL in the failover list has been exhausted on a transient
// error (timeout, 5xx, connection refused, rate limit). Non-transient errors
// like reverts don't trip this; those aren't infrastructure problems.
//
// Subscribers receive the current state immediately, so a banner consumer
// renders correctly on first paint without flicker.
//
// UNREACHABLE IS DEBOUNCED; REACHABLE IS NOT. The underlying signal flips false
// when ONE call exhausts the failover list, and back true on the next call that
// succeeds — and the dapp runs many calls concurrently. So a single unlucky
// request against a throttled public endpoint would flip the flag false and the
// very next response would flip it back, milliseconds later.
//
// That is not harmless flicker. The banner is a block element in normal flow,
// so it does not merely flash: it pushes the whole page down and releases it.
// Users reported a red bar appearing and vanishing too fast to read.
//
// The asymmetry is the point. "The chain is unreachable" is a claim about a
// sustained condition, so it has to hold for a moment before we make it. "The
// chain is fine" is proven by a response that already arrived, so it applies at
// once — a recovery must never be delayed behind a timer, or the banner would
// outlive the outage it describes.
export function useChainHealth(): { reachable: boolean } {
  const [reachable, setReachable] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clear = () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    };
    const unsubscribe = onChainHealth((next) => {
      if (next) {
        // Recovery wins immediately, and cancels any pending "went down".
        clear();
        setReachable(true);
      } else if (!timer.current) {
        // Already counting down? Leave the original deadline alone — restarting
        // it on every failing call would let a steady stream of failures push
        // the banner off forever, which is exactly when it should appear.
        timer.current = setTimeout(() => {
          timer.current = null;
          setReachable(false);
        }, UNREACHABLE_GRACE_MS);
      }
    });
    return () => { clear(); unsubscribe(); };
  }, []);

  return { reachable };
}
