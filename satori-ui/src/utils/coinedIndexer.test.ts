import { coinedIndexer } from './coinedIndexer';
import { getCoinedIndexerUrl, TESTNET_CHAIN_ID } from '../contracts/addresses';

// Same contract as indexerClient: rows when the Coined indexer is configured,
// reachable and answers with a list; null for every other reason. The name box
// must keep working from Satori's own stream list when this is null.

const realFetch = (global as any).fetch;
const ROW = { id: '0x6269', text: 'bitcoin', hashed: false, pile: '420000000000000000' };

function mockFetch(impl: (url: string) => Promise<any>): jest.Mock {
  const fn = jest.fn((input: unknown) => impl(String(input)));
  (global as any).fetch = fn;
  return fn;
}

const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  delete process.env.REACT_APP_COINED_INDEXER_URL;
  delete process.env.REACT_APP_COINED_INDEXER_PORT;
});
afterAll(() => { (global as any).fetch = realFetch; });

describe('getCoinedIndexerUrl', () => {
  it('is null with nothing configured on the dev chain', () => {
    expect(getCoinedIndexerUrl(31337)).toBeNull();
  });
  it('takes the URL override, trailing slash dropped', () => {
    process.env.REACT_APP_COINED_INDEXER_URL = 'http://coined.test/';
    expect(getCoinedIndexerUrl(31337)).toBe('http://coined.test');
  });
  it('derives host from the page when only a port is given', () => {
    process.env.REACT_APP_COINED_INDEXER_PORT = '8799';
    expect(getCoinedIndexerUrl(31337)).toBe(`http://${window.location.hostname}:8799`);
  });
  it('points Base Sepolia at the live Coined indexer, under /idx on its own host', () => {
    // nginx on coined.satorinet.io strips /idx and proxies to the service's
    // /names, /search, /lookalike — the paths coinedIndexer below appends.
    expect(getCoinedIndexerUrl(TESTNET_CHAIN_ID)).toBe('https://coined.satorinet.io/idx');
  });
});

describe('coinedIndexer', () => {
  it('returns null and never fetches when no URL is configured', async () => {
    const fn = mockFetch(ok([ROW]));
    expect(await coinedIndexer.names()).toBeNull();
    expect(await coinedIndexer.search('bit')).toBeNull();
    expect(await coinedIndexer.lookalike('bit')).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns the rows the indexer answers with, on the documented paths', async () => {
    process.env.REACT_APP_COINED_INDEXER_URL = 'http://coined.test';
    const fn = mockFetch(ok([ROW]));
    expect(await coinedIndexer.names(100)).toEqual([ROW]);
    expect(await coinedIndexer.byId(['0x6269', '0x62'])).toEqual([ROW]);
    expect(await coinedIndexer.search('bit coin', 6)).toEqual([ROW]);
    expect(await coinedIndexer.lookalike('bit', 3)).toEqual([ROW]);
    const urls = fn.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toBe('http://coined.test/names?sort=money&limit=100');
    expect(urls[1]).toBe('http://coined.test/names?ids=0x6269,0x62');
    expect(urls[2]).toBe('http://coined.test/search?q=bit%20coin&limit=6');
    expect(urls[3]).toBe('http://coined.test/lookalike?text=bit&limit=3');
  });

  it('returns null on an HTTP error, a thrown fetch, or a body that is not a list', async () => {
    process.env.REACT_APP_COINED_INDEXER_URL = 'http://coined.test';
    mockFetch(async () => ({ ok: false, status: 500, json: async () => [] }));
    expect(await coinedIndexer.search('bit')).toBeNull();
    mockFetch(async () => { throw new Error('connection refused'); });
    expect(await coinedIndexer.search('bit')).toBeNull();
    mockFetch(ok({ not: 'a list' }));
    expect(await coinedIndexer.search('bit')).toBeNull();
  });
});
