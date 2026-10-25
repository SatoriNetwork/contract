// Shared EIP-170 size logic, used by BOTH scripts/check-sizes.js (CLI) and
// test/ContractSize.test.js (in-suite guard) so the two can never disagree —
// the same split the storage-layout guard uses (storage-layout-lib.js, audit F24).
const hre = require("hardhat");
const { sourcePrefix } = require("./source-prefix");

/// The hard protocol limit on deployed bytecode. Over this, the contract
/// simply cannot be deployed to mainnet.
const EIP170_LIMIT = 24576;

/// Headroom below which a contract is reported as TIGHT. Not a failure — a
/// heads-up that the next feature may not fit.
const WARN_BYTES = 2048;

// Only production contracts gate the build. Mocks/harnesses/interfaces are
// test fixtures deployed on the unlimited-size in-process network and may
// legitimately exceed the limit.
//
// Matched against the path BELOW the sources dir, so the patterns stay true
// whatever that dir is called (see source-prefix.js).
const EXCLUDE = [
  /^mocks\//,
  /^interfaces\//,
  /^next\/interfaces\//,
];

const isProduction = (source) => {
  const prefix = sourcePrefix();
  if (!source.startsWith(prefix)) return false; // a dependency, not our source
  const rel = source.slice(prefix.length);
  return !EXCLUDE.some((re) => re.test(rel));
};

/// Deployed-bytecode size, in bytes, of every production contract — sorted
/// largest first. Read through hardhat's artifact API rather than a hardcoded
/// artifacts path: the previous check_sizes.sh hardcoded /app/satori/... and
/// silently measured nothing once the tree moved.
async function productionSizes() {
  const rows = [];
  for (const fq of await hre.artifacts.getAllFullyQualifiedNames()) {
    const [source] = fq.split(":");
    if (!isProduction(source)) continue;
    const { deployedBytecode, contractName } = await hre.artifacts.readArtifact(fq);
    // Interfaces / abstract contracts compile to "0x" — nothing to measure.
    if (!deployedBytecode || deployedBytecode.length <= 2) continue;
    rows.push({
      name: contractName,
      source,
      bytes: (deployedBytecode.length - 2) / 2,
      headroom: EIP170_LIMIT - (deployedBytecode.length - 2) / 2,
    });
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

const overLimit = (rows) => rows.filter((r) => r.bytes > EIP170_LIMIT);
const tight = (rows) => rows.filter((r) => r.bytes <= EIP170_LIMIT && r.headroom < WARN_BYTES);

module.exports = { EIP170_LIMIT, WARN_BYTES, isProduction, productionSizes, overLimit, tight };
