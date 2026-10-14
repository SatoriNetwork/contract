// The rewards read model (docs/issues/events-are-the-read-model.md, step 6):
// the unclaimed ledger, each round's frozen budget and every delegate's inbound
// power rebuild from logs, with no unclaimedRewards / predictionDelegateInfo read.
const { expect } = require("chai");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const nextRound = () => time.increase(86400);

async function streamIdOf(tx, registry) {
  const rc = await tx.wait();
  for (const l of rc.logs) {
    try { const p = registry.interface.parseLog(l); if (p && p.name === "DataStreamCreated") return p.args.streamId; } catch {}
  }
  throw new Error("no DataStreamCreated");
}

function parsedFrom(rc, contract, name) {
  return rc.logs.filter((l) => l.address === contract.target)
    .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .filter((p) => p && p.name === name);
}

describe("Rewards read model", function () {
  this.timeout(300000);
  let satori, rewards, registry, owner, alice, bob, carol;
  let game;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, rewards, registry, owner } = fix);
    [, alice, bob, carol] = await ethers.getSigners();
    game = await streamIdOf(await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 1440), registry);
    await satori.transfer(alice.address, ethers.parseEther("400"));
    await satori.transfer(bob.address, ethers.parseEther("200"));
    await satori.transfer(carol.address, ethers.parseEther("50"));
    await voteFor(satori, owner, game);
    await nextRound();
  });

  // predict at v, then two rising values: the A-B-C rhythm of a cadence-1440 stream.
  async function winOnce(who, v) {
    await nextRound();
    await registry.setValue(game, v);
    await satori.connect(who).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
    await nextRound();
    await registry.setValue(game, v + 10);
    await nextRound();
    await registry.setValue(game, v + 20);
    return (await (await satori.settlePrediction(who.address, game)).wait());
  }

  describe("the unclaimed ledger", function () {
    it("a win with no delegators emits RewardSplit carrying gameId and the predictor's new balance", async function () {
      const rc = await winOnce(bob, 100);
      const split = parsedFrom(rc, rewards, "RewardSplit");
      expect(split.length).to.equal(1);
      expect(split[0].args.gameId).to.equal(game);
      expect(split[0].args.delegatorAmount).to.equal(0n);
      expect(split[0].args.predictorAmount).to.be.gt(0n);
      expect(split[0].args.newUnclaimed).to.equal(await rewards.unclaimedRewards(bob.address));
      const ref = parsedFrom(rc, rewards, "ReferralPaid");
      expect(ref.length).to.equal(1);
      expect(ref[0].args.newUnclaimed).to.equal(await rewards.unclaimedRewards(ref[0].args.referral));
    });

    it("a delegator's accrual emits DelegatorRewardsAccrued, and a fold of the ledger events equals unclaimedRewards for everyone", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await winOnce(bob, 100);
      await winOnce(bob, 200);
      await winOnce(bob, 300);
      await nextRound();
      const rc = await (await satori.connect(alice)["claim()"]()).wait();
      const acc = parsedFrom(rc, rewards, "DelegatorRewardsAccrued");
      expect(acc.length).to.equal(1);
      expect(acc[0].args.delegator).to.equal(alice.address);
      expect(acc[0].args.amount).to.be.gt(0n);

      const kinds = ["RewardSplit", "DelegatorRewardsAccrued", "ReferralPaid", "RewardsClaimed"];
      const logs = (await Promise.all(kinds.map((k) => rewards.queryFilter(rewards.filters[k](), 0)))).flat()
        .sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
      const fold = {};
      for (const l of logs) {
        const a = l.args;
        if (l.fragment.name === "RewardSplit") fold[a.predictor] = a.newUnclaimed;
        else if (l.fragment.name === "DelegatorRewardsAccrued") fold[a.delegator] = a.newUnclaimed;
        else if (l.fragment.name === "ReferralPaid") fold[a.referral] = a.newUnclaimed;
        else fold[a.owner] = 0n;
      }
      const who = [alice.address, bob.address, await rewards.marketingFeeRecipient()];
      for (const w of who) expect(fold[w] ?? 0n, w).to.equal(await rewards.unclaimedRewards(w));
    });
  });

  describe("the round budget", function () {
    it("the round's first touch emits RoundBudgetFrozen with the frozen budget; later touches emit nothing", async function () {
      await nextRound();
      const round = await satori.getCurrentRound();
      const budget = (await satori.emissionRateNow()) - (await satori.devRateNow()) - (await rewards.offchainBudget());
      await expect(registry.setValue(game, 1)).to.emit(rewards, "RoundBudgetFrozen").withArgs(round, budget);
      await expect(satori.connect(bob).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]))
        .to.not.emit(rewards, "RoundBudgetFrozen");
    });
  });

  describe("prediction delegation", function () {
    const inbound = async (d) => (await rewards.predictionDelegateInfo(d)).power;

    it("delegating emits the activation round and the delegate's new inbound power", async function () {
      const today = await satori.getCurrentRound();
      const tx = satori.connect(alice).delegatePredictionPower(bob.address);
      await expect(tx).to.emit(rewards, "PredictionDelegated");
      const ev = parsedFrom(await (await tx).wait(), rewards, "PredictionDelegated")[0];
      expect(ev.args.delegator).to.equal(alice.address);
      expect(ev.args.delegate).to.equal(bob.address);
      expect(ev.args.activationRound).to.equal(today);
      expect(ev.args.newDelegatePower).to.equal(await inbound(bob.address));
    });

    it("delegating after the delegate predicted this round defers activation to the next round", async function () {
      await registry.setValue(game, 100);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: game, payload: pack1(UP) }]);
      const today = await satori.getCurrentRound();
      const rc = await (await satori.connect(alice).delegatePredictionPower(bob.address)).wait();
      expect(parsedFrom(rc, rewards, "PredictionDelegated")[0].args.activationRound).to.equal(today + 1n);
    });

    it("switching delegates emits PredictionUndelegated naming the one left, then PredictionDelegated", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      const rc = await (await satori.connect(alice).delegatePredictionPower(carol.address)).wait();
      const out = parsedFrom(rc, rewards, "PredictionUndelegated");
      const into = parsedFrom(rc, rewards, "PredictionDelegated");
      expect(out.length).to.equal(1);
      expect(out[0].args.delegate).to.equal(bob.address);
      expect(out[0].args.newDelegatePower).to.equal(await inbound(bob.address));
      expect(into.length).to.equal(1);
      expect(into[0].args.delegate).to.equal(carol.address);
      expect(into[0].args.newDelegatePower).to.equal(await inbound(carol.address));
    });

    it("undelegating names the delegate; a no-op undelegation emits nothing", async function () {
      await expect(satori.connect(carol).delegatePredictionPower(ethers.ZeroAddress))
        .to.not.emit(rewards, "PredictionUndelegated");
      await satori.connect(alice).delegatePredictionPower(bob.address);
      const rc = await (await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress)).wait();
      const out = parsedFrom(rc, rewards, "PredictionUndelegated");
      expect(out.length).to.equal(1);
      expect(out[0].args.delegator).to.equal(alice.address);
      expect(out[0].args.delegate).to.equal(bob.address);
      expect(out[0].args.newDelegatePower).to.equal(await inbound(bob.address));
    });

    it("a receipt to a delegator emits DelegatePowerSynced with next-round activation and the delegate's new power", async function () {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      const today = await satori.getCurrentRound();
      const rc = await (await satori.connect(carol).transfer(alice.address, ethers.parseEther("7"))).wait();
      const ev = parsedFrom(rc, rewards, "DelegatePowerSynced");
      expect(ev.length).to.equal(1);
      expect(ev[0].args.delegate).to.equal(bob.address);
      expect(ev[0].args.delegator).to.equal(alice.address);
      expect(ev[0].args.value).to.equal(ethers.parseEther("7"));
      expect(ev[0].args.activationRound).to.equal(today + 1n);
      expect(ev[0].args.newDelegatePower).to.equal(await inbound(bob.address));
    });
  });
});
