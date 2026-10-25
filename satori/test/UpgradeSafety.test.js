// REGRESSION TEST FOR THE BASE SEPOLIA BRICK, 2026-08-30.
//
// SatoriRewards was upgraded to an implementation whose storage layout had
// drifted two slots from the deployed proxy. Every guard in the repo passed,
// because they all compare CURRENT SOURCE against a COMMITTED BASELINE FILE —
// and the baseline tracks main while a deployment is frozen at the commit that
// produced it. Nothing compared source against what was actually on chain.
//
// The observed divergence, read straight out of the live proxy's storage:
//
//   slot 34   deployed: satoriEngine + airdropStart   source: marketingFeeRecipient
//   slot 35   deployed: satoriToken  + _initialized   source: pendingMarketingFeeRecipient
//   slot 36   deployed: marketingFeeRecipient         source: _frozenQ
//
// Consequence: the new code read `satoriToken` from slot 33 (never written, so
// zero) and `_upgradeGovernor()` — `ISatoriGovernorSource(satoriToken).rootAuthority()`
// — began reverting on the extcodesize check against address(0). The proxy can
// no longer be upgraded by anyone, including the governor.
//
// These tests pin that `diffLayout` — the comparison `check-upgrade-safety.js`
// runs against the layout RECORDED AT DEPLOY TIME — catches exactly this.
const { expect } = require("chai");
const { diffLayout, shapeOf, layoutOf, TRACKED } = require("../scripts/storage-layout-lib");

// The real fragments, transcribed from the incident.
const DEPLOYED = [
  { label: "satoriEngine", slot: "34", offset: 0, type: "t_address" },
  { label: "airdropStart", slot: "34", offset: 20, type: "t_uint64" },
  { label: "satoriToken", slot: "35", offset: 0, type: "t_address" },
  { label: "_initialized", slot: "35", offset: 20, type: "t_bool" },
  { label: "marketingFeeRecipient", slot: "36", offset: 0, type: "t_address" },
];

const DRIFTED_SOURCE = [
  { label: "satoriToken", slot: "33", offset: 0, type: "t_address" },
  { label: "marketingFeeRecipient", slot: "34", offset: 0, type: "t_address" },
  { label: "pendingMarketingFeeRecipient", slot: "35", offset: 0, type: "t_address" },
  { label: "_frozenQ", slot: "36", offset: 0, type: "t_uint256" },
];

describe("Upgrade safety — the layout that is DEPLOYED, not the one in the repo", function () {
  it("catches the exact drift that bricked SatoriRewards", function () {
    const violations = diffLayout(DEPLOYED, DRIFTED_SOURCE);
    expect(violations.length).to.be.greaterThan(0);
  });

  it("names satoriToken specifically — the variable whose move did the damage", function () {
    // It is the one `_upgradeGovernor()` reads, so its slot moving is what took
    // the upgrade path away. A guard that fired without naming it would leave
    // the next person guessing at severity.
    const violations = diffLayout(DEPLOYED, DRIFTED_SOURCE);
    expect(JSON.stringify(violations)).to.match(/satoriToken/);
  });

  it("still allows a genuine append onto the deployed layout", function () {
    // The guard has to stay usable, or it gets bypassed. Appending after the
    // last deployed slot is the safe, normal case and must pass cleanly —
    // this is what the offchainReporter / curveOperator additions looked like.
    const appended = [
      ...DEPLOYED,
      { label: "offchainReporter", slot: "37", offset: 0, type: "t_address" },
    ];
    expect(diffLayout(DEPLOYED, appended)).to.deep.equal([]);
  });

  it("catches a variable that keeps its slot but changes type", function () {
    // A resize is as destructive as a move and easier to do by accident.
    const resized = DEPLOYED.map((e) =>
      e.label === "airdropStart" ? { ...e, type: "t_uint128" } : e);
    expect(diffLayout(DEPLOYED, resized).length).to.be.greaterThan(0);
  });

  it("catches a removal, which shifts everything after it", function () {
    const removed = DEPLOYED.filter((e) => e.label !== "satoriToken");
    expect(diffLayout(DEPLOYED, removed).length).to.be.greaterThan(0);
  });

  it("is not satisfied by the source matching its own baseline", function () {
    // The heart of the incident: source and baseline agreed perfectly, and that
    // told us nothing, because neither described the chain. Comparing the
    // drifted source to ITSELF is clean — which is precisely why the old guards
    // stayed green while the upgrade was unsafe.
    expect(diffLayout(DRIFTED_SOURCE, DRIFTED_SOURCE)).to.deep.equal([]);
    expect(diffLayout(DEPLOYED, DRIFTED_SOURCE).length).to.be.greaterThan(0);
  });
});

// M09: a struct held in a mapping or array has one `type` string whatever its
// members are, so a field added, reordered or retyped inside it was invisible to
// the slot/offset/type comparison. `shape` spells the members out.
describe("Upgrade safety — what is INSIDE a struct", function () {
  const types = (members) => ({
    "t_mapping(t_address,t_struct(Pos)1_storage)": {
      label: "mapping(address => struct S.Pos)", key: "t_address", value: "t_struct(Pos)1_storage",
    },
    "t_address": { label: "address", numberOfBytes: "20" },
    "t_uint128": { label: "uint128", numberOfBytes: "16" },
    "t_uint64": { label: "uint64", numberOfBytes: "8" },
    "t_uint256": { label: "uint256", numberOfBytes: "32" },
    "t_struct(Pos)1_storage": { label: "struct S.Pos", numberOfBytes: "64", members },
  });
  const POS = [
    { label: "amount", slot: "0", offset: 0, type: "t_uint128" },
    { label: "since", slot: "0", offset: 16, type: "t_uint64" },
    { label: "bonus", slot: "1", offset: 0, type: "t_uint256" },
  ];
  const shape = (members) => shapeOf(types(members), "t_mapping(t_address,t_struct(Pos)1_storage)");
  const entry = (members) => ({
    label: "positions", slot: "5", offset: 0,
    type: "t_mapping(t_address,t_struct(Pos)1_storage)", shape: shape(members),
  });

  it("spells out members, offsets and types, and ignores AST ids in the type name", function () {
    expect(shape(POS)).to.equal(
      "mapping(address/20=>struct S.Pos{amount@0.0:uint128/16,since@0.16:uint64/8,bonus@1.0:uint256/32})");
    const renumbered = { ...types(POS), "t_struct(Pos)99_storage": { ...types(POS)["t_struct(Pos)1_storage"] } };
    expect(shapeOf(renumbered, "t_struct(Pos)99_storage")).to.equal(shapeOf(types(POS), "t_struct(Pos)1_storage"));
  });

  it("cuts a struct that reaches itself instead of recursing forever", function () {
    const t = {
      "t_struct(Node)1_storage": { label: "struct S.Node", numberOfBytes: "32", members: [
        { label: "next", slot: "0", offset: 0, type: "t_mapping(t_uint256,t_struct(Node)1_storage)" }] },
      "t_mapping(t_uint256,t_struct(Node)1_storage)": {
        label: "mapping", key: "t_uint256", value: "t_struct(Node)1_storage" },
      "t_uint256": { label: "uint256", numberOfBytes: "32" },
    };
    expect(shapeOf(t, "t_struct(Node)1_storage")).to.contain("ref(struct S.Node)");
  });

  it("catches a field retyped inside a struct that the slot/offset/type comparison cannot see", function () {
    const baseline = [entry(POS)];
    const retyped = [entry(POS.map((m) => m.label === "amount" ? { ...m, type: "t_uint256", slot: "0" } : m))];
    expect(baseline[0].label).to.equal(retyped[0].label);
    expect(baseline[0].type).to.equal(retyped[0].type);          // the old comparison is blind
    expect(diffLayout(baseline, retyped).length).to.equal(1);
  });

  it("catches a field inserted before the others, and one appended after them (a stored struct's shape is pinned)", function () {
    const baseline = [entry(POS)];
    const inserted = [entry([{ label: "kind", slot: "0", offset: 0, type: "t_uint64" }, ...POS])];
    const appended = [entry([...POS, { label: "extra", slot: "2", offset: 0, type: "t_uint256" }])];
    expect(diffLayout(baseline, inserted).length).to.equal(1);
    // An append inside a struct held in a mapping changes its shape too; the
    // guard reports it so a person checks the struct's slots stay free.
    expect(diffLayout(baseline, appended).length).to.equal(1);
  });

  it("an older baseline without `shape` is compared as before", function () {
    const { shape: _drop, ...noShape } = entry(POS);
    expect(diffLayout([noShape], [entry(POS)])).to.deep.equal([]);
    expect(diffLayout([noShape], [{ ...entry(POS), slot: "6" }]).length).to.equal(1);
  });

  it("layoutOf records a shape for every entry of every tracked contract, and a layout is clean against itself", async function () {
    this.timeout(120000);
    for (const fq of TRACKED) {
      const layout = await layoutOf(fq);
      expect(layout.length, fq).to.be.greaterThan(0);
      for (const e of layout) expect(e.shape, `${fq}.${e.label}`).to.be.a("string").and.not.equal("");
      expect(diffLayout(layout, layout), fq).to.deep.equal([]);
    }
  });
});
