const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, impersonateAccount, setBalance, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee, deploySatoriFixtureOpts, pack1, VOTE } = require("../fixtures");
const {
  ROUND, BASE, DEFAULT_RATIO, ladder, grossUp, generalReaching, generalBelow,
  rewardsSigner, issuedOf, issueTo, advanceRound, eventsNamed,
} = require("./emissionHelpers");

// What moves `emission().issued` (docs/issues/emission-issuance-indexed-schedule.md §4):
// genesis, each winning score's `userPortion + committedDelegatorShare`, and
// positive reserve banking deltas, all grossed up at the live dev-fee bps.
// Nothing that only moves or drains already-counted value may bump it.

const UP = 1;
const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const SUPERCHAIN_BRIDGE = "0x4200000000000000000000000000000000000028";
const E = (n) => ethers.parseEther(String(n));
const net = (x) => x - (x * 500n) / 10000n;

function leafOf(addr, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount])
  );
  return ethers.keccak256(inner);
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

describe("Issued counter — what counts toward the emission steps", function () {
  this.timeout(600000);
  let fix, satori, hub, token, rewards, registry, merkle, publisher;
  let owner, alice, bob, carol, sink;
  let gameA, bps;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixtureNoFee);
    ({ satori, hub, token, rewards, registry, merkle, owner } = fix);
    publisher = fix.merklePublisher;
    [, alice, bob, carol, , , sink] = fix.signers;
    bps = await token.devFeeBps();

    await satori.transfer(alice.address, E(200));
    await satori.transfer(bob.address, E(100));
    await satori.transfer(carol.address, E(50));
    gameA = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    await satori.connect(carol).vote(gameA, VOTE);
    await advanceRound();
  });

  // The rate steps every round's worth, so a round's reserve is read off the
  // rate it runs at, at the moment it applies, never carried from an earlier read.
  const reserveNext = async () => (await hub.residualNext()) * 5000n / 10000n;
  const reserveNow = async () => ((await hub.emissionRateNow()) - (await hub.devRateNow())) * 5000n / 10000n;

  /** Runs `send`, asserts the counter did not fall, returns its rise and the receipt. */
  async function issuedDelta(send) {
    const before = await issuedOf(hub);
    const tx = await send();
    const rc = await tx.wait();
    const after = await issuedOf(hub);
    expect(after, "the counter never decreases").to.be.gte(before);
    return { delta: after - before, rc };
  }

  async function predict(base) {
    await registry.setValue(gameA, base);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
  }

  /** Resolves bob's prediction; returns the counter rise and the RewardSplit (emitted only with delegators). */
  async function resolve(base, win) {
    await advanceRound();
    await registry.setValue(gameA, base + 10);
    await advanceRound();
    await registry.setValue(gameA, win ? base + 20 : base);
    const r = await issuedDelta(() => satori.connect(carol).settlePrediction(bob.address, gameA));
    const splits = eventsNamed(r.rc, rewards, "RewardSplit");
    return { ...r, split: splits.length ? splits[0].args : null };
  }

  async function wireMerkle() {
    await hub.connect(owner).setSatoriMerkle(await merkle.getAddress());
    await merkle.connect(owner).setSatoriCore(await hub.getAddress());
  }

  it("seeds at INITIAL_MINT", async function () {
    expect(await issuedOf(hub)).to.equal(BASE);
  });

  it("a winning score bumps issued by grossUp(u), the referral cut included", async function () {
    const mkt = await rewards.marketingFeeRecipient();
    const bobBefore = await rewards.unclaimedRewards(bob.address);
    const mktBefore = await rewards.unclaimedRewards(mkt);
    await predict(100);
    const { delta } = await resolve(100, true);
    // No delegators: _splitReward returns early, so u is read off the credits.
    const u = (await rewards.unclaimedRewards(bob.address)) - bobBefore
            + (await rewards.unclaimedRewards(mkt)) - mktBefore;
    expect(u, "the score must pay").to.be.gt(0n);
    expect((await rewards.unclaimedRewards(mkt)) - mktBefore, "a referral cut was taken").to.be.gt(0n);
    expect(delta).to.equal(grossUp(u, bps));
  });

  it("counts the whole delegator pot with the predictor's share; delegator claims never count", async function () {
    await satori.connect(alice).delegatePredictionPower(bob.address);
    let base = 100;
    for (let i = 0; i < 3; i++, base += 100) {
      await predict(base);
      const { delta, split } = await resolve(base, true);
      expect(split, `round ${i} must pay`).to.not.equal(null);
      expect(split.delegatorAmount, `round ${i} has a delegator pot`).to.be.gt(0n);
      expect(await rewards.delegatorRewardRatePerRound(bob.address, split.round), `round ${i} rate`).to.be.gt(0n);
      expect(delta, `round ${i}`).to.equal(grossUp(split.predictorAmount + split.delegatorAmount, bps));
      await advanceRound();
      const claim = await issuedDelta(() => satori.connect(alice)["claim(address)"](sink.address));
      expect(claim.delta, "delegator claim").to.equal(0n);
    }
  });

  it("a losing score does not bump", async function () {
    const owed = await rewards.unclaimedRewards(bob.address);
    await predict(100);
    const { delta } = await resolve(100, false);
    expect(await rewards.unclaimedRewards(bob.address)).to.equal(owed);
    expect(delta).to.equal(0n);
  });

  it("claims, the dev fee, airdrop and bridge mints do not bump", async function () {
    await predict(100);
    const win = await resolve(100, true);
    expect(win.delta).to.be.gt(0n);
    await advanceRound();

    const balBefore = await token.balanceOf(bob.address);
    const claim = await issuedDelta(() => satori.connect(bob)["claim()"]());
    expect(await token.balanceOf(bob.address)).to.be.gt(balBefore);
    expect(claim.delta, "predictor claim").to.equal(0n);

    const devBefore = await token.devFeeMinted();
    const dev = await issuedDelta(() => token.connect(sink).mintDevFee());
    expect(await token.devFeeMinted()).to.be.gt(devBefore);
    expect(dev.delta, "mintDevFee").to.equal(0n);

    const airdropAddr = await token.airdrop();
    await impersonateAccount(airdropAddr);
    await setBalance(airdropAddr, E(1));
    const airdropSigner = await ethers.getSigner(airdropAddr);
    const air = await issuedDelta(() => token.connect(airdropSigner).airdropMint(sink.address, E(5)));
    expect(air.delta, "airdropMint").to.equal(0n);

    await impersonateAccount(SUPERCHAIN_BRIDGE);
    await setBalance(SUPERCHAIN_BRIDGE, E(1));
    const bridge = await ethers.getSigner(SUPERCHAIN_BRIDGE);
    const burn = await issuedDelta(() => token.connect(bridge).crosschainBurn(alice.address, E(3)));
    expect(burn.delta, "crosschainBurn").to.equal(0n);
    const mint = await issuedDelta(() => token.connect(bridge).crosschainMint(sink.address, E(3)));
    expect(mint.delta, "crosschainMint").to.equal(0n);
  });

  it("reserve banking bumps by the positive cumulative delta; merkle claims do not bump", async function () {
    await wireMerkle();
    await rewards.connect(owner).setOffchainShareBps(5000);
    const dial = await reserveNext(); // nothing touches the next three rounds, so the rate holds
    await advanceRound();
    await advanceRound();
    await advanceRound();

    // The dial took effect the round after it was set; three rounds on, a
    // sync banks those three rounds — the current one included, as every bank
    // site does.
    const cum0 = await hub.merkleReserveCumulative();
    const bank = await issuedDelta(() => hub.connect(sink).syncEmission());
    const cum1 = await hub.merkleReserveCumulative();
    expect(cum1 - cum0).to.equal(dial * 3n);
    expect(bank.delta).to.equal(grossUp(cum1 - cum0, bps));

    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(50)));
    const claim = await issuedDelta(() => merkle.connect(alice).claimMerkle(E(50), []));
    expect(await hub.merkleMinted()).to.equal(E(50));
    expect(claim.delta, "merkle claim").to.equal(0n);

    const dial2 = await reserveNext(); // the first sync banked, then stepped
    await advanceRound();
    const again = await issuedDelta(() => hub.connect(sink).syncEmission());
    expect(again.delta).to.equal(grossUp(dial2, bps));
    const idle = await issuedDelta(() => hub.connect(sink).syncEmission());
    expect(idle.delta, "same-round resync").to.equal(0n);
  });

  it("the reserve is banked at each round's first touch, and a winning score counts only its credit", async function () {
    await rewards.connect(owner).setOffchainShareBps(5000);
    const dial = await reserveNext();
    await advanceRound();
    // The round's first touch prices it: its on-chain gross and its reserve,
    // sized at the same moment, both reported to the token right then.
    const cumBefore = await hub.merkleReserveCumulative();
    const touch = await issuedDelta(() => registry.setValue(gameA, 100));
    expect((await hub.merkleReserveCumulative()) - cumBefore).to.equal(dial);
    expect(touch.delta).to.equal(grossUp(dial, bps));
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
    const cum0 = await hub.merkleReserveCumulative();
    const owed0 = await rewards.unclaimedRewards(bob.address)
                + await rewards.unclaimedRewards(await rewards.marketingFeeRecipient());
    // `resolve`, inline, to read each round's reserve as its first touch banks it.
    let banked = 0n;
    for (const v of [110, 120]) {
      await advanceRound();
      banked += await reserveNow();
      await registry.setValue(gameA, v);
    }
    const { delta } = await issuedDelta(() => satori.connect(carol).settlePrediction(bob.address, gameA));
    // The two rounds touched banked their reserve at their own first touch, not
    // at the score...
    expect((await hub.merkleReserveCumulative()) - cum0).to.equal(banked);
    // ...so the score itself counts exactly its credit.
    const u = await rewards.unclaimedRewards(bob.address)
            + await rewards.unclaimedRewards(await rewards.marketingFeeRecipient()) - owed0;
    expect(u).to.be.gt(0n);
    expect(delta).to.equal(grossUp(u, bps));
  });

  it("a score that is its round's first touch banks that round's reserve and reports it with the credit, in one report", async function () {
    await rewards.connect(owner).setOffchainShareBps(5000);
    await advanceRound();
    await predict(100);
    await advanceRound();
    await registry.setValue(gameA, 110);
    await advanceRound();
    await registry.setValue(gameA, 120);
    // Scoring never prices a round, so after this the settle is the round's
    // first touch and `noteIssued` banks its reserve.
    await advanceRound();
    expect(await hub.onChainPricedRound(), "nothing touched the round yet").to.be.lt(await token.getCurrentRound());
    const dial = await reserveNow();

    const mkt = await rewards.marketingFeeRecipient();
    const owed0 = await rewards.unclaimedRewards(bob.address) + await rewards.unclaimedRewards(mkt);
    const cum0 = await hub.merkleReserveCumulative();
    const gen0 = await token.generalAccrued();
    const { delta } = await issuedDelta(() => satori.connect(carol).settlePrediction(bob.address, gameA));
    const u = await rewards.unclaimedRewards(bob.address) + await rewards.unclaimedRewards(mkt) - owed0;
    expect(u, "the score must pay").to.be.gt(0n);
    expect((await hub.merkleReserveCumulative()) - cum0).to.equal(dial);
    expect((await token.generalAccrued()) - gen0, "reported to the token").to.equal(u + dial);
    // One report rounds its fee once, on the sum.
    expect(delta).to.equal(grossUp(u + dial, bps));
  });

  it("a real report that crosses a threshold takes the step in the same call", async function () {
    const rw = await rewardsSigner(rewards);
    // Untouched rounds are priced together at the next touch, so after this
    // warp the allowance covers the reports below.
    await time.increase(3 * ROUND);
    const cur = await token.getCurrentRound();
    // Genesis issued IS the first threshold (one round's worth), so this first
    // touch already takes step 1; the report below must take step 2.
    await hub.connect(rw).freezeRoundGross(cur);
    const [first, second] = ladder();
    const e0 = await hub.emission();
    expect(e0.stepsTaken).to.equal(1n);
    expect(e0.nextStepAt).to.equal(first.next);
    expect(e0.ratioWad).to.equal(DEFAULT_RATIO);

    await hub.connect(rw).noteIssued(generalBelow(first.next - e0.issued, bps));
    expect(await issuedOf(hub)).to.be.lt(first.next);
    expect((await hub.emission()).stepsTaken, "just under the threshold").to.equal(1n);

    const g = generalReaching(first.next - (await issuedOf(hub)), bps);
    const rc = await (await hub.connect(rw).noteIssued(g)).wait();
    const e1 = await hub.emission();
    expect(e1.stepsTaken).to.equal(2n);
    expect(e1.issued).to.be.gte(first.next);
    expect(e1.issued, "the counter is what the token booked").to.equal(
      (await token.generalAccrued()) + (await token.devFeeAccrued()));
    expect(e1.nextStepAt).to.equal(second.next);
    const steps = eventsNamed(rc, hub, "EmissionStepped");
    expect(steps.length).to.equal(1);
    expect([...steps[0].args]).to.deep.equal([2n, second.rate, second.next, e1.issued, cur + 1n, 0n]);
    expect(await hub.emissionRateNow()).to.equal(BASE);
    expect(await hub.emissionRateNext()).to.equal(second.rate);
  });

  it("a fee-bps raise under a standing share never underflows and never lowers the counter", async function () {
    await wireMerkle();
    await rewards.connect(owner).setOffchainShareBps(9999);
    for (let i = 0; i < 31; i++) await advanceRound();   // past the fee's 30-round change gap (DEV_FEE_CHANGE_GAP_ROUNDS, counted from genesis)
    await hub.syncEmission();

    const cum = await hub.merkleReserveCumulative();
    const take = (cum * 9n) / 10n;
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, take));
    await merkle.connect(alice).claimMerkle(take, []);
    const mm = await hub.merkleMinted();
    expect(mm).to.be.gt(0n);

    await token.connect(owner).proposeDevFeeBps(2500);
    await token.connect(owner).acceptDevFeeBps();
    expect(await token.devFeeBps()).to.equal(2500n);
    await advanceRound();

    const rw = await rewardsSigner(rewards);
    const issued0 = await issuedOf(hub);
    await expect(hub.connect(sink).syncEmission()).to.not.be.reverted;
    // The share now splits the smaller residual: price the rounds, report a
    // wei, mint it.
    await expect(hub.connect(rw).freezeRoundGross(await token.getCurrentRound())).to.not.be.reverted;
    await expect(hub.connect(rw).noteIssued(1n)).to.not.be.reverted;
    await expect(hub.connect(rw).rewardMint(sink.address, 1n)).to.not.be.reverted;
    expect(await issuedOf(hub)).to.be.gte(issued0 + grossUp(1n, 2500n));

    const cumAfter = await hub.merkleReserveCumulative();
    expect(cumAfter).to.be.gte(mm);
    // Both lanes stay inside what was reported to the token, and the raise
    // moved none of it.
    expect((await hub.onChainMinted()) + cumAfter).to.be.lte(await token.generalAccrued());
    expect(await hub.merkleMinted()).to.be.lte(cumAfter);
  });

  it("a round predicted before a step and scored after it pays the old rate", async function () {
    const residualOld = (await hub.emissionRateNow()) - (await hub.devRateNow());
    await predict(100);

    const rw = await rewardsSigner(rewards);
    await issueTo(hub, token, rw, (await hub.emission()).nextStepAt);
    expect(await hub.emissionRateNext()).to.be.lt(await hub.emissionRateNow());

    const bobBefore = await rewards.unclaimedRewards(bob.address);
    await resolve(100, true);
    expect(await hub.emissionRateNow()).to.be.lt(BASE);
    expect((await rewards.unclaimedRewards(bob.address)) - bobBefore).to.equal(net(residualOld));
  });
});

// Without the default stream nothing else pins a round before its first
// prediction, so predict itself has to.
describe("Issued counter — predict pins the round's gross", function () {
  this.timeout(600000);
  const noDefault = () => deploySatoriFixtureOpts(0, { skipDefaultStream: true });
  const ROUND_BUDGET_SLOT = 10n; // SatoriRewards._roundBudget (storage-layouts/SatoriRewards.json)

  async function roundBudgetOf(rewards, round) {
    const key = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [round, ROUND_BUDGET_SLOT]));
    return BigInt(await ethers.provider.getStorage(rewards.target, key));
  }

  it("a round with no stream write before its prediction still pays the pre-step rate", async function () {
    const { satori, hub, token, rewards, registry, owner, signers } = await loadFixture(noDefault);
    const [, , bob, carol] = signers;
    await satori.transfer(bob.address, E(100));
    await satori.transfer(carol.address, E(50));
    await satori[SIMPLE3]("pad", owner.address, 1440);
    const gameA = await streamIdFrom(await satori[SIMPLE3]("A", owner.address, 1440), satori);
    expect(gameA).to.not.equal(1n);
    await satori.connect(carol).vote(gameA, VOTE);
    await registry.setValue(gameA, 100);
    await advanceRound();

    const round = await hub.getCurrentRound();
    const residualOld = (await hub.emissionRateNow()) - (await hub.devRateNow());
    expect(await roundBudgetOf(rewards, round), "nothing touched the round yet").to.equal(0n);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gameA, payload: pack1(UP) }]);
    expect(await roundBudgetOf(rewards, round)).to.equal(residualOld);

    await issueTo(hub, token, await rewardsSigner(rewards), (await hub.emission()).nextStepAt);
    expect(await hub.emissionRateNext()).to.be.lt(await hub.emissionRateNow());

    const bobBefore = await rewards.unclaimedRewards(bob.address);
    await advanceRound();
    await registry.setValue(gameA, 110);
    await advanceRound();
    await registry.setValue(gameA, 120);
    await satori.connect(carol).settlePrediction(bob.address, gameA);
    expect(await hub.emissionRateNow()).to.be.lt(BASE);
    expect((await rewards.unclaimedRewards(bob.address)) - bobBefore).to.equal(net(residualOld));
  });
});
