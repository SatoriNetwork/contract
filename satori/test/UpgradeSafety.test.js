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
const { diffLayout } = require("../scripts/storage-layout-lib");

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
