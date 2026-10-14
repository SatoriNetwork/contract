"use strict";

// Everything the pipeline needs, from the environment, checked at boot.
// Fail fast and loud: a proposal's activation window is ~2 minutes on Base,
// so "running but misconfigured" must be impossible.

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`set ${name}`);
  return v;
}
function num(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} is not a number: ${v}`);
  return n;
}

module.exports = () => ({
  rpcUrl: req("RPC_URL"),
  governor: req("GOVERNOR_ADDRESS"),
  // First block worth scanning: the TOKEN's deploy block. Not strictly
  // required, but a 0 default against a mainnet RPC means a needlessly long
  // first backfill.
  startBlock: num("START_BLOCK", 0),
  // Optional. Without it the pipeline still reconstructs headers and
  // precomputes every proof, but cannot send the activation transaction —
  // it waits for someone else to. With it, activation is automatic; the key
  // needs only dust ETH and can do nothing except submit data that verifies.
  activatorKey: process.env.ACTIVATOR_PRIVATE_KEY || null,
  port: num("PORT", 8788),
  pollMs: num("POLL_MS", 3000),
  logChunk: num("LOG_CHUNK", 1900),
  proofConcurrency: num("PROOF_CONCURRENCY", 8),
  dataDir: process.env.DATA_DIR || "/data",
});
