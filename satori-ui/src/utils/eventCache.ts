import { ethers } from 'ethers';

// Client-side event indexer backed by IndexedDB. Replaces queryFilter calls
// that would scan from deploymentBlock to head on every page load. After the
// first load, subsequent calls only fetch logs since the cached high-water
// mark, so cost is O(new-blocks-since-last-call) instead of O(chain-history).
//
// IndexedDB has effectively unlimited storage (browser-allocated quota,
// usually >50% of free disk). Cache is per-device — first user on a fresh
// browser still pays a cold-load cost, but it's bounded by chunked getLogs
// rather than a single unchunked queryFilter call that providers would cap.

const DB_NAME = 'satori-event-cache';
const DB_VERSION = 1;
const STORE = 'events';

// 10k blocks per getLogs request — universal cap across most RPC providers.
// Exported because it is the unit of COST, and callers that page backwards
// budget in it rather than in blocks (see lib/historyWindow.ts).
export const CHUNK_SIZE = 10_000;
// Overlap window re-scanned on every load so reorged-out logs can't persist
// in the cache (review #18). Base finalizes far shallower than this; 128
// blocks (~4.3 min at 2s blocks) is a comfortable margin.
const REORG_DEPTH = 128;

// Bump this when the cached event shape changes (e.g., new contract redeploy
// at the SAME address with an incompatible ABI, or a serialization change).
// The version becomes part of the cache key, so old records become orphaned
// and the cache rebuilds from chain on next read. Cross-deployment redeploys
// (different address or chainId) already get fresh keys for free.
const SCHEMA_VERSION = 2;

interface CacheRecord {
  key: string;
  /// The scanned range is CONTIGUOUS: [firstScannedBlock, lastScannedBlock].
  /// Tracking the floor explicitly is what lets a caller start with a recent
  /// window and later extend backwards, fetching only the gap. Absent on records
  /// written before windowing existed — those were always scanned from
  /// `fromBlock`, so that is what theirs is.
  firstScannedBlock?: number;
  lastScannedBlock: number;
  // Raw logs serialized just enough to re-parse via the contract's interface.
  // Stored shape: { blockNumber, index, transactionHash, address, topics, data }.
  logs: SerializedLog[];
}

interface SerializedLog {
  blockNumber: number;
  index: number;
  transactionHash: string;
  address: string;
  topics: string[];
  data: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function readRecord(key: string): Promise<CacheRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function writeRecord(rec: CacheRecord): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function cacheKey(chainId: number, contractAddr: string, eventName: string, filterArgs: any[]): string {
  // Filter args become part of the key so a query for ReferralPaid(null, alice)
  // doesn't collide with ReferralPaid(null, bob). Addresses lowercased,
  // primitives stringified, anything else JSON'd as a fallback.
  const argsKey = filterArgs
    .map((a) => {
      if (a == null) return 'null';
      if (typeof a === 'string') return a.toLowerCase();
      if (typeof a === 'number' || typeof a === 'bigint' || typeof a === 'boolean') return String(a);
      return JSON.stringify(a);
    })
    .join('|');
  return `v${SCHEMA_VERSION}:${chainId}:${contractAddr.toLowerCase()}:${eventName}:${argsKey}`;
}

export interface DecodedEvent {
  args: any;
  blockNumber: number;
  index: number;
  transactionHash: string;
}

export interface CachedEventQuery {
  contract: ethers.Contract;
  eventName: string;
  filterArgs?: any[];
  /// The deployment floor. Nothing below this is ever read, and a CHANGE to it
  /// means the contract was redeployed at this address, which invalidates
  /// anything cached below it.
  fromBlock: number;
  /// Optional floor for THIS call: "I only need back to here for now."
  /// Clamped into [fromBlock, head+1], so windowing can never be mistaken for a
  /// redeploy. Passing a LOWER value than a previous call extends the cached
  /// range backwards and fetches only the gap; passing a higher one keeps what
  /// is already held and returns it — it has been paid for already.
  sinceBlock?: number;
}

/// Load all events of a given filter, cache-first. Always returns events from
/// `fromBlock` (typically deploymentBlock) through the current head, reading
/// the bulk from IndexedDB and only fetching the delta from the chain.
export async function loadEventsCached(opts: CachedEventQuery): Promise<DecodedEvent[]> {
  const { contract, eventName, filterArgs = [], fromBlock, sinceBlock } = opts;
  const provider = (contract as any).runner?.provider as ethers.Provider | undefined;
  if (!provider) throw new Error('eventCache: contract has no provider');

  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  const contractAddr = (contract as any).target as string;
  const key = cacheKey(chainId, contractAddr, eventName, filterArgs);

  const head = await provider.getBlockNumber();
  // The floor for this call. Clamped into [fromBlock, head+1] so a window can
  // never reach below the deployment or past the chain.
  const want = Math.min(Math.max(sinceBlock ?? fromBlock, fromBlock), head + 1);

  let rec = await readRecord(key);
  if (!rec) rec = { key, firstScannedBlock: want, lastScannedBlock: want - 1, logs: [] };
  if (rec.firstScannedBlock == null) rec.firstScannedBlock = fromBlock;

  if (rec.lastScannedBlock > head) {
    if (head < fromBlock) {
      // A fresh deployment has shifted the chain (e.g., redeploy on local
      // dev): the head is before the deployment block we're scanning from.
      rec = { key, firstScannedBlock: want, lastScannedBlock: want - 1, logs: [] };
    } else {
      // Head moved BACKWARD but is still past fromBlock — a rollback/reorg.
      // Trim instead of nuking the whole cache (review #18).
      rec.logs = rec.logs.filter((l) => l.blockNumber <= head);
      rec.lastScannedBlock = head;
    }
  }

  // Deployment moved FORWARD — a redeploy at the same address on a live chain.
  // Everything below the new floor belongs to the old deployment. A narrow
  // window cannot land here, because `want` is clamped at `fromBlock`.
  if ((rec.firstScannedBlock ?? fromBlock) < fromBlock) {
    rec.logs = rec.logs.filter((l) => l.blockNumber >= fromBlock);
    rec.firstScannedBlock = fromBlock;
    if (rec.lastScannedBlock < fromBlock - 1) rec.lastScannedBlock = fromBlock - 1;
  }

  // REORG HANDLING (review #18): logs cached from blocks near the head may
  // belong to a fork that got reorged out — they'd otherwise persist forever
  // (the old code only ever scanned FORWARD). On every load, re-scan an
  // overlap window of the most recent REORG_DEPTH blocks: drop cached entries
  // inside the window and refetch them fresh. Costs one extra small
  // eth_getLogs on warm loads; guarantees the cache converges to the
  // canonical chain for anything deeper than REORG_DEPTH.
  const floor = rec.firstScannedBlock ?? fromBlock;
  const rescanStart = Math.max(floor, Math.min(rec.lastScannedBlock + 1, head - REORG_DEPTH + 1));
  rec.logs = rec.logs.filter((l) => l.blockNumber < rescanStart);

  const filter = filterArgs.length > 0
    ? contract.filters[eventName](...filterArgs)
    : contract.filters[eventName]();

  const into = rec;
  const scanRange = async (from: number, to: number) => {
    let cursor = from;
    while (cursor <= to) {
      const chunkEnd = Math.min(cursor + CHUNK_SIZE - 1, to);
      const logs = await contract.queryFilter(filter, cursor, chunkEnd);
      for (const log of logs) {
        into.logs.push({
          blockNumber: log.blockNumber,
          index: (log as any).index ?? 0,
          transactionHash: log.transactionHash,
          address: log.address,
          topics: [...log.topics],
          data: log.data,
        });
      }
      cursor = chunkEnd + 1;
    }
  };

  // Backwards first — the "show me older" direction. Only the GAP below what is
  // already held is fetched; nothing cached is re-read.
  if (want < floor) {
    await scanRange(want, floor - 1);
    rec.firstScannedBlock = want;
  }

  // Then forward to the head. Single chunk in the warm path; many on cold start.
  await scanRange(rescanStart, head);
  rec.lastScannedBlock = head;

  // A backfill pushes older logs on after newer ones. Callers are entitled to
  // assume chain order, so restore it before storing or decoding.
  rec.logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));

  await writeRecord(rec);

  // Decode on read. parseLog needs {topics, data}; we attach the rest.
  const decoded: DecodedEvent[] = [];
  for (const log of rec.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) continue;
      decoded.push({
        args: parsed.args,
        blockNumber: log.blockNumber,
        index: log.index,
        transactionHash: log.transactionHash,
      });
    } catch {
      // Skip logs that no longer match the current ABI (e.g., contract upgrade).
    }
  }
  return decoded;
}

