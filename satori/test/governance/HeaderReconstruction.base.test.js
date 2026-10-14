const { expect } = require("chai");
const { ethers } = require("hardhat");
const { headerFields } = require("./rlpHeader.js");

// THE PHASE 2 TEST THAT ACTUALLY MATTERS.
//
// Header reconstruction is the one place in this design where a silent mistake
// is possible: a wrong field order or a wrong integer encoding produces a header
// that is simply a DIFFERENT block. Local anvil headers prove nothing about
// Base, because OP Stack appends header fields at every fork.
//
// So this reconstructs REAL Base Sepolia headers and checks them against the
// chain's own hashes, at several depths — a shape that changed at a fork
// boundary would pass near the tip and fail further back.
//
// NETWORK-GATED. Skips when Base Sepolia is unreachable, so the ordinary suite
// stays green offline. A skip is not a pass: this must be run before shipping.
// Override the endpoint with BASE_SEPOLIA_RPC_URL.

const RPC = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

describe("Phase 2 — real Base Sepolia headers reconstruct exactly", function () {
  this.timeout(180000);
  let tip;

  before(async function () {
    try {
      tip = BigInt(await rpc("eth_blockNumber", []));
    } catch (e) {
      console.log(`      (skipped: ${RPC} unreachable — ${e.message})`);
      this.skip();
    }
  });

  it("reconstructs headers at several depths, hashing to the chain's own values", async function () {
    // The public endpoint prunes deep history, so these stay inside what it
    // serves. Depth is what matters, not age: a fork boundary shows up as a
    // failure at some depth while the tip keeps passing.
    const depths = [0n, 1n, 10n, 1000n, 50000n, 500000n];
    let checked = 0;

    for (const d of depths) {
      if (d > tip) continue;
      const n = tip - d;
      let b;
      try {
        b = await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
      } catch (e) {
        // Pruned history is an infrastructure limit, not a reconstruction bug.
        if (/pruned|not available|unavailable/i.test(e.message)) continue;
        throw e;
      }
      const fields = headerFields(b);
      const raw = ethers.encodeRlp(fields);
      expect(
        ethers.keccak256(raw).toLowerCase(),
        `block ${n} (tip-${d}, ${fields.length} fields) reconstructed to a different hash — ` +
        `a fork may have appended a header field`
      ).to.equal(b.hash.toLowerCase());
      checked++;
    }

    // A test that silently checked nothing would be worse than no test.
    expect(checked, "no Base blocks were actually checked").to.be.gte(3);
  });

  it("a real Base header verifies ON CHAIN and yields Base's state root", async function () {
    const b = await rpc("eth_getBlockByNumber", ["0x" + tip.toString(16), false]);
    const raw = ethers.encodeRlp(headerFields(b));

    const probe = await (await ethers.getContractFactory("HistoricalHeaderProbe")).deploy();
    await probe.waitForDeployment();

    // The full production path: bytes from a Base RPC, authenticated against
    // Base's own block hash, decoded by our library, on a local EVM.
    expect(await probe.stateRootOf(b.hash, BigInt(b.number), raw)).to.equal(b.stateRoot);
  });
});
