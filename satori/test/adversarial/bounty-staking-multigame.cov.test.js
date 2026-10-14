// Regression guard — bounties are keyed by gameId (was HIGH finding adv_13).
//
// Previously bounty state was keyed by (stream, round, direction, token), so a
// user who predicted TWO distinct games sharing one dataStreamId in a single
// batch double-bumped the per-direction denominator AND was double-credited at
// score time (one credit per game, no already-credited guard). Equal-stake
// users could end up with unequal earnings. Fixed by re-keying the entire
// bounty path — fund / applyBoost snapshot / gameHasBounty gate / credit — to
// gameId.
//
// INTENDED behavior (docs/narratives/A_bounty_staking.md, now per-game):
//   two users with EQUAL real bounty-token stake who both predict correctly on
//   the SAME bountied game in the SAME round/direction earn EQUAL shares. A user
//   cannot amplify their share by predicting a SECOND game on the same stream —
//   that game is an independent pool (here it isn't funded, so it pays nothing).
//
// This test asserts that INTENDED behavior: equal real stake -> equal earnings.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  deployAndRegisterYesNoGame,
  createYesNoGame,
  pack1,
  warmUpStreak,
  voteFor,
} = require("../fixtures");

const UP = 1;

// YesNoGame threshold. The stream is driven 100 (predict round R) -> 110 (R+1)
// -> 120 (R+2); YesNoGame scores each bet against the FIRST stream value after
// the bet's round (== 110 here) and YES wins iff that value > threshold. With
// threshold 100, 110 > 100 so YES (direction 1 == UP) wins — exactly mirroring
// the binary game's "UP correct" outcome the original test relied on.
const YESNO_THRESHOLD = 100;

async function deployMockToken(sym = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(sym, sym);
  await t.waitForDeployment();
  return t;
}

// The host stream is cadence 2 (2880 minutes, see createStream), so setValue
// must wait a full cadence period (2 rounds of 24h, wall-clock gap 171000s)
// between writes; advancing two whole rounds satisfies both the round-level
// and timestamp cadence guards.
async function advanceCadencePeriod() { await time.increase(2 * 86400); }

async function createStream(satori, signer, name, authority) {
  // Fixture's Proxy wrapper auto-creates a paired binary game on the stream
  // (gameId == streamId for this first game). Cadence 2: this stream hosts an
  // adapter game (gameB below), which the create-time gate now requires to sit
  // on a stream of at least two rounds' cadence (else GameCadenceTooShort). The
  // built-in binary game (gameA) is exempt but rides along on the same stream.
  const tx = await satori
    .connect(signer)
    ["createSimpleDataStream(string,address,uint24)"](name, authority, 2880);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

describe("adv_13 bounty-staking: two games on one stream must not double-credit", function () {
  this.timeout(120000);

  let satori, bounties, registry, games, owner;
  let alice, bob, funder, authority;
  let streamId, gameA, gameB, usd;
  let yesNoTypeId;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, bounties, registry, games, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    // Register the YesNoGame adapter once so the SECOND game on the stream can
    // be an adapter (type-1) game — the only way to put two games on one
    // stream now that each stream auto-creates its single binary (type-0) game
    // and a duplicate type-0 reverts DuplicateBinaryGame.
    ({ gameTypeId: yesNoTypeId } = await deployAndRegisterYesNoGame(fix));

    // Stream S with its auto game gameA (gameId == streamId), plus a SECOND
    // game gameB — a YesNoGame adapter — on the SAME stream. gameB is the
    // independent, UNFUNDED pool the adversarial case probes: Alice predicting
    // it must not amplify her bountied-gameA share.
    streamId = await createStream(satori, authority, "S", authority.address);
    gameA = streamId; // the fixture auto-game uses gameId == streamId
    gameB = await createYesNoGame(
      satori.connect(owner), yesNoTypeId, streamId, YESNO_THRESHOLD, "extra"
    );
    expect(gameB).to.not.equal(gameA);

    // Burn for gameA only. gameB is an ADAPTER game (gameTypeId > 0) and is not
    // mint-eligible, so `vote(gameB, ...)` reverts GameNotMintEligible — it can
    // never carry weight, and bets on it are recorded with predictionPower == 0.
    // That changes nothing here: the bounty is funded on gameA, and this test's
    // subject is the gameId keying of the BOUNTY rail, which pays out of escrow
    // on stake × streak multiplier, not on mint weight. Alice and Bob burn the
    // same 10 each, so their prediction power stays equal.
    await voteFor(satori, alice, gameA);
    await voteFor(satori, bob, gameA);

    usd = await deployMockToken("USDC");
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    // Bounty is funded on gameA only (gameId-keyed).
    // audit C-2: streak 0 takes no bounty boost — warm to streak >= 1 before funding
    // warmUpStreak takes cadence in OLD 12h-round units: the 2880-minute stream
    // writes every 2 new (24h) rounds == 4 old half-rounds.
    await warmUpStreak(satori, registry, authority, [alice, bob], streamId, 1000, 4);

    await bounties.connect(funder).fundBounty(
      gameA, await usd.getAddress(),
      ethers.parseEther("1000"), ethers.parseEther("200")
    );
  });

  it("equal real stake -> equal bounty earnings even if Alice predicts BOTH same-stream games", async function () {
    // Equal REAL bounty-token stake: Alice 100, Bob 100.
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));

    // Anchor A.
    await registry.connect(authority).setValue(streamId, 100);

    // Alice predicts BOTH games on the same stream/direction in ONE batch.
    // Distinct gameIds -> passes DuplicatePrediction; one batch -> passes
    // AlreadyPredicted. With gameId-keyed bounties, only the gameA predict
    // snapshots (gameB has no bounty), so Alice cannot self-duplicate.
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
      { gameId: gameB, payload: pack1(UP) },
    ]);

    // Bob predicts only ONE game (honest single prediction).
    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: gameA, payload: pack1(UP) },
    ]);

    // Drive the stream up (100 -> 110 -> 120) so UP is correct. The host
    // stream is cadence 2 (adapter game gameB lives here), so the built-in
    // binary game scores non-ABC: anchor = value AT the predict round (100),
    // post = first value after (110) -> UP correct. gameB (YesNoGame) scores
    // that same first-value-after (110) > threshold (100) -> YES/UP wins.
    // Each advanceCadencePeriod() spans a full cadence-2 period (2 rounds) so
    // the per-write cadence guards pass.
    await advanceCadencePeriod();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceCadencePeriod();
    await registry.connect(authority).setValue(streamId, 120);

    // Settle every prediction (each game scored independently).
    await satori.settlePrediction(alice.address, gameA);
    await satori.settlePrediction(alice.address, gameB);
    await satori.settlePrediction(bob.address, gameA);

    const usdAddr = await usd.getAddress();
    const aliceEarned =
      (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("100");
    const bobEarned =
      (await bounties.bountyStake(bob.address, usdAddr)) - ethers.parseEther("100");

    // Both should have earned a positive bounty share.
    expect(aliceEarned).to.be.gt(0n);
    expect(bobEarned).to.be.gt(0n);

    // INTENDED: equal real stake, same game/round/direction, both correct ->
    // EQUAL share. Tolerance for integer-truncation dust only.
    const TOL = ethers.parseEther("0.01");
    expect(aliceEarned).to.be.closeTo(
      bobEarned, TOL,
      "Alice (predicted both same-stream games) must not earn more than Bob with equal real stake"
    );

    // Solvency cross-check: total credited (predictor stakes added) for the
    // single dripped round must not exceed the dripped pot (== RATE = 200).
    // Sigma share <= pot (Q60).
    const drip = ethers.parseEther("200");
    const totalCredited = aliceEarned + bobEarned;
    expect(totalCredited).to.be.lte(
      drip + TOL,
      "Sigma credited (shares) must not exceed the dripped pot"
    );
  });
});
