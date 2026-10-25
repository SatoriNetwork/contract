// After a redeploy, the apps outside this repo that keep their own copy of the addresses (CLAUDE.md, "Contract
// redeploy"). An app file that gains a new address literal for one of KEYS must hold it once, or this refuses.
//
//   node scripts/repoint-apps.js [--check] [--network baseSepolia]
const fs = require("fs");
const path = require("path");

const SATORI = path.resolve(__dirname, "../../.."); // the Satori repos, side by side
const KEYS = ["token", "merkle", "airdrop", "rewards", "engine", "games", "registry", "hub", "lens", "voting"];
const APPS = [
  { name: "central (the Satori Network)", file: "central/src/services/base_config.py", branch: "base-upgrade" },
  { name: "the Satori app", file: "satori/src/chain/config.js", branch: "main" },
  { name: "Satori Lite", file: "neuron/neuron-lite/satorineuron/base_config.py", branch: "base-upgrade" },
];

// `"token": "0x…"` (Python) or `token: '0x…'` (JS); a key an app does not hold is skipped, a key held twice refused.
const literal = (key) => new RegExp(`((["']?)\\b${key}\\2\\s*:\\s*(["']))(0x[0-9a-fA-F]{40})(\\3)`, "g");

function repoint(text, book) {
  const changed = [];
  for (const key of KEYS) {
    if (!book[key]) continue;
    const hits = [...text.matchAll(literal(key))];
    if (hits.length > 1) throw new Error(`${key} appears ${hits.length} times`);
    if (!hits.length || hits[0][4] === book[key]) continue;
    changed.push(`${key} ${hits[0][4]} -> ${book[key]}`);
    text = text.replace(literal(key), `$1${book[key]}$5`);
  }
  return { text, changed };
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const network = args.includes("--network") ? args[args.indexOf("--network") + 1] : "baseSepolia";
  const bookFile = path.join(__dirname, "..", "deployments", `${network}.json`);
  const book = JSON.parse(fs.readFileSync(bookFile, "utf8")).addresses;
  console.log(`book: deployments/${network}.json`);
  let off = 0;
  for (const app of APPS) {
    const file = path.join(SATORI, app.file);
    if (!fs.existsSync(file)) { console.log(`  ${app.name}: ${app.file} not found, skipped`); continue; }
    const { text, changed } = repoint(fs.readFileSync(file, "utf8"), book);
    if (!changed.length) { console.log(`  ${app.name}: on the book`); continue; }
    off++;
    console.log(`  ${app.name} (${app.file}, branch ${app.branch}):`);
    for (const c of changed) console.log(`    ${c}`);
    if (!check) fs.writeFileSync(file, text);
  }
  if (check && off) { console.log(`${off} app(s) not on the book: run without --check.`); process.exit(1); }
  if (!check && off) console.log(`Wrote ${off} app(s). Commit each on its branch and redeploy it (CLAUDE.md, "Contract redeploy").`);
}

if (require.main === module) main();
module.exports = { repoint, APPS, KEYS };
