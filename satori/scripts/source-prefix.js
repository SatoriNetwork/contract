// The prefix every local source name carries, derived from the live hardhat
// config rather than hardcoded.
//
// Hardhat names a contract by its source path relative to the PROJECT ROOT, so
// the same file is `contracts/SatoriVoting.sol:SatoriVoting` from a project
// rooted at satori/ and `satori/contracts/SatoriVoting.sol:SatoriVoting` from
// one rooted a level up. Both size and storage-layout guards look contracts up
// by that name, and both used to hardcode the first form. When a second config
// existed at the repo root, running the suite from there made every lookup miss:
// the layout guard threw "no build info", and the size guard matched zero
// contracts and reported that it was measuring nothing.
// (docs/issues/closed/hardhat-guards-silently-fail-from-repo-root.md)
//
// That second config is gone and satori/ is now the only hardhat project, so
// this resolves to "contracts/" today. It is derived anyway: the guards must
// never again be quietly disarmed by where they were invoked from, and both must
// agree on the answer — the same reason the size and layout logic each live in
// one shared module.
const hre = require("hardhat");
const path = require("path");

/// e.g. "contracts/" — always forward-slashed, always trailing-slashed, because
/// hardhat source names are POSIX-style regardless of platform.
function sourcePrefix() {
  const rel = path.relative(hre.config.paths.root, hre.config.paths.sources);
  return rel.split(path.sep).join("/") + "/";
}

module.exports = { sourcePrefix };
