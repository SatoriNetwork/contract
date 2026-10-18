// A receipt to a delegator must either be synced into its delegate's power or
// not happen at all, whatever gas the sender picks; and a receipt that was
// never synced (the hook unset for a while) must not stop the delegator
// leaving. docs/issues/predeploy-sweep-2026-10-17/B1-hook-gas-skip-freezes-delegator.md
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { takeSnapshot, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySplitFixture } = require("./splitFixture.js");

const E = (n) => ethers.parseEther(String(n));
const ROUND = 86400;

async function setup() {
  const fx = await deploySplitFixture();
  const { token, hub, owner, signers } = fx;
  const [, alice, bob, carol, dave, eve] = signers;
  await (await token.connect(owner).transfer(alice.address, E(100))).wait();
  await (await token.connect(owner).transfer(carol.address, E(50))).wait();
  await (await token.connect(owner).transfer(dave.address, E(10))).wait();
  await (await hub.connect(alice).delegatePredictionPower(bob.address)).wait();
  return { ...fx, alice, bob, carol, dave, eve };
}

const powerOf = async (rewards, a) => (await rewards.predictionDelegateInfo(a))[1];

function skipEvents(rcpt, token, hub) {
  const names = [];
  for (const log of rcpt.logs) {
    for (const c of [token, hub]) {
      if (log.address.toLowerCase() !== c.target.toLowerCase()) continue;
      try {
        const p = c.interface.parseLog(log);
        if (p && (p.name === "TransferHookFailed" || p.name === "ChildSyncFailed")) names.push(p.name);
      } catch (_) {}
    }
  }
  return names;
}

describe("Delegation sync: no gas limit skips it, and a missed one cannot trap a delegator", function () {
  this.timeout(600000);

  it("at every gas limit, a 1-wei receipt to a delegator either reverts or is synced", async function () {
    const { token, hub, rewards, alice, bob, dave } = await setup();
    const before = await powerOf(rewards, bob.address);

    const outcome = async (gasLimit) => {
      const s = await takeSnapshot();
      let kind;
      try {
        const rcpt = await (await token.connect(dave).transfer(alice.address, 1n, { gasLimit })).wait();
        const skipped = skipEvents(rcpt, token, hub);
        const delta = (await powerOf(rewards, bob.address)) - before;
        kind = skipped.length === 0 && delta === 1n ? "synced" : `landed-unsynced(${skipped.join(",")},${delta})`;
      } catch (_) {
        kind = "reverted";
      }
      await s.restore();
      return kind;
    };

    const full = await token.connect(dave).transfer.estimateGas(alice.address, 1n);
    const hi = Number(full) + 60000;
    const seen = [];
    let prev = null;
    for (let g = 30000; g <= hi; g += 500) {
      const k = await outcome(g);
      expect(k, `gas limit ${g}`).to.be.oneOf(["reverted", "synced"]);
      if (prev !== null && k !== prev) seen.push(g);
      prev = k;
    }
    // The old skip window sat right below the first gas limit that synced;
    // probe the edges finely so a narrow window cannot hide between steps.
    for (const edge of seen) {
      for (let g = edge - 1500; g <= edge + 1500; g += 25) {
        expect(await outcome(g), `gas limit ${g}`).to.be.oneOf(["reverted", "synced"]);
      }
    }
    expect(prev).to.equal("synced");
  });

  it("a sender using the node's gas estimate gets a synced receipt", async function () {
    const { token, hub, rewards, alice, bob, dave } = await setup();
    const before = await powerOf(rewards, bob.address);
    const est = await token.connect(dave).transfer.estimateGas(alice.address, 1n);
    const rcpt = await (await token.connect(dave).transfer(alice.address, 1n, { gasLimit: est })).wait();
    expect(skipEvents(rcpt, token, hub)).to.deep.equal([]);
    expect(await powerOf(rewards, bob.address)).to.equal(before + 1n);
  });

  // The cost of not skipping on empty revert data: a hook that fails without a
  // reason blocks what it hooks. It hooks only delegators, not the hub's fee
  // intake, and re-pointing the hook recovers.
  it("a hook that fails without a reason blocks only receipts to delegators, and re-pointing it recovers", async function () {
    const { token, hub, rewards, owner, alice, bob, carol, dave } = await setup();
    expect(await token.hasParticipated(hub.target)).to.equal(false);
    const broken = await (await ethers.getContractFactory("MockTransferHook")).deploy();
    await (await broken.setMode(2)).wait();
    await (await token.connect(owner).setHook(broken.target)).wait();

    await expect(token.connect(dave).transfer(alice.address, 1n))
      .to.be.revertedWithCustomError(token, "HookFailedWithoutReason");
    await (await token.connect(owner).approve(hub.target, ethers.MaxUint256)).wait();
    await (await hub.connect(owner)["createSimpleDataStream(string,address)"]("fee intake", owner.address)).wait();
    await (await token.connect(carol).transfer(dave.address, 1n)).wait();

    await (await token.connect(owner).setHook(hub.target)).wait();
    await (await token.connect(dave).transfer(alice.address, 1n)).wait();
    expect(await powerOf(rewards, bob.address)).to.equal(E(100) + 1n);
  });

  it("a receipt the hook never saw does not stop the delegator undelegating, and the delegate keeps exactly the rest", async function () {
    const { token, hub, rewards, owner, alice, bob, carol, dave } = await setup();
    await (await hub.connect(carol).delegatePredictionPower(bob.address)).wait();
    expect(await powerOf(rewards, bob.address)).to.equal(E(150));

    await (await token.connect(owner).setHook(ethers.ZeroAddress)).wait();
    await (await token.connect(dave).transfer(alice.address, 1n)).wait();
    await (await token.connect(owner).setHook(hub.target)).wait();
    expect(await powerOf(rewards, bob.address)).to.equal(E(150));

    await expect(hub.connect(alice).delegatePredictionPower(ethers.ZeroAddress))
      .to.emit(rewards, "PredictionUndelegated").withArgs(alice.address, bob.address, E(100), E(50));
    expect(await powerOf(rewards, bob.address)).to.equal(E(50));

    await expect(hub.connect(carol).delegatePredictionPower(ethers.ZeroAddress))
      .to.emit(rewards, "PredictionUndelegated").withArgs(carol.address, bob.address, E(50), 0n);

    await time.increase(ROUND * 2);
    await (await token.connect(alice).transfer(dave.address, E(100) + 1n)).wait();
    expect(await token.balanceOf(alice.address)).to.equal(0n);
  });

  it("a receipt the hook never saw does not stop the delegator switching; the new delegate gets its whole balance", async function () {
    const { token, hub, rewards, owner, alice, bob, dave, eve } = await setup();
    await (await token.connect(owner).setHook(ethers.ZeroAddress)).wait();
    await (await token.connect(dave).transfer(alice.address, E(1))).wait();
    await (await token.connect(owner).setHook(hub.target)).wait();

    await (await hub.connect(alice).delegatePredictionPower(eve.address)).wait();
    expect(await powerOf(rewards, bob.address)).to.equal(0n);
    expect(await powerOf(rewards, eve.address)).to.equal(E(101));

    await (await hub.connect(alice).delegatePredictionPower(ethers.ZeroAddress)).wait();
    expect(await powerOf(rewards, eve.address)).to.equal(0n);
  });
});
