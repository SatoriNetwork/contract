// Named streams: a stream that is just a name. Nobody sets its value — it is a
// per-game counter of capital-weighted predictions (UP adds the predictor's
// per-game power, DOWN subtracts), snapshotted into the ring on the first touch
// of each clock hour and scored on the ordinary 24h moment-anchored path with
// the predictor's own contribution added back to the anchor. Rewards on a
// named game are pari-mutuel (a side is paid from what the other side
// committed), and names are unique among named streams.
// Narrative: docs/narratives/A_named_streams.md.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, createNamedStream, onChainGrossNow, RAW_TOLERANCE, VOTE, pack1 } = require("./fixtures");

const HOUR = 3600;
const DAY = 24 * HOUR;
const UP = 1;
const DOWN = 2;
// The engine's `_effectiveRaw` truncation (PR_RAW_SHIFT = 40), applied AFTER
// the batch split — expected counter moves are `eff(power / N)`, never round.
const eff = (p) => (p >> 40n) << 40n;

describe("Named streams (prediction-flow counter, hourly snapshot, daily game)", function () {
  this.timeout(1200000); // the eviction test writes the 768-slot ring out
  let fix, satori, registry, games, rewards, engine, hub, lens, namedAdapter;
  let owner, alice, bob, carol, dave;

  beforeEach(async function () {
    fix = await deploySatoriFixture();
    ({ satori, registry, games, rewards, hub, lens, namedAdapter } = fix);
    owner = fix.owner;
    [alice, bob, carol, dave] = fix.signers.slice(1, 5);
    engine = await ethers.getContractAt("SatoriEngine", await satori.engine());

    // Alice burns VOTE (10) to make the game eligible, leaving 100 of power;
    // bob 50; carol 100 (she seeds the counter in the worked example); dave is
    // dust, below hub.farmingThreshold().
    await satori.transfer(alice.address, ethers.parseEther("110"));
    await satori.transfer(bob.address, ethers.parseEther("50"));
    await satori.transfer(carol.address, ethers.parseEther("100"));
    await satori.transfer(dave.address, ethers.parseEther("0.5"));
  });

  // Just past an hour boundary, so "one hour later" is unambiguous and the
  // first touch of the next hour is a fresh snapshot.
  async function alignToHour(extraHours = 1) {
    const now = await time.latest();
    await time.increaseTo(Math.floor(now / HOUR) * HOUR + extraHours * HOUR + 5);
  }

  async function namedStream(name = "Bitcoin", signer = alice) {
    const sid = await registry.nextStreamId();
    await (await createNamedStream(fix, name, signer)).wait();
    await alignToHour();
    return sid;
  }

  async function power(who) {
    return rewards.getPredictionPower(who.address);
  }

  async function predict(who, gid, dir) {
    return satori.connect(who).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(dir) }]);
  }

  async function hourNow() {
    return BigInt(Math.floor((await time.latest()) / HOUR));
  }

  // Straight through the hub (no fixture auto-approval), with one argument of
  // the canonical creation varied.
  async function rawCreate({ name = "X", provider, config = "0x", cadence = 60, signer = alice } = {}) {
    return hub.connect(signer)["createAdapterDataStream(string,uint16,address,bytes,uint24)"](
      name, fix.namedAdapterId, provider ?? (await engine.getAddress()), config, cadence);
  }

  // Pin the clock to `hourOfDay` (just past the hour) of the NEXT UTC day, so
  // a sequence of predictions lands in one known round.
  async function pinTomorrow(hourOfDay) {
    const now = await time.latest();
    await time.increaseTo(Math.floor(now / DAY) * DAY + DAY + hourOfDay * HOUR + 5);
  }

  // ---- 1. worked example --------------------------------------------------

  it("worked example: carol seeds 100, alice UP (100) then bob UP (50) → alice settles correct", async function () {
    const sid = await namedStream();
    const gid = await games.binaryGameByStream(sid);
    expect(await games.targetMinutes(gid)).to.equal(1440);
    await satori.connect(alice).vote(gid, VOTE);

    // h0: carol's pull writes the stream's first entry (0), then her flow lands.
    const c = eff(await power(carol));
    await predict(carol, gid, UP);
    expect(await engine.namedStreamValue(sid)).to.equal(c);

    // h1: alice. The first touch of h1 snapshots the counter BEFORE her flow.
    await time.increase(HOUR);
    const h1 = await hourNow();
    const a = eff(await power(alice));
    await predict(alice, gid, UP);
    expect(await registry.getValueAtHour(sid, h1)).to.equal(c);
    expect(await engine.namedStreamValue(sid)).to.equal(c + a);

    // h2: bob.
    await time.increase(HOUR);
    const b = eff(await power(bob));
    await predict(bob, gid, UP);
    expect(await engine.namedStreamValue(sid)).to.equal(c + a + b);

    // Every later hour's first touch writes the standing counter.
    for (let i = 0; i < 23; i++) {
      await time.increase(HOUR);
      await registry.updateValue(sid);
      expect(await registry.getValue(sid)).to.equal(c + a + b);
    }
    // anchor = c, anchor' = c + a, post = c + a + b > anchor' → UP correct.
    await expect(satori.settlePrediction(alice.address, gid))
      .to.emit(engine, "PredictionScored")
      .withArgs(alice.address, gid, h1 / 24n, true, 1, eff(a));
    expect(await satori.streaks(alice.address, gid)).to.equal(1);
  });

  it("lone predictor: post == adjusted anchor → void, streak unchanged (not a loss)", async function () {
    const sid = await namedStream();
    const gid = await games.binaryGameByStream(sid);
    await satori.connect(alice).vote(gid, VOTE);

    // Streak 1 first (bob follows alice), so "unchanged" is distinguishable
    // from a loss.
    await predict(alice, gid, UP);
    await time.increase(HOUR);
    await predict(bob, gid, UP);
    await time.increase(24 * HOUR);
    await registry.updateValue(sid);
    await satori.settlePrediction(alice.address, gid);
    expect(await satori.streaks(alice.address, gid)).to.equal(1);

    // Lone second prediction: nobody else moves the counter for 24h.
    await time.increase(HOUR);
    const h2 = await hourNow();
    const before = await engine.namedStreamValue(sid);
    const a = eff(await power(alice));
    await predict(alice, gid, UP);
    await time.increase(24 * HOUR);
    await registry.updateValue(sid); // post = before + a == anchor'
    // The void reports the ADJUSTED anchor.
    await expect(satori.settlePrediction(alice.address, gid))
      .to.emit(engine, "PredictionVoided")
      .withArgs(alice.address, gid, h2 / 24n, UP, before + a);
    expect(await satori.streaks(alice.address, gid)).to.equal(1);
    const pred = await satori.predictions(alice.address, gid, h2 / 24n);
    expect(pred.scored).to.equal(true);
  });

  // ---- 2. DOWN --------------------------------------------------------------

  it("DOWN subtracts, and a DOWN predictor wins when the net other flow is negative", async function () {
    const sid = await namedStream();
    const gid = await games.binaryGameByStream(sid);
    await satori.connect(alice).vote(gid, VOTE);

    const a = eff(await power(alice));
    await predict(alice, gid, DOWN);
    expect(await engine.namedStreamValue(sid)).to.equal(-a);

    await time.increase(HOUR);
    const b = eff(await power(bob));
    await predict(bob, gid, DOWN);
    expect(await engine.namedStreamValue(sid)).to.equal(-a - b);

    await time.increase(24 * HOUR);
    await registry.updateValue(sid);
    // anchor = 0, anchor' = 0 − a, post = −a − b < anchor' → DOWN correct.
    await satori.settlePrediction(alice.address, gid);
    expect(await satori.streaks(alice.address, gid)).to.equal(1);
    // Bob's own view: anchor = −a (h2 snapshot), anchor' = −a − b, post = −a − b → void.
    await time.increase(HOUR);
    await registry.updateValue(sid);
    await expect(satori.settlePrediction(bob.address, gid)).to.emit(engine, "PredictionVoided");
  });

  // ---- 3. same-hour ordering ---------------------------------------------

  it("a snapshot later in the predictor's hour is refused; the first toucher of an hour writes before predicting", async function () {
    const sid = await namedStream();
    const gid = await games.binaryGameByStream(sid);
    await satori.connect(alice).vote(gid, VOTE);

    const h = await hourNow();
    const a = eff(await power(alice));
    await predict(alice, gid, UP);
    const [count0] = await registry.getLatestUpdateInfo(sid);

    // Later in the same hour: the clock hour did not advance → no entry.
    await time.increase(20 * 60);
    await expect(registry.updateValue(sid)).to.be.revertedWithCustomError(registry, "CadenceGapNotElapsed");
    const [count1] = await registry.getLatestUpdateInfo(sid);
    expect(count1).to.equal(count0);
    expect(await registry.getValueAtHour(sid, h)).to.equal(0); // never alice's own flow
    expect(await engine.namedStreamValue(sid)).to.equal(a);

    // Bob is the first toucher of the next hour: his pull lands `a` BEFORE his
    // own flow is added, so the h+1 entry excludes him.
    await time.increase(HOUR);
    const b = eff(await power(bob));
    await predict(bob, gid, UP);
    expect(await registry.getValueAtHour(sid, h + 1n)).to.equal(a);
    expect(await engine.namedStreamValue(sid)).to.equal(a + b);
  });

  // ---- 4. own next prediction --------------------------------------------

  it("predicting again < 24h later (even in a new round) reverts DuplicatePrediction", async function () {
    const sid = await namedStream();
    const gid = await games.binaryGameByStream(sid);
    await satori.connect(alice).vote(gid, VOTE);

    // Pin to 23:00:05 so the second prediction at 00:30 is a NEW round yet
    // inside the first prediction's 24h window (the next day's, if the suite's
    // clock is already past today's).
    const now = await time.latest();
    const pin = Math.floor(now / DAY) * DAY + DAY - HOUR + 5;
    await time.increaseTo(pin > now ? pin : pin + DAY);
    await predict(alice, gid, UP);
    await time.increase(90 * 60);
    await expect(predict(alice, gid, UP)).to.be.revertedWithCustomError(engine, "DuplicatePrediction");
  });

  it("predicting at >= 24h pulls a post sample that excludes the new contribution (always-write)", async function () {
    const sid = await namedStream();
    const gid = await games.binaryGameByStream(sid);
    await satori.connect(alice).vote(gid, VOTE);

    const h1 = await hourNow();
    const a1 = eff(await power(alice));
    await predict(alice, gid, UP);

    // Nobody else touches the counter for 24h. Alice's own next prediction
    // pulls first: that pull must land the h1+24 entry (= a1, the previous
    // prediction's post sample) BEFORE her new flow is added.
    await time.increase(24 * HOUR);
    const a2 = eff(await power(alice));
    await predict(alice, gid, UP);
    expect(await registry.getValueAtHour(sid, h1 + 24n)).to.equal(a1);
    expect(await engine.namedStreamValue(sid)).to.equal(a1 + a2);
    // ...and the previous prediction settled as a void on that sample.
    const pred = await satori.predictions(alice.address, gid, h1 / 24n);
    expect(pred.scored).to.equal(true);
    expect(await satori.streaks(alice.address, gid)).to.equal(0);

    // A second pull in the same hour is refused: the hour's entry was the pull's.
    await expect(registry.updateValue(sid)).to.be.revertedWithCustomError(registry, "CadenceGapNotElapsed");
  });

  // ---- 5. batch split ----------------------------------------------------

  it("batch split: the counter moves by eff(power / N) when N games are predicted together", async function () {
    const sid = await namedStream();
    const gid = await games.binaryGameByStream(sid);
    // Two ordinary hourly streams alongside, both eligible.
    const others = [];
    for (const n of ["S1", "S2"]) {
      const osid = await registry.nextStreamId();
      await (await satori.connect(alice)["createSimpleDataStream(string,address,uint24)"](n, owner.address, 60)).wait();
      await registry.connect(owner).setValue(osid, 100);
      others.push(osid);
    }
    await satori.connect(alice).vote(gid, VOTE);
    for (const o of others) await satori.connect(alice).vote(o, VOTE);

    const p = await power(alice);
    await satori.connect(alice).predictMultipleWithPayloads([
      { gameId: gid, payload: pack1(UP) },
      { gameId: others[0], payload: pack1(UP) },
      { gameId: others[1], payload: pack1(DOWN) },
    ]);
    expect(await engine.namedStreamValue(sid)).to.equal(eff(p / 3n));
    expect(eff(p / 3n)).to.not.equal(p / 3n); // the truncation is real
  });

  it("a predictor below the farming floor still moves the counter and settles against anchor ± own", async function () {
    const sid = await namedStream();
    const gid = await games.binaryGameByStream(sid);
    await satori.connect(alice).vote(gid, VOTE);

    const d = eff(await power(dave));
    expect(d).to.be.gt(0n);
    expect(await power(dave)).to.be.lt(await hub.farmingThreshold());
    const h = await hourNow();
    await predict(dave, gid, UP);
    expect(await engine.namedStreamValue(sid)).to.equal(d);

    // Lone: post == anchor + own → void at the adjusted anchor, not a loss.
    await time.increase(24 * HOUR);
    await registry.updateValue(sid);
    await expect(satori.settlePrediction(dave.address, gid))
      .to.emit(engine, "PredictionVoided")
      .withArgs(dave.address, gid, h / 24n, UP, d);
  });

  // ---- 6. unapproved -----------------------------------------------------

  it("unapproved named game: the counter stays 0 and the prediction voids", async function () {
    const sid = await registry.nextStreamId();
    await rawCreate({ name: "Unapproved" });
    await alignToHour();
    const gid = await games.binaryGameByStream(sid);
    expect(await fix.voting.weightOf(gid)).to.equal(0);

    const h1 = await hourNow();
    await predict(alice, gid, UP);
    expect(await engine.namedStreamValue(sid)).to.equal(0);

    await time.increase(24 * HOUR);
    await registry.updateValue(sid);
    await expect(satori.settlePrediction(alice.address, gid))
      .to.emit(engine, "PredictionVoided")
      .withArgs(alice.address, gid, h1 / 24n, UP, 0);
  });

  // ---- 7. guards ---------------------------------------------------------

  describe("guards", function () {
    it("setValue on a named stream reverts", async function () {
      const sid = await namedStream();
      await expect(registry.connect(alice).setValue(sid, 1))
        .to.be.revertedWithCustomError(registry, "NotStreamProvider");
    });

    it("creation rejects a non-engine provider", async function () {
      await expect(rawCreate({ provider: alice.address }))
        .to.be.revertedWithCustomError(namedAdapter, "InvalidProvider");
    });

    it("the registry writes the config: a caller's config is refused, even the right id", async function () {
      const sid = await registry.nextStreamId();
      for (const id of [sid, sid + 1n]) {
        const config = ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [id]);
        await expect(rawCreate({ config }))
          .to.be.revertedWithCustomError(registry, "NamedStreamConfig");
      }
    });

    it("back-to-back creates need no id from the caller; each config names its own stream", async function () {
      const first = await registry.nextStreamId();
      await rawCreate({ name: "Bitcoin" });
      await rawCreate({ name: "Ether", signer: bob });
      const created = await registry.queryFilter(registry.filters.DataStreamCreated());
      for (const sid of [first, first + 1n]) {
        const log = created.find((l) => l.args.streamId === sid);
        expect(log.args.config).to.equal(ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [sid]));
        expect(await namedAdapter.readValue(await engine.getAddress(), log.args.config))
          .to.equal(await engine.namedStreamValue(sid));
      }
    });

    it("creation rejects any cadence other than 60", async function () {
      for (const cad of [120, 1440]) {
        await expect(rawCreate({ cadence: cad }))
          .to.be.revertedWithCustomError(registry, "InvalidCadence");
      }
    });

    it("a second named stream with the same name reverts NameTaken; a Simple stream may reuse it", async function () {
      await namedStream("Bitcoin");
      await expect(rawCreate({ name: "Bitcoin", signer: bob }))
        .to.be.revertedWithCustomError(registry, "NameTaken");
      expect(await registry.namedNameTaken(await fix.coined.idOf("Bitcoin"))).to.equal(true);
      // Case is a different Coined term.
      await namedStream("bitcoin", bob);
      await satori.connect(alice)["createSimpleDataStream(string,address,uint24)"]("Bitcoin", owner.address, 60);
    });

    it("a second game on a named stream is rejected", async function () {
      const sid = await namedStream();
      await expect(satori.connect(alice)["createGame(uint32,uint16,bytes,string,uint24)"](sid, 0, "0x", "weekly", 10080))
        .to.be.revertedWithCustomError(games, "NamedStreamSingleGame");
    });

    it("an adapter instance that is not the registry's wired named adapter refuses creation", async function () {
      const stray = await (await ethers.getContractFactory("NamedStreamAdapter"))
        .deploy(await engine.getAddress(), await registry.getAddress(), await fix.coined.getAddress());
      const sid = await registry.nextStreamId();
      const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [sid]);
      await expect(stray.validate(await engine.getAddress(), cfg))
        .to.be.revertedWithCustomError(stray, "NotWired");
      // The wired one accepts the same input.
      await namedAdapter.validate(await engine.getAddress(), cfg);
    });

    it("an adapter deployed without a Coined address refuses creation", async function () {
      const noCoined = await (await ethers.getContractFactory("NamedStreamAdapter"))
        .deploy(await engine.getAddress(), await registry.getAddress(), ethers.ZeroAddress);
      expect(await noCoined.coined()).to.equal(ethers.ZeroAddress);
      // A mismatched streamId would be StreamIdMismatch: NotWired proves the
      // Coined check comes first and is not the unwired-instance check.
      const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [(await registry.nextStreamId()) + 1n]);
      await expect(noCoined.validate(await engine.getAddress(), cfg))
        .to.be.revertedWithCustomError(noCoined, "NotWired");
      // The registry calls nameKey before validate, so this is the revert a
      // dapp user actually sees on an unwired chain.
      await expect(noCoined.nameKey("Bitcoin")).to.be.revertedWithCustomError(noCoined, "NotWired");
    });

    // Wiring and naming are logged so "is this stream named" is a fold over
    // events, never a registry read (docs/issues/events-are-the-read-model.md).
    it("setNamedAdapterId emits NamedAdapterSet", async function () {
      const [log] = await registry.queryFilter(registry.filters.NamedAdapterSet());
      expect(log.args.adapterId).to.equal(fix.namedAdapterId);
    });

    it("a named stream's creation emits its Coined nameKey", async function () {
      const sid = await registry.nextStreamId();
      const key = await namedAdapter.nameKey.staticCall("Bitcoin");
      await expect(createNamedStream(fix, "Bitcoin", alice))
        .to.emit(registry, "NamedStreamCreated").withArgs(sid, key)
        .and.to.emit(registry, "DataStreamCreated")
        .withArgs(sid, alice.address, await engine.getAddress(), fix.namedAdapterId, 60,
          ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [sid]), "Bitcoin");
    });

    it("setNamedAdapterId is one-shot and deployer-gated", async function () {
      await expect(registry.connect(alice).setNamedAdapterId(fix.namedAdapterId))
        .to.be.revertedWithCustomError(registry, "OnlyDeployer");
      await expect(registry.connect(owner).setNamedAdapterId(fix.namedAdapterId))
        .to.be.revertedWithCustomError(registry, "CoreAlreadyInitialized");
      expect(await registry.namedAdapterId()).to.equal(fix.namedAdapterId);
    });

    it("isNamedStream distinguishes named from ordinary streams", async function () {
      const sid = await namedStream();
      expect(await registry.isNamedStream(sid)).to.equal(true);
      expect(await registry.isNamedStream(1)).to.equal(false);
      const [cad, named] = await registry.streamScoringInfo(sid);
      expect(cad).to.equal(60);
      expect(named).to.equal(true);
    });

    it("isNamedStream is false for id 0 and ids not created yet", async function () {
      expect(await registry.isNamedStream(0)).to.equal(false);
      expect(await registry.isNamedStream(9999)).to.equal(false);
    });

    // The engine's predict reads the flag from getLatestUpdateInfo, the call it
    // already makes, instead of a separate isNamedStream call.
    it("the stream record and getLatestUpdateInfo carry the named flag", async function () {
      const sid = await namedStream();
      expect((await registry.streams(sid - 1n)).named).to.equal(true);
      expect((await registry.streams(0)).named).to.equal(false);
      expect((await registry.getLatestUpdateInfo(sid))[4]).to.equal(true);
      expect((await registry.getLatestUpdateInfo(1))[4]).to.equal(false);
      expect((await registry.getLatestUpdateInfo(9999))[4]).to.equal(false);
    });

    // A named stream's rules (hour grid, always-write, own-exclusion at settle,
    // pari-mutuel) must not move under a game already being played.
    it("named status is fixed at creation, whatever namedAdapterId later reads", async function () {
      const sid = await namedStream();
      const layout = require("../storage-layouts/SatoriRegistry.json");
      const entry = layout.find((e) => e.label === "namedAdapterId");
      const slot = ethers.toBeHex(BigInt(entry.slot), 32);
      const proxy = await registry.getAddress();
      const word = BigInt(await ethers.provider.getStorage(proxy, slot));
      const shift = BigInt(entry.offset * 8);
      const repointed = (word & ~(0xffffn << shift)) | (999n << shift);
      await ethers.provider.send("hardhat_setStorageAt", [proxy, slot, ethers.toBeHex(repointed, 32)]);
      expect(await registry.namedAdapterId()).to.equal(999n);
      expect(await registry.isNamedStream(sid)).to.equal(true);
      expect((await registry.streamScoringInfo(sid))[1]).to.equal(true);
    });

    it("a bounty cannot be funded on a named game", async function () {
      const sid = await namedStream();
      const gid = await games.binaryGameByStream(sid);
      const bounties = fix.bounties;
      await satori.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("1"));
      await expect(bounties.connect(alice).fundBounty(gid, await satori.getAddress(), ethers.parseEther("1"), ethers.parseEther("1")))
        .to.be.revertedWithCustomError(bounties, "NamedGame");
    });
  });

  // ---- names are Coined terms ---------------------------------------------

  describe("Coined names", function () {
    let coined;
    beforeEach(function () { coined = fix.coined; });

    // Coined's id rule, computed here independently of the mock.
    const idOf = (s) => {
      const b = ethers.toUtf8Bytes(s.trim());
      if (b.length <= 32) return ethers.zeroPadBytes(b, 32);
      return ethers.toBeHex(BigInt(ethers.keccak256(b)) & ((1n << 248n) - 1n), 32);
    };
    const coinedEvents = (receipt) => receipt.logs.filter((l) => l.address === coined.target);

    it("a name not on Coined is coined by creating the stream", async function () {
      const id = idOf("Bitcoin");
      expect(await coined.idOf("Bitcoin")).to.equal(id);
      expect(await coined.exists(id)).to.equal(false);
      const sid = await registry.nextStreamId();
      const receipt = await (await rawCreate({ name: "Bitcoin" })).wait();
      expect(await coined.exists(id)).to.equal(true);
      expect(coinedEvents(receipt)).to.have.length(1);
      expect(await registry.namedNameTaken(id)).to.equal(true);
      expect(await registry.isNamedStream(sid)).to.equal(true);
    });

    it("a name already on Coined creates the stream and coins nothing new", async function () {
      await coined.register("Ether");
      const receipt = await (await rawCreate({ name: "Ether" })).wait();
      expect(coinedEvents(receipt)).to.have.length(0);
      expect(await coined.exists(idOf("Ether"))).to.equal(true);
    });

    // Coined folds the padding into the id, so " Ether " would claim "Ether"
    // under a stored name that is not it.
    it("a padded name is refused, and coins nothing", async function () {
      for (const name of [" Ether", "Ether ", "\tEther", "Ether\n", "\rEther\r"]) {
        await expect(rawCreate({ name })).to.be.revertedWithCustomError(namedAdapter, "BadName");
      }
      expect(await coined.exists(idOf("Ether"))).to.equal(false);
      const sid = await registry.nextStreamId();
      await rawCreate({ name: "Ether" });
      expect((await registry.getDataStreamInfo(sid)).name).to.equal("Ether");
    });

    it("empty and control-character names revert with Coined's errors", async function () {
      for (const name of ["", "   ", "\n"]) {
        await expect(rawCreate({ name })).to.be.revertedWithCustomError(coined, "EmptyName");
      }
      for (const name of ["bit\u0001coin", "bit\u007fcoin"]) {
        await expect(rawCreate({ name })).to.be.revertedWithCustomError(coined, "BadName");
      }
      // Invisible code points (soft hyphen, zero-width space, word joiner, BOM)
      // make a second "bitcoin" nobody can see; Coined refuses them and so does
      // the mock, so the dapp's "invisible characters" copy is reachable locally.
      for (const name of ["bit\u00adcoin", "bit\u200bcoin", "bit\u2060coin", "\ufeffbitcoin"]) {
        await expect(rawCreate({ name })).to.be.revertedWithCustomError(coined, "BadName");
      }
      // Visible multi-byte text passes the decoder.
      expect(await coined.idOf("ビットコイン")).to.equal(idOf("ビットコイン"));
      expect(await registry.nextStreamId()).to.equal(2n);
    });

    // The mock carries Coined's rules (CoinedState._checkText at d2a101d), so
    // a name the real Coined refuses cannot pass here and fail on the chain.
    it("names Coined refuses since d2a101d revert here too", async function () {
      for (const name of ["free\u00a0speech", "bit\u0085coin", "bit\u2028coin", "bit\u3164coin", "bit\u2800coin"]) {
        await expect(rawCreate({ name })).to.be.revertedWithCustomError(coined, "BadName");
      }
      await expect(rawCreate({ name: "bitc\u043ein" })) // cyrillic о
        .to.be.revertedWithCustomError(coined, "MixedScript");
    });

    it("a name over 32 bytes is keyed by its hashed id, and is still unique", async function () {
      const long = "A".repeat(40);
      const id = idOf(long);
      expect(id.slice(0, 4)).to.equal("0x00");
      expect(await coined.idOf(long)).to.equal(id);
      await rawCreate({ name: long });
      expect(await coined.exists(id)).to.equal(true);
      expect(await registry.namedNameTaken(id)).to.equal(true);
      await expect(rawCreate({ name: long, signer: bob }))
        .to.be.revertedWithCustomError(registry, "NameTaken");
    });

    it("nameKey is the adapter's register call: Coined's reverts propagate unwrapped", async function () {
      expect(await namedAdapter.nameKey.staticCall("Bitcoin")).to.equal(idOf("Bitcoin"));
      await expect(namedAdapter.nameKey("")).to.be.revertedWithCustomError(coined, "EmptyName");
    });
  });

  // ---- pari-mutuel rewards ------------------------------------------------

  describe("pari-mutuel pool", function () {
    // Claimable is the reward net of the 5% referral skim (to marketing when
    // the earner has no referral); the skim added back is the gross reward.
    let marketing;
    beforeEach(async function () { marketing = await rewards.marketingFeeRecipient(); });
    async function paidTo(who, settle) {
      const m0 = await rewards.unclaimedRewards(marketing);
      await settle();
      const [claimable] = await lens.getTotalClaimableRewards(who.address);
      return claimable + (await rewards.unclaimedRewards(marketing)) - m0;
    }

    // Round R: bob DOWN at 21:00 (lands before alice's anchor), alice UP at
    // 22:00 with the same committed weight. Round R+1: carol UP at 01:00 is the
    // "rest of the network" leaning alice's way. Only the named game is
    // predicted in round R, so its pool P is the whole round budget. Bob's post
    // sample is the next day's 21:00 entry, alice's the 22:00 one.
    async function twoSided() {
      const sid = await namedStream();
      const gid = await games.binaryGameByStream(sid);
      await satori.connect(alice).vote(gid, VOTE);
      // Alice down to bob's 50, so the two sides commit the same weight and
      // carol's 100 outweighs either.
      await satori.connect(alice).transfer(owner.address, (await power(alice)) - (await power(bob)));
      const a = eff(await power(alice));
      expect(eff(await power(bob))).to.equal(a);

      await pinTomorrow(21);
      const P = await onChainGrossNow(satori);
      await predict(bob, gid, DOWN);
      await time.increase(HOUR);
      await predict(alice, gid, UP);
      expect(await engine.namedStreamValue(sid)).to.equal(0n);
      const round = await satori.getCurrentRound();
      expect(await lens.totalWeightByDirection(gid, round, UP)).to.equal(a);
      expect(await lens.totalWeightByDirection(gid, round, DOWN)).to.equal(a);

      await time.increase(3 * HOUR); // 01:00, next round
      await predict(carol, gid, UP);
      return { sid, gid, P, a };
    }

    it("(a) everyone UP: the win scores but pays nothing", async function () {
      const sid = await namedStream();
      const gid = await games.binaryGameByStream(sid);
      await satori.connect(alice).vote(gid, VOTE);
      await pinTomorrow(21);
      await predict(alice, gid, UP);
      await time.increase(HOUR);
      await predict(bob, gid, UP);
      await time.increase(24 * HOUR);
      await registry.updateValue(sid);
      const paid = await paidTo(alice, async () => {
        await expect(satori.settlePrediction(alice.address, gid)).to.emit(engine, "PredictionScored");
      });
      expect(paid).to.equal(0n);
      expect(await satori.streaks(alice.address, gid)).to.equal(1);
      expect((await lens.getTotalClaimableRewards(alice.address))[0]).to.equal(0n);
    });

    it("(b) alice UP wins against bob DOWN at equal committed weight → P / 2", async function () {
      const { sid, gid, P } = await twoSided();
      await time.increase(20 * HOUR + 5 * 60); // 21:05
      await registry.updateValue(sid);
      await time.increase(HOUR);               // 22:05
      await registry.updateValue(sid);
      const paidAlice = await paidTo(alice, async () => {
        await expect(satori.settlePrediction(alice.address, gid)).to.emit(engine, "PredictionScored");
      });
      expect(paidAlice).to.be.closeTo(P / 2n, RAW_TOLERANCE);
      const paidBob = await paidTo(bob, async () => {
        await expect(satori.settlePrediction(bob.address, gid)).to.emit(engine, "PredictionScored");
      });
      expect(paidBob).to.equal(0n);
      expect(await satori.streaks(bob.address, gid)).to.equal(0);
    });

    it("(c) a non-named game in the same fixture still pays its solo winner the whole pool", async function () {
      const sid = await registry.nextStreamId();
      await satori.connect(alice)["createSimpleDataStream(string,address,uint24)"]("S", owner.address, 1440);
      await registry.connect(owner).setValue(sid, 100);
      await satori.connect(alice).vote(sid, VOTE);
      await pinTomorrow(21);
      const P = await onChainGrossNow(satori);
      await predict(alice, sid, UP);
      await pinTomorrow(1);
      await registry.connect(owner).setValue(sid, 110);
      await pinTomorrow(1);
      await registry.connect(owner).setValue(sid, 120);
      const paid = await paidTo(alice, async () => {
        await expect(satori.settlePrediction(alice.address, sid)).to.emit(engine, "PredictionScored");
      });
      expect(paid).to.be.closeTo(P, RAW_TOLERANCE);
    });

    it("(d) conservation: both sides winning split exactly P between them", async function () {
      const { sid, gid, P, a } = await twoSided();
      // Next day: dave DOWN (d > b + c) drags the 21:00 sample under bob's
      // adjusted anchor; erin UP (e > d − c) lifts the 22:00 sample over alice's.
      const erin = fix.signers[5];
      await satori.transfer(dave.address, ethers.parseEther("160"));
      await satori.transfer(erin.address, ethers.parseEther("70"));
      await time.increase(19 * HOUR + 30 * 60); // 20:30
      await predict(dave, gid, DOWN);
      await time.increase(35 * 60);             // 21:05
      await registry.updateValue(sid);
      expect(await registry.getValue(sid)).to.be.lt(-a);
      await time.increase(25 * 60);             // 21:30
      await predict(erin, gid, UP);
      await time.increase(35 * 60);             // 22:05
      await registry.updateValue(sid);
      expect(await registry.getValue(sid)).to.be.gt(0n);
      const paidAlice = await paidTo(alice, () => satori.settlePrediction(alice.address, gid));
      const paidBob = await paidTo(bob, () => satori.settlePrediction(bob.address, gid));
      expect(await satori.streaks(alice.address, gid)).to.equal(1);
      expect(await satori.streaks(bob.address, gid)).to.equal(1);
      expect(paidAlice).to.be.closeTo(P / 2n, RAW_TOLERANCE);
      expect(paidBob).to.be.closeTo(P / 2n, RAW_TOLERANCE);
      expect(paidAlice + paidBob).to.be.lte(P);
      expect(paidAlice + paidBob).to.be.closeTo(P, RAW_TOLERANCE);
    });
  });

  // ---- 8. eviction -------------------------------------------------------

  it("ring eviction (768 hourly snapshots past the anchor) → PredictionUnrecoverable, streak 0", async function () {
    const sid = await namedStream();
    const gid = await games.binaryGameByStream(sid);
    await satori.connect(alice).vote(gid, VOTE);

    // Streak 1 first, so the reset is observable.
    await predict(alice, gid, UP);
    await time.increase(HOUR);
    await predict(bob, gid, UP);
    await time.increase(24 * HOUR);
    await registry.updateValue(sid);
    await satori.settlePrediction(alice.address, gid);
    expect(await satori.streaks(alice.address, gid)).to.equal(1);

    // Fresh prediction, then 769 hourly first-touch writes roll its anchor out.
    await time.increase(HOUR);
    await predict(alice, gid, UP);
    const r2 = await satori.getCurrentRound();
    for (let i = 0; i < 769; i++) {
      await time.increase(HOUR);
      await registry.updateValue(sid);
    }
    await expect(satori.connect(carol).settlePrediction(alice.address, gid))
      .to.emit(engine, "PredictionUnrecoverable");
    const pred = await satori.predictions(alice.address, gid, r2);
    expect(pred.scored).to.equal(true);
    expect(await satori.streaks(alice.address, gid)).to.equal(0);
  });

  // ---- no stream burn --------------------------------------------------------

  describe("no stream burn", function () {
    let token, hubAddr, fee;
    const NO_PERMIT = { value: 0n, deadline: 0n, signature: "0x" };

    beforeEach(async function () {
      token = fix.token;
      hubAddr = await hub.getAddress();
      fee = await satori.streamBurn();
      expect(fee).to.be.gt(0n);
      // The fixture pre-approves every signer for MaxUint256; a zero allowance
      // is what proves no transferFrom is attempted.
      await token.connect(alice).approve(hubAddr, 0);
    });

    it("a named stream is created with a ZERO allowance and no SATORI moves", async function () {
      const aliceBefore = await token.balanceOf(alice.address);
      const hubBefore = await token.balanceOf(hubAddr);
      const sid = await registry.nextStreamId();
      await rawCreate({ name: "Bitcoin" });
      expect(await registry.isNamedStream(sid)).to.equal(true);
      expect(await token.balanceOf(alice.address)).to.equal(aliceBefore);
      expect(await token.balanceOf(hubAddr)).to.equal(hubBefore);
    });

    it("the capability gate still applies, exactly as for a Simple stream", async function () {
      await rewards.connect(owner).setCapabilities(0);
      await expect(rawCreate({ name: "Bitcoin" }))
        .to.be.revertedWithCustomError(hub, "CapabilityDisabled");
      await expect(hub.connect(alice)["createSimpleDataStream(string,address,uint24)"]("X", alice.address, 60))
        .to.be.revertedWithCustomError(hub, "CapabilityDisabled");
    });

    it("a non-named adapter stream in the same fixture still charges exactly streamBurn()", async function () {
      await token.connect(alice).approve(hubAddr, fee);
      const aliceBefore = await token.balanceOf(alice.address);
      const hubBefore = await token.balanceOf(hubAddr);
      await hub.connect(alice)["createAdapterDataStream(string,uint16,address,bytes,uint24)"](
        "Feed", 3, bob.address, "0x", 1440);
      expect(await token.balanceOf(alice.address)).to.equal(aliceBefore - fee);
      expect(await token.balanceOf(hubAddr)).to.equal(hubBefore + fee);
    });

    it("the permit variant with the dapp's empty permit creates a named stream for free", async function () {
      const sid = await registry.nextStreamId();
      const aliceBefore = await token.balanceOf(alice.address);
      await hub.connect(alice).createAdapterDataStreamWithPermit(
        "Bitcoin", fix.namedAdapterId, await engine.getAddress(), "0x", 60, NO_PERMIT);
      expect(await registry.isNamedStream(sid)).to.equal(true);
      expect(await token.balanceOf(alice.address)).to.equal(aliceBefore);
      expect(await token.allowance(alice.address, hubAddr)).to.equal(0n);
    });
  });
});
