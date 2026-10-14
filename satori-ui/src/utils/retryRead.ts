import { isTransient } from './rpcProvider';

/// Retry a read that failed for transport reasons.
///
/// WHY THIS EXISTS SEPARATELY FROM createResilientProvider. That provider retries
/// and fails over, and it is NOT in the path once a wallet is connected:
/// `useContracts` hands every contract the signer, and a contract with a signer
/// runner reads through the SIGNER's provider — the wallet's own RPC. So exactly
/// when a user is doing something, reads stop being resilient.
///
/// The visible consequence: a cold page load fires a burst of reads at once, a
/// few lose, and any hook doing `Promise.all` over several of them fails whole.
/// Pressing retry a second later works, because by then nothing else is
/// competing. See docs/issues/closed/dapp-reads-bypass-resilient-provider.md.
///
/// This is a plaster on that, applied where it was reported. The real fix is to
/// read through the resilient provider and reserve the signer for writes.
export async function retryRead<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 500 }: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      // A revert is an answer. Retrying it wastes time and then reports a
      // contract's honest "no" as a network problem.
      if (!isTransient(e) || i === attempts - 1) throw e;
      // Backoff, because the cause is usually contention: retrying instantly is
      // indistinguishable from the burst that lost in the first place.
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}
