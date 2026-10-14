const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { rawHeaderFor } = require("./rlpHeader.js");
const { expectRevert } = require("./revert.js");

// PHASES 3-6 of docs/design/holder-voting-proposal.txt: the token account proof,
// the proposal lifecycle, voting, and finalization — end to end against REAL
// eth_getProof output, with no trusted party anywhere in the path.
//
// EXECUTION IS AN EVENT. finalize() records and publishes the outcome and moves
// nothing — the same rule the DAO framework settled on (dao-governance.md §9):
// emitting is the base ability, and real on-chain action is a custom override
// that replaces it. That override is the `_onFinalized` hook, unimplemented
// here. This governor holds authority over nothing.
//
// Needs a node that serves eth_getProof; hardhat's does not, anvil does:
//
//     anvil --port 8549 --silent &
//     HARDHAT_URL=http://127.0.0.1:8549 npx hardhat test \
//         test/governance/HistoricalBalanceGovernor.test.js --network localhost
//
// SKIPS rather than fails without one, so the ordinary suite stays green.

const DAY = 24 * 60 * 60;

describe("Phases 3-6 — propose, activate, vote, finalize", function () {
  this.timeout(300000);

  let token, gov, tokenAddr, dep, alice, bob, carol, nobody;

  beforeEach(async function () {
    [dep, alice, bob, carol, , , , , , nobody] = await ethers.getSigners();
    try {
      await network.provider.send("eth_getProof", [ethers.ZeroAddress, [], "latest"]);
    } catch {
      console.log("      (skipped: no eth_getProof — run against anvil)");
      this.skip();
    }

    const chainId = (await ethers.provider.getNetwork()).chainId;
    token = await (await ethers.getContractFactory("SatoriToken"))
      .deploy(dep.address, dep.address, chainId);
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();

    gov = await (await ethers.getContractFactory("HistoricalBalanceGovernor"))
      .deploy(tokenAddr, 64, DAY);      // 64-block activation window, 1-day vote
    await gov.waitForDeployment();

    await (await token.transfer(alice.address, ethers.parseEther("100"))).wait();
    await (await token.transfer(bob.address, ethers.parseEther("40"))).wait();
    await (await token.transfer(carol.address, ethers.parseEther("10"))).wait();
  });

  async function proposeOne(minTurnoutBps = 0, approvalBps = 5000, g = gov) {
    const rc = await (await g.propose(
      ethers.id("actions"), ethers.id("desc"), minTurnoutBps, approvalBps)).wait();
    const ev = rc.logs.map(l => { try { return g.interface.parseLog(l); } catch { return null; } })
                      .find(e => e && e.name === "ProposalCreated");
    return ev.args.proposalId;
  }

  async function activate(id) {
    const p = await gov.proposal(id);
    const hex = "0x" + p.snapshotBlock.toString(16);
    const b = await network.provider.send("eth_getBlockByNumber", [hex, false]);
    const tsSlot = ethers.zeroPadValue("0x02", 32);              // _totalSupply
    const acct = await network.provider.send("eth_getProof", [tokenAddr, [tsSlot], hex]);
    const tsProof = acct.storageProof[0].proof;
    await (await gov.activateProposal(id, rawHeaderFor(b), acct.accountProof, tsProof)).wait();
    return { block: b, acct, tsProof };
  }

  async function balanceProof(id, who) {
    const p = await gov.proposal(id);
    const hex = "0x" + p.snapshotBlock.toString(16);
    const slot = await gov.balanceSlot(who);
    const r = await network.provider.send("eth_getProof", [tokenAddr, [slot], hex]);
    return r.storageProof[0].proof;
  }

  it("runs the whole path: propose, activate, vote, decide", async function () {
    const id = await proposeOne();
    const { acct } = await activate(id);

    // The account proof is verified ON CHAIN against a state root that came from
    // a header the EVM itself vouched for — not from the RPC.
    const p = await gov.proposal(id);
    expect(p.tokenStorageRoot.toLowerCase()).to.equal(acct.storageHash.toLowerCase());
    expect(p.activated).to.equal(true);

    // Weight is read OUT of each proof; nobody states a balance.
    for (const [who, support] of [[alice, 1], [bob, 0], [carol, 1]]) {
      await (await gov.connect(who).castVote(id, support, await balanceProof(id, who.address))).wait();
    }

    const after = await gov.proposal(id);
    expect(after.forVotes).to.equal(ethers.parseEther("110"));    // alice + carol
    expect(after.againstVotes).to.equal(ethers.parseEther("40")); // bob

    expect(await gov.succeeded(id)).to.equal(false);              // still open
    await network.provider.send("evm_increaseTime", [DAY + 1]);
    await network.provider.send("evm_mine");
    expect(await gov.succeeded(id)).to.equal(true);
  });

  it("THE POINT: weight is the snapshot balance, not the current one", async function () {
    const id = await proposeOne();
    await activate(id);
    const proof = await balanceProof(id, alice.address);

    // Alice empties her wallet AFTER the snapshot...
    await (await token.connect(alice).transfer(nobody.address, ethers.parseEther("100"))).wait();
    expect(await token.balanceOf(alice.address)).to.equal(0n);

    // ...and still votes her snapshot weight.
    await (await gov.connect(alice).castVote(id, 1, proof)).wait();
    expect((await gov.proposal(id)).forVotes).to.equal(ethers.parseEther("100"));

    // And the recipient cannot vote what he was given: he held nothing then.
    await expectRevert(
      gov.connect(nobody).castVote.staticCall(id, 1, await balanceProof(id, nobody.address)),
      gov, "NoVotingPower");
  });

  it("MY REVIEW FINDING: a proposal expires if it is not activated in time", async function () {
    // Without this a proposer picks a snapshot and then chooses WHEN to open
    // voting — propose, wait for a large holder to sell, then activate while
    // that holder still carries full snapshot weight. It is also bounded by
    // reality: activation needs eth_getProof at the snapshot block, and public
    // Base RPCs stop serving proofs after hundreds of blocks (review §9).
    const id = await proposeOne();
    const p = await gov.proposal(id);
    const hex = "0x" + p.snapshotBlock.toString(16);
    const b = await network.provider.send("eth_getBlockByNumber", [hex, false]);
    const tsSlot = ethers.zeroPadValue("0x02", 32);
    const acct = await network.provider.send("eth_getProof", [tokenAddr, [tsSlot], hex]);

    for (let i = 0; i < 70; i++) await network.provider.send("evm_mine");   // past 64

    await expectRevert(
      gov.activateProposal.staticCall(id, rawHeaderFor(b), acct.accountProof,
                                      acct.storageProof[0].proof),
      gov, "ActivationWindowClosed");
  });

  it("refuses a second activation, so the snapshot can never be restated", async function () {
    const id = await proposeOne();
    const { block, acct, tsProof } = await activate(id);
    await expectRevert(
      gov.activateProposal.staticCall(id, rawHeaderFor(block), acct.accountProof, tsProof),
      gov, "AlreadyActivated");
  });

  it("refuses voting before activation and after the deadline", async function () {
    const id = await proposeOne();
    await expectRevert(gov.connect(alice).castVote.staticCall(id, 1, []), gov, "NotActive");

    await activate(id);
    const proof = await balanceProof(id, alice.address);
    await network.provider.send("evm_increaseTime", [DAY + 1]);
    await network.provider.send("evm_mine");
    await expectRevert(gov.connect(alice).castVote.staticCall(id, 1, proof), gov, "NotActive");
  });

  it("one ballot per address, whatever proof is presented", async function () {
    // §53 — the guard is the voter flag, not proof identity.
    const id = await proposeOne();
    await activate(id);
    const proof = await balanceProof(id, alice.address);

    await (await gov.connect(alice).castVote(id, 1, proof)).wait();
    await expectRevert(gov.connect(alice).castVote.staticCall(id, 0, proof), gov, "AlreadyVoted");
    // A freshly fetched proof is the same bytes, but fetch it again anyway —
    // the point is that nothing about the PROOF is what stops the second vote.
    await expectRevert(
      gov.connect(alice).castVote.staticCall(id, 0, await balanceProof(id, alice.address)),
      gov, "AlreadyVoted");
  });

  it("cannot vote another holder's weight, or a forged one", async function () {
    const id = await proposeOne();
    await activate(id);

    // §38.2 — the slot is derived from msg.sender, so alice's proof answers a
    // question nobody asked when carol presents it.
    await expectRevert(
      gov.connect(carol).castVote.staticCall(id, 1, await balanceProof(id, alice.address)), gov);

    // A mutated node cannot pass the hash chain.
    const bad = [...await balanceProof(id, alice.address)];
    const last = bad[bad.length - 1];
    bad[bad.length - 1] = last.slice(0, -2) + (last.slice(-2) === "ff" ? "ee" : "ff");
    await expectRevert(gov.connect(alice).castVote.staticCall(id, 1, bad), gov);
  });

  it("cannot smuggle totalSupply in as voting weight", async function () {
    // §54, the sharpest adversarial case.
    const id = await proposeOne();
    await activate(id);
    const p = await gov.proposal(id);
    const hex = "0x" + p.snapshotBlock.toString(16);
    const tsSlot = ethers.zeroPadValue("0x02", 32);          // _totalSupply
    const r = await network.provider.send("eth_getProof", [tokenAddr, [tsSlot], hex]);
    await expectRevert(gov.connect(alice).castVote.staticCall(id, 1, r.storageProof[0].proof), gov);
  });

  it("an address that never held tokens has no weight", async function () {
    const id = await proposeOne();
    await activate(id);
    await expectRevert(
      gov.connect(nobody).castVote.staticCall(id, 1, await balanceProof(id, nobody.address)),
      gov, "NoVotingPower");
  });

  it("PHASE 6: finalize publishes the outcome — the event IS the execution", async function () {
    const id = await proposeOne();
    await activate(id);
    for (const [who, support] of [[alice, 1], [bob, 0], [carol, 2]]) {
      await (await gov.connect(who).castVote(id, support, await balanceProof(id, who.address))).wait();
    }

    // Not while voting is open.
    await expectRevert(gov.finalize.staticCall(id), gov, "VotingStillOpen");
    await network.provider.send("evm_increaseTime", [DAY + 1]);
    await network.provider.send("evm_mine");

    const rc = await (await gov.finalize(id)).wait();
    const ev = rc.logs.map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
                      .find(e => e && e.name === "ProposalFinalized");
    expect(ev, "the outcome must be emitted — it is the whole execution").to.not.equal(undefined);
    expect(ev.args.passed).to.equal(true);
    expect(ev.args.forVotes).to.equal(ethers.parseEther("100"));
    expect(ev.args.againstVotes).to.equal(ethers.parseEther("40"));
    expect(ev.args.abstainVotes).to.equal(ethers.parseEther("10"));
    expect(ev.args.snapshotTotalSupply).to.equal(await token.totalSupply());

    // Frozen, so the answer stops depending on when you ask.
    await expectRevert(gov.finalize.staticCall(id), gov, "AlreadyFinalized");
  });

  it("reports percentages, and TURNOUT — the number that carries the meaning", async function () {
    const id = await proposeOne();
    await activate(id);
    // Only carol votes: 10 SATORI out of a ~846 supply. A 100% yes on almost no
    // turnout must be legible AS almost no turnout.
    await (await gov.connect(carol).castVote(id, 1, await balanceProof(id, carol.address))).wait();
    await network.provider.send("evm_increaseTime", [DAY + 1]);
    await network.provider.send("evm_mine");
    await (await gov.finalize(id)).wait();

    const r = await gov.result(id);
    expect(r.finalized).to.equal(true);
    expect(r.passed).to.equal(true);
    expect(r.forBps).to.equal(10000n);                       // 100% of votes cast
    const supply = await token.totalSupply();
    expect(r.snapshotTotalSupply).to.equal(supply);
    expect(r.turnoutBps).to.equal((ethers.parseEther("10") * 10000n) / supply);
    expect(r.turnoutBps).to.be.lt(200n);                     // under 2% — and it SHOWS
  });

  it("a proposal with no votes at all finalizes without dividing by zero", async function () {
    const id = await proposeOne();
    await activate(id);
    await network.provider.send("evm_increaseTime", [DAY + 1]);
    await network.provider.send("evm_mine");
    await (await gov.finalize(id)).wait();

    const r = await gov.result(id);
    expect(r.passed).to.equal(false);          // nothing for, nothing against
    expect(r.forBps).to.equal(0n);
    expect(r.turnoutBps).to.equal(0n);
  });

  it("cannot finalize a proposal that was never activated", async function () {
    const id = await proposeOne();
    await expectRevert(gov.finalize.staticCall(id), gov, "NotActive");
  });

  it("THE TRIGGER IS DATA: the bar is committed at propose time, before any vote", async function () {
    const id = await proposeOne(2000, 6667);
    const p = await gov.proposal(id);
    expect(p.minTurnoutBps).to.equal(2000n);
    expect(p.approvalBps).to.equal(6667n);
    // The bar is in the id's preimage, so the same actions at a different bar
    // are a DIFFERENT proposal.
    expect(await proposeOne(2000, 5000)).to.not.equal(id);
    // And a bar over 100% is nonsense, refused at the door.
    await expectRevert(
      gov.propose.staticCall(ethers.id("a"), ethers.id("d"), 10001, 5000), gov, "BadThresholds");
    await expectRevert(
      gov.propose.staticCall(ethers.id("a"), ethers.id("d"), 0, 10001), gov, "BadThresholds");
  });

  it("turnout trigger: a unanimous yes below the floor does NOT pass", async function () {
    // 20% turnout required; only carol shows up with ~1.2% of supply. The vote
    // is 100% yes and it still fails — which is the entire point of the floor.
    const id = await proposeOne(2000, 5000);
    await activate(id);
    await (await gov.connect(carol).castVote(id, 1, await balanceProof(id, carol.address))).wait();
    await network.provider.send("evm_increaseTime", [DAY + 1]);
    await network.provider.send("evm_mine");
    await (await gov.finalize(id)).wait();

    const r = await gov.result(id);
    expect(r.forBps).to.equal(10000n);       // unanimous...
    expect(r.passed).to.equal(false);        // ...and insufficient
    expect(r.turnoutBps).to.be.lt(r.minTurnoutBps);
  });

  it("approval trigger: the same tally passes a 2/3 bar and fails a 3/4 bar", async function () {
    // alice 100 for, bob 40 against => for-share 71.4% of for+against.
    for (const [bar, shouldPass] of [[6667, true], [7500, false]]) {
      const id = await proposeOne(0, bar);
      await activate(id);
      await (await gov.connect(alice).castVote(id, 1, await balanceProof(id, alice.address))).wait();
      await (await gov.connect(bob).castVote(id, 0, await balanceProof(id, bob.address))).wait();
      await network.provider.send("evm_increaseTime", [DAY + 1]);
      await network.provider.send("evm_mine");
      await (await gov.finalize(id)).wait();
      expect((await gov.result(id)).passed, `bar ${bar}`).to.equal(shouldPass);
    }
  });

  it("abstain counts toward turnout and NEVER toward approval", async function () {
    // Supply ~846.6. alice 100 for, bob 40 against, carol 10 ABSTAIN.
    //   turnout  = 150 cast  (~17.7%) — carol's abstention is what clears 17%
    //   approval = 100 / 140 (~71.4%) — carol's abstention is excluded
    // The 7000 bar splits the two readings: 71.4% passes it, while 100/150
    // (66.7%, abstain wrongly in the denominator) would fail it. So this test
    // cannot pass unless BOTH properties hold at once.
    const id = await proposeOne(1700, 7000);
    await activate(id);
    for (const [who, support] of [[alice, 1], [bob, 0], [carol, 2]]) {
      await (await gov.connect(who).castVote(id, support, await balanceProof(id, who.address))).wait();
    }
    await network.provider.send("evm_increaseTime", [DAY + 1]);
    await network.provider.send("evm_mine");
    await (await gov.finalize(id)).wait();
    expect((await gov.result(id)).passed).to.equal(true);
  });

  it("at the default bar a tie still fails — 5000 IS the old strict majority", async function () {
    // alice moves 60 to nobody, then 40-for vs 40-against... simpler: bob(40)
    // for, and give nobody 40 to vote against.
    await (await token.transfer(nobody.address, ethers.parseEther("40"))).wait();
    const id = await proposeOne(0, 5000);
    await activate(id);
    await (await gov.connect(bob).castVote(id, 1, await balanceProof(id, bob.address))).wait();
    await (await gov.connect(nobody).castVote(id, 0, await balanceProof(id, nobody.address))).wait();
    await network.provider.send("evm_increaseTime", [DAY + 1]);
    await network.provider.send("evm_mine");
    await (await gov.finalize(id)).wait();
    expect((await gov.result(id)).passed).to.equal(false);
  });

  it("THE SEAMS: a subclass replaces the judgment and receives the verdict", async function () {
    // The user's question, answered in code: CAN trigger logic live in the hook
    // layer? Yes — _evaluate is virtual and the stored bars are only its
    // default. The mock demands unanimity, a rule the bars cannot express, and
    // its action hook records what it was HANDED rather than computing anything.
    const mock = await (await ethers.getContractFactory("TriggeredGovernorMock"))
      .deploy(tokenAddr, 64, DAY);
    await mock.waitForDeployment();

    // Majority-but-not-unanimous: passes the stored bar, fails the override.
    const id1 = await proposeOne(0, 5000, mock);
    {
      const p = await mock.proposal(id1);
      const hex = "0x" + p.snapshotBlock.toString(16);
      const b = await network.provider.send("eth_getBlockByNumber", [hex, false]);
      const tsSlot = ethers.zeroPadValue("0x02", 32);
      const acct = await network.provider.send("eth_getProof", [tokenAddr, [tsSlot], hex]);
      await (await mock.activateProposal(id1, rawHeaderFor(b), acct.accountProof,
                                         acct.storageProof[0].proof)).wait();
      const slotOf = async (w) => (await network.provider.send("eth_getProof",
        [tokenAddr, [await mock.balanceSlot(w)], hex])).storageProof[0].proof;
      await (await mock.connect(alice).castVote(id1, 1, await slotOf(alice.address))).wait();
      await (await mock.connect(bob).castVote(id1, 0, await slotOf(bob.address))).wait();
    }
    await network.provider.send("evm_increaseTime", [DAY + 1]);
    await network.provider.send("evm_mine");
    await (await mock.finalize(id1)).wait();

    expect(await mock.lastFinalizedId()).to.equal(id1);
    expect(await mock.lastVerdict()).to.equal(false);   // 100 vs 40 — but not unanimous
    expect(await mock.finalizedCount()).to.equal(1n);
    expect((await mock.result(id1)).passed).to.equal(false);
  });

  it("rejects an activation window wider than BLOCKHASH can reach", async function () {
    const F = await ethers.getContractFactory("HistoricalBalanceGovernor");
    // Statically CALL the deploy bytecode rather than sending it. A failed
    // deployment is a transaction, and a transaction carries no decodable revert
    // data — so sending it would only ever tell us "reverted", not why.
    for (const args of [[tokenAddr, 257, DAY], [tokenAddr, 0, DAY], [ethers.ZeroAddress, 64, DAY]]) {
      const tx = await F.getDeployTransaction(...args);
      await expectRevert(ethers.provider.call({ data: tx.data }), gov, "BadConfig");
    }
    // ...and the sane configuration deploys.
    const good = await F.deploy(tokenAddr, 64, DAY);
    await good.waitForDeployment();
    expect(await good.ACTIVATION_WINDOW()).to.equal(64n);
  });
});
