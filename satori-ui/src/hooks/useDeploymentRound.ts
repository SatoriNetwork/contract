import { useState, useEffect } from 'react';
import { useContracts } from './useContracts';
import { chainCache } from './useChainRead';
import { getChainConfig, DEFAULT_CHAIN_ID } from '../contracts/addresses';

// The protocol's first round (`SatoriToken.deploymentRound`, constructor-set and
// immutable). Every round shown to a user is relative to it: display round =
// absolute - deploymentRound + 1.
//
// WHY THIS READS THE PERSISTED CACHE SYNCHRONOUSLY
// It used to keep its own module-scope `cached` variable and fetch on mount.
// A module variable dies with the page, so EVERY load started at null, and
// `toElapsedRound` fell back to returning the raw chain round. The dashboard
// therefore rendered "Current Round 41373" for the first frames of every visit
// before snapping to 1 (owner, 2026-08-21). The value was already in
// localStorage the whole time; nothing could read it before first paint.
//
// `chainCache` persists `immutable` entries under a chain-namespaced key, so
// `peekImmutable` returns the right answer on the very first render of any
// visit after the first ever. The key matches `chainValues.getDeploymentRound`
// so the two share one entry rather than fetching twice.
const KEY = 'satori.deploymentRound';

/// Best answer available with no network at all, in order of confidence:
///
///   1. the persisted cache — this exact chain, read from this exact deployment
///   2. the build-time constant in `addresses.ts`, shipped alongside the
///      contract addresses it was deployed with and pinned to the deployment
///      book by `chainConfig.test.ts`
///
/// Falling back to the constant is what removes the "—" placeholder from a
/// first-ever visit. It is no less trustworthy than the addresses beside it: if
/// those are wrong the dapp is talking to the wrong contracts anyway, and one
/// test guards both. Dev chains omit it deliberately (redeployed constantly),
/// so there the answer is null and the fetch happens.
function knownWithoutNetwork(): number | null {
  const cached = chainCache.peekImmutable<unknown>(KEY);
  if (cached != null) return Number(cached);
  try {
    return getChainConfig(DEFAULT_CHAIN_ID).deploymentRound ?? null;
  } catch {
    return null;
  }
}

export function useDeploymentRound(): number | null {
  const { contracts } = useContracts();
  const [round, setRound] = useState<number | null>(knownWithoutNetwork);

  useEffect(() => {
    if (round != null || !contracts) return;
    // Route through the cache rather than calling the contract directly, so the
    // answer is written to localStorage and the NEXT load needs no fetch at all.
    chainCache
      .read<unknown>(KEY, { class: 'immutable' }, () => contracts.satori.deploymentRound())
      .then((r) => setRound(Number(r)))
      .catch(() => { /* leave null; callers render a placeholder, never a wrong number */ });
  }, [contracts, round]);

  return round;
}

/// Convert an absolute on-chain round to its display number, 1-indexed from
/// genesis.
///
/// Returns **null** when `deploymentRound` is not known yet. It used to return
/// the raw absolute round in that case, which is not a degraded answer — it is a
/// different number by a factor of forty thousand, rendered with no indication
/// that it is provisional. Callers show a placeholder instead; see
/// `formatElapsedRound`.
export function toElapsedRound(absolute: number, deploymentRound: number | null): number | null {
  return deploymentRound != null ? absolute - deploymentRound + 1 : null;
}

/// Display helper: the round number, or a quiet placeholder while the immutable
/// deployment round is still loading. One dash beats a wrong number.
export function formatElapsedRound(absolute: number, deploymentRound: number | null): string {
  const r = toElapsedRound(absolute, deploymentRound);
  return r == null ? '—' : String(r);
}
