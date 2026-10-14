// Freeze a winning attack into a permanent category-1 regression PoC. The
// generated test replays the attacker's EXACT attack.js against a fresh world
// and asserts it no longer beats fair share (and trips no wire) — RED against
// the vulnerable contract, GREEN once the hole is closed, forever after. The
// attack code is saved verbatim alongside so nothing is lost to paraphrase.
const fs = require("fs");
const path = require("path");

function scaffoldFinding({ attackSource, score, id }) {
  const findingsDir = path.resolve(__dirname, "findings");
  const frozenAttack = path.join(findingsDir, `${id}.attack.js`);
  fs.writeFileSync(frozenAttack, attackSource);

  const rel = `../../adversary/findings/${id}.attack.js`;
  const tripline = score.tripwires && score.tripwires.length
    ? ` and tripped: ${score.tripwires.join("; ")}` : "";
  const file = `// AUTO-SCAFFOLDED adversarial finding ${id}.
// The intelligent-adversary harness found an attack where a ~half-supply
// wallet beat its fair share of emissions${tripline}.
// gain=${score.attackerGainWei} wei vs fairShare=${score.fairShareWei} wei${
    score.winRate != null ? ` (win-rate ${score.winRate}, ${score.predictionsCorrect}/${score.predictionsScored})` : ""} at
// capital share ${score.capitalSharePct}%. The winning attack is frozen at
// ${rel} and replayed below.
//
// This test asserts the attack now FAILS. It is RED against the vulnerable
// contract and MUST be made GREEN by CLOSING the hole (never by weakening the
// assertion). Once green it is a permanent regression guard.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { buildWorld } = require("../../adversary/world");
const { buildTools } = require("../../adversary/tools");
const { Scorer } = require("../../adversary/scorer");
const attack = require("${rel}");

describe("[adversarial-finding] ${id}", function () {
  this.timeout(600000);
  it("a half-supply attacker cannot beat fair share via the recorded attack", async function () {
    const world = await buildWorld();
    const tools = buildTools(world);
    const scorer = new Scorer(world.fix);
    await scorer.start(world.attacker.address);
    const log = () => {};
    await attack({ world, tools, ethers, log });
    const s = await scorer.snapshot();
    expect(s.isFinding, \`why=\${s.why} gain=\${s.attackerGainWei} winRate=\${s.winRate} scored=\${s.predictionsScored}\`).to.equal(false);
  });
});
`;
  const testPath = path.resolve(__dirname, "../test/adversarial", `exploit-adversary-${id}.poc.test.js`);
  fs.writeFileSync(testPath, file);
  return { testPath, frozenAttack };
}

module.exports = { scaffoldFinding };
