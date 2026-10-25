// Sweep C4 — small hardening that lands before the immutable contracts deploy.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("../fixtures");

describe("C4 hardening", function () {
  it("a dust emission ratio is refused; the floor itself and the default are fine", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, owner } = fix;
    await expect(satori.connect(owner).setEmissionRatio(1)).to.be.revertedWithCustomError(satori, "BadInput");
    await expect(satori.connect(owner).setEmissionRatio(10n ** 15n - 1n)).to.be.revertedWithCustomError(satori, "BadInput");
    await expect(satori.connect(owner).setEmissionRatio(10n ** 15n)).to.not.be.reverted;
    await expect(satori.connect(owner).setEmissionRatio(618033988749894848n)).to.not.be.reverted;
  });

  it("the admin cannot approve a game id that does not exist yet", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { voting, games, owner } = fix;
    const next = (await games.gameCount()) + 1n;
    await expect(voting.connect(owner).setGameApproved(next, true))
      .to.be.revertedWithCustomError(voting, "UnknownGame");
  });

  it("the lens reports the longest lock, so a wallet that cannot transfer never shows as unlocked", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, lens, voting, registry, signers } = fix;
    const [owner, alice, carol] = signers;
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    const tx = await satori["createSimpleDataStream(string,address,uint24)"]("L", owner.address, 1440);
    const rcpt = await tx.wait();
    const sid = registry.interface.parseLog(
      rcpt.logs.find((l) => { try { return registry.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; } })
    ).args.streamId;
    await satori.connect(carol).vote(sid, VOTE);
    await registry.setValue(sid, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(1) }]);
    const token = await ethers.getContractAt("SatoriToken", await satori.satoriToken());
    expect(await lens.lockedUntil(alice.address)).to.equal(await token.transferLockedUntil(alice.address));
    expect(await lens.lockedUntil(alice.address)).to.be.gt(0n);
  });
});
