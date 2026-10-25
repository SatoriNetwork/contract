// v5+ — core bounty surface against the merged-pool design.
//
// Funding: fundBounty(streamId, token, amount, proposedRate). Single pool +
// rate per (stream, token); rate is a contribution-weighted average. No
// recover path. Cleanup is unnecessary (pool drains to 0, the entry just
// contributes 0 to future drips).
//
// Drip: at score time, `_dripTokenForRound` (lazy per-token, called from
// `_accrueBountyForWinSubscribed`) drips `min(ratePerRound, pool)` into
// `roundBountyPot`. Drip is per-(stream, round, token) idempotent.
//
// Payout: `_accrueBountyForWinToken` reads the pot and credits
// `unclaimedBounty[user][token]` with the v5 split (predictor + fee1 + fee2).
// `withdrawBounty(tokens[], recipient)` zeroes and transfers per token.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, warmUpStreak } = require("./fixtures");

const UP = 1;

async function advanceOneDay() { await time.increase(86400); }

async function deployMockToken(name = "MockUSD", sym = "mUSD") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(name, sym);
  await t.waitForDeployment();
  return t;
}

async function createSimpleStream(satori, signer, name, authority) {
  const fee = await satori.streamBurn();
  const sigBal = await satori.balanceOf(signer.address);
  if (sigBal < fee) {
    await satori.transfer(signer.address, fee - sigBal);
  }
  // Every-round (1440-minute) stream — one value write per 24h round, which is
  // this suite's rhythm. 1440 is the finest PUBLIC cadence SatoriHub allows, so
  // no admin exemption is needed. `authority` stays the provider — it is who
  // may call `registry.setValue`.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const parsed = satori.interface.parseLog(log);
      if (parsed && parsed.name === "DataStreamCreated") return parsed.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function setStreamValue(satori, registry, signer, streamId, val) {
  await registry.connect(signer).setValue(streamId, val);
}

describe("Bounty — core surface (merged-pool design)", function () {
  let satori, token, voting, rewards, bounties, registry, owner, alice, bob, funder, authority;
  let stream, usd, eur;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, token, voting, rewards, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;
    // The fixture already calls initializeDefaultStream() (matching deploy.js),
    // so the default stream/game occupies id 1 and `stream` below is id 2.

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("50"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    stream = await createSimpleStream(satori, owner, "USD/JPY", authority.address);

    usd = await deployMockToken("USDC", "USDC");
    eur = await deployMockToken("EURC", "EURC");

    await usd.mint(funder.address, ethers.parseEther("10000"));
    await eur.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await eur.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));

    // Stake-required bounty eligibility: stake-mint a small amount of each
    // bounty token for alice and bob so they qualify for any bounty share
    // on streams these tokens fund. Stake amount is small but non-zero —
    // tests that care about exact share amounts override with their own
    // larger stakes via stakeFor().
    for (const u of [alice, bob]) {
      for (const t of [usd, eur]) {
        await t.mint(u.address, ethers.parseEther("1"));
        await t.connect(u).approve(await bounties.getAddress(), ethers.parseEther("1"));
        await bounties.connect(u).stakeBountyToken(await t.getAddress(), ethers.parseEther("1"));
      }
    }

    // A bounty boost requires a NON-zero multiplier, and audit C-2 made streak 0
    // run the normal curve (W(0) = 0) — so a streak-0 prediction takes no bounty
    // snapshot by design, keeping depositors' tokens for real streaks only. Warm
    // both predictors to streak >= 1 here. Safe at this point: no bounty is funded
    // yet, so applyBoost short-circuits on the empty token list and the warm-up
    // cannot drip a pot or move any assertion the tests make.
    await warmUpStreak(satori, registry, authority, [alice, bob], stream);
  });

  describe("fundBounty — basic invariants", function () {
    it("first fund anchors pool == received and rate == proposedRate × RATE_SCALE (scaled storage)", async function () {
      // Round-2: stored rate is scaled by RATE_SCALE; BountyFunded.newRate
      // and the on-chain getter both reflect the scaled value.
      const rate = ethers.parseEther("10");
      const amount = ethers.parseEther("1000");
      const scale = await bounties.RATE_SCALE();
      const scaledRate = rate * scale;
      await expect(
        bounties.connect(funder).fundBounty(stream, await usd.getAddress(), amount, rate)
      ).to.emit(bounties, "BountyFunded")
       .withArgs(funder.address, stream, await usd.getAddress(), amount, rate, scaledRate, amount);

      expect(await bounties.pool(stream, await usd.getAddress())).to.equal(amount);
      expect(await bounties.ratePerRound(stream, await usd.getAddress())).to.equal(scaledRate);
      expect(await bounties.gameBountyTokens(stream, 0)).to.equal(await usd.getAddress());
      expect(await bounties.gameBountyTokenCount(stream)).to.equal(1);
    });

    it("rejects zero amount and zero token", async function () {
      await expect(
        bounties.connect(funder).fundBounty(stream, await usd.getAddress(), 0, 1)
      ).to.be.revertedWithCustomError(rewards, "BadInput");
      await expect(
        bounties.connect(funder).fundBounty(stream, ethers.ZeroAddress, ethers.parseEther("1"), 1)
      ).to.be.revertedWithCustomError(rewards, "BadInput");
    });

    it("supports SATORI itself as the bounty token", async function () {
      const rewardsAddr = await bounties.getAddress();
      await token.connect(funder).approve(rewardsAddr, ethers.parseEther("20"));
      await bounties.connect(funder).fundBounty(
        stream, await token.getAddress(), ethers.parseEther("20"), ethers.parseEther("1")
      );
      // SATORI moved into the rewards contract.
      expect(await token.balanceOf(rewardsAddr)).to.be.gte(ethers.parseEther("20"));
      expect(await bounties.pool(stream, await token.getAddress())).to.equal(ethers.parseEther("20"));
    });

    it("refuses the default game: it is a Sentiment game, and a Sentiment game takes no bounties", async function () {
      const defaultStreamId = await satori.DEFAULT_STREAM_ID();
      await expect(
        bounties.connect(funder).fundBounty(
          defaultStreamId, await usd.getAddress(), ethers.parseEther("100"), ethers.parseEther("5")
        )
      ).to.be.revertedWithCustomError(bounties, "NamedGame");
      expect(await bounties.gameBountyTokenCount(defaultStreamId)).to.equal(0);
    });
  });

  describe("drip capture at score time", function () {
    it("first scoring drips min(ratePerRound, pool) into the round's pot; pool decrements", async function () {
      await bounties.connect(funder).fundBounty(
        stream, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("10")
      );

      await setStreamValue(satori, registry, authority, stream, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
      await advanceOneDay();
      await setStreamValue(satori, registry, authority, stream, 110);
      await advanceOneDay();
      await setStreamValue(satori, registry, authority, stream, 120);
      await satori.settlePrediction(alice.address, stream);

      const pred = await satori.getLatestPrediction(alice.address, stream);
      const r = Number(pred.roundMade);
      const pot = await bounties.roundBountyPot(stream, r, await usd.getAddress());
      expect(pot).to.equal(ethers.parseEther("10"));
      expect(await bounties.pool(stream, await usd.getAddress())).to.equal(ethers.parseEther("990"));
    });
  });

  describe("withdrawBounty (happy path + CEI)", function () {
    it("auto-compounds predictor earnings into bountyStake; unstake transfers tokens out", async function () {
      await bounties.connect(funder).fundBounty(
        stream, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("10")
      );

      await setStreamValue(satori, registry, authority, stream, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
      await advanceOneDay();
      await setStreamValue(satori, registry, authority, stream, 110);
      await advanceOneDay();
      await setStreamValue(satori, registry, authority, stream, 120);
      await satori.settlePrediction(alice.address, stream);

      const usdAddr = await usd.getAddress();
      // Earnings flow into bountyStake.
      const staked = await bounties.bountyStake(alice.address, usdAddr);
      expect(staked).to.be.gt(0);

      // Predictor pulls tokens out via unstake. Settle cleared the pending
      // counter so unstake is unlocked.
      const aliceBefore = await usd.balanceOf(alice.address);
      await bounties.connect(alice).unstakeBountyToken(usdAddr, staked, alice.address);
      const aliceAfter = await usd.balanceOf(alice.address);
      expect(aliceAfter - aliceBefore).to.equal(staked);
      expect(await bounties.bountyStake(alice.address, usdAddr)).to.equal(0);
    });

    it("late-claimer scenario: both winners get fair share via predict-time totals", async function () {
      await bounties.connect(funder).fundBounty(
        stream, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("300")
      );

      await setStreamValue(satori, registry, authority, stream, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
      await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
      await advanceOneDay();
      await setStreamValue(satori, registry, authority, stream, 110);
      await advanceOneDay();
      await setStreamValue(satori, registry, authority, stream, 120);

      // Score Alice first; Bob remains pending.
      await satori.settlePrediction(alice.address, stream);

      const usdAddr = await usd.getAddress();
      // Alice's earnings: auto-compounded into bountyStake. The bounty-payout
      // fee is gone, so a winner now receives the FULL stake-share: half of the
      // 300 pot = 150. Subtract her 1-ether seed stake.
      const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("1");
      expect(aliceEarned).to.be.closeTo(ethers.parseEther("150"), ethers.parseEther("0.01"));

      // Now score Bob — same proportional share lands in his stake.
      await satori.settlePrediction(bob.address, stream);
      const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - ethers.parseEther("1");
      expect(bobEarned).to.be.closeTo(ethers.parseEther("150"), ethers.parseEther("0.01"));

      // Conservation: with no payout fee, predictor amounts sum to the whole
      // pot. Predictors sum to 300.
      const total = aliceEarned + bobEarned;
      expect(total).to.be.closeTo(ethers.parseEther("300"), ethers.parseEther("1"));
    });
  });

  describe("SATORI-as-bounty doesn't break sync hooks", function () {
    it("SATORI bounty withdrawal runs the _update sync hooks cleanly", async function () {
      const rewardsAddr = await bounties.getAddress();
      const satoriAddr = await token.getAddress();
      await token.connect(funder).approve(rewardsAddr, ethers.parseEther("30"));
      await bounties.connect(funder).fundBounty(
        stream, satoriAddr, ethers.parseEther("30"), ethers.parseEther("10")
      );
      // Stake-required eligibility: alice has to stake SATORI to earn
      // from the SATORI-funded pot.
      await token.connect(alice).approve(rewardsAddr, ethers.parseEther("1"));
      await bounties.connect(alice).stakeBountyToken(satoriAddr, ethers.parseEther("1"));

      await setStreamValue(satori, registry, authority, stream, 100);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
      await advanceOneDay();
      await setStreamValue(satori, registry, authority, stream, 110);
      await advanceOneDay();
      await setStreamValue(satori, registry, authority, stream, 120);
      await satori.settlePrediction(alice.address, stream);

      const staked = await bounties.bountyStake(alice.address, satoriAddr);
      expect(staked).to.be.gt(ethers.parseEther("1"));
      // Pull tokens out via unstake. SATORI bounty exercises the same
      // _update sync hooks as ERC20 transfer.
      const aliceBefore = await token.balanceOf(alice.address);
      await bounties.connect(alice).unstakeBountyToken(satoriAddr, staked, alice.address);
      const aliceAfter = await token.balanceOf(alice.address);
      expect(aliceAfter - aliceBefore).to.equal(staked);
    });
  });
});
