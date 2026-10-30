const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("../fixtures");
const { rewardsSigner, issuedOf, advanceRound, eventsNamed } = require("./emissionHelpers");

// THE FEE IS BOOKED WHEN A REWARD IS EARNED (owner's rule, 2026-10-20; M03).
//
// SatoriRewards credits a win, the hub reports it to the token in the same
// call (`accrueRewards`), and the token books the dev's share then. A claim
// later mints only what was reported, and no hub or rewards upgrade can pay
// anyone without the fee having been booked first.
//
// This file runs the whole stack: real predictions, real scoring, real
// claims. The token's own rule in isolation is in DevFee.test.js.

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const E = (n) => ethers.parseEther(String(n));
const ROUND = 86400;
const feeOn = (g, bps) => (g * bps + (10000n - bps) - 1n) / (10000n - bps);

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

describe("Earn-time dev fee — booked when a reward is earned", function () {
  this.timeout(600000);
  let fix, satori, hub, token, rewards, registry, lens;
  let owner, alice, bob, carol, dan, voter;
  let gameA, players, base;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixtureNoFee);
    ({ satori, hub, token, rewards, registry, owner } = fix);
    lens = fix.lens;
    [, alice, bob, carol, dan, voter] = fix.signers;
    players = [alice, bob, carol, dan];
    for (const p of players) await satori.transfer(p.address, E(100));
    await satori.transfer(voter.address, E(50));
    gameA = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    await satori.connect(voter).vote(gameA, VOTE);
    await advanceRound();
    base = 1000;
  });

  /** Everyone predicts UP, the value rises over two rounds, everyone is settled as a winner. */
  async function winningCycle() {
    await advanceRound();
    await registry.setValue(gameA, base);
    for (const p of players) {
      await satori.connect(p).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
    }
    await advanceRound();
    await registry.setValue(gameA, base + 10);
    await advanceRound();
    await registry.setValue(gameA, base + 20);
    for (const p of players) await satori.connect(voter).settlePrediction(p.address, gameA);
    base += 100;
  }

  /** Σ of the fee each report booked, straight from the token's log. */
  async function bookedFromLogs() {
    const logs = await token.queryFilter(token.filters.RewardsAccrued(), 0, "latest");
    let fee = 0n, general = 0n;
    for (const l of logs) { fee += l.args.devFee; general += l.args.general; }
    return { fee, general, count: logs.length };
  }

  async function expectIssuedMirrorsToken(label) {
    expect(await issuedOf(hub), `${label}: issued == the token's accrued total`)
      .to.equal((await token.generalAccrued()) + (await token.devFeeAccrued()));
  }

  async function claimAllAndExpectExact(label) {
    for (const p of players) {
      const owed = await rewards.unclaimedRewards(p.address);
      expect(owed, `${label}: ${p.address} has a credit`).to.be.gt(0n);
      const before = await token.balanceOf(p.address);
      await expect(satori.connect(p)["claim()"](), `${label}: claim must not revert`).to.not.be.reverted;
      expect((await token.balanceOf(p.address)) - before, `${label}: paid to the wei`).to.equal(owed);
      expect(await rewards.unclaimedRewards(p.address)).to.equal(0n);
    }
  }

  it("a backlog of unclaimed wins: every claim pays in full, and the dev's pull is exactly what the reports booked", async function () {
    for (let i = 0; i < 16; i++) await winningCycle();     // 48 rounds, nobody claims
    const before = await bookedFromLogs();
    expect(before.count).to.be.gt(16);
    await expectIssuedMirrorsToken("before the claims");
    const logs = await token.queryFilter(token.filters.RewardsAccrued(), 1, "latest");
    for (const l of logs) expect(l.args.devFee).to.equal(feeOn(l.args.general, 1500n));
    await claimAllAndExpectExact("backlog");
    expect(await hub.onChainMinted()).to.equal(await token.generalMinted());
    await expectIssuedMirrorsToken("after the claims");
    const owed = await token.mintDevFee.staticCall();
    expect(owed).to.equal(before.fee - (await token.devFeeMinted()));
    await token.connect(voter).mintDevFee();
    expect(await token.devFeeMinted()).to.equal(before.fee);
  });

  it("the lens mirrors the hub: onChainRewardCeiling - onChainMinted is exactly the unclaimed backlog, before and after the claims", async function () {
    for (let i = 0; i < 16; i++) await winningCycle();
    // Every bucket the credits landed in: the players', and the referral
    // skim's (nobody here has a referral, so it goes to marketing).
    const marketing = await rewards.marketingFeeRecipient();
    const backlog = async () =>
      (await Promise.all([...players.map((p) => p.address), marketing].map((a) => rewards.unclaimedRewards(a))))
        .reduce((a, b) => a + b, 0n);
    const room = async () => (await lens.onChainRewardCeiling()) - (await hub.onChainMinted());
    expect(await room()).to.equal(await backlog());
    await claimAllAndExpectExact("lens");
    expect(await room()).to.equal(await backlog());
  });

  describe("the hub fails closed", function () {
    it("a Rewards that credits more than its priced rounds is refused at the report", async function () {
      // The hub's allowance is every round's frozen gross; a credit beyond it
      // (a buggy or hostile rewards upgrade) reverts here, instead of leaving
      // a credit the token would later refuse to mint.
      const rw = await rewardsSigner(rewards);
      await advanceRound();
      await hub.connect(rw).freezeRoundGross(await token.getCurrentRound());
      const allowance = await hub.onChainAllowance();
      const reported = (await token.generalAccrued()) - (await hub.merkleReserveCumulative());
      const left = allowance - reported;
      await expect(hub.connect(rw).noteIssued(left + 1n))
        .to.be.revertedWithCustomError(hub, "BudgetExceeded");
      await expect(hub.connect(rw).noteIssued(left)).to.not.be.reverted;
      await expectIssuedMirrorsToken("at the allowance");
    });

    it("freezeRoundGross: rewards only, the current round only, once per round", async function () {
      const cur = await token.getCurrentRound();
      await expect(hub.connect(alice).freezeRoundGross(cur))
        .to.be.revertedWithCustomError(hub, "Unauthorized");
      const rw = await rewardsSigner(rewards);
      await expect(hub.connect(rw).freezeRoundGross(cur - 1n))
        .to.be.revertedWithCustomError(hub, "BadInput");
      await expect(hub.connect(rw).freezeRoundGross(cur + 1n))
        .to.be.revertedWithCustomError(hub, "BadInput");
      const a0 = await hub.onChainAllowance();
      const priced0 = await hub.onChainPricedRound();
      const gross = await hub.onChainGrossNow();
      expect(await hub.connect(rw).freezeRoundGross.staticCall(cur)).to.equal(gross);
      await hub.connect(rw).freezeRoundGross(cur);
      // Rounds nobody touched since the last freeze are priced with this one.
      expect(await hub.onChainAllowance()).to.equal(a0 + gross * (cur - priced0));
      expect(await hub.onChainPricedRound()).to.equal(cur);
      // Idempotent: a repeat adds nothing.
      expect(await hub.connect(rw).freezeRoundGross.staticCall(cur)).to.equal(0n);
      await hub.connect(rw).freezeRoundGross(cur);
      expect(await hub.onChainAllowance()).to.equal(a0 + gross * (cur - priced0));
    });

    it("a round's on-chain gross is priced by the hub at the rate live when the round starts", async function () {
      await advanceRound();
      await time.increase(ROUND * 30);
      const rate = await hub.emissionRateNow();
      const bps = await token.devFeeBps();
      expect(await hub.onChainGrossNow()).to.equal(rate - (rate * bps) / 10000n);
      // The round's first touch is the stream producing a value.
      const tx = await registry.setValue(gameA, base);
      const frozen = eventsNamed(await tx.wait(), rewards, "RoundBudgetFrozen");
      expect(frozen.length).to.equal(1);
      expect(frozen[0].args[1]).to.equal(rate - (rate * bps) / 10000n);
      // A second touch in the same round freezes nothing new.
      const tx2 = await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
      expect(eventsNamed(await tx2.wait(), rewards, "RoundBudgetFrozen").length).to.equal(0);
    });
  });
});
