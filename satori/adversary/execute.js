// Executor: build a fresh world, run the adversary's attack.js through the
// attacker tools, score it, and write the result. Run each iteration with:
//   npx hardhat run adversary/execute.js
// A finding (attacker beats fair share OR trips a protocol-cap wire) prints
// loudly and exits non-zero, like a red test. The winning attack.js stays on
// disk for the orchestrator to freeze into a permanent regression PoC.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { buildWorld } = require("./world");
const { buildTools } = require("./tools");
const { Scorer } = require("./scorer");

async function main() {
  const world = await buildWorld();
  const tools = buildTools(world);
  const scorer = new Scorer(world.fix);
  await scorer.start(world.attacker.address);

  const logs = [];
  const log = (m) => { const s = typeof m === "string" ? m : JSON.stringify(m); logs.push(s); console.log(s); };

  // Fresh require so the agent's latest edit is picked up each process run.
  delete require.cache[require.resolve("./attack.js")];
  const attack = require("./attack.js");
  try { await attack({ world, tools, ethers, log }); }
  catch (e) { log("ATTACK THREW: " + (e && e.message ? e.message : e)); }

  const score = await scorer.snapshot();
  console.log("\n=== SCORE ===");
  console.log(JSON.stringify(score, null, 2));
  fs.writeFileSync(path.join(__dirname, "last-score.json"),
    JSON.stringify({ score, logs, attackSource: fs.readFileSync(path.join(__dirname, "attack.js"), "utf8") }, null, 2));

  if (score.isFinding) {
    console.log(`\n*** FINDING (${score.why}): real theft signal. ***`);
    if (score.tripwires.length) console.log("tripwires: " + score.tripwires.join("; "));
    console.log(`gain ${score.attackerGainWei} wei; win-rate ${score.winRate} (${score.predictionsCorrect}/${score.predictionsScored} correct, ${score.predictionsVoided} void)`);
    process.exitCode = 1;
  } else {
    console.log(`\nNo finding — win-rate ${score.winRate} (${score.predictionsCorrect}/${score.predictionsScored}), gain ${score.attackerGainWei} wei, no wire tripped.`);
  }
}
main().catch((e) => { console.error(e); process.exit(2); });
