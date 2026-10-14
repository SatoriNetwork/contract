"use strict";
const http = require("http");
const { ethers } = require("ethers");

// Read-only HTTP API. Same posture as the indexer: the pipeline is the only
// writer of its /data; everyone else (the dapp's vote page, a curious human)
// is an ordinary HTTP client.
//
//   GET /health                       liveness
//   GET /status                       cursors, counts, last errors
//   GET /proposals                    every proposal seen, one line each
//   GET /proposals/:id                full meta incl. rawHeader + account proof
//                                     (enough to activate BY HAND if no key runs)
//   GET /proposals/:id/proof/:addr    the ballot payload: { balance, proof }
//                                     — exactly castVote's second argument
//
// Plus ONE write, and only because it cannot lie:
//
//   POST /proposals/:id/description   raw utf-8 body; accepted only if it
//                                     keccak-hashes to the proposal's on-chain
//                                     descriptionHash. Unauthenticated on
//                                     purpose — only the right words fit.

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

// Proposal ids are decimal on disk; accept hex from callers too.
function normId(s) {
  try { return BigInt(s).toString(); } catch { return null; }
}

function start(cfg, { status, ledger, pipeline }) {
  const srv = http.createServer((req, res) => {
    try {
      const parts = req.url.split("?")[0].split("/").filter(Boolean);

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }

      if (req.method === "POST" && parts.length === 3 &&
          parts[0] === "proposals" && parts[2] === "description") {
        const id = normId(parts[1]);
        if (!id) return json(res, 400, { error: "bad proposal id" });
        let body = "";
        let over = false;
        req.on("data", (d) => {
          body += d;
          if (body.length > 65536) { over = true; req.destroy(); }
        });
        req.on("end", () => {
          if (over) return json(res, 413, { error: "description over 64KB" });
          const r = pipeline.setDescription(id, body);
          return r.ok ? json(res, 200, { ok: true }) : json(res, r.code, r);
        });
        return;
      }

      if (req.method !== "GET") return json(res, 405, { error: "GET only" });

      if (parts.length === 1 && parts[0] === "health") return json(res, 200, { ok: true });

      if (parts.length === 1 && parts[0] === "status") {
        return json(res, 200, {
          ...status,
          ledgerCursor: ledger.cursor(),
          holders: ledger.holderCount(),
          proposals: pipeline.list(),
        });
      }

      if (parts[0] === "proposals" && parts.length === 1) {
        return json(res, 200, pipeline.list());
      }

      if (parts[0] === "proposals" && parts.length === 2) {
        const id = normId(parts[1]);
        const m = id && pipeline.meta(id);
        return m ? json(res, 200, m) : json(res, 404, { error: "unknown proposal" });
      }

      if (parts[0] === "proposals" && parts.length === 4 && parts[2] === "proof") {
        const id = normId(parts[1]);
        if (!id || !ethers.isAddress(parts[3])) return json(res, 400, { error: "bad id or address" });
        const p = pipeline.proof(id, parts[3]);
        return p ? json(res, 200, p)
                 : json(res, 404, { error: "no proof (zero balance at snapshot, or not yet computed)" });
      }

      return json(res, 404, { error: "unknown route" });
    } catch (e) {
      return json(res, 500, { error: String((e && e.message) || e) });
    }
  });
  srv.listen(cfg.port);
  return srv;
}

module.exports = { start };
