import { useEffect, useState, useCallback } from 'react';
import { ethers } from 'ethers';

// Where the captured referrer is parked so it survives tab navigation / reload.
const PENDING_REFERRAL_KEY = 'satori.pendingReferral';

// Read a referral address from the current URL's ?ref= param (validated).
export function getReferralFromURL(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');
  if (!ref) return null;
  return ethers.isAddress(ref) ? ref : null;
}

/**
 * Capture-only referral flow.
 *
 * A referred ("new") user who opens an invite link sees NOTHING happen — no
 * transaction, no redirect, no banner. We just remember the referrer (persisted
 * so it survives navigation and reload) and hand it to the predict button. The
 * referral is then set atomically on their FIRST prediction via the core's
 * `predictMultipleWithReferral(referrer, requests)` wrapper, which is a no-op on
 * the referral side if one is already set. There is deliberately no auto-tx on
 * link open.
 */
export function usePendingReferral() {
  const [pendingReferrer, setPendingReferrer] = useState<string | null>(null);

  useEffect(() => {
    // Capture ?ref= into storage the first time we see it, then surface
    // whatever is currently parked (URL param this visit, or a prior one).
    const fromUrl = getReferralFromURL();
    if (fromUrl) {
      try { localStorage.setItem(PENDING_REFERRAL_KEY, fromUrl); } catch { /* ignore */ }
    }
    try { setPendingReferrer(localStorage.getItem(PENDING_REFERRAL_KEY)); } catch { /* ignore */ }
  }, []);

  // Call once the referral has actually been applied (a successful prediction
  // through the referral wrapper) so we stop threading it into future predicts.
  const clearPendingReferral = useCallback(() => {
    try { localStorage.removeItem(PENDING_REFERRAL_KEY); } catch { /* ignore */ }
    setPendingReferrer(null);
  }, []);

  return { pendingReferrer, clearPendingReferral };
}
