// `SatoriVoting.vote` mints PERMANENT weight on the assumption that the caller
// burned the voter's tokens FIRST — and only the hub performs that burn
// (SatoriHub._vote: burnFrom, then vote). The shared onlyCore modifier also
// admits the engine, which never burns, so `vote` used to have a second,
// latent, unbacked weight-minting caller one engine upgrade away. It is now
// hub-only (`onlyHub`), while the engine keeps its real path,
// `recordGameVotesForRound`, through onlyCore.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  loadFixture, impersonateAccount, setBalance,
} = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, VOTE } = require("./fixtures");

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  for (const l of r.logs) {
    try {
      const p = satori.interface.parseLog(l);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("voting.vote is hub-only — a non-burning onlyCore caller is refused", function () {
  it("the engine cannot mint weight; the hub burn path still can; recordGameVotesForRound stays engine-callable", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, token, voting, engine, owner } = fix;
    const [, alice] = fix.signers;
    await satori.transfer(alice.address, ethers.parseEther("50"));

    const streamId = await streamIdFrom(
      await satori["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 720),
      satori
    );

    // The engine is a legitimate onlyCore caller (recordGameVotesForRound), so
    // impersonating it is the exact caller the old gate would have admitted.
    const engineAddr = await engine.getAddress();
    await impersonateAccount(engineAddr);
    await setBalance(engineAddr, ethers.parseEther("1"));
    const engineSigner = await ethers.getSigner(engineAddr);

    const before = await voting.weightOf(streamId);
    await expect(
      voting.connect(engineSigner).vote(streamId, alice.address, ethers.parseEther("1"))
    ).to.be.revertedWithCustomError(voting, "OnlySatoriCore");
    expect(await voting.weightOf(streamId)).to.equal(before); // no unbacked weight

    // The engine's real path is untouched.
    const round = await satori.getCurrentRound();
    await voting.connect(engineSigner).recordGameVotesForRound(streamId, round);

    // The hub path still mints weight — and every unit of it is BACKED by a
    // burn: supply drops by exactly what the game's weight gained.
    const supplyBefore = await token.totalSupply();
    await satori.connect(alice).vote(streamId, VOTE);
    expect(await voting.weightOf(streamId)).to.equal(before + VOTE);
    expect(await token.totalSupply()).to.equal(supplyBefore - VOTE);
  });
});
