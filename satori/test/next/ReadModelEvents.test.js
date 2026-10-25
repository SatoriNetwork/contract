// G11 — the events a reader needs to rebuild state without reading storage.
//
// Each event here carries a fact that used to exist only in storage: an adapter
// game's bet and result, the bounty token an adapter round pays in, an unchanged
// pull's cadence advance, the total burned weight after a vote or approval, the
// governor's turnout denominator, the wiring a one-shot setter bound, and the
// raw capability word.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const {
  deploySatoriFixture,
  deployAndRegisterYesNoGame,
  createYesNoGame,
  createChainlinkStream,
  pack1,
  VOTE,
} = require("../fixtures");

const YES = 1;
const E = (n) => ethers.parseEther(String(n));

async function streamIdFrom(tx, registry) {
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = registry.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("Read-model events (G11)", function () {
  this.timeout(600000);

  describe("adapter games and their bounty token", function () {
    it("announces the pinned token, the stake snapshot, the bet and its settlement", async function () {
      const fix = await loadFixture(deploySatoriFixture);
      const { satori, bounties, registry } = fix;
      const [, alice, funder, authority] = fix.signers;
      for (const u of [alice, funder, authority]) await satori.transfer(u.address, E(100));

      const { gameTypeId } = await deployAndRegisterYesNoGame(fix);
      const stream = await streamIdFrom(
        await satori.connect(authority)["createSimpleDataStream(string,address,uint24)"]("S", authority.address, 2880),
        registry
      );
      await registry.connect(authority).setValue(stream, 100);
      const gameId = await createYesNoGame(satori.connect(authority), gameTypeId, stream, 150, "yn");

      const usd = await (await ethers.getContractFactory("MockERC20")).deploy("USDC", "USDC");
      const usdAddr = await usd.getAddress();
      const bountiesAddr = await bounties.getAddress();
      for (const u of [funder, alice]) {
        await usd.mint(u.address, E(10000));
        await usd.connect(u).approve(bountiesAddr, E(10000));
      }
      await bounties.connect(authority).setAdapterBountyToken(gameId, usdAddr);
      await bounties.connect(alice).stakeBountyToken(usdAddr, E(100));
      await bounties.connect(funder).fundBounty(gameId, usdAddr, E(1000), E(400));

      const round = await satori.getCurrentRound();
      expect(await bounties.adapterActiveToken(gameId, round)).to.equal(ethers.ZeroAddress);

      const tx = await satori.connect(alice).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
      await expect(tx).to.emit(bounties, "AdapterBountyTokenPinned").withArgs(gameId, round, usdAddr);
      await expect(tx).to.emit(bounties, "AdapterStakeSnapshotted")
        .withArgs(alice.address, gameId, usdAddr, round, E(100), round + 1n);
      await expect(tx).to.emit(fix.engine, "AdapterPredictionMade")
        .withArgs(alice.address, gameId, round, anyValue, E(100));
      expect(await bounties.adapterActiveToken(gameId, round)).to.equal(usdAddr);

      await time.increase(2 * 86400);
      await registry.connect(authority).setValue(stream, 200);
      const settle = await satori.connect(funder).settlePrediction(alice.address, gameId);
      await expect(settle).to.emit(fix.engine, "AdapterPredictionSettled");
      const evt = (await (await settle.wait()).logs
        .map((l) => { try { return fix.engine.interface.parseLog(l); } catch (e) { return null; } })
        .filter((p) => p && p.name === "AdapterPredictionSettled"))[0];
      expect(evt.args.user).to.equal(alice.address);
      expect(evt.args.gameId).to.equal(gameId);
      expect(evt.args.round).to.equal(round);
      expect(evt.args.finalized).to.equal(true);
    });

    it("says there is no token for a round with no live bounty", async function () {
      const fix = await loadFixture(deploySatoriFixture);
      const { satori, bounties, registry } = fix;
      const [, alice, authority] = fix.signers;
      for (const u of [alice, authority]) await satori.transfer(u.address, E(100));
      const { gameTypeId } = await deployAndRegisterYesNoGame(fix);
      const stream = await streamIdFrom(
        await satori.connect(authority)["createSimpleDataStream(string,address,uint24)"]("S", authority.address, 2880),
        registry
      );
      await registry.connect(authority).setValue(stream, 100);
      const gameId = await createYesNoGame(satori.connect(authority), gameTypeId, stream, 150, "yn");
      const round = await satori.getCurrentRound();
      const tx = await satori.connect(alice).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
      await expect(tx).to.emit(bounties, "AdapterBountyTokenPinned").withArgs(gameId, round, ethers.ZeroAddress);
      expect(await bounties.adapterActiveToken(gameId, round)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("an unchanged pull", function () {
    it("emits StreamChecked and writes no value", async function () {
      const fix = await loadFixture(deploySatoriFixture);
      const { satori, registry } = fix;
      const [, authority] = fix.signers;
      await satori.transfer(authority.address, E(100));
      const feed = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy();
      await feed.setAnswer(3000n);
      const streamId = await streamIdFrom(
        await createChainlinkStream(satori, "ETH/USD", await feed.getAddress(), authority.address),
        registry
      );
      await registry.connect(authority).updateValue(streamId);
      await time.increase(86400);
      await feed.setAnswer(3000n); // refreshed, same value
      const tx = await registry.connect(authority).updateValue(streamId);
      await expect(tx).to.emit(registry, "StreamChecked").withArgs(streamId, (await ethers.provider.getBlock(tx.blockNumber)).timestamp);
      await expect(tx).to.not.emit(registry, "StreamValueUpdated");
    });
  });

  describe("vote and approval events carry the running burned weight", function () {
    it("Voted and GameApprovedSet end with totalBurnedWeight", async function () {
      const fix = await loadFixture(deploySatoriFixture);
      const { satori, voting, games, rewards } = fix;
      const [owner, alice, authority] = fix.signers;
      await satori.transfer(alice.address, E(100));
      await satori.transfer(authority.address, E(100));
      const streamId = await streamIdFrom(
        await satori.connect(authority)["createSimpleDataStream(string,address,uint24)"]("V", authority.address, 1440),
        fix.registry
      );
      const gameId = await games.binaryGameByStream(streamId);

      const admin = await ethers.getSigner(await rewards.admin());
      const unapprove = await voting.connect(admin).setGameApproved(gameId, false);
      await expect(unapprove).to.emit(voting, "GameApprovedSet").withArgs(gameId, false, await voting.totalBurnedWeight());
      const approve = await voting.connect(admin).setGameApproved(gameId, true);
      await expect(approve).to.emit(voting, "GameApprovedSet").withArgs(gameId, true, await voting.totalBurnedWeight());

      const tx = await satori.connect(alice).vote(gameId, VOTE);
      const total = await voting.totalBurnedWeight();
      await expect(tx).to.emit(voting, "Voted")
        .withArgs(alice.address, gameId, await satori.getCurrentRound(), VOTE, VOTE, await voting.weightOf(gameId), total);
    });
  });

  describe("wiring and capabilities", function () {
    it("Rewards announces the engine and bounties it was bound to", async function () {
      const fix = await loadFixture(deploySatoriFixture);
      const { rewards, engine, bounties } = fix;
      const engineLogs = await rewards.queryFilter(rewards.filters.SatoriEngineSet());
      const bountyLogs = await rewards.queryFilter(rewards.filters.SatoriBountiesSet());
      expect(engineLogs.map((l) => l.args.engine)).to.deep.equal([await engine.getAddress()]);
      expect(bountyLogs.map((l) => l.args.bounties)).to.deep.equal([await bounties.getAddress()]);
    });

    it("exposes the raw capability word", async function () {
      const fix = await loadFixture(deploySatoriFixture);
      const { rewards } = fix;
      const admin = await ethers.getSigner(await rewards.admin());
      await rewards.connect(admin).setCapabilities(0b100101n);
      expect(await rewards.capabilityBitmap()).to.equal(0b100101n);
    });
  });
});
