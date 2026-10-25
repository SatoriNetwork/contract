// Satori split-stack facade.
//
// The protocol was restructured from one monolithic contract into an immutable
// SatoriToken (ERC20 + minting), an upgradeable SatoriEngine (prediction state /
// logic, behind a proxy) and a SatoriHub (the user-facing facade: vote / claim /
// create / delegate / adapters / fees). Those three live at three different
// addresses.
//
// The dapp used to talk to a single `contracts.satori` object. To avoid touching
// every call site, this facade re-creates that single object: a Proxy that
// routes each method to whichever underlying contract (token / engine / hub)
// actually exposes it. It mirrors the contract test suite's `makeSatoriShim`
// (test/next/splitFixture.js) so the dapp and the tests route identically.
import { ethers } from 'ethers';

// Methods served by the engine (prediction state + logic). Everything not listed
// here or in TOKEN_METHODS defaults to the hub (the ISatoriCore facade).
//
// KEEP THIS IN STEP WITH THE ENGINE ABI. A name listed here that the engine no
// longer has does not fail loudly — the facade happily routes to the engine and
// the call dies as "not a function" at the call site, pointing at the engine
// rather than at this list. `roundTotals` and `isRoundTotalLocked` were removed
// for exactly that reason: roundTotals now lives on SatoriVoting as
// `roundDenominator(round)` (the divisor SatoriRewards._gameRoundAllocation
// actually uses), and isRoundTotalLocked had no caller at all.
// Exported for `contractSurface.test.ts`, which asserts every name below still
// exists on the corresponding ABI. That test is what makes the warning above
// fail loudly instead of at a user's click.
export const ENGINE_METHODS = new Set<string>([
  'predictMultipleWithPayloads',
  'predictMultipleWithReferral',
  'settlePrediction',
  'streaks',
  'predictions',
  'getLatestPrediction',
  'roundPredictionCount',
  'eligibilityRound',
  'predictedStreamsCount',
  'userPredictions',
]);

// Methods served by the immutable token (ERC20 + round clock + participation).
// getCurrentRound / deploymentRound also exist on the hub and engine, so they
// MUST be forced to the token here to resolve consistently; deploymentBlock is token-only.
export const TOKEN_METHODS = new Set<string>([
  'balanceOf',
  'transfer',
  'transferFrom',
  'approve',
  'allowance',
  'totalSupply',
  'name',
  'symbol',
  'decimals',
  'deploymentBlock',
  'deploymentRound',
  'getCurrentRound',
  'hasParticipated',
  'airdropMintedTo',
  'totalRewardsMinted',
]);

// Views MIGRATED OFF SatoriHub in audit LA-4 and now owned by SatoriRewardsLens.
// Declared explicitly — matching ENGINE_METHODS / TOKEN_METHODS above — rather
// than falling through to whichever contract happens to expose a name, so the
// routing stays reviewable and a typo fails loudly instead of resolving somewhere
// unintended. The hub stopped being an intermediary for reads nothing on-chain
// consumes; each of these now resolves against the child that owns the state.
export const LENS_METHODS = new Set<string>([
  'streamBurn', 'gameBurn', 'bountyBurn', 'farmingThreshold',
  // `votingLockedUntil` was routed here until 2026-08-20 and existed on no ABI
  // at all — a leftover of delegated voting, which burn-to-vote replaced.
  'lockedUntil',
  'onChainRewardCeiling', 'getValueChange', 'streamExists',
  'satoriVoting', 'satoriBounties', 'satoriMerkle',
]);

// `lens` is routed explicitly by LENS_METHODS. Audit LA-4 moved the hub's off-chain-only view
// forwarders (burn fees, lockedUntil/votingLockedUntil, onChainRewardCeiling,
// getValueChange, streamExists, the satoriX() address aliases) onto
// SatoriRewardsLens, so the hub stopped being an intermediary for reads no
// on-chain caller consumes. Appending the lens here keeps every existing call
// site working — the read simply resolves against the child that owns it.
function routeOrder(
  prop: string,
  token: ethers.Contract,
  engine: ethers.Contract,
  hub: ethers.Contract,
  lens: ethers.Contract,
): ethers.Contract[] {
  const base = prop.includes('(') ? prop.slice(0, prop.indexOf('(')) : prop;
  if (ENGINE_METHODS.has(base)) return [engine, token, hub];
  if (TOKEN_METHODS.has(base)) return [token, engine, hub];
  if (LENS_METHODS.has(base)) return [lens, hub];
  return [hub, token, engine];
}

// A merged Interface spanning all three layers, so `satori.interface` can decode
// any event / custom error the stack emits (the dapp parses receipt logs with
// it). Drops constructor / receive / fallback and de-dupes by fragment shape.
function mergeInterfaces(contracts: ethers.Contract[]): ethers.Interface {
  const seen = new Set<string>();
  const frags: ethers.Fragment[] = [];
  // Keep only the fragment kinds we route on / decode: functions (method
  // dispatch + hasFunction), and errors + events (receipt-log / revert decode).
  // Constructor / fallback / receive / struct fragments are dropped — a merged
  // Interface can't hold two constructors, and they aren't needed to decode.
  const KEEP = new Set(['function', 'error', 'event']);
  for (const c of contracts) {
    for (const f of c.interface.fragments) {
      if (!KEEP.has(f.type)) continue;
      const key = f.type + ':' + f.format();
      if (seen.has(key)) continue;
      seen.add(key);
      frags.push(f);
    }
  }
  return new ethers.Interface(frags);
}

// Build the monolith-shaped `satori` object from the three split contracts.
// The hub is the identity/base (its address is what the monolith's core address
// meant: fee sink, fee-pulling spender, the privileged caller children trust),
// so `getAddress()` / `target` resolve to the hub.
export function makeSatoriFacade(
  token: ethers.Contract,
  engine: ethers.Contract,
  hub: ethers.Contract,
  lens: ethers.Contract,
): ethers.Contract {
  const merged = mergeInterfaces([token, engine, hub, lens]);
  return new Proxy(hub, {
    get(_target, prop) {
      if (prop === 'interface') return merged;
      // NOT SAFE FOR MULTICALL. These two resolve to the hub unconditionally,
      // because a facade cannot vary its address by method. Direct calls are
      // fine — the dispatch below picks the right underlying contract — but
      // anything that builds calldata from `.target` + `.interface` instead of
      // calling (multicallRead does exactly that) will aim every method at the
      // HUB. With `allowFailure: true` that is silent: the call reverts, the
      // batch returns 0, and it looks like real data. It cost every streak in
      // the dapp reading as 0 on every chain until 2026-08-13.
      //
      // Pass the concrete contract (contracts.reads.engine / .token / .hub) to
      // multicall, never this facade.
      if (prop === 'getAddress') return async () => hub.getAddress();
      if (prop === 'target') return hub.target;
      if (typeof prop === 'string') {
        for (const c of routeOrder(prop, token, engine, hub, lens)) {
          if (c.interface.hasFunction(prop)) {
            const v = (c as unknown as Record<string, unknown>)[prop];
            // Returned AS-IS, never `.bind(c)`.
            //
            // An ethers contract method is a function with helpers hanging off
            // it — `staticCall`, `estimateGas`, `populateTransaction`,
            // `fragment`. `Function.prototype.bind` returns a NEW function and
            // copies none of them, so binding here silently deleted every one,
            // for every method, across the whole facade. It stayed invisible
            // until something reached for one, then surfaced as "staticCall is
            // not a function" (2026-08-05).
            //
            // The bind was never needed: ethers builds these methods closed over
            // their own contract, so they already carry their receiver.
            return v;
          }
        }
      }
      const fallback = (hub as unknown as Record<string | symbol, unknown>)[prop];
      return typeof fallback === 'function'
        ? (fallback as (...a: unknown[]) => unknown).bind(hub)
        : fallback;
    },
  }) as unknown as ethers.Contract;
}
