const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, RAW_TOLERANCE, pack1, VOTE } = require("./fixtures");

const UP = 1;

async function advanceOneDay() { await time.increase(86400); }

async function deployMockToken() {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy("USDC", "USDC");
  await t.waitForDeployment();
  return t;
}

async function createStream(satori, signer, name, authority) {
  const fee = await satori.streamBurn();
  if ((await satori.balanceOf(signer.address)) < fee) {
    await satori.transfer(signer.address, fee);
  }
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

// v5 invariants for bounty + delegation:
//   - Bounty share routes to predictor + fee1 + fee2 ONLY. No delegator slice.
//   - Delegators still earn SATORI proportional to delegated power (unchanged
//     by v5 — the 80/10/5/5 SATORI split is preserved).
//   - The `claimBountyAsDelegator` function is deleted; delegators cannot
//     claim any bounty under any path.
describe("Bounty — delegation (v5: bounty surface is predictor-only)", function () {
  let satori, voting, rewards, bounties, registry, owner, predictor, delegator, funder, authority;
  let stream, usd;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, voting, rewards, bounties, registry, owner } = fix);
    [, predictor, delegator, funder, authority] = fix.signers;

    // Give delegator the actual capital. Predictor has zero own-balance so
    // delegated power = 100% of total prediction power → predictor takes
    // 100% of the bounty share minus fees (no delegator slice in v5).
    await satori.transfer(delegator.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    stream = await createStream(satori, owner, "stream", authority.address);
    usd = await deployMockToken();
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));

    // Delegator delegates prediction power to predictor.
    await satori.connect(delegator).delegatePredictionPower(predictor.address);

    // Option B: predictor must subscribe to receive eager bounty credit.
  });

  // WHY THIS TEST WAS REWRITTEN. It used to be titled "predictor with 0 own
  // power gets 0 bounty (delegated SATORI does not extend bounty reach)" and
  // asserted `bountyStake[predictor] == 0` and `bountyStake[delegator] == 0`
  // after a scenario in which NOBODY had ever called `stakeBountyToken`. With
  // an empty `userStakedTokens`, `applyBoost` (SatoriBounties L774-777) never
  // enters its loop, `boosted` stays false, `creditBountyForWin` is never
  // cross-called and `roundBountyPot` is never even dripped — so both zeros
  // were forced by the missing stake and could not fail under ANY change to
  // the bounty or delegation logic. Its in-line justification ("the predictor's
  // bounty userW is 0") also described a SATORI-weighted bounty formula that
  // A_bounties.md:128 says does not exist ("No SATORI weight in the bounty
  // share ... pure stake-proportional"). The title is renamed because it
  // asserted the inverse of the documented rule.
  it("bounty is pure stake-proportional: the 0-own-SATORI predictor who staked takes the WHOLE pot; the delegator who holds all the SATORI but staked nothing gets 0", async function () {
    // Funding a NON-SATORI bounty charges an upfront bountyBurn in SATORI on the
    // first fund of a given (game, token) pair. Give the funder enough SATORI.
    const POOL = ethers.parseEther("1000");
    const DRIP = ethers.parseEther("100");
    const STAKE = ethers.parseEther("50");
    const usdAddr = await usd.getAddress();

    await satori.transfer(funder.address, await satori.bountyBurn());
    await bounties.connect(funder).fundBounty(stream, usdAddr, POOL, DRIP);

    // THE OPT-IN (A_bounties.md:30 "Stake is the opt-in ... Zero stake = zero
    // earnings"). Only the predictor stakes. The predictor owns ZERO SATORI —
    // 100% of their prediction power is delegated in from `delegator`, who owns
    // all of it and stakes nothing.
    await usd.mint(predictor.address, STAKE);
    await usd.connect(predictor).approve(await bounties.getAddress(), STAKE);
    await bounties.connect(predictor).stakeBountyToken(usdAddr, STAKE);
    expect(await satori.balanceOf(predictor.address)).to.equal(0n, "predictor must hold no own SATORI");
    expect(await satori.balanceOf(delegator.address)).to.equal(ethers.parseEther("100"));

    // Round 1 — win once to get a non-zero streak. At streak 0 the engine
    // passes multiplier 0 and `applyBoost` early-returns, so no boost snapshot
    // is taken and no bounty can be earned yet.
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(predictor).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(predictor.address, stream);
    expect(await satori.streaks(predictor.address, stream)).to.equal(1n, "streak needed for the boost snapshot");
    expect(await bounties.bountyStake(predictor.address, usdAddr)).to.equal(
      STAKE, "no bounty yet — the streak-0 prediction took no boost snapshot"
    );

    // Round 2 — predict WITH the streak: applyBoost snapshots the stake.
    const boostRound = await satori.getCurrentRound();
    await satori.connect(predictor).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 130);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 140);
    await satori.settlePrediction(predictor.address, stream);

    // A REAL payout happened: settle lazily dripped one round's rate into the
    // pot. Without this the zeros below would be vacuous, as they were before.
    const pot = await bounties.roundBountyPot(stream, boostRound, usdAddr);
    expect(pot).to.equal(DRIP, "one round's rate must have dripped into the pot");

    // The predictor is the only staker, so `share = pot × userStake /
    // totalStake` pays them the ENTIRE pot — despite holding zero own SATORI.
    // A regression that reintroduced a SATORI-power term into the bounty share,
    // or that routed the bounty through the delegation split, would pay them
    // less than the full pot.
    const predictorEarned = (await bounties.bountyStake(predictor.address, usdAddr)) - STAKE;
    expect(predictorEarned).to.equal(pot, "staker takes the full stake-proportional pot");

    // The delegator holds ALL the SATORI and staked NOTHING: zero bounty.
    expect(await bounties.bountyStake(delegator.address, usdAddr)).to.equal(0n, "no delegator slice of a bounty");

    // Residue: the pot was fully claimed by its only winner, and the rest of
    // the funded pool is still sitting in `pool` awaiting future drips.
    expect(await bounties.roundBountyPotClaimed(stream, boostRound, usdAddr)).to.equal(pot);
    expect(await bounties.pool(stream, usdAddr)).to.equal(POOL - DRIP);

    // Defense-in-depth: the bounty-delegator entry point is deleted. The
    // function selector no longer exists on the contract; any prior client
    // calling it would now fail at the ABI level.
    expect(rewards.interface.fragments.some(f =>
      f.type === "function" && f.name === "claimBountyAsDelegator"
    )).to.equal(false);
  });

  it("delegator still earns SATORI share from delegate's win (SATORI surface untouched)", async function () {
    // No bounty needed for this — verify pure SATORI delegation path.
    // SATORI rewards require non-zero gameVotesAtRound; vote for the stream
    // before predicting.
    await satori.connect(authority).vote(stream, VOTE);

    // SEVERAL winning rounds, not one. Delegator payout is weighted by loyalty
    // (docs/design/delegation-loyalty-weighting.md): a fresh delegation starts
    // at L = 0 and the fold point is lagged by LOY_LAG rounds, so the first
    // PAYING round is startRound + LOY_LAG + 1. Each cycle here is 3 rounds, so
    // three cycles puts the last one comfortably past the lag.
    for (const base of [100, 200, 300]) {
      await advanceOneDay();
      await registry.connect(authority).setValue(stream, base);
      await satori.connect(predictor).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
      await advanceOneDay();
      await registry.connect(authority).setValue(stream, base + 10);
      await advanceOneDay();
      await registry.connect(authority).setValue(stream, base + 20);
      await satori.settlePrediction(predictor.address, stream);
    }

    // After settlement, delegator should have accrued SATORI from the
    // delegate's win via the 80/10/5/5 split. Delegator must undelegate to
    // claim. (claim is only blocked while currently delegated.)
    await satori.connect(delegator).delegatePredictionPower(ethers.ZeroAddress);
    // Cooldown: claim is locked through the undelegation round; advance one
    // round so the lockout clears.
    await advanceOneDay();
    const before = await satori.balanceOf(delegator.address);
    await satori.connect(delegator)['claim()']();
    const after = await satori.balanceOf(delegator.address);
    expect(after - before).to.be.gt(0n);
  });
});
