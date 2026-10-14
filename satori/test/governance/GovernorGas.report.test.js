const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { rawHeaderFor } = require("./rlpHeader.js");

// GAS (proposal §58), measured with real proof sizes rather than estimated —
// proof depth depends on actual trie shape, so the token is given ~120 holders
// first. Numbers print to the log and live in holder-voting-review.md; if they
// drift an order of magnitude, something structural changed.
//
// Needs eth_getProof (anvil); skips elsewhere.

describe("Gas report — the four calls, with real proofs", function () {
  this.timeout(600000);

  it("propose / activate / castVote / finalize", async function () {
    try {
      await network.provider.send("eth_getProof", [ethers.ZeroAddress, [], "latest"]);
    } catch {
      console.log("      (skipped: no eth_getProof — run against anvil)");
      this.skip();
    }
    const signers = await ethers.getSigners();
    const [dep, alice] = signers;
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const token = await (await ethers.getContractFactory("SatoriToken"))
      .deploy(dep.address, dep.address, chainId);
    await token.waitForDeployment();
    const tokenAddr = await token.getAddress();
    const gov = await (await ethers.getContractFactory("HistoricalBalanceGovernor"))
      .deploy(tokenAddr, 64, 86400);
    await gov.waitForDeployment();

    // ~120 distinct holders => a storage trie a few levels deep, so the per-vote
    // proof carries a realistic number of nodes for a young token.
    for (let i = 0; i < 120; i++) {
      const w = ethers.Wallet.createRandom().address;
      await (await token.transfer(w, ethers.parseEther("0.5"))).wait();
    }
    await (await token.transfer(alice.address, ethers.parseEther("10"))).wait();

    const gas = {};

    let rc = await (await gov.propose(ethers.id("a"), ethers.id("d"), 1000, 5000)).wait();
    gas.propose = rc.gasUsed;
    const id = rc.logs.map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
                      .find(e => e && e.name === "ProposalCreated").args.proposalId;

    const p = await gov.proposal(id);
    const hex = "0x" + p.snapshotBlock.toString(16);
    const b = await network.provider.send("eth_getBlockByNumber", [hex, false]);
    const tsSlot = ethers.zeroPadValue("0x02", 32);
    const acct = await network.provider.send("eth_getProof", [tokenAddr, [tsSlot], hex]);
    rc = await (await gov.activateProposal(id, rawHeaderFor(b), acct.accountProof,
                                           acct.storageProof[0].proof)).wait();
    gas.activate = rc.gasUsed;
    gas.activateNodes = acct.accountProof.length;

    const slot = await gov.balanceSlot(alice.address);
    const bp = await network.provider.send("eth_getProof", [tokenAddr, [slot], hex]);
    rc = await (await gov.connect(alice).castVote(id, 1, bp.storageProof[0].proof)).wait();
    gas.vote = rc.gasUsed;
    gas.voteNodes = bp.storageProof[0].proof.length;

    await network.provider.send("evm_increaseTime", [86401]);
    await network.provider.send("evm_mine");
    rc = await (await gov.finalize(id)).wait();
    gas.finalize = rc.gasUsed;

    console.log(`      propose   ${gas.propose}`);
    console.log(`      activate  ${gas.activate}  (header + account proof of ${gas.activateNodes} nodes + supply proof)`);
    console.log(`      castVote  ${gas.vote}  (storage proof of ${gas.voteNodes} nodes)`);
    console.log(`      finalize  ${gas.finalize}`);

    // Loose ceilings — tripwires against structural regressions, not budgets.
    expect(gas.propose).to.be.lt(250000n);
    expect(gas.activate).to.be.lt(1200000n);
    expect(gas.vote).to.be.lt(800000n);
    expect(gas.finalize).to.be.lt(150000n);
  });
});
