"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { readJson, writeJson } = require("./state");
const { rawHeaderFor } = require("./header");

const ABI = [
  "event ProposalCreated(uint256 indexed proposalId, address indexed proposer, uint256 snapshotBlock, bytes32 snapshotBlockHash, bytes32 actionsHash, bytes32 descriptionHash, uint256 minTurnoutBps, uint256 approvalBps)",
  "function TOKEN() view returns (address)",
  "function ACTIVATION_WINDOW() view returns (uint256)",
  "function proposal(uint256) view returns (tuple(uint64 snapshotBlock, bytes32 snapshotBlockHash, bytes32 stateRoot, bytes32 tokenStorageRoot, uint48 voteStart, uint48 voteEnd, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes, bytes32 actionsHash, bytes32 descriptionHash, uint64 createdAtBlock, bool activated, uint16 minTurnoutBps, uint16 approvalBps, uint256 snapshotTotalSupply, bool finalized, bool passed, uint64 finalizedAt))",
  "function activateProposal(uint256 proposalId, bytes rawHeader, bytes[] tokenAccountProof, bytes[] totalSupplyProof)",
];

const TS_SLOT = ethers.zeroPadValue("0x02", 32);   // SatoriToken._totalSupply
const BALANCES_SLOT = 0n;                          // SatoriToken._balances

// keccak256(abi.encode(holder, 0)) — the RAW slot of balances[holder].
// eth_getProof takes the raw slot and hashes it for the trie path itself
// (holder-voting-review.md §10, the double-hash trap).
function balanceSlot(holder) {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256"], [holder, BALANCES_SLOT]));
}

// Bounded-concurrency worker pool; per-item failures are collected, not fatal.
async function pool(items, k, fn) {
  const it = items[Symbol.iterator]();
  let failures = 0;
  const workers = Array.from({ length: Math.max(1, k) }, async () => {
    for (;;) {
      const n = it.next();
      if (n.done) return;
      try { await fn(n.value); } catch { failures++; }
    }
  });
  await Promise.all(workers);
  return failures;
}

// One proposal's lifecycle, resumable from disk at every step:
//
//   seen -> header reconstructed -> account+totalSupply proofs fetched
//        -> ACTIVATED (tx, if we hold a key; else wait for anyone)
//        -> every candidate holder's balance proof fetched -> complete
//
// Each tick re-enters work() for every unfinished proposal, so a crash, a
// flaky RPC, or a restart never loses a proposal — it resumes at whichever
// step is still missing. What is genuinely unrecoverable is marked dead
// (activation window closed) or expired (voting over) and left alone.
class Pipeline {
  constructor(provider, signer, cfg, ledger) {
    this.provider = provider;
    this.signer = signer;
    this.cfg = cfg;
    this.ledger = ledger;
    this.iface = new ethers.Interface(ABI);
    this.gov = new ethers.Contract(cfg.governor, ABI, provider);
    this.govW = signer ? this.gov.connect(signer) : null;
    this.dir = path.join(cfg.dataDir, "proposals");
    this.indexFile = path.join(this.dir, "index.json");
    this.index = readJson(this.indexFile, { gcursor: cfg.startBlock - 1, ids: [] });
  }

  async init() {
    this.token = (await this.gov.TOKEN()).toLowerCase();
    this.window = Number(await this.gov.ACTIVATION_WINDOW());
  }

  metaFile(id) { return path.join(this.dir, id, "meta.json"); }
  proofFile(id, addr) { return path.join(this.dir, id, "proofs", addr.toLowerCase() + ".json"); }
  zerosFile(id) { return path.join(this.dir, id, "zeros.json"); }
  descriptionFile(id) { return path.join(this.dir, id, "description.txt"); }

  async tick(head) {
    // 1. New proposals since the cursor.
    while (this.index.gcursor < head) {
      const from = this.index.gcursor + 1;
      const to = Math.min(from + this.cfg.logChunk - 1, head);
      const logs = await this.provider.getLogs({
        address: this.cfg.governor,
        topics: [this.iface.getEvent("ProposalCreated").topicHash],
        fromBlock: from, toBlock: to,
      });
      for (const lg of logs) this._seen(this.iface.parseLog(lg), lg.blockNumber);
      this.index.gcursor = to;
      writeJson(this.indexFile, this.index);
    }
    // 2. Push every unfinished proposal one step further.
    for (const id of this.index.ids) await this._work(id, head);
  }

  _seen(ev, createdAtBlock) {
    const id = ev.args.proposalId.toString();
    if (this.index.ids.includes(id)) return;
    writeJson(this.metaFile(id), {
      id,
      proposer: ev.args.proposer,
      snapshotBlock: Number(ev.args.snapshotBlock),
      snapshotBlockHash: ev.args.snapshotBlockHash,
      createdAtBlock,
      deadlineBlock: createdAtBlock + this.window,
      actionsHash: ev.args.actionsHash,
      descriptionHash: ev.args.descriptionHash,
      minTurnoutBps: Number(ev.args.minTurnoutBps),
      approvalBps: Number(ev.args.approvalBps),
      activated: false,
      proofsComplete: false,
    });
    this.index.ids.push(id);
    writeJson(this.indexFile, this.index);
  }

  async _work(id, head) {
    const meta = readJson(this.metaFile(id), null);
    if (!meta) return;
    // Fill in times a lagging node withheld at activation — even on an
    // otherwise-finished proposal, since consumers read voteEnd from meta.
    if (meta.activated && !meta.voteEnd) {
      try {
        const p2 = await this.gov.proposal(id);
        if (p2.activated && Number(p2.voteEnd) > 0) {
          meta.voteStart = Number(p2.voteStart);
          meta.voteEnd = Number(p2.voteEnd);
          this._save(id, meta);
        }
      } catch { /* next tick */ }
    }
    if (meta.dead || meta.expired || meta.proofsComplete) return;
    try {
      const S = meta.snapshotBlock;
      const hexS = "0x" + S.toString(16);

      // Header: reconstruct and refuse anything that does not hash to the
      // snapshot hash the proposal itself committed to.
      if (!meta.rawHeader) {
        const b = await this.provider.send("eth_getBlockByNumber", [hexS, false]);
        if (!b) throw new Error(`snapshot block ${S} not returned by RPC`);
        const raw = rawHeaderFor(b);
        if (ethers.keccak256(raw).toLowerCase() !== meta.snapshotBlockHash.toLowerCase()) {
          throw new Error(`reconstructed header does not match proposal snapshot hash`);
        }
        meta.rawHeader = raw;
        this._save(id, meta);
      }

      // Token account proof + totalSupply proof: one call, both from it.
      if (!meta.accountProof) {
        const pr = await this.provider.send("eth_getProof", [this.token, [TS_SLOT], hexS]);
        meta.accountProof = pr.accountProof;
        meta.totalSupplyProof = pr.storageProof[0].proof;
        meta.snapshotTotalSupply = BigInt(pr.storageProof[0].value ?? "0x0").toString();
        this._save(id, meta);
      }

      // Activation: ours if we hold a key, anyone's otherwise. Permissionless
      // by design — the worst a activator can do is submit data that reverts.
      if (!meta.activated) {
        let p = await this.gov.proposal(id);
        if (!p.activated) {
          if (head > meta.deadlineBlock) {
            meta.dead = "activation-window-closed";
            this._save(id, meta);
            return;
          }
          if (!this.govW) { this._save(id, meta); return; }  // wait for someone else
          try {
            const tx = await this.govW.activateProposal(
              id, meta.rawHeader, meta.accountProof, meta.totalSupplyProof);
            await tx.wait();
            meta.activationTx = tx.hash;
          } catch (e) {
            p = await this.gov.proposal(id);       // raced by another activator?
            if (!p.activated) throw e;
          }
          p = await this.gov.proposal(id);
        }
        meta.activated = true;
        // The public RPC load-balances across nodes that can lag a confirmed
        // receipt: this re-read may still show the pre-activation struct
        // (voteEnd 0). Store times only when the read attests activation;
        // the fill-in below completes them on a later tick.
        if (p.activated) {
          meta.voteStart = Number(p.voteStart);
          meta.voteEnd = Number(p.voteEnd);
        }
        this._save(id, meta);
      }


      // Proofs are useless once voting has closed; stop retrying then.
      if (meta.voteEnd && Date.now() / 1000 > meta.voteEnd && !meta.proofsComplete) {
        meta.expired = "voting-closed-before-proofs-complete";
        this._save(id, meta);
        return;
      }

      // Balance proofs for every candidate holder at S. Files on disk are the
      // progress marker, so a restart resumes instead of refetching.
      await this.ledger.advanceTo(S);
      const zeros = new Set(readJson(this.zerosFile(id), { addrs: [] }).addrs);
      const todo = this.ledger.holdersAt(S).filter(
        (a) => !zeros.has(a) && !fs.existsSync(this.proofFile(id, a)));
      const failures = await pool(todo, this.cfg.proofConcurrency, async (addr) => {
        const pr = await this.provider.send(
          "eth_getProof", [this.token, [balanceSlot(addr)], hexS]);
        const bal = BigInt(pr.storageProof[0].value ?? "0x0");
        if (bal > 0n) {
          writeJson(this.proofFile(id, addr), {
            address: addr,
            balance: bal.toString(),
            snapshotBlock: S,
            proof: pr.storageProof[0].proof,
          });
        } else {
          zeros.add(addr);
        }
      });
      writeJson(this.zerosFile(id), { addrs: [...zeros] });
      if (failures === 0) {
        meta.proofsComplete = true;
        meta.holderCount = fs.existsSync(path.join(this.dir, id, "proofs"))
          ? fs.readdirSync(path.join(this.dir, id, "proofs")).length : 0;
        meta.zeroCount = zeros.size;
        meta.lastError = null;
      } else {
        meta.lastError = `${failures} proof fetches failed; retrying`;
      }
      this._save(id, meta);
    } catch (e) {
      meta.lastError = String((e && e.message) || e);
      this._save(id, meta);
    }
  }

  _save(id, meta) {
    meta.updatedAt = Math.floor(Date.now() / 1000);
    writeJson(this.metaFile(id), meta);
  }

  // ---- read side, for the HTTP server ----
  list() {
    return this.index.ids.map((id) => {
      const m = readJson(this.metaFile(id), {});
      return {
        id,
        snapshotBlock: m.snapshotBlock,
        activated: !!m.activated,
        proofsComplete: !!m.proofsComplete,
        dead: m.dead || null,
        expired: m.expired || null,
        holderCount: m.holderCount,
        voteEnd: m.voteEnd,
      };
    });
  }
  meta(id) {
    const m = readJson(this.metaFile(id), null);
    if (m) {
      try { m.description = fs.readFileSync(this.descriptionFile(id), "utf8"); }
      catch { m.description = null; }
    }
    return m;
  }

  // The chain commits to keccak256 of the words; anyone may supply the words,
  // because only the right ones fit the commitment. Self-verifying, so no
  // authentication — a wrong text is rejected, the right text is public anyway.
  setDescription(id, text) {
    const m = readJson(this.metaFile(id), null);
    if (!m) return { ok: false, code: 404, error: "unknown proposal" };
    const got = ethers.keccak256(ethers.toUtf8Bytes(text));
    if (got.toLowerCase() !== (m.descriptionHash || "").toLowerCase()) {
      return { ok: false, code: 400,
               error: `text does not hash to the proposal's commitment`,
               expected: m.descriptionHash, got };
    }
    fs.mkdirSync(path.dirname(this.descriptionFile(id)), { recursive: true });
    fs.writeFileSync(this.descriptionFile(id), text);
    return { ok: true };
  }
  proof(id, addr) { return readJson(this.proofFile(id, addr), null); }
}

module.exports = { Pipeline, balanceSlot };
