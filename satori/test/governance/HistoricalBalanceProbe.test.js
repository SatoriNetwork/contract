const { expect } = require("chai");
const { ethers, network } = require("hardhat");

// PHASE 1 of docs/design/holder-voting-proposal.txt — the standalone proof
// prototype, and the gate everything else waits on.
//
// The proposal's own instruction (§60): before building any governance, prove
// that a REAL `eth_getProof` response verifies on chain to the EXACT historical
// balance. If this does not work perfectly, nothing built on top of it can.
//
// HOW TO RUN IT. Hardhat's node does not implement `eth_getProof`, so this suite
// needs a node that does. Anvil does:
//
//     anvil --port 8549 --silent &
//     HARDHAT_URL=http://127.0.0.1:8549 npx hardhat test \
//         test/governance/HistoricalBalanceProbe.test.js --network localhost
//
// It SKIPS rather than fails when pointed at a node without proof support, so
// the ordinary suite stays green. A skip here is not a pass — read the message.

describe("Phase 1 — historical balance proofs verify on chain", function () {
  this.timeout(300000);

  let token, probe, tokenAddr, snapBlockHex, storageRoot;
  let dep, alice, bob, carol, nobody;

  before(async function () {
    [dep, alice, bob, carol, , , , , , nobody] = await ethers.getSigners();

    // Does this provider serve proofs at all? If not there is nothing to test.
    try {
      await network.provider.send("eth_getProof", [ethers.ZeroAddress, [], "latest"]);
    } catch {
      console.log("      (skipped: this provider has no eth_getProof — run against anvil)");
      this.skip();
    }

    const chainId = (await ethers.provider.getNetwork()).chainId;
    token = await (await ethers.getContractFactory("SatoriToken"))
      .deploy(dep.address, dep.address, chainId);
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();

    probe = await (await ethers.getContractFactory("HistoricalBalanceProbe")).deploy();
    await probe.waitForDeployment();

    // Several magnitudes, so the walk meets more than one trie shape.
    await (await token.transfer(alice.address, ethers.parseEther("100"))).wait();
    await (await token.transfer(bob.address, 1n)).wait();                       // one wei
    await (await token.transfer(carol.address, ethers.parseEther("250.5"))).wait();

    const snap = await ethers.provider.getBlockNumber();
    snapBlockHex = "0x" + snap.toString(16);

    // ethers v6's Block object does not carry stateRoot, so it comes from the
    // raw RPC here. In production it comes from a VERIFIED raw header instead —
    // Phase 1 is only proving the trie walk, not the header authentication.
    const header = await network.provider.send("eth_getBlockByNumber", [snapBlockHex, false]);
    const acct = await network.provider.send("eth_getProof", [tokenAddr, [], snapBlockHex]);
    storageRoot = await probe.accountStorageRoot(header.stateRoot, tokenAddr, acct.accountProof);

    // The account proof is verified ONCE per snapshot, not once per voter —
    // which is what keeps a vote's calldata to a single storage proof.
    expect(storageRoot.toLowerCase(), "derived storage root must equal the RPC's storageHash")
      .to.equal(acct.storageHash.toLowerCase());
  });

  async function proofFor(who) {
    const slot = await probe.balanceSlot(who);
    const r = await network.provider.send("eth_getProof", [tokenAddr, [slot], snapBlockHex]);
    return r.storageProof[0].proof;
  }

  it("proves the exact balance for every magnitude, including one wei and zero", async function () {
    for (const [name, who] of [
      ["deployer", dep], ["alice", alice], ["one wei", bob],
      ["carol", carol], ["never held any", nobody],
    ].map(([n, s]) => [n, s.address])) {
      const proven = await probe.proveBalance(storageRoot, who, await proofFor(who));
      expect(proven, name).to.equal(await token.balanceOf(who));
    }
  });

  it("THE POINT: a later transfer does not change the historical balance", async function () {
    // Proposal §52. Without this property the whole design is pointless — it is
    // what makes the vote resistant to buying weight after the snapshot.
    const before = await token.balanceOf(alice.address);
    expect(before).to.be.gt(0n);
    const proof = await proofFor(alice.address);

    await (await token.connect(alice).transfer(carol.address, before)).wait();
    expect(await token.balanceOf(alice.address)).to.equal(0n);   // empty NOW

    expect(await probe.proveBalance(storageRoot, alice.address, proof)).to.equal(before);
  });

  it("the caller cannot vote someone else's weight", async function () {
    // Proposal §38.2 — the governor derives the slot from the VOTER, so a proof
    // for a different holder simply does not answer the question being asked.
    const richProof = await proofFor(dep.address);
    let result;
    try { result = await probe.proveBalance(storageRoot, nobody.address, richProof); }
    catch { result = 0n; }
    expect(result).to.equal(0n);
  });

  it("cannot be pointed at another storage slot to mint weight", async function () {
    // Proposal §54, the sharpest adversarial case: prove totalSupply instead of
    // a balance. `proveBalance` computes the slot itself from the address, so a
    // totalSupply proof cannot be smuggled in as a balance.
    const tsSlot = ethers.zeroPadValue("0x02", 32);       // _totalSupply, slot 2
    const r = await network.provider.send("eth_getProof", [tokenAddr, [tsSlot], snapBlockHex]);
    let result;
    try { result = await probe.proveBalance(storageRoot, dep.address, r.storageProof[0].proof); }
    catch { result = 0n; }
    expect(result, "a totalSupply proof must not read as a balance").to.not.equal(
      await token.totalSupply());
  });

  it("rejects a mutated proof node, a wrong root, and a truncated proof", async function () {
    const good = await proofFor(dep.address);

    const mutated = [...good];
    const last = mutated[mutated.length - 1];
    mutated[mutated.length - 1] = last.slice(0, -2) + (last.slice(-2) === "ff" ? "ee" : "ff");
    await expect(probe.proveBalance(storageRoot, dep.address, mutated)).to.be.reverted;

    await expect(probe.proveBalance(ethers.ZeroHash, dep.address, good)).to.be.reverted;

    if (good.length > 1) {
      await expect(probe.proveBalance(storageRoot, dep.address, good.slice(0, -1)))
        .to.be.reverted;
    }
  });

  it("the derived slot agrees with the chain's own view of the balance", async function () {
    // Proposal §48 — the most fundamental assumption, checked directly rather
    // than through the proof machinery: the slot we compute really is where the
    // balance lives.
    // Both sides read AT THE SNAPSHOT. Comparing snapshot storage against a
    // present-day balanceOf would fail for anyone the test moved tokens to
    // afterwards — which is the property the previous test exists to prove, and
    // would be a confusing way to discover it.
    for (const who of [dep.address, carol.address]) {
      const slot = await probe.balanceSlot(who);
      const raw = await network.provider.send("eth_getStorageAt", [tokenAddr, slot, snapBlockHex]);
      const atSnapshot = await token.balanceOf(who, { blockTag: parseInt(snapBlockHex, 16) });
      expect(BigInt(raw), who).to.equal(atSnapshot);
    }
  });
});
