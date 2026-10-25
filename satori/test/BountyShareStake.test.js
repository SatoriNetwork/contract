// Slice 3/4 of the bounty-share refactor: pure stake-share formula.
//
//   share = pot × userStake / totalStake
//
// Where userStake and totalStake are the predict-time snapshots already
// multiplied by the user's streak (so streak amplifies automatically).
//
// Tests:
//   (a) Two stakers, same SATORI, different stake. Shares are proportional
//       to stake (not to SATORI).
//   (b) Two stakers, same stake, different streaks. Shares are proportional
//       to streak (streak baked into the predict-time snapshot).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak, VOTE } = require("./fixtures");

const UP = 1;

async function deployMockToken(symbol = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

async function createStream(satori, signer, name, authority) {
  // Every-round (1440-minute) stream — one value write per 24h round, which is
  // this suite's rhythm. 1440 is the finest PUBLIC cadence SatoriHub allows, so
  // no admin exemption is needed. `authority` stays the provider — it is who
  // may call `registry.setValue`.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

describe("Slice 3/4: pure stake-share formula", function () {
  let satori, bounties, registry, owner;
  let alice, bob, funder, authority;
  let stream, usd;
  const POT = ethers.parseEther("1000");
  const RATE = ethers.parseEther("100");
  // Bounty payout fee removed: predictors now receive the FULL share (100%).
  const NET_BPS = 10000n;
  // Small tolerance for integer-truncation dust across the share math.
  const TOL = ethers.parseEther("0.01");

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    stream = await createStream(satori, owner, "S", authority.address);

    // audit C-2: streak 0 pays flat dust and takes no bounty boost — warm to streak >= 1

    await warmUpStreak(satori, registry, authority, [alice, bob], stream);
    await satori.connect(alice).vote(stream, VOTE);
    await satori.connect(bob).vote(stream, VOTE);

    usd = await deployMockToken();
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await bounties.connect(funder).fundBounty(stream, await usd.getAddress(), POT, RATE);
  });

  // A win and a deposit are different facts, and every pool write says where it
  // left the pool, so history and liveness are folds over logs with no pool /
  // ratePerRound / bountyStake reads (docs/issues/events-are-the-read-model.md).
  it("a deposit emits BountyTokenStaked with the new stake", async function () {
    const usdAddr = await usd.getAddress();
    await usd.mint(alice.address, ethers.parseEther("300"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("300"));
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("200"));
    await expect(bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100")))
      .to.emit(bounties, "BountyTokenStaked")
      .withArgs(alice.address, usdAddr, ethers.parseEther("100"), ethers.parseEther("300"));
    // And an unstake says what it left, so the latest stake event is the stake.
    await expect(bounties.connect(alice).unstakeBountyToken(usdAddr, ethers.parseEther("40"), bob.address))
      .to.emit(bounties, "BountyTokenUnstaked")
      .withArgs(alice.address, usdAddr, bob.address, ethers.parseEther("40"), ethers.parseEther("260"));
  });

  it("a win emits BountyPaid (never BountyTokenStaked), and the reservation at predict reports the pool it left", async function () {
    const usdAddr = await usd.getAddress();
    const scale = await bounties.RATE_SCALE();
    await stakeFor(bounties, alice, usd, ethers.parseEther("200"));

    await registry.connect(authority).setValue(stream, 100);
    const bountyLogs = (rcpt) => rcpt.logs
      .filter((l) => l.address === bounties.target)
      .map((l) => bounties.interface.parseLog(l));
    const predictRcpt = await (await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }])).wait();
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);

    const drip = bountyLogs(predictRcpt).find((p) => p.name === "BountyDripped");
    const logs = bountyLogs(await (await satori.settlePrediction(alice.address, stream)).wait());
    expect(logs.map((p) => p.name)).to.not.include("BountyTokenStaked");
    expect(logs.map((p) => p.name)).to.not.include("BountyDripped");

    expect(drip.args.gameId).to.equal(stream);
    expect(drip.args.amount).to.equal(RATE);
    expect(drip.args.newPool).to.equal(POT - RATE);
    expect(drip.args.newRate).to.equal(RATE * scale);
    expect(await bounties.pool(stream, usdAddr)).to.equal(drip.args.newPool);

    const paid = logs.find((p) => p.name === "BountyPaid");
    expect(paid.args.user).to.equal(alice.address);
    expect(paid.args.gameId).to.equal(stream);
    expect(paid.args.token).to.equal(usdAddr);
    expect(paid.args.round).to.equal(drip.args.round);
    expect(paid.args.share).to.equal(RATE); // sole winner takes the whole drip
    expect(paid.args.newStake).to.equal(await bounties.bountyStake(alice.address, usdAddr));
    expect(paid.args.newStake).to.equal(ethers.parseEther("200") + RATE);
  });

  it("shares are stake-proportional: Alice stakes 200, Bob stakes 100 → Alice gets 2× Bob", async function () {
    await stakeFor(bounties, alice, usd, ethers.parseEther("200"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);

    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);

    await satori.settlePrediction(alice.address, stream);
    await satori.settlePrediction(bob.address, stream);

    const usdAddr = await usd.getAddress();
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("200");
    const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - ethers.parseEther("100");

    // Pot drips RATE per round on first scoring of the round. Only one
    // round was scored (round of the predict), so drip = RATE = 100 USDC.
    // Stakes 200 / 100 → shares 2/3 / 1/3 of the full drip (no payout fee).
    const drip = RATE;
    const aliceExpected = (drip * 2n * NET_BPS) / (3n * 10000n);
    const bobExpected = (drip * 1n * NET_BPS) / (3n * 10000n);

    expect(aliceEarned).to.be.closeTo(aliceExpected, TOL);
    expect(bobEarned).to.be.closeTo(bobExpected, TOL);
    // 2:1 ratio within dust precision.
    expect(aliceEarned).to.be.closeTo(bobEarned * 2n, TOL);
  });
});
