// PHASE-CLOSE gap test for SatoriBounties' adapter score/total single-active-token
// rail (SatoriBounties.sol snapshotAdapterStake / _firstFundedToken /
// creditAdapterBounty).
//
// IMPORTANT gap closed here — the SENTINEL_NONE "pinned-to-none" freeze:
//
//   snapshotAdapterStake pins SENTINEL_NONE (address(1)) into
//   _adapterActiveToken[gameId][round] when _firstFundedToken returns address(0)
//   at the round's FIRST predict (no live-funded token on the adapter game yet).
//   That "no-bounty" decision is then FROZEN for the WHOLE round: a fundBounty that
//   arrives mid-round must NOT retroactively create a bounty obligation for a later
//   same-round predictor. The `if (T == SENTINEL_NONE) return 0` guard in
//   snapshotAdapterStake (and the mirror `T == SENTINEL_NONE` early-return in
//   creditAdapterBounty) short-circuit every later predict/credit in that round.
//
// The SENTINEL_NONE constant exists ONLY for this path and is exercised nowhere
// else in the test tree (grep for SENTINEL / pinned-none returns zero hits). Other
// adapter-bounty pin tests (adapter-bounty-pin-cap M3) only freeze the pin when a
// token is ALREADY pinned to a real address; none stage the "no live token at first
// predict -> SENTINEL_NONE -> fund mid-round -> second predictor still gets nothing"
// freeze, then prove the pin RECOMPUTES (and pays) the next round.
//
// On the immutable launch a regression here would either (a) let a late mid-round
// funder retroactively mint a bounty a first predictor never snapshotted, or (b)
// brick the SENTINEL_NONE early-returns. This test locks both directions.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, ensureAdapterBountyToken } = require("../fixtures");

const ROUND = 86400, YES = 1;
const TOL = ethers.parseEther("0.01");
async function advanceRound() { await time.increase(ROUND); }

async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try { const p = games.interface.parseLog(log); if (p && p.name === "GameCreated") return Number(p.args.gameId); } catch (e) {}
  }
  throw new Error("GameCreated missing");
}
async function impersonateCore(satori) {
  const a = await satori.getAddress();
  await impersonateAccount(a); await setBalance(a, ethers.parseEther("10"));
  return ethers.getSigner(a);
}
async function deployToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}
async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}
async function fundBountyOn(bounties, funder, token, gameId, poolEth = "1000", rateEth = "1000") {
  await token.mint(funder.address, ethers.parseEther("100000"));
  await token.connect(funder).approve(await bounties.getAddress(), ethers.MaxUint256);
  await ensureAdapterBountyToken(bounties, gameId, token);
  await bounties.connect(funder).fundBounty(
    gameId, await token.getAddress(), ethers.parseEther(poolEth), ethers.parseEther(rateEth));
}

// Register a YesNoGame adapter at type 1, create a game on a fresh stream with
// the given int128 threshold. Returns { gameId, streamId }.
//
// NOT voted: only the built-in binary game (gameTypeId == 0) is mint-eligible, so
// `vote` on an adapter game reverts GameNotMintEligible. The SENTINEL_NONE freeze
// under test lives entirely on the BOUNTY rail — funded escrow, snapshotted from
// the user's STAKE — so it is indifferent to the mint boundary.
async function setupYesNoGame(fix, threshold = 150) {
  const { satori, engine, registry, rewards, games, owner } = fix;
  const YesNoGame = await ethers.getContractFactory("YesNoGame");
  const yesNo = await YesNoGame.deploy(await engine.getAddress(), await games.getAddress(),
    await registry.getAddress());
  await yesNo.waitForDeployment();
  const coreSigner = await impersonateCore(satori);
  await games.connect(coreSigner).registerGameAdapter(await yesNo.getAddress(), owner.address, "YesNo", false);

  await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 2880);
  // Stream/game id 1 is the protocol's DEFAULT game (the fixture initializes it
  // exactly as production does), so this stream is id 2 — capture it.
  const streamId = Number(await registry.nextStreamId()) - 1;
  await registry.connect(owner).setValue(streamId, 100);
  const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [threshold]);
  const gameId = await gameIdFrom(await satori.connect(owner).createGame(streamId, 1, cfg, "yn"), games);
  return { gameId, streamId };
}

describe("gap-bounties — SENTINEL_NONE pinned-to-none freeze (mid-round fund cannot retro-bounty; pin recomputes next round)", function () {
  this.timeout(300000);

  it("no live token at round R's first predict pins SENTINEL_NONE; a same-round fund pays NEITHER same-round predictor, then R+2 recomputes and pays", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, registry, rewards, bounties, owner, signers } = fix;
    const funder = signers[5];

    const { gameId, streamId } = await setupYesNoGame(fix, 150);
    // Deliberately do NOT fund any bounty before the round's first predict.
    const tok = await deployToken();
    const tokAddr = await tok.getAddress();

    const p1 = signers[1], p2 = signers[2], p3 = signers[3];
    for (const p of [p1, p2, p3]) await satori.transfer(p.address, ethers.parseEther("10"));
    // All three stake the SAME token T (so the ONLY reason a snapshot is 0 is the
    // SENTINEL_NONE freeze, not a missing stake).
    await stakeFor(bounties, p1, tok, ethers.parseEther("100"));
    await stakeFor(bounties, p2, tok, ethers.parseEther("100"));
    await stakeFor(bounties, p3, tok, ethers.parseEther("100"));

    // Sanity: stakes are live BEFORE any predict, and no round lock is set yet.
    expect(await bounties.bountyStake(p1.address, tokAddr)).to.equal(ethers.parseEther("100"));
    expect(await bounties.stakeLockedUntil(p1.address, tokAddr)).to.equal(0n);

    // ---- Round R: P1 is the FIRST predictor on the adapter game. No live-funded
    //      token exists, so _firstFundedToken returns address(0) and
    //      _adapterActiveToken[game][R] is pinned to SENTINEL_NONE. P1's snapshot
    //      is 0 and its stake is NOT locked (the snapshot short-circuited). ----
    const roundR = Number(await satori.getCurrentRound());
    await satori.connect(p1).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);

    // P1 snapshotted nothing for T in round R (SENTINEL_NONE return 0 path).
    expect(await bounties.boostStakeForPrediction(p1.address, gameId, roundR, tokAddr)).to.equal(0n);
    // And the snapshot short-circuited BEFORE the stake-lock write — lock untouched.
    expect(await bounties.stakeLockedUntil(p1.address, tokAddr)).to.equal(0n);

    // ---- A fundBounty arrives MID-round R (after the pin was frozen). It is the
    //      first virgin fund for T, so it stamps the funding epoch at round R and
    //      makes T a live-funded token going forward. ----
    // fundBounty on a NON-SATORI token now charges an upfront SATORI bountyBurn on
    // the first fund of this (game, token) pair. Give the funder exactly that.
    await satori.transfer(funder.address, await satori.bountyBurn());
    await fundBountyOn(bounties, funder, tok, gameId);
    expect(await bounties.pool(gameId, tokAddr)).to.be.gt(0n);
    expect(await bounties.ratePerRound(gameId, tokAddr)).to.be.gt(0n);

    // ---- P2 predicts the SAME round R. The SENTINEL_NONE freeze must still hold:
    //      a later same-round predictor resolves the FROZEN "no bounty" decision and
    //      snapshots 0, even though T is now live-funded. The mid-round fund did NOT
    //      retroactively create an obligation. ----
    await satori.connect(p2).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    expect(await bounties.boostStakeForPrediction(p2.address, gameId, roundR, tokAddr)).to.equal(0n);
    expect(await bounties.stakeLockedUntil(p2.address, tokAddr)).to.equal(0n);

    // ---- Settle round R for both. YES wins. Neither earns any bounty, and the
    //      late fund did NOT drip into round R's pot (creditAdapterBounty hit its
    //      `T == SENTINEL_NONE` early return, so _dripTokenForRound was never
    //      called for round R). ----
    // The host stream is at a two-round (2880-minute) cadence, so its writes must
    // be >= 2 rounds apart. This setValue(200) is BOTH the round-R settlement value
    // (first value after R) AND the fresh value the next predictor commits on — a
    // two-round stream can only be written (and therefore predicted) every 2
    // rounds, so advance TWO rounds.
    await advanceRound();
    await advanceRound();
    await registry.connect(owner).setValue(streamId, 200); // 200 > 150 → YES wins

    const s1Before = await bounties.bountyStake(p1.address, tokAddr);
    const s2Before = await bounties.bountyStake(p2.address, tokAddr);

    await satori.settlePrediction(p1.address, gameId);
    await satori.settlePrediction(p2.address, gameId);

    expect((await bounties.bountyStake(p1.address, tokAddr)) - s1Before).to.equal(0n);
    expect((await bounties.bountyStake(p2.address, tokAddr)) - s2Before).to.equal(0n);
    // The SENTINEL_NONE freeze blocked the round-R drip entirely.
    expect(await bounties.roundBountyPot(gameId, roundR, tokAddr)).to.equal(0n);

    // ---- Round R+2 (now the current round after the 2-round cadence advance): the
    //      pin RECOMPUTES. _adapterActiveToken[game][R+2] is unset, _firstFundedToken
    //      now returns T (live pool + rate), so the freeze lifts and a fresh
    //      predictor IS paid. (The two-round cadence means the next writable/predictable round is
    //      R+2, not R+1.) ----
    const roundNext = Number(await satori.getCurrentRound());
    expect(roundNext).to.equal(roundR + 2);

    await satori.connect(p3).predictMultipleWithPayloads([{ gameId, payload: pack1(YES) }]);
    // The pin recomputed to the real token T: P3 snapshotted a non-zero stake and
    // its stake is now locked through the round after (roundNext + 1).
    expect(await bounties.boostStakeForPrediction(p3.address, gameId, roundNext, tokAddr))
      .to.equal(ethers.parseEther("100"));
    expect(await bounties.stakeLockedUntil(p3.address, tokAddr)).to.equal(BigInt(roundNext + 1));

    // Two-round-cadence host: this final settlement write (the first value after R+2) must
    // be >= 2 rounds after setValue(200), so advance TWO rounds (not one).
    await advanceRound();
    await advanceRound();
    await registry.connect(owner).setValue(streamId, 250); // YES wins again

    const p3Before = await bounties.bountyStake(p3.address, tokAddr);
    await satori.settlePrediction(p3.address, gameId);
    const p3Earn = (await bounties.bountyStake(p3.address, tokAddr)) - p3Before;

    // The freeze lifted next round: P3 IS paid from T.
    expect(p3Earn).to.be.gt(0n);
    const drippedNext = await bounties.roundBountyPot(gameId, roundNext, tokAddr);
    expect(drippedNext).to.be.gt(0n);
    // Conservation for the recompute round: P3's earnings ≤ the dripped pot.
    expect(p3Earn).to.be.lte(drippedNext + TOL);
  });
});
