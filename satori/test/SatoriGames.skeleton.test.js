// Phase 2 skeleton: SatoriGames game registry + game-adapter registry.
//
// Voting and eligibility are NOT yet on this contract (Phase 3). These tests
// verify the storage and dispatch surface: createGame validates inputs,
// registerGameAdapter binds an adapter, gamesByStream fan-out is populated,
// authority transfer and rename work, and onlyCore / onlyAuthority gates
// reject the right callers.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, impersonateAccount, setBalance } =
  require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

// Spin up a SatoriGames on top of an existing Satori deployment. The Satori
// contract address is what we impersonate to satisfy onlyCore.
async function deployGamesFixture() {
  const fix = await loadFixture(deploySatoriFixture);
  const { satori, registry, owner } = fix;

  const SatoriGames = await ethers.getContractFactory("SatoriGames");
  const games = await SatoriGames.deploy();
  await games.waitForDeployment();

  // Wire the core (Satori). After this the registry pointer is resolved off
  // the core (via core.satoriRegistry()).
  await games.setSatoriCore(await satori.getAddress());

  // Impersonate Satori so we can call onlyCore functions on SatoriGames.
  const satoriAddr = await satori.getAddress();
  await impersonateAccount(satoriAddr);
  await setBalance(satoriAddr, ethers.parseEther("10"));
  const satoriSigner = await ethers.getSigner(satoriAddr);

  // The base fixture doesn't initialize the default stream, so registry
  // The fixture already created the DEFAULT stream at id 1, so this one lands
  // at id 2. Create it via the normal Satori path so we have a known-good
  // streamId to point games at. 2880 minutes (two rounds) so ADAPTER games can
  // be attached below — SatoriGames rejects adapter games on every-round
  // (1440-minute) streams. (The value-provider cut argument is gone —
  // providers are not paid.)
  await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
    "TestStream", owner.address, 2880
  );
  const knownStreamId = 2;

  return { ...fix, games, satoriSigner, knownStreamId };
}

describe("SatoriGames — Phase 2 skeleton", function () {
  describe("Wiring", function () {
    it("constructor sets the deployer; setSatoriCore is one-shot", async function () {
      const { games, satori, signers } = await loadFixture(deployGamesFixture);
      // Already wired in the fixture.
      expect(await games.satoriCore()).to.equal(await satori.getAddress());

      // Second call from anyone reverts.
      const newSat = signers[1];
      await expect(games.connect(newSat).setSatoriCore(newSat.address))
        .to.be.revertedWithCustomError(games, "OnlyDeployer");
    });

    it("resolves satoriRegistry off the core after wiring", async function () {
      const { games, registry } = await loadFixture(deployGamesFixture);
      expect(await games.satoriRegistry()).to.equal(await registry.getAddress());
    });
  });

  describe("registerGameAdapter", function () {
    it("only the core can register an adapter", async function () {
      const { games, signers } = await loadFixture(deployGamesFixture);
      const stranger = signers[2];
      await expect(games.connect(stranger).registerGameAdapter(stranger.address, stranger.address, "x", true))
        .to.be.revertedWithCustomError(games, "OnlySatoriCore");
    });

    it("rejects zero impl address", async function () {
      const { games, satoriSigner } = await loadFixture(deployGamesFixture);
      await expect(games.connect(satoriSigner).registerGameAdapter(ethers.ZeroAddress, ethers.ZeroAddress, "x", true))
        .to.be.revertedWithCustomError(games, "InvalidGameAdapter");
    });

    it("community=true marks the adapter as community + emits event with the flag", async function () {
      const { games, satoriSigner, signers } = await loadFixture(deployGamesFixture);
      const impl = signers[5].address;
      await expect(games.connect(satoriSigner).registerGameAdapter(impl, signers[1].address, "YesNo", true))
        .to.emit(games, "GameAdapterRegistered")
        .withArgs(1, impl, signers[1].address, true, "YesNo");
      expect(await games.gameAdapter(1)).to.equal(impl);
      expect(await games.isCommunityGameAdapter(1)).to.equal(true);
      expect(await games.isRegisteredGameAdapter(impl)).to.equal(true);
      expect(await games.gameAdapterName(1)).to.equal("YesNo");
      expect(await games.nextGameTypeId()).to.equal(2);
    });

    it("community=false marks the adapter as official", async function () {
      const { games, satoriSigner, signers } = await loadFixture(deployGamesFixture);
      const impl = signers[5].address;
      await expect(games.connect(satoriSigner).registerGameAdapter(impl, signers[1].address, "Canonical", false))
        .to.emit(games, "GameAdapterRegistered")
        .withArgs(1, impl, signers[1].address, false, "Canonical");
      expect(await games.isCommunityGameAdapter(1)).to.equal(false);
      expect(await games.isRegisteredGameAdapter(impl)).to.equal(true);
    });

    it("monotonically increments — second register gets the next ID", async function () {
      const { games, satoriSigner, signers } = await loadFixture(deployGamesFixture);
      const impl1 = signers[5].address;
      const impl2 = signers[6].address;
      await games.connect(satoriSigner).registerGameAdapter(impl1, impl1, "A", true);
      await games.connect(satoriSigner).registerGameAdapter(impl2, impl2, "B", false);
      expect(await games.gameAdapter(1)).to.equal(impl1);
      expect(await games.gameAdapter(2)).to.equal(impl2);
      expect(await games.isCommunityGameAdapter(1)).to.equal(true);
      expect(await games.isCommunityGameAdapter(2)).to.equal(false);
    });
  });

  describe("createGame", function () {
    it("only the core can create a game", async function () {
      const { games, signers, knownStreamId } = await loadFixture(deployGamesFixture);
      const stranger = signers[1];
      await expect(
        games.connect(stranger).createGame(
          stranger.address,
          knownStreamId,
          0,           // built-in binary
          "0x",
          "should fail"
        )
      ).to.be.revertedWithCustomError(games, "OnlySatoriCore");
    });

    it("rejects zero authority", async function () {
      const { games, satoriSigner, knownStreamId } = await loadFixture(deployGamesFixture);
      await expect(
        games.connect(satoriSigner).createGame(
          ethers.ZeroAddress,
          knownStreamId,
          0,
          "0x",
          "no authority"
        )
      ).to.be.revertedWithCustomError(games, "InvalidAuthority");
    });

    it("rejects a non-existent data stream", async function () {
      const { games, satoriSigner, signers } = await loadFixture(deployGamesFixture);
      await expect(
        games.connect(satoriSigner).createGame(
          signers[1].address,
          999_999,    // way past streams.length
          0,
          "0x",
          "phantom stream"
        )
      ).to.be.revertedWithCustomError(games, "InvalidDataStream");
    });

    it("rejects unknown adapter for non-default game type", async function () {
      const { games, satoriSigner, signers, knownStreamId } = await loadFixture(deployGamesFixture);
      await expect(
        games.connect(satoriSigner).createGame(
          signers[1].address,
          knownStreamId,
          5,           // not registered
          "0x",
          "unknown adapter"
        )
      ).to.be.revertedWithCustomError(games, "UnknownGameAdapter");
    });

    it("creates a built-in binary game and emits the event", async function () {
      const { games, satoriSigner, signers, knownStreamId } = await loadFixture(deployGamesFixture);
      const author = signers[1].address;
      await expect(
        games.connect(satoriSigner).createGame(
          author,
          knownStreamId,
          0,           // built-in
          "0x",
          "BTC binary"
        )
      ).to.emit(games, "GameCreated")
       // The whole GameMeta: the 2880-minute stream's default target is its
       // cadence, resolved here so no gameMeta read is needed to know it.
       .withArgs(1, knownStreamId, author, 0, 2880, "BTC binary", "0x");

      expect(await games.gameCount()).to.equal(1);
      expect(await games.gameExists(1)).to.equal(true);
      const meta = await games.gameMeta(1);
      expect(meta.authority).to.equal(author);
      expect(meta.gameTypeId).to.equal(0);
      expect(meta.dataStreamId).to.equal(knownStreamId);
      expect(meta.name).to.equal("BTC binary");
    });

    // Two games on one stream must both land in gamesByStream's fan-out list.
    // The stream allows exactly ONE type-0 binary game (g1); the SECOND game on
    // the same stream must be an ADAPTER (gameTypeId >= 1), so g2 is a YesNoGame
    // (type-1) game. The fan-out property (both gameIds in creation order) is
    // independent of game type — that's exactly what this still pins.
    it("populates gamesByStream so the producer fan-out can find it", async function () {
      const { games, satoriSigner, signers, knownStreamId } = await loadFixture(deployGamesFixture);

      // g1 — the stream's single built-in binary game.
      const g1 = await games.connect(satoriSigner).createGame.staticCall(
        signers[1].address, knownStreamId, 0, "0x", "g1"
      );
      await games.connect(satoriSigner).createGame(signers[1].address, knownStreamId, 0, "0x", "g1");

      // Register a YesNoGame adapter on this bare games contract (onlyCore path,
      // via the impersonated core). createGame(type-1) calls the adapter's
      // validateForStream, so impl must be the real YesNoGame contract.
      const YesNoGame = await ethers.getContractFactory("YesNoGame");
      const yesNo = await YesNoGame.deploy(
        await games.satoriCore(),
        await games.getAddress(),
        await games.satoriRegistry());
      await yesNo.waitForDeployment();
      const adapterTx = await games.connect(satoriSigner).registerGameAdapter(
        await yesNo.getAddress(), signers[2].address, "Yes/No", true
      );
      await adapterTx.wait();
      const adapterTypeId = Number(await games.nextGameTypeId()) - 1;

      // YesNoGame.validateForStream requires a 32-byte int128 threshold config.
      const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["int128"], [0]);

      // g2 — a SECOND game on the SAME stream, this time an adapter game.
      const g2 = await games.connect(satoriSigner).createGame.staticCall(
        signers[2].address, knownStreamId, adapterTypeId, cfg, "g2"
      );
      await expect(games.connect(satoriSigner).createGame(signers[2].address, knownStreamId, adapterTypeId, cfg, "g2"))
        .to.emit(games, "GameCreated")
        .withArgs(2, knownStreamId, signers[2].address, adapterTypeId, 2880, "g2", cfg);

      expect(g1).to.equal(1);
      expect(g2).to.equal(2);
      expect(await games.gamesByStreamCount(knownStreamId)).to.equal(2);
      const list = await games.gamesByStream(knownStreamId);
      expect(list.map(Number)).to.deep.equal([1, 2]);
    });

    it("gamesByStream is empty for a stream with no games", async function () {
      const { games } = await loadFixture(deployGamesFixture);
      expect(await games.gamesByStreamCount(99)).to.equal(0);
      const list = await games.gamesByStream(99);
      expect(list.length).to.equal(0);
    });
  });

  describe("Authority paths", function () {
    async function makeGame() {
      const fix = await loadFixture(deployGamesFixture);
      const { games, satoriSigner, signers, knownStreamId } = fix;
      const author = signers[3];
      await games.connect(satoriSigner).createGame(
        author.address, knownStreamId, 0, "0x", "authority-test"
      );
      return { ...fix, author };
    }

    it("only the authority can rename", async function () {
      const { games, signers, author } = await makeGame();
      const stranger = signers[1];
      await expect(games.connect(stranger).setGameName(1, "hacked"))
        .to.be.revertedWithCustomError(games, "NotGameAuthority");
      await expect(games.connect(author).setGameName(1, "renamed"))
        .to.emit(games, "GameNameUpdated")
        .withArgs(1, "renamed");
      const meta = await games.gameMeta(1);
      expect(meta.name).to.equal("renamed");
    });

    it("authority can transfer to a non-zero address", async function () {
      const { games, signers, author } = await makeGame();
      const newAuth = signers[4];
      await expect(games.connect(author).setGameAuthority(1, newAuth.address))
        .to.emit(games, "GameAuthorityTransferred")
        .withArgs(1, author.address, newAuth.address);
      const meta = await games.gameMeta(1);
      expect(meta.authority).to.equal(newAuth.address);
      // Old authority loses rights
      await expect(games.connect(author).setGameName(1, "x"))
        .to.be.revertedWithCustomError(games, "NotGameAuthority");
    });

    it("authority transfer rejects zero address", async function () {
      const { games, author } = await makeGame();
      await expect(games.connect(author).setGameAuthority(1, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(games, "InvalidAuthority");
    });
  });

  describe("Views", function () {
    it("gameMeta reverts on invalid IDs", async function () {
      const { games } = await loadFixture(deployGamesFixture);
      await expect(games.gameMeta(0)).to.be.revertedWithCustomError(games, "InvalidGameId");
      await expect(games.gameMeta(1)).to.be.revertedWithCustomError(games, "InvalidGameId");
    });

    it("dataStreamId reverts on invalid IDs", async function () {
      const { games } = await loadFixture(deployGamesFixture);
      await expect(games.dataStreamId(0)).to.be.revertedWithCustomError(games, "InvalidGameId");
    });

    it("gameAdapterAddress returns 0 for type 0 and unregistered types", async function () {
      const { games } = await loadFixture(deployGamesFixture);
      expect(await games.gameAdapterAddress(0)).to.equal(ethers.ZeroAddress);
      expect(await games.gameAdapterAddress(42)).to.equal(ethers.ZeroAddress);
    });
  });
});
