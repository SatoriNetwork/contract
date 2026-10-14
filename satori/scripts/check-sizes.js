// EIP-170 deployed-bytecode guardrail (CLI form).
//
//   npx hardhat run scripts/check-sizes.js
//
// Why this exists: hardhat.config.js sets `allowUnlimitedContractSize: true` on
// the in-process network so the suite can run, which means NO test can tell you
// a contract has grown past the 24,576-byte mainnet limit. A fully green suite
// can therefore ship a contract that cannot be deployed.
//
// The measurement lives in ./contract-sizes-lib.js and is shared with
// test/ContractSize.test.js, so the CLI and the in-suite guard can never
// disagree — the same split as check-storage-layout.js / StorageLayout.test.js
// (audit F24). This script is the human-readable report; the test is the gate.
//
// Exits non-zero if anything is over the limit.
const {
  EIP170_LIMIT,
  WARN_BYTES,
  productionSizes,
  overLimit,
  tight,
} = require("./contract-sizes-lib");

async function main() {
  const rows = await productionSizes();

  console.log(`EIP-170 limit: ${EIP170_LIMIT} bytes — ${rows.length} production contracts\n`);
  for (const { name, bytes, headroom } of rows) {
    const pct = ((bytes / EIP170_LIMIT) * 100).toFixed(1);
    const flag = bytes > EIP170_LIMIT ? "  *** OVER LIMIT ***" : headroom < WARN_BYTES ? "  <-- TIGHT" : "";
    console.log(
      `${name.padEnd(24)}${String(bytes).padStart(7)}  (${pct.padStart(5)}%)  headroom ${String(headroom).padStart(6)}${flag}`
    );
  }

  const over = overLimit(rows);
  if (over.length) {
    console.error(`\nFAIL: ${over.length} contract(s) exceed the EIP-170 limit and CANNOT be deployed:`);
    for (const { name, bytes } of over) console.error(`  ${name}: ${bytes} bytes (${bytes - EIP170_LIMIT} over)`);
    process.exitCode = 1;
    return;
  }

  const close = tight(rows);
  if (close.length) {
    console.warn(`\nWARN: ${close.length} contract(s) within ${WARN_BYTES} bytes of the limit:`);
    for (const { name, headroom } of close) console.warn(`  ${name}: ${headroom} bytes of headroom left`);
  }

  console.log(`\nOK: every production contract is under the EIP-170 limit.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
