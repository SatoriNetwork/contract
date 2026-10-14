import { ethers } from 'ethers';
import { Policy, cacheKey } from './chainCache';
import { chainCache } from '../hooks/useChainRead';

/// Wrap a contract so every VIEW call goes through the cache under the given
/// policy, and every other property behaves exactly as before.
///
/// The call site keeps its shape — `voting.getEligibleGamesAtRound(r)` — and gains the
/// policy from which handle it was reached through, so reading the code tells
/// you the staleness rule without looking anything up.
///
/// View-versus-write is decided by the ABI's `stateMutability`, never by the
/// method name. That is the same rule the earlier resilient-provider migration
/// used, and for the same reason: the error is asymmetric. Caching a read that
/// should have been fresh shows a stale number; caching a WRITE would return a
/// previous transaction's result and silently not send the new one.
export function cachedContract(
  name: string,
  contract: ethers.Contract,
  policy: Policy,
): ethers.Contract {
  return new Proxy(contract, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;

      // Not an ABI function (getAddress, on, off, queryFilter, …) — untouched.
      let fragment: ethers.FunctionFragment | null = null;
      try {
        fragment = target.interface.getFunction(prop);
      } catch {
        fragment = null;
      }
      if (!fragment) return value.bind(target);

      // Anything that can change state is passed straight through.
      if (fragment.stateMutability !== 'view' && fragment.stateMutability !== 'pure') {
        return value.bind(target);
      }

      return (...args: unknown[]) =>
        chainCache.read(
          cacheKey(name, prop, args),
          policy,
          () => value.apply(target, args),
        );
    },
  }) as ethers.Contract;
}

/// Build cached views of a whole `reads` bundle, one per policy.
///
/// Two handles rather than a per-read policy table, because at a call site the
/// question is always "how fresh does THIS need to be", and the answer comes
/// from the map's classes:
///
///   round — Class 2 and Class 5. Frozen snapshots, per-round ceilings, and
///           governance values that only an admin action changes. One read per
///           24h round, expiring exactly at the boundary.
///   live  — Class 4. Anything another person can move: vote weights, stream
///           values, balances, and every address-keyed read except the two real
///           Class 3 members. 30s, bypassed by an explicit refresh.
///
/// Class 1 (immutable) is not here: those go through lib/chainValues.ts, which
/// also persists them across reloads.
export function makeCachedReads<T extends Record<string, ethers.Contract>>(
  reads: T,
): { round: T; live: T } {
  const wrap = (policy: Policy) => {
    const out = {} as T;
    (Object.keys(reads) as (keyof T)[]).forEach((k) => {
      out[k] = cachedContract(String(k), reads[k], policy) as T[keyof T];
    });
    return out;
  };
  return { round: wrap({ class: 'round' }), live: wrap({ class: 'live' }) };
}
