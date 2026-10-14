// Self-test for the intelligent-adversary harness (adversary/). Runs the WORLD,
// TOOLS, SCORER and SCAFFOLDER with a SCRIPTED attacker — no LLM, no API cost —
// so the rig that gates real (paid) runs is itself covered. Lives in test-fork/
// (outside `npm test`); run: `npx hardhat test test-fork/AdversaryHarness.selftest.js`.
const { expect } = require("chai");
const fs = require("fs");
const { buildWorld } = require("../adversary/world");
const { buildTools } = require("../adversary/tools");
const { Scorer } = require("../adversary/scorer");
const { scaffoldFinding } = require("../adversary/scaffoldFinding");

describe("[selftest] adversary harness", function () {
  this.timeout(600000);

  it("builds a world with honest history and a half-supply attacker", async function () {
    const world = await buildWorld({ honestRounds: 6 });
    const { fix, attacker, streamIds } = world;
    expect(streamIds.length).to.equal(2);
    const bal = await fix.token.balanceOf(attacker.address);
    const supply = await fix.token.totalSupply();
    // Attacker holds a large share (governor kept the rest minus the cast).
    expect(bal * 100n / supply).to.be.gte(20n);
    expect(Number(await fix.satori.getCurrentRound())).to.be.greaterThan(5);
  });

  it("exposes read-only source and working action tools; scorer measures fair share", async function () {
    const world = await buildWorld({ honestRounds: 4 });
    const tools = buildTools(world);

    // Source access is real and sandboxed.
    const files = await tools.list_source.run({});
    expect(files).to.include("SatoriRegistry.sol");
    const src = await tools.read_source.run({ file: "SatoriRegistry.sol" });
    expect(src).to.match(/contract SatoriRegistry/);
    await expect(tools.read_source.run({ file: "../../../etc/passwd" })).to.be.rejectedWith(/outside contracts/);
    const hits = await tools.grep_source.run({ pattern: "moveVotes" });
    expect(hits.some((h) => h.includes("SatoriVoting"))).to.equal(true);

    // A scripted attack sequence runs through the same tools the agent uses.
    const scorer = new Scorer(world.fix);
    await scorer.start(world.attacker.address);
    const { streamId } = await tools.create_stream.run({ name: "ATK", cadenceMinutes: 60 });
    expect(streamId).to.be.a("number");
    await tools.set_value.run({ streamId, value: 500 });
    const st = await tools.state.run({});
    expect(st.streamIds.length).to.equal(2);

    const s = await scorer.snapshot();
    // Retuned score surface: theft fingerprints, capital only as context.
    expect(s).to.include.keys(
      "isFinding", "why", "attackerGainWei", "predictionsScored",
      "predictionsCorrect", "winRate", "clairvoyant", "freeLunch", "tripwires",
      "capitalSharePct");
    // An attacker who only observed/created (no correct predictions, no gain)
    // is not a finding.
    expect(s.isFinding).to.equal(false);
    expect(s.tripwires).to.deep.equal([]);
  });

  it("freezes a category-1 PoC from a (simulated) finding, shaped like the real ones", async function () {
    const attackSource = "module.exports = async ({ tools, log }) => { await tools.state.run({}); };\n";
    const fakeScore = { isFinding: true, why: "cap/conservation", attackerGainWei: "1",
      predictionsScored: 0, predictionsCorrect: 0, winRate: null, clairvoyant: false,
      freeLunch: false, capitalSharePct: 50, tripwires: ["totalRewardsMinted > rewardCeiling"] };
    const { testPath, frozenAttack } = scaffoldFinding({ attackSource, score: fakeScore, id: "selftest-sim" });
    try {
      const body = fs.readFileSync(testPath, "utf8");
      expect(body).to.match(/\[adversarial-finding\] selftest-sim/);
      expect(body).to.match(/const attack = require\(/);
      expect(body).to.match(/await attack\(\{ world, tools, ethers, log \}\)/);
      expect(body).to.match(/expect\(s\.isFinding.*\)\.to\.equal\(false\)/);
      // Regression-guard shape: asserts the attack FAILS, never that it succeeds.
      expect(body).to.not.match(/isFinding.*\.to\.equal\(true\)/);
      expect(fs.readFileSync(frozenAttack, "utf8")).to.equal(attackSource);
    } finally {
      fs.unlinkSync(testPath);   // don't leave a red test in the tree
      fs.unlinkSync(frozenAttack);
    }
  });
});
