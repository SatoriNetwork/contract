/**
 * REFERRAL — EAGER CREDIT-TIME SKIM. The 5% referral cut is taken the moment a
 * reward is credited to a user's unclaimedRewards (settlement / delegation /
 * provider paths), NOT at claim. It applies to EVERY earner: with a referral the
 * cut goes to the referrer; with none (or a self-referral) it routes to
 * MARKETING_FEE_RECIPIENT. The referral's cut lands in ITS OWN unclaimedRewards
 * bucket (it must claim it) and is never itself re-cut (no referral-on-referral).
 *
 * Zero-fee stack so the predictor's on-chain slice is exactly the round gross
 * (nothing is reserved out of it any more — the first-predictor bonus is gone),
 * and the reward that flows through _creditReward is easy to reconstruct:
 *   pool = unclaimedRewards[earner] + unclaimedRewards[dest]
 *   cut  = unclaimedRewards[dest] == pool * 500 / 10000   (5%, floored)
 */

const { expect } = require("chai");
const { deploySatoriFixtureNoFee, pack1, voteFor, onChainGrossNow } = require("./fixtures");
const { TEST_MARKETING_FEE_RECIPIENT } = require("./next/splitFixture");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const E = (n) => ethers.parseEther(String(n));
// The constructor-set immutable marketing fee recipient (from the shared fixture).
const MARKETING = TEST_MARKETING_FEE_RECIPIENT;

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 + 1);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

// Zero-platform-fee stack: on-chain slice is exactly the round gross.
async function deployStack() {
  const fix = await deploySatoriFixtureNoFee();
  return { satori: fix.satori, rewards: fix.rewards, registry: fix.registry };
}

describe("Referral eager credit — 5% skimmed at credit time", function () {
  let satori, rewards, registry;
  let owner, alice, bob, carol, platform;
  // The on-chain round pool, read from the chain (was the 1440 − 288 literal),
  // and the round's budget read off the hub's rate, both in the round `earn`
  // predicts in: the rate steps every round's worth issued.
  let GROSS, earnBudget;

  beforeEach(async function () {
    [owner, alice, bob, carol, platform] = await ethers.getSigners();
    ({ satori, rewards, registry } = await deployStack());
    await satori.transfer(alice.address, E(100));
    await satori.transfer(bob.address, E(100));
    await satori.transfer(carol.address, E(100));
    await advanceRound();
  });

  // `subject` burns for a fresh game (making it the round's only weighted,
  // predicted game) and its winning prediction settles, so the whole round
  // budget lands in `subject`'s bucket via one _creditReward call. Nothing is
  // credited before settlement: the first-predictor bonus no longer exists.
  async function earn(subject) {
    const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
    await registry.setValue(sid, 100);
    await voteFor(satori, subject, sid);
    GROSS = await onChainGrossNow(satori);
    earnBudget = (await satori.emissionRateNow()) - (await satori.devRateNow());
    await satori.connect(subject).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(UP) }]);
    expect(await rewards.unclaimedRewards(subject.address)).to.equal(0n); // nothing credited at predict time
    await advanceRound(); await registry.setValue(sid, 110);
    await advanceRound(); await registry.setValue(sid, 120);
    await satori.settlePrediction(subject.address, sid);
  }

  it("referred earner: exactly 5% of the reward is credited to the referrer, 95% to the earner", async function () {
    await rewards.connect(alice).setReferral(bob.address);
    await earn(alice);
    const net = await rewards.unclaimedRewards(alice.address);
    const cut = await rewards.unclaimedRewards(bob.address);
    const pool = net + cut; // the reward that flowed through _creditReward
    expect(cut).to.be.gt(0n);
    expect(cut).to.equal(pool * 500n / 10000n);   // exactly 5%, floored
    expect(net).to.equal(pool - cut);             // earner keeps 95%
  });

  it("no referral: the 5% routes to the marketing wallet", async function () {
    await earn(alice); // alice never set a referral
    const net = await rewards.unclaimedRewards(alice.address);
    const cut = await rewards.unclaimedRewards(MARKETING);
    const pool = net + cut;
    expect(cut).to.be.gt(0n);
    expect(cut).to.equal(pool * 500n / 10000n);
  });

  it("self-referral is rejected — you can't refer yourself (it serves no purpose now)", async function () {
    // Referring yourself neither avoids the 5% nor pays it to you; it would just
    // route to marketing, same as having no referral. So it is simply disallowed.
    await expect(rewards.connect(alice).setReferral(alice.address))
      .to.be.revertedWithCustomError(rewards, "InvalidReferral");
    // The rejected attempt did NOT lock the slot: a real referral still works.
    await rewards.connect(alice).setReferral(bob.address);
    expect(await rewards.referral(alice.address)).to.equal(bob.address);
  });

  it("no referral-on-referral (no MLM): the referrer's received cut is not itself re-skimmed", async function () {
    await rewards.connect(alice).setReferral(bob.address); // bob has NO referral of his own
    await earn(alice);
    expect(await rewards.unclaimedRewards(bob.address)).to.be.gt(0n); // bob got alice's cut
    // If bob's cut had been re-skimmed, marketing (bob's fallback) would be > 0.
    expect(await rewards.unclaimedRewards(MARKETING)).to.equal(0n);
  });

  it("claim mints the whole (already-net) bucket — no second skim at claim", async function () {
    await rewards.connect(alice).setReferral(bob.address);
    await earn(alice);
    const net = await rewards.unclaimedRewards(alice.address);
    const bobBefore = await rewards.unclaimedRewards(bob.address);
    const balBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    expect((await satori.balanceOf(alice.address)) - balBefore).to.equal(net); // full net, no skim
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(0n);
    expect(await rewards.unclaimedRewards(bob.address)).to.equal(bobBefore);    // bob untouched by alice's claim
  });

  it("the referrer claims their accrued cut like any other reward", async function () {
    await rewards.connect(alice).setReferral(bob.address);
    await earn(alice);
    const cut = await rewards.unclaimedRewards(bob.address);
    expect(cut).to.be.gt(0n);
    const balBefore = await satori.balanceOf(bob.address);
    await satori.connect(bob)["claim()"]();
    expect((await satori.balanceOf(bob.address)) - balBefore).to.equal(cut);
  });

  it("conservation: earner net + referrer cut == the gross reward (nothing minted or lost)", async function () {
    await rewards.connect(alice).setReferral(bob.address);
    await earn(alice);
    const net = await rewards.unclaimedRewards(alice.address);
    const cut = await rewards.unclaimedRewards(bob.address);

    // P1 — the anchor MUST be independent of net/cut. The old version built
    // `pool = (net − bonus) + cut` and then re-asserted that same sum twice, i.e.
    // x == x: it stayed green whether _creditReward under-credited, over-credited
    // or double-minted the cut, so the property in the title was never exercised.
    // The independent anchor is the whole residual on-chain round budget: the
    // HUB's per-round emission less the senior dev rate carved out at the
    // immutable token. Alice is the round's only voter and only predictor, so
    // that entire budget is credited to her; the referral only REDISTRIBUTES it.
    //
    // The first term was `ROUND_REWARD_BUDGET()` — the token's 1440. That is the
    // outer constitutional ENVELOPE, not the rate: the hub mints under it at its
    // own decaying schedule, so anchoring on it over-states the round.
    const budget = earnBudget;
    expect(budget).to.equal(GROSS);
    expect(budget).to.be.lt(await satori.ROUND_REWARD_BUDGET()); // strictly inside the envelope
    expect(net + cut).to.equal(budget);                 // nothing minted on top, nothing lost

    // …and the split of that budget is the documented 95/5. `pool` is derived
    // from the ANCHOR, never from net/cut. There is no longer a first-predictor
    // bonus riding alongside it: the whole budget goes through _creditReward.
    const pool = budget;
    expect(cut).to.equal(pool * 500n / 10000n);         // exactly 5%, floored
    expect(net).to.equal(pool - cut);                   // 95%
    expect(net).to.be.gt(cut);                          // 95% > 5%

    // "Nothing minted" end-to-end (P3: settle only CREDITS — claim is what mints).
    // Claiming BOTH buckets mints exactly the budget: the cut is a redistribution
    // inside one credit event, not an extra mint.
    const supplyBefore = await satori.totalSupply();
    await satori.connect(alice)["claim()"]();
    await satori.connect(bob)["claim()"]();
    expect((await satori.totalSupply()) - supplyBefore).to.equal(budget);
  });
});
