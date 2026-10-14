/**
 * MAX_DELEGATOR_ROUNDS_PER_CALL must keep a single claim well inside a block.
 *
 * `_accrueDelegatorRewards` walks the delegator's rounds and gives the
 * open-round replay its OWN budget of the same size, so one claim can walk 2x
 * the cap. Measured 2026-08-12 with loyalty weighting in place: ~10.1k gas per
 * idle round walked, ~8.6k on a winning round. At the previous cap of 1024 the
 * worst case was ~21M against a 30M block -- not a margin.
 *
 * The cap is 512. This test pins the OUTCOME rather than the constant: build a
 * backlog several times the cap, and assert every capped claim stays under a
 * third of a 30M block while still draining in a bounded number of calls. It
 * fails if the cap is raised, or if a future change makes a walked round more
 * expensive, which is the regression that actually matters.
 */
const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const BLOCK_GAS = 30_000_000n;
const CEILING = BLOCK_GAS / 3n;   // one claim must stay under a third of a block

async function adv() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86401);
}

describe("delegator claim gas stays inside a block", function () {
  this.timeout(3600000);

  it("a backlog several times the per-call cap drains in bounded calls, none near the block limit", async function () {
    const [owner, alice, bob, carol] = await ethers.getSigners();
    const { satori, registry } = await deploySatoriFixtureNoFee();
    await satori.transfer(alice.address, ethers.parseEther("200"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("50"));

    const rcpt = await (await satori[SIMPLE3]("S", owner.address, 1440)).wait();
    const sid = satori.interface.parseLog(
      rcpt.logs.find(l => { try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; } })
    ).args.streamId;
    await satori.connect(carol).vote(sid, VOTE);
    await adv();
    await satori.connect(alice).delegatePredictionPower(bob.address);

    // 200 winning rounds (the credit path + q pinning), then a long idle
    // stretch: ~1500 rounds of backlog against a 512 cap.
    let v = 1000;
    for (let k = 0; k < 200; k++) {
      await adv(); v += 10;
      await registry.setValue(sid, v);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(1) }]);
    }
    await adv(); await registry.setValue(sid, v + 10);
    await adv(); await registry.setValue(sid, v + 20);
    await satori.settlePrediction(bob.address, sid);
    for (let i = 0; i < 1300; i++) await adv();

    // Drain. Each call must be affordable; the cursor resumes across calls.
    let calls = 0;
    let maxGas = 0n;
    let lastGas;
    do {
      const tx = await satori.connect(alice).getFunction("claim(address)")(carol.address);
      lastGas = (await tx.wait()).gasUsed;
      if (lastGas > maxGas) maxGas = lastGas;
      calls++;
      expect(lastGas, `claim #${calls} gas`).to.be.lt(CEILING);
      expect(calls, "backlog should drain in a bounded number of claims").to.be.lte(8);
    } while (lastGas > 200_000n);   // a walk that hit the cap is far above this

    // Sanity: the cap really did bind (otherwise this test proves nothing).
    expect(calls).to.be.gte(3);
    expect(maxGas).to.be.gt(1_000_000n);
  });
});
