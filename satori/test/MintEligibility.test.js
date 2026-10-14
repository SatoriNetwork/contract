const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, deployAndRegisterYesNoGame, pack1, VOTE } = require("./fixtures");

/**
 * Only the built-in binary game earns SATORI from the mint.
 *
 * An adapter game (type > 0) settles by its own logic; an off-chain game settles
 * entirely off-chain against a root its operator publishes. Neither outcome is
 * verifiable on-chain, so the protocol does not mint for them. The old 2x
 * off-chain vote handicap was a discount priced against exactly that risk —
 * refusing eligibility outright is a cleaner line than a multiplier.
 *
 * The enforcement is ONE check, in `vote`. Everything downstream already agrees
 * by construction: no vote -> no weight -> `recordGameVotesForRound` writes
 * nothing -> `_gameRoundAllocation` returns zero -> no reward path can pay.
 *
 * BOUNTIES ARE UNAFFECTED and that is the point of the boundary: bounty pools
 * are separately funded escrow in arbitrary tokens, not the mint. Any game type
 * can still be bountied and can still pay out.
 */
describe("mint eligibility", function () {
  this.timeout(180000);

  const UP = 1;
  let satori, voting, registry, rewards, games, owner, signers;

  async function nextRound() {
    const t = await time.latest();
    await time.increaseTo(Math.floor(Number(t) / 86400) * 86400 + 86400 + 1);
  }
  async function streamIdFrom(tx) {
    const r = await tx.wait();
    for (const l of r.logs) {
      try { const p = satori.interface.parseLog(l); if (p?.name === "DataStreamCreated") return p.args.streamId; }
      catch (_) {}
    }
    throw new Error("DataStreamCreated not found");
  }

  beforeEach(async function () {
    const fx = await deploySatoriFixture();
    ({ satori, voting, registry, rewards, games, owner, signers } = fx);
  });

  it("the built-in binary game CAN be voted for", async function () {
    const sid = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("Binary", owner.address, 1440));
    expect(Number(await games.gameTypeIdOf(sid))).to.equal(0);
    await expect(satori.connect(owner).vote(sid, VOTE)).to.not.be.reverted;
    expect(await voting.weightOf(sid)).to.equal(VOTE);
  });

  it("an ADAPTER game (type > 0) cannot be voted for", async function () {
    const { gameTypeId } = await deployAndRegisterYesNoGame({
      satori, registry, rewards, owner, games,
      engine: await ethers.getContractAt("SatoriEngine", await satori.engine()),
    });
    const sid = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("Host", owner.address, 2880));
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [100]);
    const rc = await (await satori.connect(owner).createGame(sid, gameTypeId, cfg, "yesno")).wait();
    const gid = Number(rc.logs.map((l) => { try { return games.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "GameCreated").args.gameId);

    expect(Number(await games.gameTypeIdOf(gid))).to.be.gt(0);
    await expect(satori.connect(owner).vote(gid, VOTE))
      .to.be.revertedWithCustomError(voting, "GameNotMintEligible");
    expect(await voting.weightOf(gid)).to.equal(0n);
  });

  it("weight is linear now — no off-chain handicap remains", async function () {
    // The handicap only ever applied to off-chain games, which can no longer be
    // voted at all. Every burn that lands buys weight 1:1.
    const sid = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("Linear", owner.address, 1440));
    await satori.connect(owner).vote(sid, ethers.parseEther("7"));
    expect(await voting.weightOf(sid)).to.equal(ethers.parseEther("7"));
    await satori.connect(owner).vote(sid, ethers.parseEther("3"));
    expect(await voting.weightOf(sid)).to.equal(ethers.parseEther("10"));
  });

  it("an unvotable game earns nothing from the mint, by construction", async function () {
    // Not enforced by a second check — it falls out. No weight means
    // recordGameVotesForRound writes nothing, so the round record stays empty.
    const { gameTypeId } = await deployAndRegisterYesNoGame({
      satori, registry, rewards, owner, games,
      engine: await ethers.getContractAt("SatoriEngine", await satori.engine()),
    });
    const sid = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("NoMint", owner.address, 2880));
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [100]);
    const rc = await (await satori.connect(owner).createGame(sid, gameTypeId, cfg, "g")).wait();
    const gid = Number(rc.logs.map((l) => { try { return games.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "GameCreated").args.gameId);

    await nextRound();
    await registry.setValue(sid, 100);
    const round = await satori.getCurrentRound();

    expect(await voting.weightOf(gid)).to.equal(0n);
    expect(await voting.getGameVotesAtRound(gid, round)).to.equal(0n);
    expect(await voting.isEligible(gid)).to.equal(false);
  });

  it("adapters are handed the predictor's UNDIVIDED power, not a dead zero", async function () {
    // Adapter games earn no SATORI, so the apportioned weight is always 0 for
    // them. Rather than pass a worthless argument, the engine hands adapters the
    // user's real, undivided prediction power — and it must NOT shrink just
    // because the user predicted other games in the same batch.
    const Probe = await ethers.getContractFactory("PowerProbeGame");
    const probe = await Probe.deploy();
    await probe.waitForDeployment();
    const rc0 = await (await satori.connect(owner)
      .registerGameAdapter(await probe.getAddress(), "Probe")).wait();
    const typeId = Number(rc0.logs.map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "GameAdapterRegistered").args.gameTypeId);

    const sid = await streamIdFrom(await satori["createSimpleDataStream(string,address,uint24)"]("Probed", owner.address, 2880));
    const rc = await (await satori.connect(owner).createGame(sid, typeId, "0x", "probe")).wait();
    const gid = Number(rc.logs.map((l) => { try { return games.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "GameCreated").args.gameId);

    const [, alice] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await nextRound();
    await registry.setValue(sid, 100);

    const expected = await rewards.getPredictionPower(alice.address);
    expect(expected, "sanity: alice has power").to.be.gt(0n);
    await satori.connect(alice)
      .predictMultipleWithPayloads([{ gameId: gid, payload: pack1(UP) }]);

    expect(await probe.lastPower(alice.address),
      "adapter must receive real undivided power, not 0").to.equal(expected);
  });

  it("the default game is still excluded for its own reason", async function () {
    // Type 0, but its weight is derived rather than bought — a different rule
    // reaching the same answer, and it must keep its own error.
    expect(Number(await games.gameTypeIdOf(1))).to.equal(0);
    await expect(satori.connect(owner).vote(1, VOTE))
      .to.be.revertedWithCustomError(voting, "CannotVoteDefault");
  });
});
