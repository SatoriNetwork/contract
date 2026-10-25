// M25 — an adapter game pays bounties in the one token its author chose.
//
// The old rule (first funded token in the queue is the round's active token) let a
// junk token that nobody else holds sit at the head forever. Now the game's
// author names the token, sponsors can fund only that token, and the round's
// active token is that token while it has live funding. M27 also reserves the
// round's pot when the first stake is snapshotted.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  deployAndRegisterYesNoGame,
  createYesNoGame,
  pack1,
} = require("../fixtures");

const E = (n) => ethers.parseEther(String(n));

describe("Adapter game bounty token (M25)", function () {
  this.timeout(300000);

  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, bounties, registry, games } = fix;
    const [, alice, funder, authority, stranger] = fix.signers;
    for (const u of [alice, funder, authority, stranger]) await satori.transfer(u.address, E(100));

    const { gameTypeId } = await deployAndRegisterYesNoGame(fix);
    const tx = await satori.connect(authority)["createSimpleDataStream(string,address,uint24)"]("S", authority.address, 2880);
    const rcpt = await tx.wait();
    let stream;
    for (const log of rcpt.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") stream = Number(p.args.streamId);
      } catch {}
    }
    await registry.connect(authority).setValue(stream, 100);
    const gameId = await createYesNoGame(satori.connect(authority), gameTypeId, stream, 150, "yn");

    const Mock = await ethers.getContractFactory("MockERC20");
    const usd = await Mock.deploy("USDC", "USDC");
    const junk = await Mock.deploy("JUNK", "JUNK");
    const bountiesAddr = await bounties.getAddress();
    for (const t of [usd, junk]) {
      for (const u of [funder, alice]) {
        await t.mint(u.address, E(10000));
        await t.connect(u).approve(bountiesAddr, E(10000));
      }
    }
    return { ...fix, alice, funder, authority, stranger, gameId, usd, junk, games };
  }

  it("rejects funding before the author has chosen a token, and any token but the chosen one after", async function () {
    const { bounties, funder, authority, gameId, usd, junk } = await setup();
    await expect(bounties.connect(funder).fundBounty(gameId, await usd.getAddress(), E(100), E(10)))
      .to.be.revertedWithCustomError(bounties, "NotTheGamesBountyToken");

    await expect(bounties.connect(authority).setAdapterBountyToken(gameId, await usd.getAddress()))
      .to.emit(bounties, "AdapterBountyTokenSet").withArgs(gameId, await usd.getAddress());
    expect(await bounties.adapterBountyToken(gameId)).to.equal(await usd.getAddress());

    // A junk token cannot be queued ahead of, or beside, the chosen one.
    await expect(bounties.connect(funder).fundBounty(gameId, await junk.getAddress(), E(100), E(10)))
      .to.be.revertedWithCustomError(bounties, "NotTheGamesBountyToken");
    await expect(bounties.connect(funder).fundBounty(gameId, await usd.getAddress(), E(100), E(10))).to.not.be.reverted;
  });

  it("only the game's authority may choose, only on an adapter game that exists", async function () {
    const { bounties, stranger, authority, gameId, usd, games } = await setup();
    await expect(bounties.connect(stranger).setAdapterBountyToken(gameId, await usd.getAddress()))
      .to.be.revertedWithCustomError(bounties, "NotGameAuthority");
    await expect(bounties.connect(authority).setAdapterBountyToken(gameId, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(bounties, "BadInput");
    await expect(bounties.connect(authority).setAdapterBountyToken(9999, await usd.getAddress()))
      .to.be.revertedWithCustomError(bounties, "UnknownStream");
    // The default game is a binary game, not an adapter game.
    expect(await games.gameTypeIdOf(1)).to.equal(0);
    await expect(bounties.connect(authority).setAdapterBountyToken(1, await usd.getAddress()))
      .to.be.revertedWithCustomError(bounties, "NotAnAdapterGame");
  });

  it("the token can be changed only once the current token's pool is empty", async function () {
    const { bounties, funder, authority, gameId, usd, junk } = await setup();
    await bounties.connect(authority).setAdapterBountyToken(gameId, await usd.getAddress());
    // Nothing funded yet: free to change.
    await bounties.connect(authority).setAdapterBountyToken(gameId, await junk.getAddress());
    await bounties.connect(funder).fundBounty(gameId, await junk.getAddress(), E(100), E(10));
    await expect(bounties.connect(authority).setAdapterBountyToken(gameId, await usd.getAddress()))
      .to.be.revertedWithCustomError(bounties, "BountyTokenInUse");
  });

  it("the round's active token is the chosen one while funded, and none once it is not", async function () {
    const { satori, bounties, alice, funder, authority, gameId, usd } = await setup();
    const usdAddr = await usd.getAddress();
    await bounties.connect(authority).setAdapterBountyToken(gameId, usdAddr);
    await bounties.connect(alice).stakeBountyToken(usdAddr, E(100));

    // Chosen but unfunded: no bounty this round.
    const r0 = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);
    expect(await bounties.adapterActiveToken(gameId, r0)).to.equal(ethers.ZeroAddress);
  });

  it("reserves the round's pot at the first stake snapshot (M27)", async function () {
    const { satori, bounties, alice, funder, authority, gameId, usd } = await setup();
    const usdAddr = await usd.getAddress();
    await bounties.connect(authority).setAdapterBountyToken(gameId, usdAddr);
    await bounties.connect(funder).fundBounty(gameId, usdAddr, E(1000), E(400));
    await bounties.connect(alice).stakeBountyToken(usdAddr, E(100));

    const round = await satori.getCurrentRound();
    expect(await bounties.roundBountyPot(gameId, round, usdAddr)).to.equal(0n);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId, payload: pack1(1) }]);

    expect(await bounties.adapterActiveToken(gameId, round)).to.equal(usdAddr);
    expect(await bounties.roundBountyPot(gameId, round, usdAddr)).to.equal(E(400));
    expect(await bounties.pool(gameId, usdAddr)).to.equal(E(600));
  });
});
