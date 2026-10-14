// Judge the latest adversary run. execute.js writes adversary/last-score.json
// each time it runs the current attack.js; this reads that record, prints the
// verdict, and — on a finding (attacker beat fair share, or a protocol-cap
// tripwire fired) — freezes the exact winning attack into a permanent
// category-1 regression PoC. Kept SEPARATE from the attacker so the adversary
// is never the judge of its own success.
//
// The adversary LOOP itself is driven by an agent the assistant launches as a
// subagent (see adversary/README.md for the briefing), or by hand: edit
// adversary/attack.js and run `npx hardhat run adversary/execute.js`.
//
//   node adversary/run.js
const fs = require("fs");
const path = require("path");

const ADV = __dirname;
const REPO = path.resolve(ADV, "..");
const id = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

function main() {
  const scorePath = path.join(ADV, "last-score.json");
  if (!fs.existsSync(scorePath)) {
    console.log("# No adversary/last-score.json — run the attack first:");
    console.log("#   npx hardhat run adversary/execute.js   (after editing adversary/attack.js)");
    process.exit(2);
  }
  const { score, attackSource } = JSON.parse(fs.readFileSync(scorePath, "utf8"));
  console.log("# ADVERSARY VERDICT\n" + JSON.stringify(score, null, 2));

  const runDir = path.join(ADV, "runs");
  fs.writeFileSync(path.join(runDir, `${id}.score.json`), JSON.stringify(score, null, 2));
  fs.writeFileSync(path.join(runDir, `${id}.attack.js`), attackSource);
  const notes = path.join(ADV, "agent-notes.md");
  if (fs.existsSync(notes)) fs.copyFileSync(notes, path.join(runDir, `${id}.notes.md`));

  if (score.isFinding) {
    const { scaffoldFinding } = require("./scaffoldFinding");
    const { testPath } = scaffoldFinding({ attackSource, score, id });
    console.log(`\n# FINDING. Frozen a regression PoC: ${path.relative(REPO, testPath)}`);
    console.log(`# RED now; close the hole in the CONTRACT to make it GREEN — then it guards forever.`);
    process.exitCode = 1;
  } else {
    console.log(`\n# No finding — attacker did not beat fair share and tripped no wire.`);
  }
}
main();
