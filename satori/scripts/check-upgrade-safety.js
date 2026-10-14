#!/usr/bin/env node
// UPGRADE SAFETY: does this source still match the layout of the LIVE proxy?
//
//   CONTRACT=SatoriRewards NETWORK=baseSepolia node scripts/check-upgrade-safety.js
//   (or let scripts/deploy-impl.js run it for you — it will not print Safe
//    calldata until this passes)
//
// ── THE HOLE THIS PLUGS ────────────────────────────────────────────────────
// `check-storage-layout.js` / `StorageLayout.test.js` compare the CURRENT SOURCE
// against a COMMITTED BASELINE FILE. That catches a careless edit, and it is
// worth keeping. It cannot catch the thing that actually bites, because the
// baseline is a file in the repo and the storage is on a chain, and those two
// drift independently:
//
//   * re-baselining is a normal, allowed act (LAYOUT_SNAPSHOT=1). Do it after a
//     mid-layout edit and the guard is happy forever after — with a baseline
//     that no longer describes anything deployed.
//   * a long-lived deployment falls further behind main with every merge. The
//     baseline tracks main. The chain does not.
//
// WHAT WENT WRONG ON BASE SEPOLIA, 2026-08-30. SatoriRewards was upgraded to an
// implementation whose layout had drifted TWO SLOTS from the deployed proxy:
//
//     slot 34   deployed: satoriEngine + airdropStart   source: marketingFeeRecipient
//     slot 35   deployed: satoriToken  + _initialized   source: pendingMarketingFeeRecipient
//     slot 36   deployed: marketingFeeRecipient         source: _frozenQ
//
// The source guard passed — source matched its baseline. The upgrade executed,
// because the OLD code read `satoriToken` from slot 35 and found the real token.
// The NEW code reads slot 33, finds zero, and `_upgradeGovernor()` —
// `ISatoriGovernorSource(satoriToken).rootAuthority()` — now reverts on the
// extcodesize check against address(0). The proxy can no longer be upgraded by
// anyone. It was a testnet, so the cost was a redeploy. On mainnet the same
// sequence is unrecoverable, and it would have mis-read the reward ledger too.
//
// ── WHAT THIS CHECKS ───────────────────────────────────────────────────────
// The layout that was actually deployed, recorded into deployments/<net>.json
// by deploy.js at deploy time, is the ground truth. Current source is diffed
// against THAT. Appending is fine; anything that moves an existing variable is
// refused.
//
// If a deployment predates layout recording there is nothing to compare, and
// this REFUSES rather than assuming the best — an unverifiable upgrade is
// exactly the case that produced the incident above.
const fs = require("fs");
const path = require("path");
const { layoutOf, diffLayout, TRACKED } = require("./storage-layout-lib");

async function main() {
  const name = process.env.CONTRACT;
  const net = process.env.NETWORK || process.env.HARDHAT_NETWORK;
  if (!name || !net) throw new Error("set CONTRACT= and NETWORK=");

  const bookPath = path.join(__dirname, "..", "deployments", `${net}.json`);
  if (!fs.existsSync(bookPath)) throw new Error(`no deployment book at ${bookPath}`);
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));

  const recorded = book.layouts && book.layouts[name];
  if (!recorded) {
    console.error(`
  REFUSING: ${net}.json records no deployed layout for ${name}.

  This deployment predates layout recording, so there is nothing to verify the
  candidate against — the upgrade cannot be shown to be safe, only assumed to
  be. That assumption is what bricked SatoriRewards on Base Sepolia.

  Either redeploy (deploy.js records layouts now), or reconstruct the deployed
  layout from the source commit that produced it and paste it in under
  "layouts": { "${name}": [...] }.
`);
    process.exit(1);
  }

  const fq = TRACKED.find((t) => t.endsWith(`:${name}`));
  if (!fq) throw new Error(`${name} is not in TRACKED — add it to storage-layout-lib.js`);

  const current = await layoutOf(fq);
  const violations = diffLayout(recorded, current);

  if (violations.length) {
    console.error(`
  UNSAFE TO UPGRADE — ${name} on ${net}

  Current source does NOT match the layout deployed at this proxy. Installing it
  would make the new code read live storage through the wrong map: balances,
  cursors and role pointers all silently resolve to the wrong slots.

  ${JSON.stringify(violations, null, 2)}

  Do NOT re-baseline to make this pass — the baseline is not what is deployed.
  Either restore the layout (append instead of insert), or redeploy the stack.
`);
    process.exit(1);
  }

  console.log(`  SAFE: ${name} source is append-only vs the layout deployed on ${net}`);
  console.log(`  (${recorded.length} recorded entries -> ${current.length} current)`);
}

main().catch((e) => { console.error("\n  ERR:", e.message, "\n"); process.exit(1); });
