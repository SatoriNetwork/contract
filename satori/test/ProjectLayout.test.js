// One hardhat project, one config. Enforced, because the alternative already
// bit us.
//
// There used to be a SECOND config at the repo root, left over from before the
// monolith was split out. It pointed at the same sources and the same artifacts
// directory but named contracts differently (source names are relative to the
// PROJECT ROOT), carried no `outputSelection` for storage layouts, and set a
// stale chain id and a Sepolia network this project no longer targets.
//
// The damage was not that it was wrong. It was that running the suite through it
// silently DISARMED both deploy guards: the storage-layout guard could not
// resolve a single contract, and the size guard matched zero contracts. Whichever
// directory you had compiled from last decided whether they measured anything.
// (docs/issues/closed/hardhat-guards-silently-fail-from-repo-root.md)
//
// The guards now derive their names from the live config (scripts/source-prefix.js),
// so a second project could no longer blind them the same way. This test covers
// the other half: two configs for one contract set is a trap regardless, and the
// cheapest moment to catch a reintroduced one is the moment it lands.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

// Directories this scan does not walk.
//
// `VERSION1`, `VERSION2` and `satori-ui-v1` used to be listed here as
// "superseded snapshots kept for reference". All three were DELETED on
// 2026-08-21 — 2,498 files, roughly four times the size of the live project,
// last touched 2026-07-23 and referenced by nothing. Git is the archive; a
// working tree is not. They are recoverable from commit 635f1ea2.
//
// The names are deliberately NOT kept in this set. A skip-entry for a
// directory that no longer exists is an invitation to recreate it.
//
// Worth knowing why they were skipped at all: **VERSION1 contained a real
// `hardhat.config.js`** — the exact second-project-root hazard this file was
// written to catch, and which the header above describes as having silently
// disarmed both deploy guards. The skip list was not hiding clutter; it was
// holding this test's mouth shut about a genuine one. With the snapshots gone
// the scan walks the whole tree with no exclusions and still finds exactly one.
const ARCHIVED = new Set(["node_modules", ".git"]);

function findConfigs(dir, repoRoot, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (ARCHIVED.has(entry.name)) continue;
      findConfigs(path.join(dir, entry.name), repoRoot, found);
    } else if (entry.name === "hardhat.config.js") {
      found.push(path.relative(repoRoot, path.join(dir, entry.name)));
    }
  }
  return found;
}

describe("Project layout — exactly one hardhat project", function () {
  it("satori/hardhat.config.js is the only live hardhat config", function () {
    const repoRoot = path.join(__dirname, "..", "..");
    const configs = findConfigs(repoRoot, repoRoot).sort();

    expect(
      configs,
      "More than one hardhat config means one contract set with two project roots, " +
        "two sets of fully-qualified names and two artifact trees that prune each " +
        "other. That is what silently disarmed the size and storage-layout guards. " +
        "If a second project is genuinely needed, give it its own sources and " +
        "artifacts paths and update this test to say why."
    ).to.deep.equal(["satori/hardhat.config.js"]);
  });

  it("the guards resolve their source prefix from that config, not a hardcoded string", function () {
    const { sourcePrefix } = require("../scripts/source-prefix");
    const { TRACKED } = require("../scripts/storage-layout-lib");

    const prefix = sourcePrefix();
    expect(prefix, "source prefix must be non-empty and trailing-slashed").to.match(/^[^/].*\/$/);

    // Every tracked implementation is qualified with the live prefix — the exact
    // thing that stopped resolving when the project root moved.
    for (const fq of TRACKED) {
      expect(fq, `${fq} is not qualified with the live source prefix`).to.satisfy((s) =>
        s.startsWith(prefix)
      );
    }
  });
});
