const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("../fixtures");
const { BASE, issuedOf, rewardsSigner, advanceRound } = require("./emissionHelpers");

// docs/issues/events-are-the-read-model.md: `emission().issued` and
// `merkleReserveCumulative` must be rebuildable from the hub's logs alone, at
// every point, whatever order banks, scores and fee changes happen in.

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const E = (n) => ethers.parseEther(String(n));

const RESERVE_ANCHORS = {
  MerkleReserveRateSet: "cumulativeAtFromRound",
  MerkleReserveClamped: "cumulative",
  MerkleReserveBanked: "cumulative",
  EmissionStepped: "reserveCumulative",
};

async function hubLogs(hub) {
  const raw = await ethers.provider.getLogs({ address: hub.target, fromBlock: 0, toBlock: "latest" });
  return raw.map((l) => { try { return hub.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
}

/** issued = the last EmissionIssued's post-state, and also the sum of every `added`. */
async function foldIssued(hub) {
  const logs = (await hubLogs(hub)).filter((p) => p.name === "EmissionIssued");
  expect(logs.length, "the genesis seed is logged").to.be.gt(0);
  let sum = 0n;
  for (const p of logs) sum += p.args.added;
  return { last: logs[logs.length - 1].args.issued, sum };
}

async function foldReserve(hub) {
  let v = 0n;
  for (const p of await hubLogs(hub)) if (RESERVE_ANCHORS[p.name]) v = p.args[RESERVE_ANCHORS[p.name]];
  return v;
}

describe("Emission read model — issued and the Merkle reserve rebuild from logs", function () {
  this.timeout(600000);
  let fix, satori, hub, token, rewards, registry, owner, alice, bob, carol, sink, gameA;

  async function streamIdFrom(tx) {
    const r = await tx.wait();
    const ev = r.logs.find((l) => { try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; } });
    return satori.interface.parseLog(ev).args.streamId;
  }

  async function expectFolds(label) {
    const issued = await issuedOf(hub);
    const f = await foldIssued(hub);
    expect(f.last, `${label}: last EmissionIssued`).to.equal(issued);
    expect(f.sum, `${label}: sum of EmissionIssued.added`).to.equal(issued);
    expect(await foldReserve(hub), `${label}: reserve anchors`).to.equal(await hub.merkleReserveCumulative());
  }

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixtureNoFee);
    ({ satori, hub, token, rewards, registry, owner } = fix);
    [, alice, bob, carol, , , sink] = fix.signers;
    await satori.transfer(alice.address, E(200));
    await satori.transfer(bob.address, E(100));
    await satori.transfer(carol.address, E(50));
    gameA = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440));
    await satori.connect(carol).vote(gameA, VOTE);
    await advanceRound();
  });

  it("logs the genesis seed", async function () {
    expect(await issuedOf(hub)).to.equal(BASE);
    await expectFolds("genesis");
  });

  it("scores with and without delegator weight (an evaporated share) fold exactly", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    let sawEvaporated = false, sawCommitted = false;
    for (let i = 0, base = 100; i < 8 && !(sawEvaporated && sawCommitted); i++, base += 100) {
      await registry.setValue(gameA, base);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
      await advanceRound();
      await registry.setValue(gameA, base + 10);
      await advanceRound();
      await registry.setValue(gameA, base + 20);
      const rc = await (await satori.connect(carol).settlePrediction(bob.address, gameA)).wait();
      const split = rc.logs.map((l) => { try { return rewards.interface.parseLog(l); } catch { return null; } })
        .find((p) => p && p.name === "RewardSplit");
      expect(split, `round ${i} pays a split`).to.not.equal(undefined);
      if ((await rewards.delegatorRewardRatePerRound(bob.address, split.args.round)) > 0n) sawCommitted = true;
      else sawEvaporated = true;
      await expectFolds(`round ${i}`);
      await advanceRound();
    }
    expect(sawEvaporated && sawCommitted).to.equal(true);
  });

  it("a silent bank before a fee raise under a capped dial still folds exactly", async function () {
    const residual = (await hub.emissionRateNow()) - (await hub.devRateNow());
    await rewards.connect(owner).setOffchainBudget(residual - 1n);
    for (let i = 0; i < 5; i++) await advanceRound();
    await hub.connect(sink).syncEmission();         // banks at the old effective dial
    await expectFolds("after the early bank");
    for (let i = 0; i < 3; i++) await advanceRound();
    await token.connect(owner).proposeDevFeeBps(2500);
    await token.connect(owner).acceptDevFeeBps();   // residual - 1 falls under the dial
    await advanceRound();
    const rw = await rewardsSigner(rewards);
    await hub.connect(rw).noteIssued(E(1));           // banks the rest at the new one
    await expectFolds("after the fee raise");
    await advanceRound();
    await hub.connect(rw).rewardMint(sink.address, 1n);
    await expectFolds("after a rewardMint bank");
  });

  it("an emission step folds exactly", async function () {
    await rewards.connect(owner).setOffchainBudget(E(100));
    await advanceRound();
    const rw = await rewardsSigner(rewards);
    const e = await hub.emission();
    await hub.connect(rw).noteIssued(e.nextStepAt - e.issued);
    expect((await hub.emission()).stepsTaken).to.equal(1n);
    await expectFolds("after the step");
  });
});
