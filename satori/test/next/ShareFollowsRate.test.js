const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee } = require("../fixtures");
const { issueTo } = require("./emissionHelpers");

// The off-chain share is a fraction of each round's residual (emission net of
// the dev fee), not an amount, so the split survives an emission step or a fee
// change with nobody re-setting it, and the two lanes always sum to the residual.
const SHARE = 5000n;
const ROUND = 86400;

async function nextRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / ROUND) * ROUND + ROUND + 1);
}

describe("Off-chain share follows the residual", function () {
  let satori, rewards, token, owner;

  const residualNow = async () => (await satori.emissionRateNow()) - (await satori.devRateNow());
  const banked = (rc) => rc.logs
    .map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
    .filter((e) => e && e.name === "MerkleReserveBanked")
    .map((e) => e.args);
  // Bank the current round and return what each lane got for it.
  async function lanesThisRound() {
    const rc = await (await satori.syncEmission()).wait();
    const [ev] = banked(rc);
    return { reserve: ev ? ev.perRound : 0n, gross: await satori.onChainGrossNow(), residual: await residualNow(), ev };
  }

  beforeEach(async function () {
    const fix = await deploySatoriFixtureNoFee();
    ({ satori, rewards, token, owner } = fix);
    await nextRound();
    await rewards.connect(owner).setOffchainShareBps(SHARE);
    await nextRound();
  });

  it("splits every round exactly, and keeps splitting the NEW residual after an emission step", async function () {
    const before = await lanesThisRound();
    expect(before.reserve).to.equal(before.residual * SHARE / 10000n);
    expect(before.reserve + before.gross).to.equal(before.residual);

    await issueTo(satori, token, null, (await satori.emission()).nextStepAt); // cross the next step; it applies next round
    await nextRound();
    const after = await lanesThisRound();
    expect(after.residual).to.be.lessThan(before.residual);
    expect(after.reserve).to.equal(after.residual * SHARE / 10000n);
    expect(after.reserve + after.gross).to.equal(after.residual);
    expect(await rewards.offchainShareBps()).to.equal(SHARE); // nobody re-set it
  });

  it("a dev-fee change mid-round cannot over-subscribe the round's emission", async function () {
    const fa = await token.feeAuthority();
    await impersonateAccount(fa);
    await setBalance(fa, ethers.parseEther("10"));
    const fee = await ethers.getSigner(fa);
    for (let i = 0; i < 31; i++) await nextRound(); // past DEV_FEE_CHANGE_GAP_ROUNDS
    const rate = await satori.emissionRateNow();
    const oldBps = await token.devFeeBps();
    const newBps = oldBps === 0n ? 1000n : oldBps + 500n;
    // Worst order: the reserve banks round R at the old fee, then the fee moves,
    // then the on-chain lane prices R at the new one.
    const { reserve } = await lanesThisRound();
    await token.connect(fee).proposeDevFeeBps(newBps);
    await token.connect(fee).acceptDevFeeBps();
    const gross = await satori.onChainGrossNow();
    // Each lane's fee is booked at the rate it is reported under, so each takes
    // its share of the emission and the round costs at most the rate.
    const grossUp = (g, bps) => (g * 10000n + (10000n - bps) - 1n) / (10000n - bps);
    expect(grossUp(reserve, oldBps) + grossUp(gross, newBps)).to.be.at.most(rate + 2n);
  });

  it("refuses 100%, and at 99.99% leaves the on-chain lane at least 1 wei", async function () {
    await expect(rewards.connect(owner).setOffchainShareBps(10000)).to.be.revertedWithCustomError(rewards, "BadInput");
    await rewards.connect(owner).setOffchainShareBps(9999);
    await nextRound();
    const l = await lanesThisRound();
    expect(l.gross).to.be.at.least(1n);
    expect(l.reserve + l.gross).to.equal(l.residual);
  });

  it("0% leaves the whole residual on chain and banks nothing", async function () {
    await rewards.connect(owner).setOffchainShareBps(0);
    await nextRound();
    const l = await lanesThisRound();
    expect(l.ev).to.equal(undefined);
    expect(l.gross).to.equal(l.residual);
  });

  it("MerkleReserveBanked says exactly what each round banked, across untouched rounds", async function () {
    await lanesThisRound();
    const cum0 = await satori.merkleReserveCumulative();
    await nextRound(); await nextRound(); await nextRound();
    const { ev, residual } = await lanesThisRound();
    expect(ev.throughRoundExclusive - ev.fromRound).to.equal(3n);
    expect(ev.perRound).to.equal(residual * SHARE / 10000n);
    expect(ev.cumulative - cum0).to.equal(ev.perRound * 3n);
    expect(await satori.merkleReserveCumulative()).to.equal(ev.cumulative);
  });
});
