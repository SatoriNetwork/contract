// Regression guard — bounties are keyed by gameId (was MEDIUM finding adv_12).
//
// Previously bounty state keyed on streamId, so a staker's share was multiplied
// by the number of games they predicted on the same stream (denominator
// double-counted, credit fired per game). Fixed by re-keying the bounty path to
// gameId: each game is an independent pool, so predicting extra games on the
// same stream does not inflate a staker's share of any one game's pot.
//
// INTENT (docs/narratives/A_bounty_staking.md, now per-game):
//   share = pot * userStake / totalStake — "pure stake-proportional", "Not a
//   payout multiplier". Two stakers with IDENTICAL stake predicting correctly
//   on the same bountied game must each receive an EQUAL share of the pot,
//   regardless of how many OTHER games on that stream they also predict.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  deployAndRegisterYesNoGame,
  createYesNoGame,
  pack1,
  voteFor,
} = require("../fixtures");

const UP = 1; // binary UP and YesNoGame YES share the same 1-byte payload (0x01).

async function deployMockToken(symbol = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

async function stakeFor(bounties, user, token, amount) {
  await token.mint(user.address, amount);
  await token.connect(user).approve(await bounties.getAddress(), amount);
  await bounties.connect(user).stakeBountyToken(await token.getAddress(), amount);
}

async function createStream(satori, signer, name, authority) {
  // Cadence 2: this stream hosts an ADAPTER game (the g2 YesNoGame, type-1).
  // createGame now reverts GameCadenceTooShort for any adapter (gameTypeId > 0)
  // on a stream whose minCadenceRounds < 2, so the host must be cadence >= 2.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 2880);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

// Multi-game-per-stream is now expressed with a YesNoGame ADAPTER (type-1) as
// the second game. A stream auto-creates its single binary game (gameId ==
// streamId); a duplicate type-0 reverts DuplicateBinaryGame, so the EXTRA game
// on the stream is the adapter. The bountied game stays the binary g1; g2 is
// the adapter whose only role here is to be a SECOND game Alice also predicts
// on the same stream. The original adv_12 property is unchanged: predicting an
// extra same-stream game must not inflate a staker's share of g1's pot.
describe("adv_12 bounties — multi-game-per-stream share inflation", function () {
  this.timeout(120000);

  let satori, bounties, registry, games;
  let yesNoTypeId;
  let alice, bob, funder, authority;
  let stream, g1, g2, usd;

  const POT = ethers.parseEther("1000");
  const RATE = ethers.parseEther("100");

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, bounties, registry, games } = fix);
    [, alice, bob, funder, authority] = fix.signers;

    // Register the YesNoGame adapter once; the extra same-stream game (g2) is
    // built from it. Threshold is chosen so YES wins on the same rising series
    // that makes the binary g1 UP prediction correct.
    ({ gameTypeId: yesNoTypeId } = await deployAndRegisterYesNoGame(fix));

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    // Create a stream. createSimpleDataStream auto-creates a default binary
    // game whose gameId == streamId, living on that stream.
    stream = await createStream(satori, authority, "S", authority.address);
    g1 = stream; // default binary game on the stream
    // Sanity: default game G1 lives on the stream.
    expect(await games.dataStreamId(g1)).to.equal(stream);

    // Create a SECOND game on the SAME stream — a YesNoGame ADAPTER (type-1),
    // since a duplicate type-0 binary game now reverts DuplicateBinaryGame.
    // Threshold 50 < the post-prediction stream values (110/120), so a YES
    // (direction 1, same byte as binary UP) prediction resolves correct on the
    // same rising series.
    g2 = await createYesNoGame(satori.connect(authority), yesNoTypeId, stream, 50, "G2");
    expect(await games.dataStreamId(g2)).to.equal(stream);

    // g1 must carry burnt weight for its predictors to be eligible. Both burn
    // the same 10 SATORI, so their prediction power (balance) stays equal at 90.
    await voteFor(satori, alice, g1);
    await voteFor(satori, bob, g1);

    // Fund a USDC bounty on game g1 (gameId-keyed).
    usd = await deployMockToken();
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await bounties.connect(funder).fundBounty(g1, await usd.getAddress(), POT, RATE);

    // Identical stake: 100 USDC each.
    await stakeFor(bounties, alice, usd, ethers.parseEther("100"));
    await stakeFor(bounties, bob, usd, ethers.parseEther("100"));
  });

  it("INTENDED: equal stake => equal bounty share, regardless of game count on the same stream", async function () {
    await registry.connect(authority).setValue(stream, 100);

    // Alice predicts BOTH games on the same stream "up" — binary UP on g1 and
    // YES on the g2 adapter (same 0x01 payload byte).
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: g1, payload: pack1(UP) },
      { gameId: g2, payload: pack1(UP) },
    ]);
    // Bob predicts only one game UP.
    await satori.connect(bob).predictMultipleWithPayloads([
      { gameId: g1, payload: pack1(UP) },
    ]);

    // Advance and set rising values so all UP predictions are correct.
    // The host stream is cadence 2 (2880 min), so each setValue needs 2 rounds
    // (48h) to elapse since the previous update; advance two 24h rounds per step.
    await advanceOneDay();
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);

    // Settle every (user, game) pair.
    await satori.settlePrediction(alice.address, g1);
    await satori.settlePrediction(alice.address, g2);
    await satori.settlePrediction(bob.address, g1);

    const usdAddr = await usd.getAddress();
    const aliceEarned = (await bounties.bountyStake(alice.address, usdAddr)) - ethers.parseEther("100");
    const bobEarned = (await bounties.bountyStake(bob.address, usdAddr)) - ethers.parseEther("100");

    // Per the design's pure stake-proportional rule, identical stake must earn
    // identical bounty share. Allow a few wei of integer-division dust.
    const TOL = 10n;
    expect(aliceEarned).to.be.closeTo(
      bobEarned,
      TOL,
      `Alice (predicted 2 games) earned ${aliceEarned} but Bob (1 game) earned ${bobEarned}; equal stake must earn equal share`
    );
  });
});
