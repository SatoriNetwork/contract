// Shared storage-layout logic for the upgradeable implementations (phase 2,
// PHASE2-PROXY-ALL.md). Behind a proxy, a storage-layout mistake in a new
// implementation corrupts LIVE state instead of failing a test — so every
// tracked contract's layout is pinned to a committed baseline and the layout is
// enforced APPEND-ONLY.
//
// This module is the single source of truth for BOTH:
//   - scripts/check-storage-layout.js  (CLI: compare / re-baseline)
//   - test/StorageLayout.test.js        (audit F24: enforced in the test suite)
// so the two can never drift.
const hre = require("hardhat");
const path = require("path");
const { sourcePrefix } = require("./source-prefix");

// The 8 upgradeable implementations pinned behind SatoriProxy, listed relative
// to the sources dir and qualified at load (see source-prefix.js) so the lookup
// cannot miss because of where hardhat was invoked from.
const TRACKED = [
  "SatoriVoting.sol:SatoriVoting",
  "SatoriRewards.sol:SatoriRewards",
  "SatoriRegistry.sol:SatoriRegistry",
  "SatoriGames.sol:SatoriGames",
  "SatoriBounties.sol:SatoriBounties",
  "next/SatoriHub.sol:SatoriHub",
  "next/SatoriEngine.sol:SatoriEngine",
  // Merkle became upgradeable 2026-08-01 (it was absent here because it was
  // deployed directly and could never be upgraded). Its storage is the claim
  // ledger — per-user cursors and the cumulative total — so a layout slip on a
  // future upgrade would mis-read who has already been paid.
  "SatoriMerkle.sol:SatoriMerkle",
].map((entry) => sourcePrefix() + entry);

const BASELINE_DIR = path.join(__dirname, "..", "storage-layouts");

// Solc type identifiers embed AST node ids (t_struct(FeeSlot)5163_storage)
// that shift with unrelated edits — strip them so only real type changes trip.
const normType = (t) => t.replace(/\)\d+/g, ")");

// The full shape of a type as a canonical string, so a change INSIDE a struct
// (a field added, reordered or retyped) is as visible as a change to a top-level
// variable. Solc's `types` table describes structs, mappings and arrays by id;
// ids carry AST node numbers, so they are replaced by their labels. A struct that
// reaches itself through a mapping is cut at the second visit.
function shapeOf(types, id, seen = new Set()) {
  const t = types[id];
  if (!t) return normType(id);
  if (seen.has(id)) return `ref(${t.label})`;
  const next = new Set(seen).add(id);
  if (t.members) {
    const members = t.members.map((m) => `${m.label}@${m.slot}.${m.offset}:${shapeOf(types, m.type, next)}`);
    return `${t.label}{${members.join(",")}}`;
  }
  if (t.key && t.value) return `mapping(${shapeOf(types, t.key, next)}=>${shapeOf(types, t.value, next)})`;
  if (t.base) return `${normType(t.label)}[${shapeOf(types, t.base, next)}]`;
  return `${normType(t.label)}/${t.numberOfBytes}`;
}

// Extract the normalized storage layout (label/slot/offset/type/shape per entry,
// in declaration order) for a fully-qualified contract name from the build info.
async function layoutOf(fqName) {
  const buildInfo = await hre.artifacts.getBuildInfo(fqName);
  if (!buildInfo) throw new Error(`no build info for ${fqName} — compile first`);
  const [src, name] = fqName.split(":");
  const layout = buildInfo.output.contracts[src][name].storageLayout;
  if (!layout) throw new Error(`no storageLayout in artifacts for ${fqName} — check hardhat.config outputSelection`);
  return layout.storage.map((s) => ({
    label: s.label,
    slot: s.slot,
    offset: s.offset,
    type: normType(s.type),
    shape: shapeOf(layout.types, s.type),
  }));
}

// Append-only diff: every BASELINE entry must still exist at the same index with
// the same label/slot/offset/type. NEW entries beyond the baseline length are
// allowed (pure append) and produce no violation. Returns the list of
// violations (empty === layout still safe for a proxy upgrade).
function diffLayout(baseline, current) {
  const violations = [];
  for (let i = 0; i < baseline.length; i++) {
    const b = baseline[i];
    const c = current[i];
    // `shape` is compared when the baseline records it (older baselines do not).
    if (!c || c.label !== b.label || c.slot !== b.slot || c.offset !== b.offset || c.type !== b.type
        || (b.shape !== undefined && c.shape !== b.shape)) {
      violations.push({ index: i, baseline: b, current: c ?? null });
    }
  }
  return violations;
}

module.exports = { TRACKED, BASELINE_DIR, normType, shapeOf, layoutOf, diffLayout };
