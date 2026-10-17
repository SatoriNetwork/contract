// Drop-in replacements for the reads that should not be RPC calls.
//
// These keep the shape the call sites already use — plain async functions
// returning exactly what ethers returned, bigint included — so switching a hook
// over is a one-line change and nothing downstream has to care.
//
// What changes is the cost:
//
//   getCurrentRound   8 call sites  ->  0 requests (clock arithmetic)
//   streamBurn        3 call sites  ->  0 requests (derived)
//   deploymentBlock   6 call sites  ->  1 request per browser, per chain, ever
//
// See docs/design/dapp-cache-invalidation-map.md for why each is safe.

import { chainCache } from '../hooks/useChainRead';
import {
  currentRound, currentRoundRaw, setRoundOffset, getRoundOffset,
  streamBurn as computeStreamBurn,
} from './round';

/// Any object exposing the `satori` facade bound to the resilient provider —
/// i.e. `contracts.reads`. Typed structurally so this file does not depend on
/// the shape of useContracts.
interface Reads {
  // ethers' Contract resolves methods off the ABI at runtime, so a structural
  // type listing them does not match. `any` here is the honest description of
  // what a Contract is, not a shortcut.
  satori: any;
}

/// The current round, as a bigint, matching `satori.getCurrentRound()`.
///
/// No await needed in principle, but kept async so call sites that already
/// `await` it do not have to change. Costs nothing:
///
///     SatoriToken.sol — return block.timestamp / TIME_UNIT_SECONDS
///
/// There is no counter to read. See lib/round.ts for the one caveat (a block's
/// timestamp can trail the wall clock by a second or two at a boundary).
export async function getCurrentRound(): Promise<bigint> {
  return BigInt(currentRound());
}

/// Measure how far the CHAIN's clock sits from the browser's, in rounds, and
/// remember it so every later `currentRound()` is the chain's answer.
///
/// One RPC per session (plus one per dev time-warp) instead of one per call, so
/// the "never fetch it" property this file exists for survives: on a real chain
/// the offset comes back 0 and nothing downstream changes. Only a node whose
/// clock has been moved — a local dev chain driven by evm_increaseTime — makes
/// it non-zero. See `roundOffset` in lib/round.ts for what goes wrong without it.
export async function calibrateRound(reads: Reads): Promise<number> {
  try {
    const chain = Number(await reads.satori.getCurrentRound());
    const drift = chain - currentRoundRaw();
    // ONLY adopt an offset big enough to be a real clock warp.
    //
    // This threshold is what keeps the change inert in production. A block's
    // timestamp can trail the wall clock by a second or two, so calibrating
    // within a breath of a round boundary can measure a spurious +/-1 — and
    // because the offset then persists for the session, adopting it would make
    // every round wrong by one for the next 24 hours on a REAL chain. That would
    // be a far worse bug than the one this fixes.
    //
    // A genuine chain cannot be a whole round (24h) away from the wall clock; a
    // dev node warped by evm_increaseTime is away by many (the seeder alone
    // moves ~60). So |drift| >= 2 separates them cleanly, and production keeps
    // the exact wall-clock arithmetic — and the zero-RPC property — it has today.
    if (Math.abs(drift) < 2) {
      setRoundOffset(0);
      return 0;
    }
    let hours = drift * 24;
    try {
      const runner = reads.satori.runner;
      const block = await (runner?.provider ?? runner).getBlock('latest');
      hours = Math.floor(Number(block.timestamp) / 3600) - Math.floor(Date.now() / 3_600_000);
    } catch {
      // whole rounds are the best measure left
    }
    setRoundOffset(drift, hours);
  } catch {
    // A failed calibration must not break the app: fall back to the wall clock,
    // which is exactly right everywhere except a warped dev node.
    setRoundOffset(0);
  }
  return getRoundOffset();
}

/// Block the protocol was deployed at. `uint256 public immutable` — one fetch
/// per browser per chain, then served from localStorage forever.
export async function getDeploymentBlock(reads: Reads): Promise<bigint> {
  return chainCache.read(
    'satori.deploymentBlock',
    { class: 'immutable' },
    () => reads.satori.deploymentBlock(),
  );
}

/// The named adapter's registry id (`SatoriRegistry.namedAdapterId`). Wired at
/// deploy before the default stream exists and unchangeable once any stream
/// does, so a NON-ZERO answer is immutable for the life of a deployment.
///
/// 0 is not: it is what the registry says between its own deploy and
/// `setNamedAdapterId`, and run-local.sh redeploys into the same cache
/// namespace, so a 0 written to localStorage would outlive the wiring and
/// disable named streams until site data is cleared. Only a non-zero id is
/// cached; 0 is answered but never stored, so the next read asks again.
export const NAMED_ADAPTER_ID_KEY = 'registry.namedAdapterId';
export async function getNamedAdapterId(reads: { registry: any }): Promise<number> {
  const known = chainCache.peekImmutable<number>(NAMED_ADAPTER_ID_KEY);
  if (known) return known;
  const id = Number(await reads.registry.namedAdapterId());
  if (id) await chainCache.read(NAMED_ADAPTER_ID_KEY, { class: 'immutable' }, async () => id);
  return id;
}

/// Round the protocol was deployed in. Constructor-set, same treatment.
///
/// Safe across the 24h redeploy only because the cache namespace carries a
/// schema version: the 12h-era persisted value (double today's round numbers)
/// lives under the old namespace and can never be served again.
export async function getDeploymentRound(reads: Reads): Promise<bigint> {
  return chainCache.read(
    'satori.deploymentRound',
    { class: 'immutable' },
    () => reads.satori.deploymentRound(),
  );
}

/// Cost to create a data stream. `SatoriHub.streamBurn()` is a flat constant
/// (0.001 SATORI), so this is a pure constant with no fetch at all — kept in
/// lockstep with the hub via lib/round.ts, verifiable against the lens.
export async function getStreamBurn(): Promise<bigint> {
  return computeStreamBurn();
}

/// The dev-fee recipient. `address public immutable PLATFORM_FEE_RECIPIENT`
/// (SatoriToken.sol) — it cannot change for the life of the deployment, so
/// one fetch per browser per chain, then localStorage.
export async function getPlatformFeeRecipient(reads: Reads): Promise<string> {
  return chainCache.read(
    'token.PLATFORM_FEE_RECIPIENT',
    { class: 'immutable' },
    () => reads.satori.PLATFORM_FEE_RECIPIENT(),
  );
}
