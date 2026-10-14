// Storage-layout guardrail for the upgradeable implementations (phase 2,
// PHASE2-PROXY-ALL.md). Behind a proxy, a storage-layout mistake in a new
// implementation corrupts LIVE state instead of failing a test — so every
// tracked contract's layout is pinned to a committed baseline.
//
//   npx hardhat run scripts/check-storage-layout.js            # compare
//   LAYOUT_SNAPSHOT=1 npx hardhat run scripts/check-storage-layout.js  # re-baseline
//
// Rules: every baseline entry must still exist with the same label, slot,
// offset, and (normalized) type, in the same order. NEW entries may only
// APPEND — the append-only convention, machine-checked. Re-baselining is a
// deliberate act, reviewed like a migration.
//
// The comparison logic lives in ./storage-layout-lib.js and is shared with
// test/StorageLayout.test.js (audit F24), so the CLI and the in-suite guard
// can never disagree.
const fs = require("fs");
const path = require("path");
const { TRACKED, BASELINE_DIR, layoutOf, diffLayout } = require("./storage-layout-lib");

async function main() {
  const snapshot = !!process.env.LAYOUT_SNAPSHOT;
  if (snapshot) fs.mkdirSync(BASELINE_DIR, { recursive: true });

  let failed = 0;
  for (const fq of TRACKED) {
    const name = fq.split(":")[1];
    const current = await layoutOf(fq);
    const baselinePath = path.join(BASELINE_DIR, `${name}.json`);

    if (snapshot) {
      fs.writeFileSync(baselinePath, JSON.stringify(current, null, 2) + "\n");
      console.log(`SNAPSHOT ${name}: ${current.length} entr${current.length === 1 ? "y" : "ies"}`);
      continue;
    }

    if (!fs.existsSync(baselinePath)) {
      console.error(`MISSING baseline for ${name} — run with LAYOUT_SNAPSHOT=1 once`);
      failed++;
      continue;
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const violations = diffLayout(baseline, current);
    if (violations.length) {
      for (const v of violations) {
        console.error(`LAYOUT BREAK ${name}[${v.index}]: baseline ${JSON.stringify(v.baseline)} vs current ${JSON.stringify(v.current)}`);
      }
      failed++;
      continue;
    }
    if (current.length > baseline.length) {
      for (let i = baseline.length; i < current.length; i++) {
        console.log(`  ${name}: appended ${current[i].label} @ slot ${current[i].slot} (ok — re-baseline when intentional)`);
      }
    }
    console.log(`OK ${name} (${baseline.length} pinned${current.length > baseline.length ? `, +${current.length - baseline.length} appended` : ""})`);
  }

  if (failed) {
    throw new Error(`${failed} contract(s) broke their pinned storage layout — a proxy upgrade with this implementation would corrupt live state`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
