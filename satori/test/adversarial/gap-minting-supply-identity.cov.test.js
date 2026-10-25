/**
 * gap-minting-supply-identity.cov.test.js
 *
 * PHASE-CLOSE gap (Minting & conservation): the ABSOLUTE strict-equality
 * conservation law
 *
 *      totalSupply() == totalRewardsMinted()
 *
 * is the single cleanest statement that every token in existence was minted
 * through the reward schedule. The reward `_mint` sites (constructor genesis,
 * rewardMint, mintDevFee) all count in totalRewardsMinted; the airdrop's
 * `airdropMint` is the other, and there is exactly ONE supply-reducing path:
 * BURN VOTING (`vote` destroys the voter's
 * SATORI to buy a game permanent weight). Spam fees are NOT a burn — they are
 * `_transfer(.., address(this), fee)`, a move. The airdrop is a SEPARATE
 * emission counter (`airdropMinted`, never `totalRewardsMinted`), so the strict
 * two-term `totalSupply() == totalRewardsMinted()` holds whenever nothing has
 * been burnt and no airdrop has been claimed, and the full law is
 * `totalSupply() == totalRewardsMinted() + airdropMinted − voteBurns`
 * (the airdrop term asserted at the end via the public mirror
 * `airdropClaimedTotal`; the burn term against `voting.totalBurnedWeight()`).
 * So this identity must hold FOREVER for the immutable launch.
 *
 * Existing coverage only proves the per-round DELTA equality
 * (supplyDelta === mintedDelta in sim_mint-budget-conservation) and one-sided
 * inequalities (supply<=cap / minted<=cap). The delta-check is INDUCTIVE and
 * its base case (prevSupply == prevMinted right after fixture setup) is never
 * asserted — a constant supply-vs-minted offset would slip past every existing
 * assertion. These tests pin the absolute identity at the genesis baseline and
 * after a multi-round adversarial mint/transfer/spam-fee sim.
 *
 * This file ADDS tests only; it never edits a contract.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, VOTE } = require("../fixtures");
const { burnedTotal } = require("../helpers/burned");

const ROUND = 86400; // timeUnitSeconds (24h)
const E = (n) => ethers.parseEther(String(n));

// Drive rewardMint directly by impersonating address(satoriRewards).
async function asRewards(rewards) {
  const addr = await rewards.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("10"));
  return await ethers.getSigner(addr);
}

describe("[gap] minting — absolute supply==minted conservation identity", function () {
  this.timeout(600000);

  // ---------------------------------------------------------------------
  // BASE CASE the inductive sim relies on but never asserts: right after
  // fixture deploy, totalSupply == totalRewardsMinted == INITIAL_MINT, and
  // the entire genesis supply is accounted for (the deployer holds it minus
  // the spam fees that have moved to address(this) — pure transfers, so the sum
  // is still the whole supply). `initializeDefaultStream` no longer pulls a
  // 1-SATORI bootstrap vote: the default game's weight is DERIVED, not bought.
  // ---------------------------------------------------------------------
  it("genesis baseline: totalSupply == totalRewardsMinted == INITIAL_MINT, fully accounted", async function () {
    const { satori, hub, owner } = await deploySatoriFixture();

    const supply = await satori.totalSupply();
    const minted = await satori.totalRewardsMinted();
    const INITIAL_MINT = await satori.INITIAL_MINT();

    // The core conservation identity at the genesis baseline.
    const burned = await burnedTotal(hub);
    expect(supply + burned).to.equal(minted);
    // The whole genesis mint is the bootstrap mint (no other mint has occurred);
    // the only SATORI missing from supply is what the fixture's adapter
    // registration fees burned.
    expect(minted).to.equal(INITIAL_MINT);
    expect(burned).to.be.gt(0n);

    // The entire supply is the deployer's balance: nothing sits at the hub
    // (the fees were burned, not held), and no token leaked into existence
    // off-schedule.
    const ownerBal = await satori.balanceOf(owner.address);
    const selfBal = await satori.balanceOf(await satori.getAddress());
    expect(ownerBal + selfBal).to.equal(supply);
    expect(selfBal).to.equal(0n);
  });

  // ---------------------------------------------------------------------
  // The identity survives a deliberate rewardMint to address(0)-safe
  // recipients across rounds, AND ordinary transfers / spam-fee payments
  // (which must NOT change totalSupply at all). After each event we assert
  // the absolute identity, not just the delta.
  // ---------------------------------------------------------------------
  it("absolute identity holds after rewardMints, transfers, and spam-fee charges across rounds", async function () {
    const { satori, hub, token, rewards, owner, signers } = await deploySatoriFixture();
    const rewardsSigner = await asRewards(rewards);
    const recipient = signers[5].address;

    const assertIdentity = async (label) => {
      const s = await satori.totalSupply();
      const m = await satori.totalRewardsMinted();
      expect(s + (await burnedTotal(hub)), `supply+burned==minted @ ${label}`).to.equal(m);
    };

    await assertIdentity("genesis");

    // A plain transfer does not change supply or minted -> identity preserved.
    await satori.transfer(signers[2].address, E("5"));
    await assertIdentity("after-transfer");

    // A spam-fee charge (createSimpleDataStream pays streamBurn()) burns the
    // fee: supply falls by exactly it, and the identity holds with it counted.
    const supplyBeforeStream = await satori.totalSupply();
    await satori.createSimpleDataStream("Z", owner.address);
    expect(await satori.totalSupply(), "spam fee is burned, not minted")
      .to.equal(supplyBeforeStream - (await hub.STREAM_BURN()));
    await assertIdentity("after-spam-fee");

    // Each round: price it, report the full allowance room, mint it, then pull
    // the fee that report booked. The on-chain lane mints only what was reported.
    for (let i = 0; i < 5; i++) {
      await time.increase(ROUND);
      await hub.connect(rewardsSigner).freezeRoundGross(await satori.getCurrentRound());
      const room = (await hub.onChainAllowance())
        - ((await token.generalAccrued()) - (await hub.merkleReserveCumulative()));
      expect(room, `allowance room @ round ${i}`).to.be.gt(0n);
      await hub.connect(rewardsSigner).noteIssued(room);
      await satori.connect(rewardsSigner).rewardMint(recipient, room);
      await assertIdentity(`after-mint-round-${i}`);
      expect(await token.mintDevFee.staticCall(), `fee booked @ round ${i}`).to.be.gt(0n);
      await token.mintDevFee();
      expect(await token.devFeeMinted()).to.equal(await token.devFeeAccrued());
      await assertIdentity(`after-fee-round-${i}`);
      // and after a transfer of freshly minted tokens (still a pure move)
      await satori.connect(signers[5]).transfer(signers[3].address, E("1"));
      await assertIdentity(`after-mint-transfer-round-${i}`);
    }
  });

  // ---------------------------------------------------------------------
  // End-to-end: a small live prediction round that legitimately mints
  // rewards through the real claim path, then assert the absolute identity.
  // This proves the identity holds when minting goes through SatoriRewards
  // (not just direct impersonated rewardMint) — i.e. the real emission path
  // also never leaks supply off-schedule.
  // ---------------------------------------------------------------------
  it("absolute identity holds after a real claim mints rewards through SatoriRewards", async function () {
    const { satori, hub, rewards, registry, games, voting, owner, signers } = await deploySatoriFixture();
    const alice = signers[1];

    // Build three weighted streams (one to predict on, two more carrying weight),
    // fund + burn for each, set a value, predict, advance, settle, claim.
    // Stream/game id 1 is the protocol's DEFAULT game, so these land at 2/3/4 —
    // capture them rather than hardcoding.
    // Admin-created cadence-1 streams: this test is about the supply==minted
    // identity, not stream timing, and the ABC (cadence-1) settlement rhythm
    // spelled out below is what it is written against. `satori` is connected to
    // `owner`, who is rewards.admin() and so exempt from the public cadence>=2
    // floor.
    const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
    await satori[SIMPLE3]("S1", owner.address, 720);
    const s1 = Number(await registry.nextStreamId()) - 1;
    await satori[SIMPLE3]("D1", owner.address, 720);
    const s2 = Number(await registry.nextStreamId()) - 1;
    await satori[SIMPLE3]("D2", owner.address, 720);
    const s3 = Number(await registry.nextStreamId()) - 1;
    const game = Number(await games.binaryGameByStream(s1));

    const INITIAL_MINT = await satori.INITIAL_MINT();
    const UNIT = INITIAL_MINT / 20n;
    await satori.transfer(alice.address, UNIT * 6n);
    await satori.transfer(signers[2].address, UNIT * 2n);
    await satori.transfer(signers[3].address, UNIT * 2n);
    await satori.connect(alice).vote(game, VOTE);
    await satori.connect(signers[2]).vote(Number(await games.binaryGameByStream(s2)), VOTE);
    await satori.connect(signers[3]).vote(Number(await games.binaryGameByStream(s3)), VOTE);

    await registry.setValue(s1, 100000);
    await registry.setValue(s2, 200000);
    await registry.setValue(s3, 300000);

    await time.increase(ROUND);
    await registry.setValue(s1, 110000); // up

    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: game, payload: pack1(1) }, // UP
    ]);

    // An ABC (cadence-1) prediction scores against the FIRST TWO stream ticks
    // strictly after its round: B then C, with UP correct iff C > B. Two more
    // writes in two more rounds are therefore required for it to resolve at all.
    // (This used to stop after ONE write and still mint, because the flat
    // first-predictor bonus paid out regardless — that bonus is gone, so the
    // round has to genuinely resolve for anything to be minted.)
    await time.increase(ROUND);
    await registry.setValue(s1, 120000); // B
    await time.increase(ROUND);
    await registry.setValue(s1, 130000); // C > B => UP was correct

    await satori.connect(alice).settlePrediction(alice.address, game);

    const mintedBefore = await satori.totalRewardsMinted();
    // Claim should mint alice's earned reward through SatoriRewards -> rewardMint.
    await satori.connect(alice)["claim()"]();
    const mintedAfter = await satori.totalRewardsMinted();

    // A real reward was actually minted (otherwise the test would be vacuous).
    expect(mintedAfter, "a real claim minted reward through SatoriRewards").to.be.gt(mintedBefore);

    // The absolute conservation identity holds after the real emission path —
    // now with the supply-REDUCING paths the protocol has: burn voting and the
    // hub's burn fees. `vote` destroys the voter's SATORI outright, so the law is
    //   totalSupply == totalRewardsMinted − (SATORI burnt by voting and fees).
    // Three on-chain games were voted at VOTE each; on-chain games take no
    // handicap, so the burnt SATORI equals voting.totalBurnedWeight() exactly.
    const burntByVoting = VOTE * 3n;
    expect(await voting.totalBurnedWeight()).to.equal(burntByVoting);
    expect(await satori.totalSupply())
      .to.equal((await satori.totalRewardsMinted()) - (await burnedTotal(hub)));
  });

  // ---------------------------------------------------------------------
  // THIRD MINT SITE: the airdrop. airdropMint increments a SEPARATE
  // counter (airdropMinted), so the strict two-term identity gives way to the
  // full three-term law: totalSupply == totalRewardsMinted + airdropMinted
  // (read via the public mirror airdropClaimedTotal). rewardMint's per-round
  // cap counter is untouched throughout.
  // ---------------------------------------------------------------------
  it("absolute identity extends to + airdropMinted after airdrop claims", async function () {
    const { satori, token, airdrop, owner, signers } = await deploySatoriFixture();
    const [, alice, bob] = signers;
    const TOTAL = await airdrop.AIRDROP_TOTAL_SUPPLY();

    // Pre-airdrop: the two-term identity holds.
    expect((await satori.totalSupply()) + (await burnedTotal(token))).to.equal(await satori.totalRewardsMinted());

    await airdrop.connect(owner).loadAirdropBatch(
      [alice.address, bob.address],
      [TOTAL / 3n, TOTAL - TOTAL / 3n]
    );

    // Claims open at finalize; each claim pays the whole allocation.
    await airdrop.connect(owner).finalizeAirdropLoading();
    await airdrop.connect(alice).claimAirdrop();
    await airdrop.connect(bob).claimAirdrop();

    const minted = await satori.totalRewardsMinted();
    const airMinted = await airdrop.airdropClaimedTotal();
    expect(airMinted).to.equal(TOTAL);                      // exactly the committed total
    // The airdrop did NOT touch rewardMint's cap counter (no predictions here).
    expect(minted).to.equal(await satori.INITIAL_MINT());
    // The full three-term conservation identity.
    expect((await satori.totalSupply()) + (await burnedTotal(token))).to.equal(minted + airMinted);
  });
});
