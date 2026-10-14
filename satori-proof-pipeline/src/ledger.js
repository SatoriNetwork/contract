"use strict";
const path = require("path");
const { ethers } = require("ethers");
const { readJson, writeJson } = require("./state");

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const ZERO = "0x0000000000000000000000000000000000000000";

// How long a drained-to-zero account stays remembered. A holder at snapshot S
// who is empty by the time we enumerate must still get a proof, and such a
// holder ALWAYS appears in a Transfer after S — so remembering zero-balance
// accounts for 2048 blocks (over an hour on Base) is a strict superset of what
// any live proposal can need: its whole activation window is at most 256.
const PRUNE_DEPTH = 2048;

// The token's Transfer history, folded into a balance map with a cursor.
// This is the bridge's discipline (one process, one cursor) applied to the
// one question eth_getProof cannot answer: WHO should we fetch proofs for.
// The ledger only nominates candidates — every balance that matters is then
// proved from the snapshot's own storage root, so a ledger bug can cost
// completeness, never correctness.
class Ledger {
  constructor(provider, tokenAddr, cfg) {
    this.provider = provider;
    this.token = tokenAddr.toLowerCase();
    this.chunk = cfg.logChunk;
    this.file = path.join(cfg.dataDir, "ledger.json");
    this.state = readJson(this.file, { cursor: cfg.startBlock - 1, holders: {} });
    this._q = Promise.resolve();      // advance mutex: two callers, one scan
    this._dirty = 0;
  }

  cursor() { return this.state.cursor; }
  holderCount() { return Object.keys(this.state.holders).length; }

  // Serialized: the proposal worker and the keep-warm loop both call this.
  advanceTo(target) {
    const run = this._q.then(() => this._advance(target));
    // Keep the chain alive even when a scan fails; the failure still
    // propagates to the caller that asked for it.
    this._q = run.catch(() => {});
    return run;
  }

  async _advance(target) {
    while (this.state.cursor < target) {
      const from = this.state.cursor + 1;
      const to = Math.min(from + this.chunk - 1, target);
      let logs;
      try {
        logs = await this.provider.getLogs({
          address: this.token, topics: [TRANSFER], fromBlock: from, toBlock: to,
        });
      } catch (e) {
        // Public RPCs cap ranges and result counts; adapt and let the next
        // attempt retry smaller rather than wedging on one chunk size.
        if (this.chunk > 500) this.chunk = Math.max(500, Math.floor(this.chunk / 2));
        throw e;
      }
      for (const lg of logs) {
        const fromA = "0x" + lg.topics[1].slice(26);
        const toA = "0x" + lg.topics[2].slice(26);
        const v = BigInt(lg.data);
        if (fromA !== ZERO) this._sub(fromA, v, lg.blockNumber);
        if (toA !== ZERO) this._add(toA, v, lg.blockNumber);
      }
      this.state.cursor = to;
      if (++this._dirty >= 20) this._persist();
    }
    this._persist();
  }

  _add(addr, v, blk) {
    const h = (this.state.holders[addr] ??= { b: "0", t: 0 });
    h.b = (BigInt(h.b) + v).toString();
    h.t = blk;
  }

  _sub(addr, v, blk) {
    const h = (this.state.holders[addr] ??= { b: "0", t: 0 });
    let nb = BigInt(h.b) - v;
    if (nb < 0n) nb = 0n;   // cannot happen on a correct scan; never go negative
    h.b = nb.toString();
    h.t = blk;
  }

  _persist() {
    const cut = this.state.cursor - PRUNE_DEPTH;
    for (const [a, h] of Object.entries(this.state.holders)) {
      if (h.b === "0" && h.t < cut) delete this.state.holders[a];
    }
    writeJson(this.file, this.state);
    this._dirty = 0;
  }

  // Candidate voters for snapshot block S. Call only after advanceTo(>= S).
  // balance > 0 now, OR touched since the snapshot (may have held at S and
  // drained after). A candidate who turns out to have held nothing at S costs
  // one wasted eth_getProof, nothing more.
  holdersAt(S) {
    const out = [];
    for (const [a, h] of Object.entries(this.state.holders)) {
      if (h.b !== "0" || h.t >= S) out.push(a);
    }
    return out;
  }
}

module.exports = { Ledger };
