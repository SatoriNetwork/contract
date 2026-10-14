const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// FUZZING (proposal §57). The invariant, stated once and held everywhere:
//
//     a mutated or malformed proof either REVERTS or proves ABSENCE (zero).
//     it never yields a third value.
//
// "Never an unintended voting value" is the property the whole system's
// integrity reduces to, so it is tested with hostility rather than examples:
// hundreds of seeded random mutations of a REAL proof, plus pure garbage.
//
// Seeded LCG, not Math.random — a failure must be reproducible from the log.
//
// Needs eth_getProof (anvil); skips elsewhere. A skip is not a pass.

function lcg(seed) {
  let s = BigInt(seed) & 0xffffffffn;
  return () => Number((s = (s * 1664525n + 1013904223n) & 0xffffffffn) % 0x7fffffffn);
}

describe("Proof fuzzing — revert or truth, never a third thing", function () {
  this.timeout(600000);

  let probe, token, tokenAddr, storageRoot, holder, trueBalance, goodProof;

  before(async function () {
    try {
      await network.provider.send("eth_getProof", [ethers.ZeroAddress, [], "latest"]);
    } catch {
      console.log("      (skipped: no eth_getProof — run against anvil)");
      this.skip();
    }
    const [dep, alice] = await ethers.getSigners();
    holder = alice.address;
    token = await (await ethers.getContractFactory("SatoriToken"))
      .deploy(dep.address, dep.address, (await ethers.provider.getNetwork()).chainId);
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();
    probe = await (await ethers.getContractFactory("HistoricalBalanceProbe")).deploy();
    await probe.waitForDeployment();

    // A few holders so the trie has some shape to mutate against.
    const signers = await ethers.getSigners();
    for (let i = 1; i < 8; i++) {
      await (await token.transfer(signers[i].address, ethers.parseEther(String(7 * i + 1)))).wait();
    }
    trueBalance = await token.balanceOf(holder);

    const bn = "0x" + (await ethers.provider.getBlockNumber()).toString(16);
    const slot = await probe.balanceSlot(holder);
    const r = await network.provider.send("eth_getProof", [tokenAddr, [slot], bn]);
    const acct = await network.provider.send("eth_getProof", [tokenAddr, [], bn]);
    const hdr = await network.provider.send("eth_getBlockByNumber", [bn, false]);
    storageRoot = await probe.accountStorageRoot(hdr.stateRoot, tokenAddr, acct.accountProof);
    goodProof = r.storageProof[0].proof;
  });

  async function outcome(proof) {
    try { return await probe.proveBalance(storageRoot, holder, proof); }
    catch { return "revert"; }
  }

  function mutate(rand, proof) {
    const p = proof.map((n) => n);           // shallow copy
    switch (rand() % 7) {
      case 0: {  // flip one byte in one node
        const i = rand() % p.length;
        const b = ethers.getBytes(p[i]);
        b[rand() % b.length] ^= 1 << (rand() % 8);
        p[i] = ethers.hexlify(b);
        return p;
      }
      case 1:    // drop a node
        p.splice(rand() % p.length, 1);
        return p;
      case 2: {  // duplicate a node in place
        const i = rand() % p.length;
        p.splice(i, 0, p[i]);
        return p;
      }
      case 3: {  // swap two nodes
        const i = rand() % p.length, j = rand() % p.length;
        [p[i], p[j]] = [p[j], p[i]];
        return p;
      }
      case 4: {  // truncate a node
        const i = rand() % p.length;
        const b = ethers.getBytes(p[i]);
        p[i] = ethers.hexlify(b.slice(0, 1 + (rand() % Math.max(1, b.length - 1))));
        return p;
      }
      case 5: {  // append a junk node
        const len = 1 + (rand() % 96);
        const junk = new Uint8Array(len);
        for (let k = 0; k < len; k++) junk[k] = rand() % 256;
        p.push(ethers.hexlify(junk));
        return p;
      }
      default: { // replace everything with garbage
        const out = [];
        const n = 1 + (rand() % 5);
        for (let k = 0; k < n; k++) {
          const len = 1 + (rand() % 128);
          const junk = new Uint8Array(len);
          for (let m = 0; m < len; m++) junk[m] = rand() % 256;
          out.push(ethers.hexlify(junk));
        }
        return out;
      }
    }
  }

  it("the unmutated proof yields the exact balance (the baseline)", async function () {
    expect(await outcome(goodProof)).to.equal(trueBalance);
  });

  it("300 seeded mutations: every outcome is revert, zero, or the exact truth", async function () {
    const rand = lcg(0x5A70121);
    let reverted = 0, zero = 0, truth = 0;
    for (let iter = 0; iter < 300; iter++) {
      const got = await outcome(mutate(rand, goodProof));
      if (got === "revert") reverted++;
      else if (got === 0n) zero++;             // a mutation can sever the path = proven absent
      else if (got === trueBalance) truth++;   // a mutation can be a no-op (dup/swap of same node)
      else expect.fail(`iteration ${iter}: proof mutated into a DIFFERENT value: ${got}`);
    }
    console.log(`      (${reverted} reverted, ${zero} absent, ${truth} unchanged-truth)`);
    // If nothing ever reverted the mutator is broken, not the verifier strong.
    expect(reverted).to.be.gt(200);
  });

  it("100 pure-garbage headers: never a state root, always a revert", async function () {
    const rand = lcg(0xBA5E);
    const hdrProbe = await (await ethers.getContractFactory("HistoricalHeaderProbe")).deploy();
    await hdrProbe.waitForDeployment();
    for (let iter = 0; iter < 100; iter++) {
      const len = 1 + (rand() % 700);
      const junk = new Uint8Array(len);
      for (let k = 0; k < len; k++) junk[k] = rand() % 256;
      const raw = ethers.hexlify(junk);
      // Even when the expected hash MATCHES the junk (we hash it ourselves),
      // decoding must fail cleanly — a junk header that decodes to a "state
      // root" would be an RLP bug worth any amount of fuzzing to find.
      let ok = false;
      try { await hdrProbe.stateRootOf(ethers.keccak256(raw), 1n, raw); ok = true; } catch {}
      if (ok) {
        // Only acceptable if the junk happened to BE a well-formed 9+ field
        // list whose field 8 equals 1 — vanishingly unlikely; treat as failure.
        expect.fail(`iteration ${iter}: garbage decoded as a header`);
      }
    }
  });
});
