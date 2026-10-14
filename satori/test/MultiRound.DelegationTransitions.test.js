const { expect } = require("chai");
const { deploySatoriFixture, pack1, VOTE, warmUpLoyalty, RAW_TOLERANCE } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

async function advanceToNextRound() {
  const now = await time.latest();
  const nextMidnight = Math.floor(now / 86400) * 86400 + 86400;
  await time.increaseTo(nextMidnight + 1);
}

describe("MultiRound: Delegation Transitions", function () {
  it("applies delegate switches prospectively across rounds", async function () {
    const fix = await deploySatoriFixture();
    const { satori, voting, rewards, registry, games, bounties, owner, lens } = fix;
    const [, alice, bob, carol, voter] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    // Voting BURNS, and the rate arithmetic below is anchored on alice holding
    // exactly 100 SATORI, so a separate `voter` pays for the game's weight.
    await satori.transfer(voter.address, ethers.parseEther("20"));

    // Game id 1 is the protocol's DEFAULT game (created by the fixture) and
    // cannot be voted on, so the stream this test creates lands at id 2.
    // Every-round (1440-minute) stream: the rounds this test walks are
    // DELEGATION transition boundaries, not stream write windows.
    const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("ETH/USD", owner.address, 1440);
    const rcpt = await tx.wait();
    const gid = Number(satori.interface.parseLog(
      rcpt.logs.find(l => {
        try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
        catch { return false; }
      })
    ).args.streamId);
    await satori.connect(voter).vote(gid, VOTE);

    await advanceToNextRound();
    await registry.setValue(gid, 1000);

    // Round A: alice delegates to bob, bob predicts.
    //
    // Each relationship needs its OWN loyalty warm-up. Delegator weight is
    // capital x loyalty and every delegation — including the switch below —
    // opens a fresh period at L = 0, so without warming both sides alice
    // carries no weight in either round and both rates come out zero. The
    // round numbers are captured AFTER each warm-up, since the warm-up itself
    // spans several rounds.
    await satori.connect(alice).delegatePredictionPower(bob.address);
    await warmUpLoyalty(satori, registry, null, bob, [alice], voter, gid);
    await registry.setValue(gid, 1000);
    const roundA = await satori.getCurrentRound();
    expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(bob.address);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

    // Round B: switch to carol, carol predicts
    await advanceToNextRound();
    await registry.setValue(gid, 1100);
    await satori.connect(alice).delegatePredictionPower(carol.address);
    await warmUpLoyalty(satori, registry, null, carol, [alice], voter, gid, 2000);
    await registry.setValue(gid, 3000);
    const roundB = await satori.getCurrentRound();
    expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

    // Round C: undelegate
    await advanceToNextRound();
    await registry.setValue(gid, 4000);
    const roundC = await satori.getCurrentRound();
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);
    expect(await satori.lockedUntil(alice.address)).to.equal(roundC + 1n);

    // Round D: close another scoring step, then SETTLE both delegates so the
    // prospective accrual this test is named for actually happens.
    //
    // WHY THIS BLOCK IS THE WAY IT IS: the old check was
    //   `expect(claimable).to.be.gte(0n)`
    // on a uint256 — a type tautology (P2) that no reachable state can violate.
    // Worse, the test never settled anything, so `_splitReward` never ran, no
    // `_delegatorRewardRatePerRound` was ever written, and the measured value was
    // a deterministic 0. Both a regression that zeroed every delegator credit and
    // one that over-credited alice sailed through. Settle first, then anchor on
    // the delegates' immutable per-round rates and on the round budget — never on
    // alice's own bucket (P1).
    await advanceToNextRound();
    await registry.setValue(gid, 5000);   // series stays ascending, so both UP calls win
    await satori.settlePrediction(bob.address, gid);
    await satori.settlePrediction(carol.address, gid);

    // PROSPECTIVE: bob banks a delegator rate ONLY for round A and carol ONLY for
    // round B — the rounds during which alice pointed at each of them
    // (A_prediction_delegation.md:30, :54 — the rates are immutable historical
    // values the delegator pulls later on their own claim).
    const rateBobA = await rewards.delegatorRewardRatePerRound(bob.address, roundA);
    const rateCarolB = await rewards.delegatorRewardRatePerRound(carol.address, roundB);
    expect(await rewards.delegatorRewardRatePerRound(bob.address, roundB)).to.equal(0n);
    expect(await rewards.delegatorRewardRatePerRound(carol.address, roundA)).to.equal(0n);

    // Each delegate was the sole predictor of their round, so the whole round pool
    // is theirs; alice's delegated 100 SATORI is exactly half of their 200 total
    // prediction power, and the predictor fee is skimmed off that half. Anchor the
    // rate on the ROUND BUDGET (devRateNow / offchainBudget are read live), not on
    // anything derived from alice's claimable. The round pool is now the WHOLE
    // on-chain gross: the first-predictor bonus that used to be reserved off the
    // top no longer exists.
    // The emission per round comes from the HUB's schedule, not from the token's
    // 1440. That 1440 is the outer constitutional envelope; sizing a pool from it
    // over-states the round by the difference.
    const onChainGross = (await satori.emissionRateNow())
                       - (await satori.devRateNow())
                       - (await rewards.offchainBudget());
    const roundPool = onChainGross;
    const aliceBal = ethers.parseEther("100");
    const SATORI_RATE_SCALE = 10n ** 24n; // SatoriRewards.sol
    const feeBps = BigInt(await rewards.effectivePredictorFee(bob.address));
    const delegatedReward = roundPool / 2n; // alice's 100 of the delegate's 200 power
    const expectedShare = delegatedReward - (delegatedReward * feeBps) / 10000n;
    // The rate's DENOMINATOR is no longer alice's raw balance: it is the
    // loyalty-weighted W = Σ cᵢLᵢ / LOY_ONE
    // (docs/design/delegation-loyalty-weighting.md §7.2). Pinning the rate
    // itself would mean recomputing L here, i.e. re-implementing the
    // contract's recursion in the test. The PAYOUT is what this test is
    // about, and it is unchanged — with one delegator per delegate,
    // credit = c·L·share/(L·C) collapses back to the full share — so anchor
    // there instead, and keep the cross-delegate symmetry check.
    expect(expectedShare).to.be.gt(0n); // the anchor itself must be non-trivial
    expect(rateBobA).to.be.gt(0n);
    expect(rateCarolB).to.equal(rateBobA); // both rounds paid the same way

    // Alice pulls BOTH periods: round A off bob's rate, round B off carol's —
    // credit = balance * rate / SATORI_RATE_SCALE (SatoriRewards.sol).
    // Alice is the only delegator of each delegate, so she takes the whole
    // delegator share of both rounds.
    const grossExpected = expectedShare * 2n;
    const claimable = (await lens.getTotalClaimableRewards(alice.address))[0];
    // The lens reports the NET figure — the 5% referral/marketing skim is taken
    // when `_accrueDelegatorRewards` credits the pull.
    expect(claimable).to.be.closeTo(grossExpected - (grossExpected * 500n) / 10000n, RAW_TOLERANCE);

    // And the claim pays exactly that, with the skim landing in the marketing
    // bucket: net + cut reconstructs the rate-derived gross (A_rewards.md:139).
    const marketing = await rewards.marketingFeeRecipient();
    const mktBefore = await rewards.unclaimedRewards(marketing);
    const aliceBefore = await satori.balanceOf(alice.address);
    await satori.connect(alice)["claim()"]();
    const minted = (await satori.balanceOf(alice.address)) - aliceBefore;
    const mktDelta = (await rewards.unclaimedRewards(marketing)) - mktBefore;
    expect(minted).to.equal(claimable);
    expect(minted + mktDelta).to.be.closeTo(grossExpected, RAW_TOLERANCE);
  });
});
