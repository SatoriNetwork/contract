// AUDIT F24 — enforce the append-only storage-layout guard IN THE TEST SUITE.
//
// The 7 core contracts are upgradeable behind SatoriProxy: the proxy holds the
// storage, the implementation holds the code. On upgrade the new code runs
// against the OLD storage, so any change to an EXISTING variable's slot (insert,
// reorder, remove, resize) makes the new code silently misread live state —
// catastrophic and irreversible for a money contract. The only safe change is to
// APPEND new variables at the end.
//
// `scripts/check-storage-layout.js` enforces exactly that against a committed
// baseline, but it is a MANUAL script — nothing forced it to run (no CI, no
// hook). This test wires the SAME comparison (shared via storage-layout-lib) into
// `npx hardhat test`, so a layout regression fails the suite and can't ship
// silently. Re-baselining stays a deliberate act (`LAYOUT_SNAPSHOT=1`), reviewed
// like a migration.

const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { TRACKED, BASELINE_DIR, layoutOf, diffLayout } = require("../scripts/storage-layout-lib");

describe("Storage layout — append-only guard (audit F24)", function () {
  this.timeout(120000);

  for (const fq of TRACKED) {
    const name = fq.split(":")[1];
    it(`${name}: current layout is append-only vs the committed baseline`, async function () {
      const baselinePath = path.join(BASELINE_DIR, `${name}.json`);
      expect(
        fs.existsSync(baselinePath),
        `missing baseline for ${name} — run: LAYOUT_SNAPSHOT=1 npx hardhat run scripts/check-storage-layout.js`
      ).to.equal(true);

      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
      const current = await layoutOf(fq);
      const violations = diffLayout(baseline, current);

      expect(
        violations,
        `PINNED STORAGE LAYOUT CHANGED for ${name} — a proxy upgrade with this implementation would corrupt live state. ` +
          `If this is an intentional APPEND, re-baseline with LAYOUT_SNAPSHOT=1. Violations:\n` +
          JSON.stringify(violations, null, 2)
      ).to.deep.equal([]);
    });
  }

  it("the guard has teeth: diffLayout catches insert / reorder / remove / type change (but allows append)", function () {
    const base = [
      { label: "a", slot: "0", offset: 0, type: "t_uint256" },
      { label: "b", slot: "1", offset: 0, type: "t_address" },
    ];

    // APPEND at the end — allowed, no violation.
    expect(diffLayout(base, [...base, { label: "c", slot: "2", offset: 0, type: "t_bool" }])).to.deep.equal([]);

    // INSERT in the middle (shifts b) — caught.
    expect(diffLayout(base, [base[0], { label: "x", slot: "1", offset: 0, type: "t_uint8" }, base[1]]).length).to.be.gt(0);

    // REMOVE an existing entry — caught.
    expect(diffLayout(base, [base[0]]).length).to.be.gt(0);

    // TYPE CHANGE on an existing entry — caught.
    expect(diffLayout(base, [base[0], { ...base[1], type: "t_uint256" }]).length).to.be.gt(0);

    // REORDER existing entries — caught.
    expect(diffLayout(base, [base[1], base[0]]).length).to.be.gt(0);
  });
});
