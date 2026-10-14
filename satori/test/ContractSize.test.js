// Enforce the EIP-170 deployed-bytecode limit IN THE TEST SUITE.
//
// hardhat.config.js sets `allowUnlimitedContractSize: true` on the in-process
// network so the suite can run. That flag also means NO test can tell you a
// contract has grown past the 24,576-byte mainnet limit — a fully green suite
// can ship a contract that cannot be deployed at all, and you find out at
// mainnet deploy time.
//
// `scripts/check-sizes.js` measures this, but it is a MANUAL script — nothing
// forces it to run (no CI, no git hook). This test wires the SAME measurement
// (shared via contract-sizes-lib) into `npx hardhat test`, so a size regression
// fails the suite instead of shipping silently.
//
// Same shape as the append-only storage-layout guard (audit F24 /
// test/StorageLayout.test.js), for the same reason: a guardrail nobody is
// obliged to run is not a guardrail.

const { expect } = require("chai");
const {
  EIP170_LIMIT,
  WARN_BYTES,
  productionSizes,
  overLimit,
  tight,
} = require("../scripts/contract-sizes-lib");

describe("Contract size — EIP-170 deploy guard", function () {
  this.timeout(120000);

  let rows;
  before(async function () {
    rows = await productionSizes();
  });

  it("every production contract is under the EIP-170 limit", async function () {
    // Guard against the guard silently measuring nothing (the exact way the old
    // check_sizes.sh failed: hardcoded path, zero contracts matched, always green).
    expect(rows.length, "no production contracts found — the size guard is measuring nothing").to.be.gt(0);

    const over = overLimit(rows);
    expect(
      over.map((r) => `${r.name}: ${r.bytes} bytes (${r.bytes - EIP170_LIMIT} over)`),
      `CONTRACT TOO LARGE TO DEPLOY. The suite passes only because ` +
        `allowUnlimitedContractSize is set on the in-process network; mainnet will reject this. ` +
        `Shrink it (move views to the lens, extract a library) or split the contract.`
    ).to.deep.equal([]);
  });

  it("reports contracts close to the limit (informational)", async function () {
    const close = tight(rows);
    if (close.length) {
      // Not a failure — the next feature landing in one of these may not fit.
      console.log(`      note: within ${WARN_BYTES} bytes of the EIP-170 limit:`);
      for (const r of close) {
        console.log(`        ${r.name}: ${r.bytes} bytes, ${r.headroom} bytes of headroom left`);
      }
    }
    expect(close.length).to.be.a("number");
  });

  it("the guard has teeth: an over-limit contract is detected", function () {
    const fake = [
      { name: "Fine", bytes: 100, headroom: EIP170_LIMIT - 100 },
      { name: "TooBig", bytes: EIP170_LIMIT + 1, headroom: -1 },
      { name: "Exact", bytes: EIP170_LIMIT, headroom: 0 },
    ];
    // Over the limit is caught; exactly at the limit is allowed (it still deploys).
    expect(overLimit(fake).map((r) => r.name)).to.deep.equal(["TooBig"]);
    // The TIGHT band flags near-misses without failing them.
    expect(tight(fake).map((r) => r.name)).to.deep.equal(["Exact"]);
  });
});
