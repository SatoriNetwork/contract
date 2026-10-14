import { CHUNK_SIZE } from '../utils/eventCache';

// The scan window for the history tab: how far back from the head we read, and
// how it grows when the user asks for older activity.
//
// See docs/design/dapp-history-tab.md §4 for the reasoning. The short version:
//
// Logs are not range-addressable by COUNT — no node will answer "rows 26 to 50".
// So paging is addressed by BLOCK SPAN instead: widen the window and take
// whatever rows fall in it. The boundary is not a row count and does not need to
// be; it only needs to yield more.
//
// The budget is denominated in CHUNKS rather than blocks or days because the
// chunk is the actual unit of cost: `eth_getLogs` is capped at ~10k blocks by
// most providers, so a scan costs ceil(span / CHUNK_SIZE) requests PER EVENT
// STREAM, and the history tab reads 17 of them. Budgeting in chunks is also what
// makes this chain-agnostic with no calibration RPC — 12 chunks is ~2.8 days on
// a 2s-block chain and the entire history on a local dev node, and in both cases
// it is the same bounded first-paint cost, which is the thing being controlled.

/// First window: ~12 requests per event stream, whatever chain this is.
export const FIRST_CHUNKS = 12;

/// The oldest block the window reaches, clamped so we never read below the
/// deployment — there is nothing there, and asking costs the same as asking for
/// something.
export function windowStart(chunks: number, head: number, deploymentBlock: number): number {
  return Math.max(deploymentBlock, head - chunks * CHUNK_SIZE + 1);
}

/// Widening step. ×4, not ×2: the later steps are expensive by construction, and
/// that is acceptable precisely because they are user-initiated — but someone
/// asking for two-year-old history should get there in a few clicks rather than
/// a dozen. 12 → 48 → 192 → 768 → 3072 chunks (~30M blocks) covers any chain
/// this runs on.
export function nextChunks(chunks: number): number {
  return chunks * 4;
}

/// True once the window has reached the deployment block: everything there is to
/// read has been read, and the "load older" control has nothing left to do.
export function isComplete(start: number, deploymentBlock: number): boolean {
  return start <= deploymentBlock;
}
