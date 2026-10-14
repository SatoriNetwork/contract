import { chainCache } from '../hooks/useChainRead';

/// Await a transaction and drop every cached read that could have changed.
///
/// Replaces a bare `tx.wait()`. Named afterTx, NOT settle: this codebase already
/// uses "settle" for settling a prediction (useDashboard.settle), and the earlier
/// name shadowed it — turning that callback into an infinite recursion. Without it, a Class 4 value stays cached for up
/// to 30 seconds after the user's own action — you vote, and the weight does
/// not move until the timer happens to expire. That reads as a broken button
/// long before anyone suspects a cache.
///
/// Deliberately blunt: it invalidates everything rather than trying to work out
/// which keys this particular call touched. After a write, correctness is worth
/// more than the handful of reads a precise invalidation would save, and a map
/// from "method called" to "storage touched" is exactly the kind of thing that
/// silently rots as the contracts change. `invalidateAll` skips Class 1, since
/// a transaction cannot alter an immutable.
///
/// The complement to this is the map's finding that my own action is the most
/// likely reason a value changed but never the only one — hence 30s on top,
/// rather than this alone.
export async function afterTx<T extends { wait: (...a: any[]) => Promise<any> }>(
  tx: T,
): Promise<any> {
  const receipt = await tx.wait();
  chainCache.invalidateAll();
  return receipt;
}
