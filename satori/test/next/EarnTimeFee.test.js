const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, pack1, VOTE } = require("../fixtures");
const { rewardsSigner, issuedOf, advanceRound, eventsNamed } = require("./emissionHelpers");

// THE FEE IS BOOKED WHEN A REWARD IS EARNED (owner's rule, 2026-10-20; M03).
//
// Before: the token took its share at MINT time against a cap repriced at the
// current rate, so raising the fee shrank the room already promised to
// credited-but-unclaimed rewards (the last claimants reverted, first come
// first served) and cutting it took back pay the dev had already earned.
//
// Now: SatoriRewards credits a win, the hub reports it to the token in the
// same call (`accrueRewards`), and the token books the dev's share then, at
// its own rate. A claim later mints only what was reported. So every credit
// stays mintable whatever the fee does, and no hub or rewards upgrade can
// pay anyone without the fee having been booked first.
//
// This file runs the whole stack: real predictions, real scoring, real
// claims, the real dial. The token's own rule in isolation is in
// DevFee.test.js and DevFeeDial.test.js.

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

describe("Earn-time dev fee — a fee change never touches what was earned", function () {
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

  async function setFee(bps) {
    await token.connect(owner).proposeDevFeeBps(bps);
    await token.connect(owner).acceptDevFeeBps();
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

  it("a RAISE after a backlog of unclaimed wins: every claim pays in full, and the dev keeps the old rate on them", async function () {
    const devGenesis = await token.devFeeAccrued();
    for (let i = 0; i < 16; i++) await winningCycle();     // 48 rounds, nobody claims
    const before = await bookedFromLogs();
    expect(before.count).to.be.gt(16);
    const unclaimed = (await Promise.all(players.map((p) => rewards.unclaimedRewards(p.address))))
      .reduce((a, b) => a + b, 0n);
    expect(unclaimed).to.be.gt(E(100));
    await expectIssuedMirrorsToken("before the raise");

    await setFee(2500n);
    // The change moved no counter...
    expect(await token.devFeeAccrued()).to.equal(before.fee + 0n);
    expect(await token.devFeeAccrued() - devGenesis).to.equal(before.fee - devGenesis);
    // ...every report so far was booked at 15%, to the wei...
    const logs = await token.queryFilter(token.filters.RewardsAccrued(), 1, "latest");
    for (const l of logs) expect(l.args.devFee).to.equal(feeOn(l.args.general, 1500n));
    // ...and every credit still mints, first to last, with nothing refused.
    await claimAllAndExpectExact("after the raise");
    expect(await hub.onChainMinted()).to.equal(await token.generalMinted());
    await expectIssuedMirrorsToken("after the claims");

    // The dev's pull is exactly what the reports booked, not 25% of the backlog.
    const owed = await token.mintDevFee.staticCall();
    expect(owed).to.equal(before.fee - (await token.devFeeMinted()));
    expect(owed).to.be.lt(feeOn(unclaimed, 2500n));

    // From here, new wins book at 25%.
    await winningCycle();
    const after = await bookedFromLogs();
    const fresh = (await token.queryFilter(token.filters.RewardsAccrued(), 0, "latest")).slice(before.count);
    for (const l of fresh) expect(l.args.devFee).to.equal(feeOn(l.args.general, 2500n));
    expect(after.fee).to.be.gt(before.fee);
  });

  it("a CUT after a backlog: every claim pays in full, and the dev's earned pay is not taken back", async function () {
    for (let i = 0; i < 16; i++) await winningCycle();
    const before = await bookedFromLogs();
    const pulledBefore = await token.mintDevFee.staticCall();

    await setFee(500n);
    expect(await token.devFeeAccrued()).to.equal(before.fee);
    expect(await token.mintDevFee.staticCall()).to.equal(pulledBefore);
    await claimAllAndExpectExact("after the cut");
    await token.connect(voter).mintDevFee();
    expect(await token.devFeeMinted()).to.equal(before.fee);
  });

  it("a raise then a cut, with half the players claiming in between", async function () {
    for (let i = 0; i < 16; i++) await winningCycle();
    await setFee(2500n);
    for (const p of players.slice(0, 2)) await satori.connect(p)["claim()"]();
    for (let i = 0; i < 15; i++) await winningCycle();      // 45 rounds: past the 30-round gap
    await setFee(500n);
    await claimAllAndExpectExact("after raise, claims, cut");
    expect(await hub.onChainMinted()).to.equal(await token.generalMinted());
    await expectIssuedMirrorsToken("end");
  });

  it("the lens mirrors the hub: onChainRewardCeiling - onChainMinted is exactly the unclaimed backlog, before and after a raise", async function () {
    for (let i = 0; i < 16; i++) await winningCycle();
    // Every bucket the credits landed in: the players', and the referral
    // skim's (nobody here has a referral, so it goes to marketing).
    const marketing = await rewards.marketingFeeRecipient();
    const backlog = async () =>
      (await Promise.all([...players.map((p) => p.address), marketing].map((a) => rewards.unclaimedRewards(a))))
        .reduce((a, b) => a + b, 0n);
    const room = async () => (await lens.onChainRewardCeiling()) - (await hub.onChainMinted());
    expect(await room()).to.equal(await backlog());
    await setFee(2500n);
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

    it("a round's on-chain gross is priced by the hub at the rate and fee live when the round starts", async function () {
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
      // A raise mid-round changes nothing for this round: the hub already
      // priced it, so a second touch freezes nothing new...
      await setFee(2500n);
      const tx2 = await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
      expect(eventsNamed(await tx2.wait(), rewards, "RoundBudgetFrozen").length).to.equal(0);
      // ...and prices the next one net of 25%, at the next round's own rate
      // (the first touch above may have taken a step).
      const rateNext = await hub.emissionRateNext();
      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(rateNext);
      expect(await hub.onChainGrossNow()).to.equal(rateNext - (rateNext * 2500n) / 10000n);
    });
  });
});
