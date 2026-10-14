const { expect } = require("chai");

// Custom-error assertions that work on ANY node, not just hardhat's.
//
// `hardhat-chai-matchers`' `revertedWithCustomError` relies on the hardhat
// network's error shape, and these suites have to run against anvil (hardhat's
// node does not implement eth_getProof). Against anvil the matcher reports
// "didn't revert" for calls that plainly did, and "receipt should not be null".
//
// The revert data is right there, so decode it instead: a JSON-RPC error carries
// the 4-byte selector in `data`, and the contract's own interface turns that back
// into a name. That makes the assertion STRONGER than the matcher rather than a
// workaround — it fails if the contract reverts for a different reason, which a
// bare `.to.be.reverted` would happily accept.
//
// Use with `.staticCall`, so the revert surfaces as a thrown error rather than a
// mined-and-failed transaction.

function decodeErrorName(e, iface) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? null;
  if (typeof data === "string" && data.length >= 10) {
    try { return iface.parseError(data)?.name ?? null; } catch { /* not ours */ }
  }
  return null;
}

/// `await expectRevert(contract.fn.staticCall(...), contract, "NotActive")`
async function expectRevert(promise, contract, expectedName) {
  let threw = false;
  try {
    await promise;
  } catch (e) {
    threw = true;
    const name = decodeErrorName(e, contract.interface);
    if (expectedName) {
      expect(
        name,
        `expected revert ${expectedName}, got ${name ?? (e.message || "").slice(0, 120)}`
      ).to.equal(expectedName);
    }
  }
  expect(threw, `expected a revert${expectedName ? ` (${expectedName})` : ""}, but the call succeeded`)
    .to.equal(true);
}

module.exports = { expectRevert, decodeErrorName };
