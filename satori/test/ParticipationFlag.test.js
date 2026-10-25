// Participation-bit semantics.
//
// The participation bit exists for ONE reason: to gate SatoriToken._update's
// prediction-delegation transfer hook. That hook does real work only for a
// prediction DELEGATOR (their balance receipts must re-book onto the delegate's
// pool). So the bit is set at exactly one site — delegating prediction power out
// (rewards.delegatePredictionPower, on the delegator only) — and NOT on
// predicting, voting, claim delegation, or bounty staking, none of which make a
// wallet's balance affect another pool. It is cleared at once on undelegating
// (unmarkParticipated, which emits ParticipationCleared); a transfer never
// changes it.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const UP = 1;

async function getStreamIdFromTx(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function deployMockToken() {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy("USDC", "USDC");
  await t.waitForDeployment();
  return t;
}

describe("ParticipationFlag", function () {
  let satori, token, voting, rewards, bounties, registry, owner, alice, bob, carol, authority;
  let stream;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, token, voting, rewards, bounties, registry, owner } = fix);
    [, alice, bob, carol, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    const tx = await satori.connect(authority).createSimpleDataStream("S", authority.address);
    stream = await getStreamIdFromTx(tx, satori);
  });

  it("initial state: fresh addresses have hasParticipated == false", async function () {
    expect(await satori.hasParticipated(alice.address)).to.equal(false);
    expect(await satori.hasParticipated(bob.address)).to.equal(false);
    expect(await satori.hasParticipated(carol.address)).to.equal(false);
  });

  it("vote does NOT mark the voter", async function () {
    expect(await satori.hasParticipated(alice.address)).to.equal(false);
    await voteFor(satori, alice, stream);
    expect(await satori.hasParticipated(alice.address)).to.equal(false);
  });

  it("predict does NOT mark msg.sender", async function () {
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    expect(await satori.hasParticipated(bob.address)).to.equal(false);
  });

  it("predictMultiple does NOT mark msg.sender", async function () {
    const tx = await satori.connect(authority).createSimpleDataStream("S2", authority.address);
    const stream2 = await getStreamIdFromTx(tx, satori);
    await registry.connect(authority).setValue(stream, 100);
    await registry.connect(authority).setValue(stream2, 200);
    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: stream, payload: pack1(UP) },
      { gameId: stream2, payload: pack1(UP) },
    ]);
    expect(await satori.hasParticipated(bob.address)).to.equal(false);
  });

  it("delegateClaimAbility does NOT mark either party", async function () {
    await satori.connect(alice).delegateClaimAbility(bob.address);
    expect(await satori.hasParticipated(alice.address)).to.equal(false);
    expect(await satori.hasParticipated(bob.address)).to.equal(false);
  });

  it("stakeBountyToken does NOT mark the staker", async function () {
    const usd = await deployMockToken();
    await usd.mint(alice.address, ethers.parseEther("100"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("100"));
    await bounties.connect(alice).stakeBountyToken(await usd.getAddress(), ethers.parseEther("10"));
    expect(await satori.hasParticipated(alice.address)).to.equal(false);
  });

  it("delegatePredictionPower marks the DELEGATOR only, not the delegate", async function () {
    expect(await satori.hasParticipated(alice.address)).to.equal(false);
    expect(await satori.hasParticipated(bob.address)).to.equal(false);
    await satori.connect(alice).delegatePredictionPower(bob.address);
    expect(await satori.hasParticipated(alice.address)).to.equal(true);
    // The delegate's own balance is read live at predict time; only its
    // delegators' balances move its pool, so the delegate needs no mark.
    expect(await satori.hasParticipated(bob.address)).to.equal(false);
  });

  it("undelegating clears the delegator bit immediately (eager, symmetric with the mark)", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    expect(await satori.hasParticipated(alice.address)).to.equal(true);

    // Undelegating unsets the bit in the same call that set it — no transfer,
    // no deferral. You are a delegator or you are not. The clear is an event
    // too, so the read model sees a wallet leave the gate as well as join it.
    const token = await ethers.getContractAt("SatoriToken", await satori.satoriToken());
    await expect(satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress))
      .to.emit(token, "ParticipationCleared").withArgs(alice.address);
    expect(await satori.hasParticipated(alice.address)).to.equal(false);
  });

  it("a delegator who burn-votes stays marked and delegated (undelegate/re-delegate around the burn nets out)", async function () {
    // burnForVote undelegates the caller, burns, then re-delegates. The eager
    // unmark fires on the undelegate step and the re-delegation re-marks, so the
    // caller ends the transaction exactly as they started: marked and delegated.
    await satori.connect(alice).delegatePredictionPower(bob.address);
    expect(await satori.hasParticipated(alice.address)).to.equal(true);

    await voteFor(satori, alice, stream);

    expect(await satori.hasParticipated(alice.address)).to.equal(true);
    expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
  });

  it("transfer between two non-participants skips the hook; a transfer touching a marked delegator runs it", async function () {
    const Probe = await ethers.getContractFactory("ReentrantTransferHook");
    const probe = await Probe.deploy(await token.getAddress());
    await probe.waitForDeployment();
    await probe.setMode(0); // observe-only — increments `calls`, returns (true,true)
    await token.connect(owner).setHook(await probe.getAddress());

    // Neither side marked → hook skipped.
    await satori.connect(alice).transfer(bob.address, ethers.parseEther("5"));
    expect(await probe.calls()).to.equal(0n,
      "skip-mask must bypass the transfer hook when neither side has participated");

    // Mark carol by delegating her prediction power (a delegator is send-locked,
    // so exercise the hook with a RECEIPT into her).
    await satori.connect(carol).delegatePredictionPower(bob.address);
    expect(await satori.hasParticipated(carol.address)).to.equal(true);
    await satori.connect(alice).transfer(carol.address, ethers.parseEther("5"));
    expect(await probe.calls()).to.equal(1n,
      "a transfer touching a participant DOES run the hook");
  });

  it("transfer into a delegator runs the sync and books onto the delegate's pool", async function () {
    // The hook fans out to exactly ONE child: rewards.syncPredictionDelegation.
    await satori.connect(alice).delegatePredictionPower(bob.address);
    expect(await satori.hasParticipated(alice.address)).to.equal(true);

    const poolBefore = (await rewards.predictionDelegateInfo(bob.address)).power;
    expect(poolBefore).to.equal(ethers.parseEther("100")); // alice's balance at delegation time

    await satori.connect(carol).transfer(alice.address, ethers.parseEther("5"));

    const poolAfter = (await rewards.predictionDelegateInfo(bob.address)).power;
    expect(poolAfter - poolBefore).to.equal(ethers.parseEther("5"));
  });

  it("markParticipated reverts Unauthorized for non-child callers", async function () {
    await expect(
      satori.connect(alice).markParticipated(alice.address)
    ).to.be.revertedWithCustomError(satori, "Unauthorized");
  });

  it("idempotent: re-delegating an already-marked delegator keeps the flag set", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    expect(await satori.hasParticipated(alice.address)).to.equal(true);
    // Switch delegate in a later round (DelegateActive guard only blocks
    // switching while the current delegate predicted this round).
    await time.increase(86400);
    await satori.connect(alice).delegatePredictionPower(carol.address);
    expect(await satori.hasParticipated(alice.address)).to.equal(true);
  });
});

describe("Hook-reason lane (reserved future hook triggers)", function () {
  let satori, token, owner, alice, bob, carol, hubSigner;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, token, owner } = fix);
    [, alice, bob, carol] = fix.signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));

    // The token's controller is the hub. Impersonate it to drive setHookReason
    // (no production caller exists yet — this is the reserved mechanism).
    const hubAddr = await satori.getAddress();
    await impersonateAccount(hubAddr);
    await setBalance(hubAddr, ethers.parseEther("1"));
    hubSigner = await ethers.getSigner(hubAddr);
  });

  it("setHookReason is controller-gated", async function () {
    await expect(
      token.connect(alice).setHookReason(alice.address, 0, true)
    ).to.be.revertedWithCustomError(token, "Unauthorized");
  });

  it("rejects an out-of-range reason index (0..14 exist)", async function () {
    await expect(
      token.connect(hubSigner).setHookReason(alice.address, 15, true)
    ).to.be.revertedWithCustomError(token, "BadInput");
  });

  it("a reason bit forces the hook, does not imply delegator, and survives transfers until cleared", async function () {
    const Probe = await ethers.getContractFactory("ReentrantTransferHook");
    const probe = await Probe.deploy(await token.getAddress());
    await probe.waitForDeployment();
    await probe.setMode(0); // observe-only
    await token.connect(owner).setHook(await probe.getAddress());

    // Clean wallets: transfer skips the hook.
    await satori.connect(alice).transfer(bob.address, ethers.parseEther("1"));
    expect(await probe.calls()).to.equal(0n);

    // Controller sets reason 2 on alice — she is NOT a delegator.
    await token.connect(hubSigner).setHookReason(alice.address, 2, true);
    expect(await token.hookReason(alice.address, 2)).to.equal(true);
    expect(await satori.hasParticipated(alice.address)).to.equal(false);

    // Now a transfer touching alice DOES fire the hook.
    await satori.connect(alice).transfer(bob.address, ethers.parseEther("1"));
    expect(await probe.calls()).to.equal(1n);
    // A transfer changes no gate bit, so the reason persists.
    expect(await token.hookReason(alice.address, 2)).to.equal(true);

    // Controller clears it → the hook stops firing for her.
    await token.connect(hubSigner).setHookReason(alice.address, 2, false);
    expect(await token.hookReason(alice.address, 2)).to.equal(false);
    await satori.connect(alice).transfer(bob.address, ethers.parseEther("1"));
    expect(await probe.calls()).to.equal(1n); // unchanged
  });

  it("undelegating clears only the delegator bit; a coexisting reason bit survives", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await token.connect(hubSigner).setHookReason(alice.address, 0, true);
    expect(await satori.hasParticipated(alice.address)).to.equal(true);
    expect(await token.hookReason(alice.address, 0)).to.equal(true);

    // Undelegating clears the delegator bit eagerly and leaves the independently
    // owned reason bit alone.
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    expect(await satori.hasParticipated(alice.address)).to.equal(false);
    expect(await token.hookReason(alice.address, 0)).to.equal(true);
  });

  it("reason bits are independent across the full lane (0..14); index 15 does not exist", async function () {
    // Exercise the ends and middle of the 15-bit lane.
    await token.connect(hubSigner).setHookReason(alice.address, 0, true);
    await token.connect(hubSigner).setHookReason(alice.address, 7, true);
    await token.connect(hubSigner).setHookReason(alice.address, 14, true);
    expect(await token.hookReason(alice.address, 0)).to.equal(true);
    expect(await token.hookReason(alice.address, 7)).to.equal(true);
    expect(await token.hookReason(alice.address, 14)).to.equal(true);
    expect(await token.hookReason(alice.address, 5)).to.equal(false);
    // Clearing the middle leaves the ends.
    await token.connect(hubSigner).setHookReason(alice.address, 7, false);
    expect(await token.hookReason(alice.address, 7)).to.equal(false);
    expect(await token.hookReason(alice.address, 0)).to.equal(true);
    expect(await token.hookReason(alice.address, 14)).to.equal(true);
    // Bit 14 (index 14) is the top; 15 is out of range.
    await expect(token.hookReason(alice.address, 15)).to.be.revertedWithCustomError(token, "BadInput");
  });
});
