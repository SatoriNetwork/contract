// The round shown on the dashboard must never be the RAW chain round.
//
// On 2026-08-21 the owner opened the live dapp and saw "Current Round 41373"
// where it should have said 1, correcting itself a moment later. Two separate
// causes, both fixed here and both pinned below:
//
//   1. `toElapsedRound` fell back to returning `absolute` while the immutable
//      deploymentRound was unknown. That is not a degraded answer, it is a
//      different number by a factor of forty thousand, printed with nothing to
//      say it was provisional.
//
//   2. The hook kept its own module-scope cache, which dies with the page, so
//      EVERY load began at null — even though `chainCache` already had the
//      answer persisted in localStorage. `peek` could not reach it, because
//      `peek` asks "is there a fresh IN-MEMORY entry" and on a cold load there
//      never is.
import { toElapsedRound, formatElapsedRound } from './useDeploymentRound';
import { ChainCache } from '../lib/chainCache';

const MID_ROUND = 41373 * 43_200_000 + 1_000;

describe('display round never shows the raw chain round', () => {
  it('is 1 in the deployment round itself', () => {
    expect(toElapsedRound(41373, 41373)).toBe(1);
  });

  it('counts up from genesis', () => {
    expect(toElapsedRound(41380, 41373)).toBe(8);
  });

  it('returns null — NOT the absolute round — while deploymentRound is unknown', () => {
    // The exact regression. Returning 41373 here is what put it on screen.
    expect(toElapsedRound(41373, null)).toBeNull();
    expect(toElapsedRound(41373, null)).not.toBe(41373);
  });

  it('renders a placeholder rather than a wrong number', () => {
    expect(formatElapsedRound(41373, null)).toBe('—');
    expect(formatElapsedRound(41373, 41373)).toBe('1');
  });
});

describe('an immutable value survives a reload and is readable BEFORE first paint', () => {
  function freshStore() {
    const store = new Map<string, string>();
    return {
      store,
      persist: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
      },
    };
  }

  it('peekImmutable reads a persisted value on a cold cache; peek cannot', async () => {
    const { persist } = freshStore();
    const first = new ChainCache({ now: () => MID_ROUND, persist, namespace: 84532 });
    await first.read('satori.deploymentRound', { class: 'immutable' }, async () => 41373);

    // A brand-new cache, exactly as after a page reload.
    const reloaded = new ChainCache({ now: () => MID_ROUND, persist, namespace: 84532 });

    // This is the gap that caused the flash: nothing in memory yet.
    expect(reloaded.peek('satori.deploymentRound')).toBeUndefined();

    // ...but the answer is on disk, and now reachable synchronously.
    expect(Number(reloaded.peekImmutable('satori.deploymentRound'))).toBe(41373);
  });

  it('returns undefined when nothing was ever stored, so the caller shows the placeholder', () => {
    const { persist } = freshStore();
    const cold = new ChainCache({ now: () => MID_ROUND, persist, namespace: 84532 });
    expect(cold.peekImmutable('satori.deploymentRound')).toBeUndefined();
    expect(formatElapsedRound(41373, null)).toBe('—');
  });

  it('does not read another chain\'s deployment round', async () => {
    const { persist } = freshStore();
    const sepolia = new ChainCache({ now: () => MID_ROUND, persist, namespace: 84532 });
    await sepolia.read('satori.deploymentRound', { class: 'immutable' }, async () => 41373);

    const mainnet = new ChainCache({ now: () => MID_ROUND, persist, namespace: 8453 });
    expect(mainnet.peekImmutable('satori.deploymentRound')).toBeUndefined();
  });
});
