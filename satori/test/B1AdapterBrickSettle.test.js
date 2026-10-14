// B-1 (block-B audit 2026-07-28) — an untrusted game adapter must not be able to
// brick the score path.
//
// docs/narratives/A_game_adapters.md:26 states the adapter's score() "MUST NOT
// revert" and concludes a malicious adapter "can never brick the score path with
// a revert loop". Nothing enforced that: SatoriEngine._scoreAdapterPrediction
// called IPredictionGame(impl).score() as a plain external call, and community
// adapters are registrable permissionlessly (registerCommunityGameAdapter behind
// CAP_REGISTER_GAME_ADAPTER). So a hostile adapter could jam settlePrediction
// forever.
//
// Three distinct vectors, two of which never revert at all:
//   1. score() reverts outright.
//   2. score() returns total = type(uint256).max        -> `total + 1` overflowed
//      (SatoriRewards) on the first-scorer pin.
//   3. score() returns bountyTotal = type(uint256).max  -> `bountyTotal + 1`
//      overflowed (SatoriBounties) on the first-scorer pin.
// Plus malformed return data, which a bare try/catch does not reliably cover.
//
// A bricked settle is not self-contained: the victim's prediction can never
// finalize, so _unsettledPredictionCount sticks above zero permanently, and for a
// delegate that leaves an openRounds entry that can never be popped.
//
// The fix: the engine decodes score()'s return manually and treats any failure
// (revert, malformed/short data) as "not resolved yet" — the pending signal the
// narrative already defines — and both pins saturate instead of overflowing.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySatoriFixture,
  createYesNoGame,
  pack1,
  VOTE,
} = require("./fixtures");

const ROUND = 86400;
const YES = 1;

const MODE_OK = 0;
const MODE_REVERT = 1;
const MODE_MAX_TOTAL = 2;
const MODE_MAX_BOUNTY = 3;
const MODE_GARBAGE = 4;
const MODE_EMPTY = 5;

async function advanceRounds(n) {
  await time.increase(ROUND * n);
}

async function streamIdFrom(tx, fix) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const p = fix.registry.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function registerBrickingAdapter(fix) {
  const Bricking = await ethers.getContractFactory("BrickingGame");
  const hostile = await Bricking.deploy();
  await hostile.waitForDeployment();
  const receipt = await (
    await fix.satori.connect(fix.owner).registerGameAdapter(await hostile.getAddress(), "Bricking")
  ).wait();
  for (const log of receipt.logs) {
    try {
      const parsed = fix.games.interface.parseLog(log);
      if (parsed && parsed.name === "GameAdapterRegistered") {
        return { hostile, gameTypeId: Number(parsed.args.gameTypeId) };
      }
    } catch (e) {}
  }
  throw new Error("GameAdapterRegistered event missing");
}

describe("B-1 — a hostile game adapter cannot brick the score path", function () {
  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, owner, signers } = fix;

    // A legitimate game, so we can prove the victim's OTHER predictions survive.
    // It is the stream's built-in BINARY game (auto-created with the stream, so
    // its id is the stream id): only type 0 is mint-eligible, so it is the only
    // kind of game that can be voted for and can pay a SATORI reward — which is
    // exactly what "the victim's other bets still settle AND pay" needs.
    const realStream = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("REAL", owner.address, 2880),
      fix
    );
    await fix.registry.connect(owner).setValue(realStream, 100);
    const realGameId = realStream;

    // The hostile adapter's own game. Registered here through the admin door;
    // in production registerCommunityGameAdapter is the permissionless path and
    // the settle mechanics are identical.
    const { hostile, gameTypeId: hostileType } = await registerBrickingAdapter(fix);
    const hostileStream = await streamIdFrom(
      await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"]("HOSTILE", owner.address, 2880),
      fix
    );
    await fix.registry.connect(owner).setValue(hostileStream, 100);
    const hostileGameId = await createYesNoGame(satori.connect(owner), hostileType, hostileStream, 0, "hostile");

    const alice = signers[1];
    const bob = signers[2];
    await satori.transfer(alice.address, ethers.parseEther("10"));
    await satori.transfer(bob.address, ethers.parseEther("10"));

    return { ...fix, hostile, realGameId, hostileGameId, realStream, alice, bob };
  }

  // Drive the attack: alice bets on BOTH the legit game and the hostile one in a
  // single round, the adapter then turns hostile, and an unprivileged caller
  // tries to settle. Returns a helper to assert the survivable outcome.
  async function runAttack(mode) {
    const fix = await loadFixture(setup);
    const { satori, registry, realGameId, hostileGameId, realStream, hostile, alice, bob, owner } = fix;

    await satori.connect(bob).vote(realGameId, VOTE);
    const R = Number(await satori.getCurrentRound());
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: realGameId, payload: pack1(YES) },
      { gameId: hostileGameId, payload: pack1(YES) },
    ]);
    await hostile.setTargetRound(R);
    await hostile.setMode(mode);

    // realStream is cadence-2, so the setup write must be >= 2 rounds back.
    await advanceRounds(2);
    await registry.connect(owner).setValue(realStream, 200); // > threshold => YES wins

    return fix;
  }

  it("control: a well-behaved adapter settles normally", async function () {
    const { satori, hostileGameId, alice, bob } = await runAttack(MODE_OK);
    await expect(satori.connect(bob).settlePrediction(alice.address, hostileGameId)).to.not.be.reverted;
  });

  for (const [name, mode] of [
    ["score() reverts outright", MODE_REVERT],
    ["score() returns total = type(uint256).max (never reverts)", MODE_MAX_TOTAL],
    ["score() returns bountyTotal = type(uint256).max (never reverts)", MODE_MAX_BOUNTY],
    ["score() returns malformed short data", MODE_GARBAGE],
    ["score() returns empty data", MODE_EMPTY],
  ]) {
    describe(name, function () {
      it("settling the hostile game does not revert", async function () {
        const { satori, hostileGameId, alice, bob } = await runAttack(mode);
        await expect(
          satori.connect(bob).settlePrediction(alice.address, hostileGameId)
        ).to.not.be.reverted;
      });

      it("the victim's prediction on the LEGIT game still settles and pays", async function () {
        const { satori, rewards, realGameId, hostileGameId, alice, bob } = await runAttack(mode);
        // The attacker pokes the hostile game first, as they would.
        await satori.connect(bob).settlePrediction(alice.address, hostileGameId);

        const before = await rewards.unclaimedRewards(alice.address);
        await expect(
          satori.connect(bob).settlePrediction(alice.address, realGameId)
        ).to.not.be.reverted;
        expect(await rewards.unclaimedRewards(alice.address)).to.be.gt(before);
      });

      it("the victim can still predict in later rounds", async function () {
        const { satori, registry, realStream, realGameId, hostileGameId, alice, bob, owner } =
          await runAttack(mode);
        await satori.connect(bob).settlePrediction(alice.address, hostileGameId);
        await satori.connect(bob).settlePrediction(alice.address, realGameId);

        // Predicting requires the stream to have ticked THIS round
        // (PredictExpired), and realStream is cadence-2, so advance two rounds
        // and post a fresh value before betting again.
        await advanceRounds(2);
        await registry.connect(owner).setValue(realStream, 250);
        await expect(
          satori.connect(alice).predictMultipleWithPayloads([
            { gameId: realGameId, payload: pack1(YES) },
          ])
        ).to.not.be.reverted;
      });
    });
  }

  it("a hostile adapter that recovers can still be settled afterwards", async function () {
    const { satori, hostile, hostileGameId, alice, bob } = await runAttack(MODE_REVERT);
    // Jammed while hostile...
    await satori.connect(bob).settlePrediction(alice.address, hostileGameId);
    // ...and once it behaves, the pending bet is still there to settle.
    await hostile.setMode(MODE_OK);
    await expect(
      satori.connect(bob).settlePrediction(alice.address, hostileGameId)
    ).to.not.be.reverted;
  });
});
