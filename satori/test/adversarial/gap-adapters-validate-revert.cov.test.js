// Closes IMPORTANT gap (Adapters & games):
//   "createGame propagating a validateForStream REVERT — YesNoGame.validateForStream
//    reverting InvalidConfig on a wrong-length config (33 bytes, 64 bytes, or empty),
//    aborting the whole createGame and rolling back the spam fee."
//
// validateForStream is the ONLY adapter-trust boundary at game-create time
// (SatoriGames.sol calls IPredictionGame(impl).validateForStream(...) inside
// createGame, and the revert surfaces to the user). On an immutable launch a
// community adapter that mis-validates, or a frontend that passes a malformed
// threshold blob, MUST fail-closed at create time — otherwise the game would be
// created with a config the adapter can't decode and the abi.decode in
// _ensureConfig would later revert inside score(), bricking settle.
//
// The grep over the entire test tree proves InvalidConfig is asserted NOWHERE,
// and createGame is never exercised with a bad config (the YesNoGame.e2e "frozen
// config" test only COMMENTS that a bad config would revert).
//
// This test:
//   1. Drives Satori.createGame(streamId, 1 /*YesNo*/, badCfg, ...) through the
//      full real path (fee charge in Satori.createGame -> SatoriGames.createGame
//      -> IPredictionGame.validateForStream) with badCfg = empty (0 bytes),
//      33 bytes, and 64 bytes; asserts each reverts InvalidConfig on the adapter.
//   2. Snapshots the caller's SATORI balance and the contract's SATORI balance
//      before/after a reverting create; asserts the spam fee was fully rolled
//      back (caller balance unchanged, contract balance unchanged, no game added)
//      — proving the fee charge (Satori.sol (pre-split)) is atomic with the
//      validateForStream failure.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../fixtures");

async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = games.interface.parseLog(log);
      if (p && p.name === "GameCreated") return Number(p.args.gameId);
    } catch (e) {}
  }
  throw new Error("GameCreated event missing");
}

describe("gap adapters — createGame propagates validateForStream InvalidConfig (fee atomic)", function () {
  this.timeout(120000);

  async function deployWithYesNo() {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, rewards, registry, games, owner } = fix;

    // Deploy + register the YesNoGame adapter at gameTypeId = 1.
    const YesNoGame = await ethers.getContractFactory("YesNoGame");
    const yesNo = await YesNoGame.deploy(
      await satori.getAddress(),
      await games.getAddress(),
      await registry.getAddress());
    await yesNo.waitForDeployment();

    const satoriAddr = await satori.getAddress();
    await impersonateAccount(satoriAddr);
    await setBalance(satoriAddr, ethers.parseEther("10"));
    const coreSigner = await ethers.getSigner(satoriAddr);
    await games.connect(coreSigner).registerGameAdapter(
      await yesNo.getAddress(), owner.address, "YesNo", false
    );

    // A real stream for the game to point at. A 2880-minute (two-round) cadence
    // is required: adapter games (gameTypeId > 0) revert GameCadenceTooShort on
    // any finer stream. The fixture calls initializeDefaultStream(), so the
    // default stream holds id 1 and this one is id 2 — read it back rather than
    // hardcoding, or the adapter would be pointed at the default stream.
    await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
      "BTC-Test", owner.address, 2880
    );
    const streamId = Number(await registry.getDataStreamCount());

    return { ...fix, yesNo, streamId };
  }

  // Sanity baseline: with a VALID 32-byte int128 config, createGame succeeds and
  // charges the spam fee (proves the bad-config cases below are exercising the
  // SAME path the happy case does, not failing for an unrelated reason).
  it("baseline: a valid 32-byte int128 config creates the game and charges the spam fee", async function () {
    const { satori, games, yesNo, streamId, owner } = await loadFixture(deployWithYesNo);

    const fee = await satori.gameBurn();
    expect(fee).to.be.gt(0); // game fee is non-zero at this point — rollback assertions below are meaningful.

    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [150]);
    const gamesBefore = await games.gameCount();
    const ownerBefore = await satori.balanceOf(owner.address);
    const contractBefore = await satori.balanceOf(await satori.getAddress());

    const tx = await satori.connect(owner).createGame(streamId, 1, cfg, "BTC-yesno");
    const gameId = await gameIdFrom(tx, games);

    expect(gameId).to.be.greaterThan(0);
    expect(await games.gameCount()).to.equal(gamesBefore + 1n);
    // Fee moved from caller to the contract.
    expect(await satori.balanceOf(owner.address)).to.equal(ownerBefore - fee);
    expect(await satori.balanceOf(await satori.getAddress())).to.equal(contractBefore + fee);
  });

  for (const [label, makeCfg] of [
    ["empty (0 bytes)", () => "0x"],
    ["33 bytes (one extra byte)", () => "0x" + "00".repeat(33)],
    ["64 bytes (two int128 words)",
      () => ethers.AbiCoder.defaultAbiCoder().encode(["int128", "int128"], [150, 0])],
  ]) {
    it(`reverts InvalidConfig through Satori.createGame for a ${label} config`, async function () {
      const { satori, yesNo, streamId, owner } = await loadFixture(deployWithYesNo);
      const cfg = makeCfg();
      await expect(
        satori.connect(owner).createGame(streamId, 1, cfg, "bad")
      ).to.be.revertedWithCustomError(yesNo, "InvalidConfig");
    });
  }

  it("the spam fee is fully rolled back when validateForStream reverts (charge is atomic)", async function () {
    const { satori, games, streamId, owner } = await loadFixture(deployWithYesNo);

    const fee = await satori.gameBurn();
    expect(fee).to.be.gt(0);

    const ownerBefore = await satori.balanceOf(owner.address);
    const contractBefore = await satori.balanceOf(await satori.getAddress());
    const totalSupplyBefore = await satori.totalSupply();
    const gamesBefore = await games.gameCount();

    // Empty config -> YesNoGame.validateForStream reverts InvalidConfig AFTER the
    // fee was _transfer'd in Satori.createGame. The whole tx must roll back.
    await expect(
      satori.connect(owner).createGame(streamId, 1, "0x", "bad")
    ).to.be.reverted;

    // Caller balance unchanged: the fee transfer was undone with the revert.
    expect(await satori.balanceOf(owner.address)).to.equal(ownerBefore);
    // Contract balance unchanged: it never kept the fee.
    expect(await satori.balanceOf(await satori.getAddress())).to.equal(contractBefore);
    // Supply unchanged (no mint/burn side effect).
    expect(await satori.totalSupply()).to.equal(totalSupplyBefore);
    // No game was added.
    expect(await games.gameCount()).to.equal(gamesBefore);
  });

  // The valid case still works AFTER a reverting attempt — i.e. the failed
  // create left no partial / poisoned state (no orphan gameId, fee re-charged
  // cleanly on the subsequent good create).
  it("a reverting bad-config create leaves no partial state; the next valid create still works", async function () {
    const { satori, games, yesNo, streamId, owner } = await loadFixture(deployWithYesNo);

    await expect(
      satori.connect(owner).createGame(streamId, 1, "0x", "bad")
    ).to.be.revertedWithCustomError(yesNo, "InvalidConfig");

    // Same path, valid config now succeeds.
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [150]);
    const tx = await satori.connect(owner).createGame(streamId, 1, cfg, "BTC-yesno");
    const gameId = await gameIdFrom(tx, games);
    expect(gameId).to.be.greaterThan(0);
    const meta = await games.gameMeta(gameId);
    expect(meta.gameTypeId).to.equal(1);
    expect(meta.dataStreamId).to.equal(streamId);
  });
});
