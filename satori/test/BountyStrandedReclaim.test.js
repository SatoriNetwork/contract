// A5: reclaimStrandedPot. The binary bounty payout denominator
// (_totalBoostStakeByKey) is a predict-time snapshot of EVERY winning-direction
// predictor. A winner who never settles leaves their share (pot - claimed)
// locked in roundBountyPot forever. reclaimStrandedPot sweeps that remainder
// back to pool once the round's scoring window has evicted (no winner can still
// settle). This test drives two equal winners, settles only one, and verifies:
//   - before eviction: reclaim reverts RoundNotEvicted
//   - after eviction:  reclaim moves the abandoned winner's residue to pool
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak, VOTE } = require("./fixtures");

const UP = 1;
async function advanceOneDay() { await time.increase(86400); }
async function deployMockToken() {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy("USDC", "USDC");
  await t.waitForDeployment();
  return t;
}
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

describe("A5 — reclaimStrandedPot returns abandoned-winner bounty shares to pool", function () {
  this.timeout(1200000); // 768-deep ring eviction loops
  let satori, rewards, bounties, registry, owner, alice, bob, funder, authority;
  let stream, usd, usdAddr;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    for (const u of [alice, bob, funder, authority]) {
      await satori.transfer(u.address, ethers.parseEther("100"));
    }
    stream = await createStream(satori, owner, "S", authority.address);
    // audit C-2: streak 0 pays flat dust and takes no bounty boost — warm to streak >= 1
    await warmUpStreak(satori, registry, authority, [alice, bob], stream);
    await satori.connect(alice).vote(stream, VOTE);
    await satori.connect(bob).vote(stream, VOTE);

    usd = await deployMockToken();
    usdAddr = await usd.getAddress();
    for (const u of [funder, alice, bob]) {
      await usd.mint(u.address, ethers.parseEther("10000"));
      await usd.connect(u).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    }
  });

  it("strands the non-settler's share, then reclaims it once the round evicts", async function () {
    // Both winners stake EQUALLY so each is owed ~half the dripped pot.
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await bounties.connect(bob).stakeBountyToken(usdAddr, ethers.parseEther("100"));

    // Fund a bounty and have both predict UP (the winning direction).
    await bounties.connect(funder).fundBounty(
      stream, usdAddr, ethers.parseEther("1000"), ethers.parseEther("400")
    );
    await registry.connect(authority).setValue(stream, 100); // anchor
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    const predRound = await satori.getCurrentRound();

    // Produce B and C (rising -> UP wins).
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);

    // ONLY Alice settles. Bob abandons his winning prediction.
    await satori.settlePrediction(alice.address, stream);

    const pot = await bounties.roundBountyPot(stream, predRound, usdAddr);
    const claimed = await bounties.roundBountyPotClaimed(stream, predRound, usdAddr);
    expect(pot).to.be.gt(0n);                 // the drip fired
    expect(claimed).to.be.gt(0n);             // Alice claimed her share
    expect(pot).to.be.gt(claimed);            // Bob's share is unclaimed (stranded)
    const residue = pot - claimed;

    // Before eviction: the round can still be settled, so reclaim is refused.
    await expect(
      bounties.reclaimStrandedPot(stream, predRound, usdAddr)
    ).to.be.revertedWithCustomError(bounties, "RoundNotEvicted");

    // Advance the ring past its 768-slot depth so predRound's entries evict
    // (anchorEvicted): every hour-keyed entry at or before the round's last
    // hour must be rolled out, which takes 768+ subsequent daily writes.
    for (let i = 0; i < 770; i++) {
      await advanceOneDay();
      await registry.connect(authority).setValue(stream, 130 + i);
    }

    const poolBefore = await bounties.pool(stream, usdAddr);
    // Post-state on the event: a drained pool's rate is revived to the residue
    // itself, a live one keeps its rate.
    const rateBefore = await bounties.ratePerRound(stream, usdAddr);
    const rateAfter = rateBefore === 0n ? residue * (await bounties.RATE_SCALE()) : rateBefore;
    await expect(bounties.reclaimStrandedPot(stream, predRound, usdAddr))
      .to.emit(bounties, "StrandedPotReclaimed")
      .withArgs(stream, predRound, usdAddr, residue, poolBefore + residue, rateAfter);
    expect(await bounties.ratePerRound(stream, usdAddr)).to.equal(rateAfter);

    // Residue moved pot -> pool; nothing minted (conservation).
    expect(await bounties.pool(stream, usdAddr)).to.equal(poolBefore + residue);
    expect(await bounties.roundBountyPotClaimed(stream, predRound, usdAddr)).to.equal(pot);

    // Second reclaim is a no-op revert (residue now zero).
    await expect(
      bounties.reclaimStrandedPot(stream, predRound, usdAddr)
    ).to.be.revertedWithCustomError(bounties, "NothingToReclaim");
  });

  // REGRESSION (pre-launch review): a NATURAL drain resets ratePerRound to 0,
  // and reclaim used to return the residue into that rate-0 pool — where the
  // drip no-ops, applyBoost skips the pair, and cleanupDrainedBountyToken
  // refuses the non-zero pool. The "returns it so it can drip to future
  // winners" promise was false in exactly the common terminal state: the funds
  // sat pinned until an unrelated re-fund happened to revive the pair. Reclaim
  // now revives the rate (residue per round — the whole remainder drips to the
  // next winning round) and stamps a fresh funding epoch (H2).
  it("revives a fully-drained pool's rate so the reclaimed residue really pays a future winner", async function () {
    await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    await bounties.connect(bob).stakeBountyToken(usdAddr, ethers.parseEther("100"));

    // rate == pool: ONE drip drains the whole pool, so after the winners' round
    // the drain path resets ratePerRound to 0 — the state that used to re-strand.
    await bounties.connect(funder).fundBounty(
      stream, usdAddr, ethers.parseEther("1000"), ethers.parseEther("1000")
    );
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    const predRound = await satori.getCurrentRound();

    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream); // drips ALL 1000; Alice takes her half

    expect(await bounties.pool(stream, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(stream, usdAddr)).to.equal(0n); // drained → rate reset

    const pot = await bounties.roundBountyPot(stream, predRound, usdAddr);
    const claimed = await bounties.roundBountyPotClaimed(stream, predRound, usdAddr);
    const residue = pot - claimed; // Bob's abandoned half
    expect(residue).to.be.gt(0n);

    // Evict predRound (768-deep hour-keyed ring — 768+ subsequent writes),
    // then reclaim: the residue must come back WITH a live rate.
    for (let i = 0; i < 770; i++) {
      await advanceOneDay();
      await registry.connect(authority).setValue(stream, 130 + i);
    }
    await bounties.reclaimStrandedPot(stream, predRound, usdAddr);
    expect(await bounties.pool(stream, usdAddr)).to.equal(residue);
    expect(await bounties.ratePerRound(stream, usdAddr)).to.be.gt(0n); // revived, not re-stranded

    // End-to-end recycle: Alice wins another round; the reclaimed residue drips
    // and — as the round's sole boosted winner — credits to her in full.
    const stakeBefore = await bounties.bountyStake(alice.address, usdAddr);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 200);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 210);
    await satori.settlePrediction(alice.address, stream);
    expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(stakeBefore + residue);

    // Fully re-drained: rate reset again, and cleanup is unblocked.
    expect(await bounties.pool(stream, usdAddr)).to.equal(0n);
    expect(await bounties.ratePerRound(stream, usdAddr)).to.equal(0n);
    await expect(bounties.cleanupDrainedBountyToken(stream, usdAddr))
      .to.emit(bounties, "BountyTokenCleaned");
  });
});
