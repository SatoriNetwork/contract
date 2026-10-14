import { getCoinedIndexerUrl, DEFAULT_CHAIN_ID } from '../contracts/addresses';

// Client for Coined's indexer (coined/indexer), which knows the list of coined
// terms — the chain keeps only a mapping nobody can walk. Same contract as
// indexerClient.ts: every call returns null for ANY failure, and the caller
// gets by on Satori's own stream list.

export interface CoinedName {
  id: string;
  text: string;
  hashed: boolean;
  /// wei behind the term, as a decimal string
  pile: string;
}

const TIMEOUT_MS = 4000;

async function get(path: string): Promise<CoinedName[] | null> {
  const base = getCoinedIndexerUrl(DEFAULT_CHAIN_ID);
  if (!base) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body)) return null;
    return body.filter((n) => n && typeof n.id === 'string' && typeof n.text === 'string');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const coinedIndexer = {
  names: (limit = 100) => get(`/names?sort=money&limit=${limit}`),
  /// `[]` when none of them is coined; null only when the indexer did not answer
  byId: (ids: string[]) => get(`/names?ids=${ids.map(encodeURIComponent).join(',')}`),
  search: (q: string, limit = 6) => get(`/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  lookalike: (text: string, limit = 3) => get(`/lookalike?text=${encodeURIComponent(text)}&limit=${limit}`),
};
