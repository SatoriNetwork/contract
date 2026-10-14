const { expect } = require("chai");
const { ethers } = require("hardhat");

// EMBEDDED TRIE NODES — the review finding, exercised.
//
// MPT inlines any node whose encoding is under 32 bytes into its parent instead
// of hash-referencing it, and eth_getProof does not ship inlined nodes as
// separate proof entries. A walker that treats every child as a 32-byte hash
// rejects such proofs.
//
// This is not theoretical: an embedded storage leaf needs ~14 nibbles of shared
// path, and a birthday collision on 56 bits is ~2^28 keccaks — seconds on a
// GPU. Anyone could make their own dust accounts unprovable, and 2^56 grinds a
// targeted dust victim. Liveness, never soundness — but a verifier that rejects
// valid tries is wrong.
//
// No real chain will hand us an embedded node on demand, so this builds the
// trie BY HAND: an extension consuming most of the path, whose child is an
// EMBEDDED branch, holding an EMBEDDED leaf — two levels of inlining in one
// hash-checked proof node. Every hash link that exists is real keccak, so this
// is a valid trie, just a small one.
//
// Runs on ANY node — pure verification, no eth_getProof needed. So unlike its
// sibling suites, this one never skips.

const nib = (hexstr, i) => parseInt(hexstr[2 + i], 16);

// Compact (hex-prefix) encoding of a nibble run.
function compact(nibbles, isLeaf) {
  const flag = (isLeaf ? 2 : 0) | (nibbles.length % 2);
  let ns = (flag & 1) ? [flag, ...nibbles] : [flag, 0, ...nibbles];
  let out = "0x";
  for (let i = 0; i < ns.length; i += 2) out += ns[i].toString(16) + ns[i + 1].toString(16);
  return out;
}

describe("MerklePatricia — embedded nodes verify like any other", function () {
  let probe;

  before(async function () {
    probe = await (await ethers.getContractFactory("HistoricalBalanceProbe")).deploy();
    await probe.waitForDeployment();
  });

  // Build: ext(61 nibbles) -> [embedded branch] -> [embedded leaf(2 nibbles)]
  // for the storage path of `holder`, carrying `valueHex` (RLP-encoded value).
  function buildTrie(pathHex, valueHex) {
    const pathNibbles = [...Array(64)].map((_, i) => nib(pathHex, i));

    // Leaf: consumes the last 2 nibbles. Tiny by construction => embedded.
    const leaf = [compact(pathNibbles.slice(62), true), valueHex];
    const leafRlp = ethers.encodeRlp(leaf);
    expect(ethers.getBytes(leafRlp).length, "test premise: leaf must be embeddable").to.be.lt(32);

    // Branch at nibble 61: the leaf sits inline in one slot.
    const branch = Array(17).fill("0x");
    branch[pathNibbles[61]] = leaf;                       // EMBEDDED (a list, not a hash)
    const branchRlp = ethers.encodeRlp(branch);
    expect(ethers.getBytes(branchRlp).length, "test premise: branch must be embeddable").to.be.lt(32);

    // Extension consuming nibbles 0..60, with the branch EMBEDDED in turn.
    const ext = [compact(pathNibbles.slice(0, 61), false), branch];
    const extRlp = ethers.encodeRlp(ext);
    return { root: ethers.keccak256(extRlp), proof: [extRlp] };
  }

  it("walks through two levels of embedding to the exact value", async function () {
    const holder = "0x1111111111111111111111111111111111111111";
    const rawSlot = await probe.balanceSlot(holder);
    const path = ethers.keccak256(rawSlot);               // the trie path is the HASH of the slot
    const { root, proof } = buildTrie(path, "0x2a");      // 42 wei

    expect(await probe.proveBalance(root, holder, proof)).to.equal(42n);
  });

  it("still proves ABSENCE through an embedded branch", async function () {
    const holder = "0x2222222222222222222222222222222222222222";
    const other  = "0x3333333333333333333333333333333333333333";
    const path = ethers.keccak256(await probe.balanceSlot(holder));
    const { root, proof } = buildTrie(path, "0x2a");

    // A different holder's slot diverges somewhere along the hand-built path,
    // which the walker must read as a proven zero — not as an error.
    expect(await probe.proveBalance(root, other, proof)).to.equal(0n);
  });

  it("an embedded leaf is still inside the hash chain — mutate it and the proof dies", async function () {
    const holder = "0x4444444444444444444444444444444444444444";
    const path = ethers.keccak256(await probe.balanceSlot(holder));
    const { root, proof } = buildTrie(path, "0x2a");

    // Flip one byte anywhere in the single proof node — which CONTAINS the
    // embedded branch and leaf — and the outer hash check must kill it. This is
    // why embedded nodes need no hash check of their own.
    const bytes = ethers.getBytes(proof[0]);
    bytes[bytes.length - 1] ^= 0x01;
    await expect(probe.proveBalance(root, holder, [ethers.hexlify(bytes)])).to.be.reverted;
  });

  it("a long-path leaf stays hash-referenced, and both shapes agree", async function () {
    // The other regime, for contrast: a SHALLOW trie leaves the leaf carrying
    // nearly the whole 64-nibble path, so it is 32+ bytes, hash-referenced, and
    // travels as its own proof node — the shape every earlier test used, and
    // the shape every realistic token trie is in (embedding needs ~14 consumed
    // nibbles, i.e. a collision, not honest growth).
    const holder = "0x5555555555555555555555555555555555555555";
    const pathHex = ethers.keccak256(await probe.balanceSlot(holder));
    const pathNibbles = [...Array(64)].map((_, i) => nib(pathHex, i));

    let bigHex = (10n ** 20n).toString(16);
    if (bigHex.length % 2) bigHex = "0" + bigHex;
    const big = "0x" + bigHex;

    // Branch at the root; the leaf keeps 63 nibbles of path.
    //
    // Faithful to geth: the leaf's value item is the RLP ENCODING of the
    // storage value — double-encoded. The embedded tests' 0x2a hid this,
    // because a single byte is its own RLP; nine bytes are not, and skipping
    // the inner layer here made the walker "find" a balance of 5 (the first
    // byte, 0x05, read as a one-byte RLP integer). The verifier was right and
    // this trie was wrong — which is itself worth keeping as a warning about
    // hand-built fixtures.
    const leafRlp = ethers.encodeRlp([compact(pathNibbles.slice(1), true),
                                      ethers.encodeRlp(big)]);
    expect(ethers.getBytes(leafRlp).length, "premise: this leaf must NOT embed").to.be.gte(32);

    const branch = Array(17).fill("0x");
    branch[pathNibbles[0]] = ethers.keccak256(leafRlp);   // by HASH this time
    const branchRlp = ethers.encodeRlp(branch);
    const root = ethers.keccak256(branchRlp);

    expect(await probe.proveBalance(root, holder, [branchRlp, leafRlp]))
      .to.equal(10n ** 20n);
  });
});
