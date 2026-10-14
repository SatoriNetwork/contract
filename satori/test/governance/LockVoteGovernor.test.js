const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures.js");

// The owner's self-contained voting path (docs/design/lock-vote-governor.md):
// no snapshot, no proofs, no daemon, no per-voter storage. Voting transfer-
// locks the voter's wallet until the vote ends, and that ONE lock is the
// entire integrity model — these tests attack it from every side the design
// claims to cover: revoting, moving tokens to a second wallet, flash-shaped
// atomic vote+transfer, topping up after voting, and the lane-A interplay.
//
// Runs on plain hardhat — the whole point of this path is needing nothing.

const DAY = 24 * 60 * 60;

describe("LockVoteGovernor — the lock is the integrity model", function () {
  let fix, token, hub, gov, dep, assoc, alice, bob, carol;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    token = fix.token; hub = fix.hub;
    // signers[0] IS the owner (who holds every authority); voters must be
    // other accounts — and fixture accounts carry protocol balances already,
    // so amount assertions read balanceOf rather than assuming.
    dep = fix.owner;
    [alice, bob, carol] = [fix.signers[1], fix.signers[2], fix.signers[3]];
    assoc = fix.signers[10];

    gov = await (await ethers.getContractFactory("LockVoteGovernor"))
      .deploy(await token.getAddress(), await hub.getAddress(), assoc.address);
    await gov.waitForDeployment();
    // dep holds every token authority in the fixture, wiring included.
    await (await hub.connect(dep).setVoteLockGovernor(await gov.getAddress())).wait();

    await (await token.connect(dep).transfer(alice.address, ethers.parseEther("100"))).wait();
    await (await token.connect(dep).transfer(bob.address, ethers.parseEther("40"))).wait();
    await (await token.connect(dep).transfer(carol.address, ethers.parseEther("10"))).wait();
  });

  async function proposeRounds(rounds, minTurnout = 0, approval = 5000, text = "words") {
    const end = (await token.getCurrentRound()) + BigInt(rounds);
    const rc = await (await gov.connect(assoc).propose(text, end, minTurnout, approval)).wait();
    const ev = rc.logs.map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
                      .find(e => e && e.name === "ProposalCreated");
    return { id: ev.args.proposalId, end, ev };
  }

  // ---- proposing ----

  it("only the association proposes; bounds hold; the words travel in the event", async function () {
    const text = "Should we do the thing?\n\nSentiment only.";
    const { id, end, ev } = await proposeRounds(3, 1000, 6000, text);
    expect(id).to.equal(1n);
    expect(ev.args.description).to.equal(text);
    const p = await gov.proposal(id);
    expect(p.descriptionHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes(text)));
    expect(p.endRound).to.equal(end);
    expect(p.supplyAtPropose).to.equal(await token.totalSupply());

    await expect(gov.connect(alice).propose("x", end, 0, 5000))
      .to.be.revertedWithCustomError(gov, "NotProposer");
    const now = await token.getCurrentRound();
    await expect(gov.connect(assoc).propose("x", now, 0, 5000))
      .to.be.revertedWithCustomError(gov, "BadEndRound");        // ends now = never open
    await expect(gov.connect(assoc).propose("x", now + 91n, 0, 5000))
      .to.be.revertedWithCustomError(gov, "BadEndRound");        // beyond the hub's lock cap
    await expect(gov.connect(assoc).propose("x", now + 2n, 0, 10000))
      .to.be.revertedWithCustomError(gov, "BadBar");             // unpassable bar
  });

  // ---- the lock does everything ----

  it("voting tallies live balance and locks the wallet until the end — no revote, no transfer", async function () {
    const { id, end } = await proposeRounds(2);

    const w = await token.balanceOf(alice.address);
    await expect(gov.connect(alice).castVote(id, 1))
      .to.emit(gov, "VoteCast").withArgs(id, alice.address, 1, w);
    expect((await gov.proposal(id)).forVotes).to.equal(w);

    // lane B pinned to endRound - 1: the exact remainder of the window.
    expect(await token.lockUntil(alice.address, 1)).to.equal(end - 1n);

    await expect(gov.connect(alice).castVote(id, 0))
      .to.be.revertedWithCustomError(gov, "VoteLockActive");     // no revote
    await expect(token.connect(alice).transfer(bob.address, 1n))
      .to.be.revertedWithCustomError(token, "Locked");           // no moving to a second wallet

    // ...and the moment voting closes, both frictions vanish together.
    await time.increase(2 * DAY);
    await expect(token.connect(alice).transfer(bob.address, 1n)).to.not.be.reverted;
    await expect(gov.connect(alice).castVote(id, 1))
      .to.be.revertedWithCustomError(gov, "VotingClosed");
  });

  it("one live vote per wallet: a locked voter cannot vote elsewhere until their vote ends", async function () {
    const short = await proposeRounds(1);
    const long = await proposeRounds(3);

    await (await gov.connect(bob).castVote(long.id, 1)).wait();
    await expect(gov.connect(bob).castVote(short.id, 1))
      .to.be.revertedWithCustomError(gov, "VoteLockActive");

    // carol votes the short one, unlocks at its end, then votes the long one —
    // sequential voting with the same tokens is legitimate: one vote per
    // proposal is the invariant, not one vote per lifetime.
    await (await gov.connect(carol).castVote(short.id, 0)).wait();
    await time.increase(1 * DAY);
    const w = await token.balanceOf(carol.address);
    await expect(gov.connect(carol).castVote(long.id, 2)).to.not.be.reverted;
    expect((await gov.proposal(long.id)).abstainVotes).to.equal(w);
  });

  it("the flash shape unwinds itself: vote + transfer in one tx reverts whole", async function () {
    const { id } = await proposeRounds(2);
    const flash = await (await ethers.getContractFactory("LockVoteFlashMock")).deploy();
    await (await token.connect(dep).transfer(await flash.getAddress(), ethers.parseEther("50"))).wait();

    await expect(flash.voteThenTransfer(
      await gov.getAddress(), await token.getAddress(), id, bob.address))
      .to.be.revertedWithCustomError(token, "Locked");
    // Nothing landed: the vote unwound with the transfer.
    expect((await gov.proposal(id)).forVotes).to.equal(0n);
  });

  it("tokens received after voting are trapped with the wallet and cannot revote", async function () {
    const { id } = await proposeRounds(2);
    const w = await token.balanceOf(carol.address);
    await (await gov.connect(carol).castVote(id, 1)).wait();

    // bob (unvoted, unlocked) tops carol up — HIS transfer out is fine.
    await (await token.connect(bob).transfer(carol.address, ethers.parseEther("40"))).wait();

    await expect(gov.connect(carol).castVote(id, 1))
      .to.be.revertedWithCustomError(gov, "VoteLockActive");     // top-up buys no second vote
    await expect(token.connect(carol).transfer(bob.address, 1n))
      .to.be.revertedWithCustomError(token, "Locked");           // and is trapped until the end
    expect((await gov.proposal(id)).forVotes).to.equal(w);       // tally = balance AT the vote
  });

  it("a lane-A (prediction) lock does not block voting — and voting still writes lane B", async function () {
    const { id, end } = await proposeRounds(2);

    // Wear the controller's hat (the hub) to set a lane-A lock directly.
    const hubAddr = await hub.getAddress();
    await network.provider.send("hardhat_impersonateAccount", [hubAddr]);
    await network.provider.send("hardhat_setBalance", [hubAddr, "0x1000000000000000000"]);
    const asHub = await ethers.getSigner(hubAddr);
    const nowRound = await token.getCurrentRound();
    await (await token.connect(asHub).setLock(alice.address, 0, nowRound + 5n)).wait();
    await network.provider.send("hardhat_stopImpersonatingAccount", [hubAddr]);

    await expect(gov.connect(alice).castVote(id, 1)).to.not.be.reverted;
    expect(await token.lockUntil(alice.address, 1)).to.equal(end - 1n);   // lane B written anyway
    expect(await token.lockUntil(alice.address, 0)).to.equal(nowRound + 5n); // lane A untouched
  });

  // ---- finalize: same bar semantics as the proof governor ----

  it("finalize publishes the frozen verdict once, after the end, bars enforced", async function () {
    // 40% turnout floor against supply-at-propose; strict majority.
    const supply = await token.totalSupply();
    const { id } = await proposeRounds(1, 4000, 5000);

    await expect(gov.finalize(id)).to.be.revertedWithCustomError(gov, "VotingNotOver");
    await (await gov.connect(carol).castVote(id, 1)).wait();     // 10 of ~supply: under the floor
    await time.increase(1 * DAY);

    await expect(gov.finalize(id)).to.emit(gov, "ProposalFinalized");
    const r = await gov.result(id);
    expect(r.finalized).to.equal(true);
    expect(r.passed).to.equal(false);                            // unanimous but under turnout
    expect(r.forBps).to.equal(10000n);
    expect(r.turnoutBps).to.equal((ethers.parseEther("10") * 10000n) / supply);
    await expect(gov.finalize(id)).to.be.revertedWithCustomError(gov, "AlreadyFinalized");
  });

  it("approval must STRICTLY exceed the bar — a dead-even split fails at 5000", async function () {
    const { id } = await proposeRounds(1, 0, 5000);
    // Two FRESH wallets with exactly equal stakes, so 50.00% For — which a
    // strict-majority bar must fail, because half is not more than half.
    const [yes, no] = [ethers.Wallet.createRandom().connect(ethers.provider),
                       ethers.Wallet.createRandom().connect(ethers.provider)];
    for (const w of [yes, no]) {
      await (await dep.sendTransaction({ to: w.address, value: ethers.parseEther("1") })).wait();
      await (await token.connect(dep).transfer(w.address, ethers.parseEther("5"))).wait();
    }
    await (await gov.connect(yes).castVote(id, 1)).wait();
    await (await gov.connect(no).castVote(id, 0)).wait();
    await time.increase(1 * DAY);
    await (await gov.finalize(id)).wait();
    const r = await gov.result(id);
    expect(r.forBps).to.equal(5000n);
    expect(r.passed).to.equal(false);
  });

  // ---- the hub door: cap, never-shorten, sever ----

  it("hub.voteLock: governor-only, lane-B-only semantics, capped, never shortens", async function () {
    // Point the door at an EOA to probe it directly.
    await (await hub.connect(dep).setVoteLockGovernor(alice.address)).wait();
    const now = await token.getCurrentRound();

    await expect(hub.connect(bob).voteLock(bob.address, now + 1n))
      .to.be.revertedWithCustomError(hub, "Unauthorized");
    await expect(hub.connect(alice).voteLock(bob.address, now + 91n))
      .to.be.revertedWithCustomError(hub, "BadInput");           // beyond the quarter cap
    await (await hub.connect(alice).voteLock(bob.address, now + 10n)).wait();
    expect(await token.lockUntil(bob.address, 1)).to.equal(now + 10n);
    await expect(hub.connect(alice).voteLock(bob.address, now + 5n))
      .to.be.revertedWithCustomError(hub, "BadInput");           // shortening a live lock
  });

  it("severing the governor stops new locks; existing locks still expire on their own", async function () {
    const { id } = await proposeRounds(2);
    await (await gov.connect(alice).castVote(id, 1)).wait();

    await (await hub.connect(dep).setVoteLockGovernor(ethers.ZeroAddress)).wait();
    await expect(gov.connect(bob).castVote(id, 1))
      .to.be.revertedWithCustomError(hub, "Unauthorized");       // door closed
    await expect(token.connect(alice).transfer(bob.address, 1n))
      .to.be.revertedWithCustomError(token, "Locked");           // alice's lock unaffected
    await time.increase(2 * DAY);
    await expect(token.connect(alice).transfer(bob.address, 1n)).to.not.be.reverted;

    await expect(hub.connect(alice).setVoteLockGovernor(alice.address))
      .to.be.revertedWithCustomError(hub, "Unauthorized");       // wiring authority only
  });

  it("proposer hands itself over; a stranger cannot", async function () {
    await expect(gov.connect(alice).transferProposer(alice.address))
      .to.be.revertedWithCustomError(gov, "NotProposer");
    await (await gov.connect(assoc).transferProposer(alice.address)).wait();
    await expect(gov.connect(alice).propose("x", (await token.getCurrentRound()) + 2n, 0, 5000))
      .to.not.be.reverted;
  });
});
