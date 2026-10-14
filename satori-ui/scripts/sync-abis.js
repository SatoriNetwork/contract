#!/usr/bin/env node
// Regenerate the vendored ABIs in src/contracts/ from the hardhat artifacts in
// ../satori/artifacts. The dapp only reads `.abi` (never bytecode), so every
// file is written in the trimmed `{ contractName, abi }` shape. Run after any
// contract change: `npm run sync-abis` (compile the contracts first).
const fs = require('fs');
const path = require('path');

const ARTIFACTS = path.join(__dirname, '..', '..', 'satori', 'artifacts', 'contracts');
const OUT = path.join(__dirname, '..', 'src', 'contracts');

// Vendored filename -> artifact contract name (same name unless mapped here).
const NAME_MAP = { Multicall: 'Multicall3Mock' };

function findArtifact(name) {
  const stack = [ARTIFACTS];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === `${name}.json`) return p;
    }
  }
  return null;
}

let updated = 0;
for (const f of fs.readdirSync(OUT)) {
  if (!f.endsWith('.json')) continue;
  const base = path.basename(f, '.json');
  const artifactName = NAME_MAP[base] || base;
  const src = findArtifact(artifactName);
  if (!src) {
    console.error(`MISSING artifact for ${f} (looked for ${artifactName}.json) — not updated`);
    process.exitCode = 1;
    continue;
  }
  const { contractName, abi } = JSON.parse(fs.readFileSync(src, 'utf8'));
  fs.writeFileSync(path.join(OUT, f), JSON.stringify({ contractName, abi }, null, 2) + '\n');
  updated++;
}
console.log(`sync-abis: ${updated} ABI file(s) regenerated from artifacts`);
