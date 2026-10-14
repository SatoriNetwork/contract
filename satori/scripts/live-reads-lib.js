// Reading state back on a LIVE network, where reads are eventually consistent.
//
// Shared by scripts/deploy.js, scripts/deploy-safe.js and test/LiveReads.test.js
// so the deploy-day behaviour and the tested behaviour can never disagree — the
// same split contract-sizes-lib.js and storage-layout-lib.js use.
//
// THE PROBLEM
// Public RPC endpoints are load-balanced across many nodes. A transaction receipt
// proves ONE node saw the block; the next JSON-RPC call is a fresh request with no
// guarantee it lands on a node as far along. So a pointer set moments ago can read
// back as address(0), and freshly deployed code can read back as "0x".
//
// A RECEIPT IS NOT A READ BARRIER. Every local run hides this: hardhat's in-memory
// node is a single process where a read after a write is trivially consistent, and
// until the first live deploy that is the only place these scripts had ever run.
//
// Hit for real on 2026-08-01 deploying the Base Sepolia rehearsal Safe: the tx
// succeeded, emitted ProxyCreation naming the address, and the getCode issued
// moments later returned "0x". See
// docs/issues/closed/rpc-read-after-write-lag-on-live-networks.md.
//
// WHY THIS IS NOT JUST AN ANNOYANCE
// The naive response to a failed post-condition is to redeploy. Over lag that is
// exactly wrong: it spends a second full stack, and on mainnet a second immutable
// PLATFORM_FEE_RECIPIENT that can never be corrected. So the goal is not merely to
// pass more often — it is to make the failure message distinguish "could not
// confirm" from "is broken", because the two demand opposite responses.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Run every probe, then RE-run only the ones that failed, up to `attempts` times.
///
/// The property that matters is preserved exactly: a genuinely wrong value fails
/// every attempt and still fails the caller. Only a stale read benefits, because it
/// resolves the moment the node catches up.
///
/// A probe that THROWS counts as "not confirmed" rather than propagating — a node
/// that cannot yet see the contract reverts the call instead of returning a wrong
/// value, which is the same lag wearing a different hat. The last error is kept and
/// returned, so a genuine fault can still report why it failed.
///
/// Note the asymmetry: re-reading rescues checks comparing against a value the
/// caller just WROTE (a stale read returns the zero default and fails). Checks
/// asserting an UNCHANGED default read that same zero default whether the node is
/// current or stale — they cannot be rescued this way and do not need to be.
///
/// @param checks  [name, async () => boolean][]  — probes, not precomputed booleans
/// @returns {passedOn: Map<name, attempt>, failed: [name, probe][], lastError: Map}
async function runChecks(checks, { attempts = 1, delayMs = 0, log = () => {} } = {}) {
  if (attempts < 1) throw new Error("attempts must be >= 1");
  const passedOn = new Map();
  const lastError = new Map();
  let pending = checks;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const failing = [];
    for (const [name, probe] of pending) {
      try {
        if (await probe()) { passedOn.set(name, attempt); continue; }
        lastError.delete(name); // failed cleanly this time — no error to report
      } catch (e) {
        lastError.set(name, e.shortMessage || e.message);
      }
      failing.push([name, probe]);
    }
    if (!failing.length) return { passedOn, failed: [], lastError };
    pending = failing;
    if (attempt < attempts) {
      log(`  ${failing.length} not confirmed (attempt ${attempt}/${attempts}) — re-reading in ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
  return { passedOn, failed: pending, lastError };
}

/// Wait for the chain head to reach `target` before reading state written at or
/// before it. A barrier, not a guarantee: the load balancer can still route the
/// next call to a node that is behind, which is what runChecks() is for.
async function waitForHead(provider, target, { tries = 15, delayMs = 2000, log = () => {} } = {}) {
  for (let i = 0; i < tries; i++) {
    if ((await provider.getBlockNumber()) >= target) return true;
    if (i === 0) log(`  waiting for chain head to reach block ${target}...`);
    await sleep(delayMs);
  }
  return false;
}

/// Poll until `addr` has code, returning its size in bytes (0 if it never appears).
/// Callers must NOT report an empty result as "deployment failed" — say it could
/// not be confirmed, and send the operator to a block explorer before redeploying.
async function waitForCode(provider, addr, { tries = 12, delayMs = 2500, log = () => {} } = {}) {
  for (let i = 0; i < tries; i++) {
    const code = await provider.getCode(addr);
    if (code !== "0x") return (code.length - 2) / 2;
    if (i === 0) log(`  (no code yet at ${addr} — RPC lag, polling)`);
    await sleep(delayMs);
  }
  return 0;
}

/// Retry/barrier settings by network. An in-memory node is a single process where
/// reads are instantaneous and consistent, so one attempt is both correct and the
/// fastest possible failure — local behaviour stays exactly as it was.
function readPolicy(networkName) {
  const local = networkName === "localhost" || networkName === "hardhat";
  return local
    ? { local: true, attempts: 1, delayMs: 0 }
    : { local: false, attempts: 5, delayMs: 4000 };
}

module.exports = { sleep, runChecks, waitForHead, waitForCode, readPolicy };
