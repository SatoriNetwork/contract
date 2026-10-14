import { ethers } from 'ethers';
import { cachedContract } from './cachedContract';
import { chainCache } from '../hooks/useChainRead';

// The one thing that must never break here is the read/write split. A cached
// WRITE would return a previous transaction's result and silently not send the
// new one — a vote button that appears to work and does nothing.

const ABI = [
  'function gameWeight(uint32 gameId) view returns (int256)',
  'function getEligibleGamesAtRound(uint256) view returns (uint32[])',
  'function vote(uint32 gameId) returns (bool)',
  'function clearVote() returns (bool)',
];

/// A contract whose calls are counted, standing in for the RPC.
function fake(returns: Record<string, unknown>) {
  const calls: string[] = [];
  const iface = new ethers.Interface(ABI);
  const c: any = { interface: iface };
  for (const frag of iface.fragments) {
    if (frag.type !== 'function') continue;
    const name = (frag as ethers.FunctionFragment).name;
    c[name] = async (...args: unknown[]) => {
      calls.push(`${name}(${args.join(',')})`);
      return returns[name];
    };
  }
  c.getAddress = async () => '0xcontract';
  return { contract: c as ethers.Contract, calls };
}

beforeEach(() => { chainCache.invalidateAll(); });

describe('cachedContract', () => {
  it('serves a repeated view call from cache', async () => {
    const f = fake({ gameWeight: BigInt(5) });
    const cached = cachedContract('votingA', f.contract, { class: 'live' });

    expect(await (cached as any).gameWeight(1)).toBe(BigInt(5));
    expect(await (cached as any).gameWeight(1)).toBe(BigInt(5));
    expect(f.calls).toEqual(['gameWeight(1)']);
  });

  it('keeps different arguments apart', async () => {
    const f = fake({ gameWeight: BigInt(5) });
    const cached = cachedContract('votingB', f.contract, { class: 'live' });

    await (cached as any).gameWeight(1);
    await (cached as any).gameWeight(2);
    expect(f.calls).toEqual(['gameWeight(1)', 'gameWeight(2)']);
  });

  it('NEVER caches a state-changing call', async () => {
    // The asymmetric failure. Two votes are two transactions and both must go
    // out; collapsing them would make the second silently do nothing.
    const f = fake({ vote: true, clearVote: true });
    const cached = cachedContract('votingC', f.contract, { class: 'live' });

    await (cached as any).vote(1);
    await (cached as any).vote(1);
    await (cached as any).clearVote();
    await (cached as any).clearVote();

    expect(f.calls).toEqual(['vote(1)', 'vote(1)', 'clearVote()', 'clearVote()']);
  });

  it('leaves non-ABI members alone', async () => {
    const f = fake({});
    const cached = cachedContract('votingD', f.contract, { class: 'live' });
    expect(await cached.getAddress()).toBe('0xcontract');
    expect(cached.interface).toBe(f.contract.interface);
  });

  it('does not collide across contracts sharing a method name', async () => {
    const a = fake({ gameWeight: BigInt(1) });
    const b = fake({ gameWeight: BigInt(2) });
    const ca = cachedContract('votingE', a.contract, { class: 'live' });
    const cb = cachedContract('gamesE', b.contract, { class: 'live' });

    expect(await (ca as any).gameWeight(1)).toBe(BigInt(1));
    expect(await (cb as any).gameWeight(1)).toBe(BigInt(2));
  });

  it('shares one entry between two callers of the same read', async () => {
    // The point of the exercise: useStreamList and StreamsTab both want the
    // eligible set and neither knows the other exists.
    const f = fake({ getEligibleGamesAtRound: [1, 2] });
    const one = cachedContract('votingF', f.contract, { class: 'live' });
    const two = cachedContract('votingF', f.contract, { class: 'live' });

    await Promise.all([(one as any).getEligibleGamesAtRound(0), (two as any).getEligibleGamesAtRound(0)]);
    expect(f.calls).toEqual(['getEligibleGamesAtRound(0)']);
  });
});
