const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("../fixtures");
const { BASE, issuedOf, issueTo, rewardsSigner, advanceRound, atRound } = require("./emissionHelpers");

// docs/issues/events-are-the-read-model.md: `emission().issued` and
// `merkleReserveCumulative` must be rebuildable from the hub's logs alone, at
// every point, whatever order banks, scores and fee changes happen in.

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const E = (n) => ethers.parseEther(String(n));

const RESERVE_ANCHORS = {
  MerkleReserveShareSet: "cumulativeAtFromRound",
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

  it("scores with delegators fold exactly", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    for (let i = 0, base = 100; i < 4; i++, base += 100) {
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
      expect(await rewards.delegatorRewardRatePerRound(bob.address, split.args.round)).to.be.gt(0n);
      await expectFolds(`round ${i}`);
      await advanceRound();
    }
  });

  it("a silent bank before a fee raise under the deepest share still folds exactly", async function () {
    const merkleLane = sink;
    await hub.connect(owner).setSatoriMerkle(merkleLane.address);
    await rewards.connect(owner).setOffchainShareBps(9999);
    for (let i = 0; i < 5; i++) await advanceRound();
    await hub.connect(sink).syncEmission();         // banks at the old residual
    await expectFolds("after the early bank");
    await atRound(token, (await token.deploymentRound()) + 30n);   // the fee dial's gap counts from genesis
    await token.connect(owner).proposeDevFeeBps(2500);
    await token.connect(owner).acceptDevFeeBps();   // the residual the share splits falls
    await advanceRound();
    const rw = await rewardsSigner(rewards);
    const banks = async (label, send) => {
      const before = await hub.merkleReserveCumulative();
      await send();
      expect(await hub.merkleReserveCumulative(), `${label} banks`).to.be.gt(before);
      await expectFolds(label);
    };
    await banks("after the fee raise", () => hub.connect(rw).noteIssued(E(1)));   // banks the rest at the new one
    await advanceRound();
    await banks("after a merkle-lane rewardMint bank", () => hub.connect(merkleLane).rewardMint(sink.address, 1n));
    await advanceRound();
    await banks("after a round-pricing bank", async () => hub.connect(rw).freezeRoundGross(await token.getCurrentRound()));
  });

  it("an emission step folds exactly", async function () {
    await rewards.connect(owner).setOffchainShareBps(5000);
    await advanceRound();
    // Real reports cannot reach a threshold inside the envelope; the harness moves the counter.
    const steps0 = (await hub.emission()).stepsTaken; // banking on the way here may already have stepped
    await issueTo(hub, token, null, (await hub.emission()).nextStepAt);
    expect((await hub.emission()).stepsTaken).to.equal(steps0 + 1n);
    await expectFolds("after the step");
  });
});
