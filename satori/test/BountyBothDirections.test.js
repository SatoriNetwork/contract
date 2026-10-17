// A daily game on an hourly stream scores each prediction against its own 24h
// window, so an UP and a DOWN placed the same round can BOTH win. The round's
// pot must still pay out at most once: each winner's share is their boost over
// the boost on BOTH sides, and a loser's share stays in the pot for
// reclaimStrandedPot to return to the pool.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, warmUpStreak, VOTE } = require("./fixtures");

const UP = 1;
const DOWN = 2;
const HOUR = 3600;
const DAY = 86400;

describe("bounty pot when both directions win one round", function () {
  let satori, bounties, registry, owner, alice, bob, funder, authority;
  let stream, usd, usdAddr, base;
  const POT = ethers.parseEther("1000");
  const RATE = ethers.parseEther("100");
  const STAKE = ethers.parseEther("100");

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;
    for (const u of [alice, bob, funder]) await satori.transfer(u.address, ethers.parseEther("100"));

    const rcpt = await (await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
      "S", authority.address, 60)).wait();
    stream = rcpt.logs.map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "DataStreamCreated").args.streamId;

    await warmUpStreak(satori, registry, authority, [alice, bob], stream);
    await satori.connect(alice).vote(stream, VOTE);
    await satori.connect(bob).vote(stream, VOTE);

    const M = await ethers.getContractFactory("MockERC20");
    usd = await M.deploy("USDC", "USDC");
    await usd.waitForDeployment();
    usdAddr = await usd.getAddress();
    const ba = await bounties.getAddress();
    await usd.mint(funder.address, POT);
    await usd.connect(funder).approve(ba, POT);
    await bounties.connect(funder).fundBounty(stream, usdAddr, POT, RATE);
    for (const u of [alice, bob]) {
      await usd.mint(u.address, STAKE);
      await usd.connect(u).approve(ba, STAKE);
      await bounties.connect(u).stakeBountyToken(usdAddr, STAKE);
    }

    base = Math.floor((await time.latest()) / DAY) * DAY + DAY;
  });

  const at = (d, h, m = 5) => time.increaseTo(base + d * DAY + h * HOUR + m * 60);
  const predict = (who, dir) =>
    satori.connect(who).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(dir) }]);
  const earned = async (who) => (await bounties.bountyStake(who.address, usdAddr)) - STAKE;

  // Alice UP at 01:00 against 100, Bob DOWN at 13:00 against 200; `bobEnd` is
  // the value Bob's window closes on (Alice's closes on 150, a win).
  async function playRound(bobEnd) {
    await at(0, 0, 30); await registry.connect(authority).setValue(stream, 100);
    await at(0, 1); await predict(alice, UP);
    const round = await satori.getCurrentRound();
    await at(0, 12, 30); await registry.connect(authority).setValue(stream, 200);
    await at(0, 13); await predict(bob, DOWN);
    await at(1, 1, 30); await registry.connect(authority).setValue(stream, 150);
    await at(1, 13, 30); await registry.connect(authority).setValue(stream, bobEnd);
    await satori.settlePrediction(alice.address, stream);
    await satori.settlePrediction(bob.address, stream);
    expect(await satori.streaks(alice.address, stream)).to.equal(2n);
    return round;
  }

  it("UP and DOWN both win: one pot, split by stake across both sides", async function () {
    const round = await playRound(50);
    expect(await satori.streaks(bob.address, stream)).to.equal(2n);

    const pot = await bounties.roundBountyPot(stream, round, usdAddr);
    expect(pot).to.equal(RATE);
    expect(await bounties.roundBountyPotClaimed(stream, round, usdAddr)).to.equal(pot);
    expect(await earned(alice)).to.equal(RATE / 2n);
    expect(await earned(bob)).to.equal(RATE / 2n);
    // Escrow stays solvent: the pool, both stakes and the unclaimed pot are all held.
    expect(await usd.balanceOf(await bounties.getAddress())).to.equal(POT + 2n * STAKE);
  });

  it("only UP wins: the winner keeps its stake share and the loser's share stays reclaimable", async function () {
    const round = await playRound(250);
    expect(await satori.streaks(bob.address, stream)).to.equal(0n);

    const pot = await bounties.roundBountyPot(stream, round, usdAddr);
    const claimed = await bounties.roundBountyPotClaimed(stream, round, usdAddr);
    expect(await earned(alice)).to.equal(RATE / 2n);
    expect(await earned(bob)).to.equal(0n);
    expect(claimed).to.equal(RATE / 2n);
    expect(pot - claimed).to.equal(RATE / 2n);
  });
});
