const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { rawHeaderFor, headerFields } = require("./rlpHeader.js");

// PHASE 2 of docs/design/holder-voting-proposal.txt — authenticate a historical
// block header against a hash the EVM captured, and read its state root.
//
// This is the hinge of the design. A proposal records blockhash(number - 1)
// while it is natively available; from then on anyone may present the raw
// header, because exactly one byte string hashes to the stored value. The
// 256-block BLOCKHASH window stops mattering.
//
// The local half of this runs anywhere. The half that MATTERS runs against real
// Base headers — see HeaderReconstruction.base.test.js — because OP Stack
// appends header fields and a local header proves nothing about Base's shape.

describe("Phase 2 — header authentication", function () {
  this.timeout(120000);
  let probe;

  before(async function () {
    probe = await (await ethers.getContractFactory("HistoricalHeaderProbe")).deploy();
    await probe.waitForDeployment();
    // A few blocks, so `captureSnapshot` has a real predecessor to point at.
    for (let i = 0; i < 3; i++) await network.provider.send("evm_mine");
  });

  async function blockAt(n) {
    return network.provider.send("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
  }

  it("a reconstructed header yields the chain's own state root", async function () {
    const n = await ethers.provider.getBlockNumber();
    const b = await blockAt(n);
    const raw = rawHeaderFor(b);   // asserts keccak(raw) === b.hash internally
    expect(await probe.stateRootOf(b.hash, BigInt(b.number), raw))
      .to.equal(b.stateRoot);
  });

  it("captureSnapshot pins the PREVIOUS block, which is what defeats flash loans", async function () {
    // Proposal §33. The snapshot is the state at the end of the block BEFORE the
    // proposal transaction, so a loan borrowed and repaid inside that
    // transaction cannot have existed at the snapshot.
    //
    // Exercised as a TRANSACTION, deliberately. Through `eth_call` the same code
    // pins head-1 instead of head, because providers set `block.number` to the
    // latest mined block for calls and to the block being mined for
    // transactions. Production only ever takes the transaction path, so testing
    // the call path would pin the wrong block and look fine.
    // Read the CALL path first, at this exact head, so the comparison below is
    // between two semantics rather than two different moments in time.
    const [callNum] = await probe.captureSnapshot();
    const headBefore = BigInt(await ethers.provider.getBlockNumber());

    const rc = await (await probe.recordSnapshot()).wait();
    const ev = rc.logs.map((l) => probe.interface.parseLog(l)).find((e) => e && e.name === "SnapshotCaptured");
    const num = ev.args.number, hash = ev.args.hash;

    expect(num).to.equal(BigInt(rc.blockNumber) - 1n);   // the block BEFORE ours
    const b = await blockAt(Number(num));
    expect(hash).to.equal(b.hash);

    // THE TRAP, stated exactly: asked at the same head, the call path pins
    // head-1 while the transaction pins head. A test written against staticCall
    // would snapshot a different block than a real proposal and still look fine.
    expect(callNum).to.equal(headBefore - 1n);
    expect(num).to.equal(headBefore);
  });

  it("rejects a header whose hash does not match — before decoding anything", async function () {
    const n = await ethers.provider.getBlockNumber();
    const b = await blockAt(n);
    const raw = rawHeaderFor(b);

    // Wrong expected hash.
    await expect(probe.stateRootOf(ethers.ZeroHash, BigInt(b.number), raw))
      .to.be.revertedWithCustomError(probe, "HeaderHashMismatch");

    // A single flipped byte anywhere in the header.
    const bytes = ethers.getBytes(raw);
    bytes[bytes.length - 1] ^= 0x01;
    await expect(probe.stateRootOf(b.hash, BigInt(b.number), ethers.hexlify(bytes)))
      .to.be.revertedWithCustomError(probe, "HeaderHashMismatch");
  });

  it("rejects a VALID header for the wrong block number", async function () {
    // The hash already pins the block, so this cannot fire on honest input. It
    // turns "the proposal stored a hash and a number that disagree" from a
    // silent wrong answer into a revert.
    const n = await ethers.provider.getBlockNumber();
    const b = await blockAt(n);
    const raw = rawHeaderFor(b);
    await expect(probe.stateRootOf(b.hash, BigInt(b.number) + 1n, raw))
      .to.be.revertedWithCustomError(probe, "HeaderWrongNumber");
  });

  it("rejects a header that is not an RLP list, and a truncated one", async function () {
    const junk = "0x80";                                  // RLP empty string
    await expect(probe.stateRootOf(ethers.keccak256(junk), 1n, junk)).to.be.reverted;

    const short = ethers.encodeRlp(["0x01", "0x02"]);     // a list, but far too short
    await expect(probe.stateRootOf(ethers.keccak256(short), 1n, short))
      .to.be.revertedWithCustomError(probe, "HeaderTooShort");
  });

  it("reads field 3 and field 8 — positions that survive every fork so far", async function () {
    // Every fork extending the header has APPENDED: London's baseFeePerGas,
    // Shanghai's withdrawalsRoot, Cancun's blob fields and
    // parentBeaconBlockRoot, Isthmus's requestsHash. So stateRoot stays at 3 and
    // number at 8, and appending a field 21 tomorrow changes nothing.
    const n = await ethers.provider.getBlockNumber();
    const b = await blockAt(n);
    const fields = headerFields(b);
    expect(fields[3]).to.equal(b.stateRoot);
    expect(BigInt(fields[8] === "0x" ? 0 : fields[8])).to.equal(BigInt(b.number));

    // And a header with EXTRA trailing fields still verifies, as long as it is
    // the real one — which it is, because its hash is what we check against.
    expect(fields.length).to.be.gte(15);
  });
});
