// END-TO-END BOUNTY SIMULATION (correctness direction).
//
// Complements the solvency/conservation sims (sim_bounty-solvency,
// sim_megasim) — which prove the SAFE direction (no over-distribution) — by
// asserting EXACT correctness with a fresh demo ERC-20 (the "your own meme
// token" case):
//
//   A. The NEW upfront fee, exactly:
//        - posting a bounty in a NON-SATORI token charges the funder exactly
//          bountyBurn() SATORI,
//        - that SATORI is locked into the core (the core's balance rises by
//          exactly the fee — it no longer buys any vote weight: the default
//          game's weight is DERIVED from burnt weight, and the token transfer
//          hook no longer touches voting at all),
//        - re-funding the SAME (game, token) is FREE (no second burn),
//        - posting a bounty in SATORI itself is FREE.
//
//   B. Exact stake-proportional payout in one round: winners split the drip in
//      proportion to stake; the wrong-direction staker earns ZERO; the platform
//      fee recipient earns ZERO bounty tokens (no payout fee).
//
//   C. Conservation + realize-to-wallet: every token in == held + owed; winners
//      unstake and receive exactly stake + winnings back.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 , warmUpStreak, voteFor } = require("./fixtures");

const UP = 1, DOWN = 2;
const E = (n) => ethers.parseEther(String(n));

async function deployDemoToken(symbol = "MEME") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}
async function advanceRound() { await time.increase(86400); }
async function createStream(satori, signer, name, authority) {
  // Every-round (1440-minute) stream — one value write per 24h round, which is
  // this suite's rhythm. 1440 is the finest PUBLIC cadence SatoriHub allows, so
  // no admin exemption is needed. `authority` stays the provider — it is who
  // may call `registry.setValue`.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try { const p = satori.interface.parseLog(log); if (p && p.name === "DataStreamCreated") return p.args.streamId; }
    catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}
async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

describe("Bounty fee + payout simulation (end-to-end, demo ERC-20)", function () {
  this.timeout(120000);

  let satori, token, bounties, registry, voting, rewards, owner, signers;
  let coreAddr, tokenAddr, feeRecipient;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, token, bounties, registry, voting, rewards, owner, signers } = fix);
    coreAddr = await satori.getAddress();
    tokenAddr = await token.getAddress();
    // platform fee moved to immutable token (see test/next/DevFee.test.js):
    // PLATFORM_FEE_RECIPIENT now lives on the token, not on rewards.
    feeRecipient = await token.PLATFORM_FEE_RECIPIENT();
  });

  // ---- A. Upfront fee accounting -------------------------------------------
  it("A: non-SATORI bounty charges the funder exactly bountyBurn (locked into the core); SATORI + re-fund are free", async function () {
    const [, funder, authority] = signers;
    await satori.transfer(funder.address, E(200));   // SATORI for the bounty burn(s)
    await satori.transfer(authority.address, E(10)); // SATORI for stream-creation burn
    const stream = await createStream(satori, owner, "S", authority.address);

    const meme = await deployDemoToken("MEME");
    await meme.mint(funder.address, E(100000));
    await meme.connect(funder).approve(await bounties.getAddress(), ethers.MaxUint256);

    // --- non-SATORI first fund: exactly bountyBurn() is pulled in SATORI ---
    const fee = await satori.bountyBurn();
    expect(fee).to.be.gt(0n);
    const funderSatBefore = await satori.balanceOf(funder.address);
    const coreSatBefore = await satori.balanceOf(coreAddr);
    const defaultWeightBefore = await voting.weightOf(1);

    await bounties.connect(funder).fundBounty(stream, await meme.getAddress(), E(1000), E(100));

    expect(await satori.balanceOf(funder.address)).to.equal(funderSatBefore - fee, "funder pays exactly bountyBurn in SATORI");
    expect(await satori.balanceOf(coreAddr)).to.equal(coreSatBefore + fee, "burn is locked into the core (not sent to a splitter)");
    // The fee buys NO vote weight. Weight comes only from burnt SATORI, and the
    // default game's share is derived from that — a fee transfer moves neither.
    expect(await voting.weightOf(1)).to.equal(defaultWeightBefore, "the locked fee does not buy the default game any weight");

    // --- re-funding the SAME (game, token) is FREE (no second burn) ---
    const funderSatMid = await satori.balanceOf(funder.address);
    await bounties.connect(funder).fundBounty(stream, await meme.getAddress(), E(500), E(100));
    expect(await satori.balanceOf(funder.address)).to.equal(funderSatMid, "top-up of an existing bounty charges no SATORI");

    // --- funding a bounty in SATORI itself is FREE (only the funded amount leaves) ---
    await satori.connect(owner).transfer(funder.address, E(300));
    await satori.connect(funder).approve(await bounties.getAddress(), ethers.MaxUint256);
    const satFundAmt = E(50);
    const before = await satori.balanceOf(funder.address);
    await bounties.connect(funder).fundBounty(stream, tokenAddr, satFundAmt, E(10));
    expect(await satori.balanceOf(funder.address)).to.equal(before - satFundAmt, "SATORI bounty: only the funded amount leaves, no extra burn");
  });

  // ---- B. Exact stake-proportional payout, loser gets zero, no payout fee ---
  it("B: winners split the drip stake-proportionally, the wrong-direction staker earns zero, and the fee recipient earns nothing", async function () {
    const [, alice, bob, carol, funder, authority] = signers;
    for (const s of [alice, bob, carol, funder, authority]) await satori.transfer(s.address, E(100));

    const stream = await createStream(satori, owner, "S", authority.address);
    // Burn for prediction eligibility (bounty earning is stake-based, but you
    // predict on an eligible game to have your prediction scored). 10 of each
    // 100-SATORI balance; the remaining 90 stays available as prediction power.
    for (const s of [alice, bob, carol]) await voteFor(satori, s, stream);
    // audit C-2: streak 0 takes no bounty boost — warm to streak >= 1 before funding
    await warmUpStreak(satori, registry, authority, [alice, bob, carol], stream);

    const meme = await deployDemoToken("MEME");
    const memeAddr = await meme.getAddress();
    await meme.mint(funder.address, E(100000));
    await meme.connect(funder).approve(await bounties.getAddress(), ethers.MaxUint256);
    const RATE = E(300);
    await bounties.connect(funder).fundBounty(stream, memeAddr, E(3000), RATE);

    // Stakes: Alice 300, Bob 100 (both UP, correct), Carol 200 (DOWN, wrong).
    await stakeFor(bounties, alice, meme, E(300));
    await stakeFor(bounties, bob, meme, E(100));
    await stakeFor(bounties, carol, meme, E(200));

    // Round R: value set, everyone predicts (first-ever prediction ⇒ equal
    // streak multiplier for all, so winner shares are purely stake-proportional).
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await satori.connect(carol).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(DOWN) }]);

    // Resolve UP: value rises across the settle window.
    await advanceRound(); await registry.connect(authority).setValue(stream, 110);
    await advanceRound(); await registry.connect(authority).setValue(stream, 120);

    await satori.settlePrediction(alice.address, stream);
    await satori.settlePrediction(bob.address, stream);
    await satori.settlePrediction(carol.address, stream);

    const aliceEarned = (await bounties.bountyStake(alice.address, memeAddr)) - E(300);
    const bobEarned = (await bounties.bountyStake(bob.address, memeAddr)) - E(100);
    const carolEarned = (await bounties.bountyStake(carol.address, memeAddr)) - E(200);

    // One round scored ⇒ drip = RATE, shared over the stake on BOTH sides
    // (300 + 100 + 200 = 600): each prediction scores its own window, so UP
    // and DOWN could both have won. Alice 3/6, Bob 1/6, Carol (wrong) 0.
    const drip = RATE;
    const TOL = E("0.01");
    expect(aliceEarned).to.be.closeTo((drip * 300n) / 600n, TOL, "Alice gets 3/6 of the drip");
    expect(bobEarned).to.be.closeTo((drip * 100n) / 600n, TOL, "Bob gets 1/6 of the drip");
    expect(carolEarned).to.equal(0n, "wrong-direction staker earns nothing");
    // Carol's 2/6 stays in the round's pot for reclaimStrandedPot (no leakage).
    const round = (await satori.getCurrentRound()) - 2n;
    expect(await bounties.roundBountyPot(stream, round, memeAddr)
      - await bounties.roundBountyPotClaimed(stream, round, memeAddr))
      .to.be.closeTo((drip * 200n) / 600n, TOL, "the wrong call's share stays in the pot");
    // The platform fee recipient never receives bounty tokens (payout fee removed).
    expect(await bounties.bountyStake(feeRecipient, memeAddr)).to.equal(0n);
  });

  // ---- C. Conservation + realize winnings to wallet ------------------------
  it("C: full token conservation, and winners unstake exactly stake + winnings back to their wallet", async function () {
    const [, alice, bob, funder, authority] = signers;
    for (const s of [alice, bob, funder, authority]) await satori.transfer(s.address, E(100));

    const stream = await createStream(satori, owner, "S", authority.address);
    await voteFor(satori, alice, stream);
    await voteFor(satori, bob, stream);
    // audit C-2: streak 0 takes no bounty boost — warm to streak >= 1 before funding
    await warmUpStreak(satori, registry, authority, [alice, bob], stream);

    const meme = await deployDemoToken("MEME");
    const memeAddr = await meme.getAddress();
    await meme.mint(funder.address, E(100000));
    await meme.connect(funder).approve(await bounties.getAddress(), ethers.MaxUint256);
    const FUND = E(2000), RATE = E(200);
    await bounties.connect(funder).fundBounty(stream, memeAddr, FUND, RATE);

    await stakeFor(bounties, alice, meme, E(200));
    await stakeFor(bounties, bob, meme, E(200));
    const stakedIn = E(400); // Σ staked into the contract

    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceRound(); await registry.connect(authority).setValue(stream, 110);
    await advanceRound(); await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream);
    await satori.settlePrediction(bob.address, stream);

    // CONSERVATION: everything the bounties contract HOLDS must be coverable by
    // what was funded + staked in, and equals held = fundedIn + stakedIn (nothing
    // has left yet). Liabilities (pool + Σ bountyStake + Σ unclaimed) never exceed
    // the held balance.
    const heldBefore = await meme.balanceOf(await bounties.getAddress());
    expect(heldBefore).to.equal(FUND + stakedIn, "contract holds exactly funded + staked");

    const pool = await bounties.pool(stream, memeAddr);
    const aStake = await bounties.bountyStake(alice.address, memeAddr);
    const bStake = await bounties.bountyStake(bob.address, memeAddr);
    const liabilities = pool + aStake + bStake; // undripped reserve + unstakeable balances
    expect(liabilities).to.be.lte(heldBefore, "owed-out never exceeds the held balance (solvency)");

    // REALIZE: each winner unstakes their full balance (original stake + winnings)
    // and receives exactly that many tokens in their wallet.
    const aWalletBefore = await meme.balanceOf(alice.address);
    await bounties.connect(alice).unstakeBountyToken(memeAddr, aStake, alice.address);
    expect(await meme.balanceOf(alice.address)).to.equal(aWalletBefore + aStake, "Alice receives stake + winnings exactly");
    expect(await bounties.bountyStake(alice.address, memeAddr)).to.equal(0n);

    const bWalletBefore = await meme.balanceOf(bob.address);
    await bounties.connect(bob).unstakeBountyToken(memeAddr, bStake, bob.address);
    expect(await meme.balanceOf(bob.address)).to.equal(bWalletBefore + bStake, "Bob receives stake + winnings exactly");

    // Both winners earned a positive bounty (they were correct and staked).
    expect(aStake).to.be.gt(E(200));
    expect(bStake).to.be.gt(E(200));
  });
});
