import 'fake-indexeddb/auto';
import { loadEventsCached, CHUNK_SIZE } from './eventCache';

// This jsdom predates structuredClone, which fake-indexeddb uses to copy records
// on put. Cache records are plain JSON — numbers, strings, arrays of both — so a
// JSON round-trip is a faithful clone for everything that goes through here.
if (typeof (globalThis as any).structuredClone !== 'function') {
  (globalThis as any).structuredClone = (v: any) => JSON.parse(JSON.stringify(v));
}

// The history tab pages backwards by widening a block window (design §4), and the
// cache is what makes that cheap: it holds a CONTIGUOUS scanned range and, when
// asked to reach further back, fetches only the gap below what it already has.
//
// This is the part most able to be quietly wrong — a subtly bad floor returns a
// SUBSET and the UI just shows less history with no error anywhere — so it is
// tested against a fake contract that records every range it is asked for.

const HEAD = 100_000;
const DEPLOY = 1_000;
const AT = [5_000, 45_000, 95_000]; // one log in each third of the chain

let seq = 0;

function makeContract(queried: Array<[number, number]>) {
  return {
    // A fresh address per test: the cache key includes it, so tests cannot
    // pollute each other through the shared fake IndexedDB.
    target: `0x${(seq++).toString(16).padStart(40, '0')}`,
    runner: {
      provider: {
        getNetwork: async () => ({ chainId: 31337 }),
        getBlockNumber: async () => HEAD,
      },
    },
    filters: { Ev: () => ({}) },
    queryFilter: async (_f: any, from: number, to: number) => {
      queried.push([from, to]);
      return AT.filter((b) => b >= from && b <= to).map((b) => ({
        blockNumber: b,
        index: 0,
        transactionHash: `0x${b}`,
        address: '0xabc',
        topics: ['0x00'],
        data: '0x',
      }));
    },
    interface: { parseLog: () => ({ args: {} }) },
  } as any;
}

const covers = (ranges: Array<[number, number]>, block: number) =>
  ranges.some(([f, t]) => block >= f && block <= t);

const blocksOf = (evs: { blockNumber: number }[]) => evs.map((e) => e.blockNumber);

describe('loadEventsCached windowing', () => {
  it('a narrow window reads only the recent end of the chain', async () => {
    const queried: Array<[number, number]> = [];
    const contract = makeContract(queried);
    const evs = await loadEventsCached({
      contract, eventName: 'Ev', fromBlock: DEPLOY, sinceBlock: 90_000,
    });
    expect(blocksOf(evs)).toEqual([95_000]);
    // Nothing older than the window was fetched — that is the entire point.
    expect(covers(queried, 45_000)).toBe(false);
    expect(covers(queried, 5_000)).toBe(false);
  });

  it('widening backwards fetches ONLY the gap, never what it already holds', async () => {
    const queried: Array<[number, number]> = [];
    const contract = makeContract(queried);
    await loadEventsCached({ contract, eventName: 'Ev', fromBlock: DEPLOY, sinceBlock: 90_000 });

    queried.length = 0;
    const evs = await loadEventsCached({
      contract, eventName: 'Ev', fromBlock: DEPLOY, sinceBlock: 40_000,
    });

    expect(blocksOf(evs)).toEqual([45_000, 95_000]);
    // The gap below the old floor was read...
    expect(covers(queried, 45_000)).toBe(true);
    // ...and the range already held was NOT re-read. (Blocks within REORG_DEPTH
    // of the head are deliberately re-scanned; 92_000 is far outside that.)
    expect(covers(queried, 92_000)).toBe(false);
  });

  it('reaching the deployment block yields the whole history, in chain order', async () => {
    const queried: Array<[number, number]> = [];
    const contract = makeContract(queried);
    await loadEventsCached({ contract, eventName: 'Ev', fromBlock: DEPLOY, sinceBlock: 90_000 });
    await loadEventsCached({ contract, eventName: 'Ev', fromBlock: DEPLOY, sinceBlock: 40_000 });
    const evs = await loadEventsCached({ contract, eventName: 'Ev', fromBlock: DEPLOY });

    // Ascending, despite having been fetched newest-window-first: a backfill
    // pushes older logs on after newer ones, and callers are entitled to assume
    // chain order.
    expect(blocksOf(evs)).toEqual([5_000, 45_000, 95_000]);
  });

  it('never reads below the deployment block, however wide the window asks', async () => {
    const queried: Array<[number, number]> = [];
    const contract = makeContract(queried);
    await loadEventsCached({ contract, eventName: 'Ev', fromBlock: DEPLOY, sinceBlock: 0 });
    expect(Math.min(...queried.map(([f]) => f))).toBe(DEPLOY);
  });

  it('narrowing the window again keeps what was already paid for', async () => {
    const queried: Array<[number, number]> = [];
    const contract = makeContract(queried);
    await loadEventsCached({ contract, eventName: 'Ev', fromBlock: DEPLOY });
    const evs = await loadEventsCached({
      contract, eventName: 'Ev', fromBlock: DEPLOY, sinceBlock: 99_000,
    });
    // A remount starts at the narrow window, but the wide history is already on
    // this device. Throwing it away to honour the narrower request would make
    // the tab lose history it had a moment ago.
    expect(blocksOf(evs)).toEqual([5_000, 45_000, 95_000]);
  });

  it('a redeploy at the same address still discards the old deployment', async () => {
    // The one case where a raised floor means "forget", not "narrow". It is
    // distinguishable because it arrives as fromBlock, not sinceBlock.
    const queried: Array<[number, number]> = [];
    const contract = makeContract(queried);
    await loadEventsCached({ contract, eventName: 'Ev', fromBlock: DEPLOY });
    const evs = await loadEventsCached({ contract, eventName: 'Ev', fromBlock: 50_000 });
    expect(blocksOf(evs)).toEqual([95_000]);
  });

  it('chunks the scan at the provider cap', async () => {
    const queried: Array<[number, number]> = [];
    const contract = makeContract(queried);
    await loadEventsCached({ contract, eventName: 'Ev', fromBlock: DEPLOY });
    for (const [f, t] of queried) expect(t - f + 1).toBeLessThanOrEqual(CHUNK_SIZE);
  });
});
