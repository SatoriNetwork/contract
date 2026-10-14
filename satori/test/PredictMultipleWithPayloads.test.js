const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  time, impersonateAccount, setBalance,
} = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const ROUND = 86400;
const UP = 1;
const DOWN = 2;
const YES = 1;
const NO = 2;

async function getStreamIdFromTx(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch {}
  }
  throw new Error("DataStreamCreated event missing");
}

async function getGameIdFromTx(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = games.interface.parseLog(log);
      if (p && p.name === "GameCreated") return Number(p.args.gameId);
    } catch {}
  }
  throw new Error("GameCreated event missing");
}

async function advanceToNextRound() {
  const now = await time.latest();
  const nextBoundary = Math.floor(now / ROUND) * ROUND + ROUND;
  await time.increaseTo(nextBoundary + 1);
}

// Pack a direction byte followed by an ABI-encoded extra value, demonstrating
// the rich-payload format adapters can interpret.
function packWithExtra(direction, extraType, extraValue) {
  const tail = ethers.AbiCoder.defaultAbiCoder()
    .encode([extraType], [extraValue]);
  return ethers.concat([new Uint8Array([direction]), tail]);
}

describe("predictMultipleWithPayloads", function () {
  let satori, engine, voting, rewards, registry, games, bounties, yesNo;
  let owner, alice, bob;
  let stream1, stream2, stream3;
  let yesNoGameId;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, voting, rewards, registry, games, bounties } = fix);
    engine = fix.engine;
    [owner, alice, bob] = fix.signers;

    // The adapter game's "core" (caller of record/score) is the ENGINE in the
    // split stack; the games registry authorizes the HUB (satori.getAddress()).
    const satoriAddr = await satori.getAddress();
    const engineAddr = await engine.getAddress();

    // Three type-0 binary streams. stream1 is created at 2880 minutes (two
    // rounds) because it also hosts an adapter game below — SatoriGames
    // rejects adapter games on every-round (1440-minute) streams.
    stream1 = await getStreamIdFromTx(
      await satori["createSimpleDataStream(string,address,uint24)"](
        "S1", owner.address, 2880), satori
    );
    stream2 = await getStreamIdFromTx(
      await satori.createSimpleDataStream("S2", owner.address), satori
    );
    stream3 = await getStreamIdFromTx(
      await satori.createSimpleDataStream("S3", owner.address), satori
    );

    // Register the YesNoGame adapter at game type 1, then create a game on
    // stream1. The mixed-batch test predicts on this game's id alongside
    // type-0 binary games (stream2, stream3).
    const YesNoGame = await ethers.getContractFactory("YesNoGame");
    yesNo = await YesNoGame.deploy(
      engineAddr,
      await games.getAddress(),
      await registry.getAddress());
    await yesNo.waitForDeployment();

    await impersonateAccount(satoriAddr);
    await setBalance(satoriAddr, ethers.parseEther("10"));
    const coreSigner = await ethers.getSigner(satoriAddr);
    await games.connect(coreSigner).registerGameAdapter(
      await yesNo.getAddress(), owner.address, "YesNo", false
    );

    const threshold = 150;
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(
      ["int128"], [threshold]
    );
    yesNoGameId = await getGameIdFromTx(
      await satori.connect(owner).createGame(stream1, 1, cfg, "S1-yesno"),
      games
    );

    // Fund alice and bob, vote streams eligible.
    const initialMint = await satori.INITIAL_MINT();
    const perActor = initialMint / 8n;
    await satori.transfer(alice.address, perActor);
    await satori.transfer(bob.address, perActor);

    const sigs = await ethers.getSigners();
    for (let i = 3; i <= 7; i++) {
      await satori.transfer(sigs[i].address, perActor);
    }
    // Only the three binary stream games get burnt weight. `yesNoGameId` is an
    // adapter game (type 1) and adapter games are not mint-eligible, so voting
    // for one reverts GameNotMintEligible — and nothing here needs it: this
    // suite is about the batch-predict payload plumbing, not about rewards.
    await voteFor(satori, sigs[3], stream1);
    await voteFor(satori, sigs[4], stream2);
    await voteFor(satori, sigs[5], stream3);
    await voteFor(satori, sigs[7], stream1);

    await advanceToNextRound();

    // Set fresh values so the round-aligned predict window matches.
    await registry.setValue(stream1, 100);
    await registry.setValue(stream2, 200);
    await registry.setValue(stream3, 300);
  });

  it("reverts EmptyBatch on empty input", async function () {
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([])
    ).to.be.revertedWithCustomError(satori, "EmptyBatch");
  });

  it("reverts BadDirection on an empty payload entry", async function () {
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: "0x" },
      ])
    ).to.be.revertedWithCustomError(satori, "BadDirection");
  });

  it("reverts DuplicatePrediction on duplicate gameId in batch", async function () {
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream1, payload: pack1(DOWN) },
      ])
    ).to.be.revertedWithCustomError(satori, "DuplicatePrediction");
  });

  it("all-type-0 batch with 1-byte payloads behaves like predictMultiple", async function () {
    const round = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: stream1, payload: pack1(UP) },
      { gameId: stream2, payload: pack1(DOWN) },
      { gameId: stream3, payload: pack1(UP) },
    ]);

    const p1 = await satori.predictions(alice.address, stream1, round);
    const p2 = await satori.predictions(alice.address, stream2, round);
    const p3 = await satori.predictions(alice.address, stream3, round);
    expect(p1.direction).to.equal(UP);
    expect(p2.direction).to.equal(DOWN);
    expect(p3.direction).to.equal(UP);
  });

  it("all-type-0 batch with multi-byte payloads ignores trailing bytes", async function () {
    // Type-0 binary games consume only payload[0]. Trailing bytes are
    // adapter-defined and irrelevant to the inline binary path — the
    // prediction record should land identically to the 1-byte case.
    const round = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: stream1, payload: packWithExtra(UP, "uint256", 999n) },
      { gameId: stream2, payload: packWithExtra(DOWN, "address", alice.address) },
    ]);

    const p1 = await satori.predictions(alice.address, stream1, round);
    const p2 = await satori.predictions(alice.address, stream2, round);
    expect(p1.direction).to.equal(UP);
    expect(p2.direction).to.equal(DOWN);
  });

  it("mixed type-0 + type-1+ batch records both kinds correctly", async function () {
    const round = await satori.getCurrentRound();
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: stream2, payload: pack1(UP) },          // type-0
      { gameId: yesNoGameId, payload: pack1(YES) },     // type-1+ (adapter)
      { gameId: stream3, payload: pack1(DOWN) },        // type-0
    ]);

    // Binary side: prediction records on stream2 and stream3 reflect the
    // chosen directions, written via the inline binary path.
    const p2 = await satori.predictions(alice.address, stream2, round);
    const p3 = await satori.predictions(alice.address, stream3, round);
    expect(p2.direction).to.equal(UP);
    expect(p3.direction).to.equal(DOWN);
    // The two type-0 games are the only mint-ELIGIBLE entries in the batch, so
    // they split alice's power evenly between the two of them — the adapter
    // game (which can hold no voting weight) takes no share of it.
    expect(p2.eligible).to.equal(true);
    expect(p3.eligible).to.equal(true);
    expect(p2.rawPredictionPower).to.be.gt(0n);
    expect(p2.rawPredictionPower).to.equal(p3.rawPredictionPower);

    // Adapter side: under the score/total model the protocol stores NO bucket
    // or weight — the adapter (YesNoGame) owns its per-bet state. Confirm the
    // adapter remembered alice's YES bet for this round. (No `adapterUserRecord`
    // /`adapterBucketWeight` getters exist anymore; these are the adapter's own
    // public mappings.)
    expect(await yesNo.pendingDir(yesNoGameId, alice.address)).to.equal(YES);
    expect(await yesNo.pendingRound(yesNoGameId, alice.address)).to.equal(round);

    // The adapter is handed alice's REAL undivided prediction power — not the
    // apportioned SATORI weight, and not a dead zero. Adapter games earn nothing
    // from the mint, but that belongs in the payout rather than in the
    // information the adapter gets. Note it is NOT divided by the two eligible
    // games in this batch: the split apportions SATORI, and there is none here.
    const alicePower = await rewards.getPredictionPower(alice.address);
    expect(alicePower).to.be.gt(0n);
    expect(await yesNo.pendingWeight(yesNoGameId, alice.address)).to.equal(alicePower);
    expect(await yesNo.dirWeight(yesNoGameId, round, YES)).to.equal(alicePower);

    // Behavioral confirmation: the bet is genuinely pending and not yet
    // scored — settling before the resolving stream value is a no-op (the
    // adapter returns scored=false), so no reward is credited yet.
    const ucBefore = await rewards.unclaimedRewards(alice.address);
    await satori.settlePrediction(alice.address, yesNoGameId);
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(ucBefore);
    // And the adapter's pending state survives the premature settle.
    expect(await yesNo.pendingDir(yesNoGameId, alice.address)).to.equal(YES);
  });

  it("respects the one-batch-per-round lock vs predictMultiple", async function () {
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: stream1, payload: pack1(UP) },
    ]);
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream2, payload: pack1(UP) },
      ])
    ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
  });

  it("respects the one-batch-per-round lock vs itself", async function () {
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: stream1, payload: pack1(UP) },
    ]);
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream2, payload: pack1(UP) },
      ])
    ).to.be.revertedWithCustomError(satori, "AlreadyPredicted");
  });

  it("emits MultiplePredictionsMade with the batch length", async function () {
    const round = await satori.getCurrentRound();
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
        { gameId: stream2, payload: pack1(DOWN) },
      ])
    )
      .to.emit(engine, "MultiplePredictionsMade")
      .withArgs(alice.address, round, 2);
  });
});
