// A Coined-backed stream records Coined's price as the block opened (sweep item B5).
//
// Coined charges no fee, so a buy, a pull and a sell in one block cost about a
// wei. Reading the live price let anyone write any value that way; the adapter
// reads the supply the block opened with, which no trade in the block can move.
//
// Runs against Coined's real bytecode: its forge artifact in /code/coined, or
// COINED_ARTIFACT. Skips where neither exists, and fails if the artifact is
// older than Coined's sources beside it.
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySplitFixture } = require("../next/splitFixture");
const { checkCoined } = require("../../scripts/coined-probe");

const ARTIFACT = process.env.COINED_ARTIFACT
  || path.join(__dirname, "../../../../../coined/contracts/out/Coined.sol/Coined.json");
const HOUR = 3600;
const UP = 1;
const DOWN = 2;
const K = 500_000n;
const V = 1_000n * 10n ** 18n;
const E = (n) => ethers.parseEther(String(n));
const pack1 = (d) => ethers.hexlify(new Uint8Array([d]));
const cfg = (term) => ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [term]);
const TEXT = "bitcoin";

async function setup() {
  const art = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
  const fix = await deploySplitFixture();
  const { token, hub, voting, registry, games, owner, signers } = fix;
  const [attacker, honest, holder, seller] = signers.slice(5, 9);

  const coined = await new ethers.ContractFactory(art.abi, art.bytecode.object, owner).deploy();
  await coined.waitForDeployment();
  const term = await coined.idOf(TEXT);
  await (await coined.connect(holder).buy(TEXT, E(10), 0n, { value: E(10) })).wait();
  await (await coined.connect(seller).buy(TEXT, E(2), 0n, { value: E(2) })).wait();

  const adapter = await (await ethers.getContractFactory("CoinedAdapter")).deploy(await coined.getAddress());
  await adapter.waitForDeployment();
  const adapterId = await registry.nextAdapterId();
  await (await hub.connect(owner).registerAdapter(await adapter.getAddress(), "Coined price")).wait();
  const create = (provider, t) => hub.connect(owner)["createAdapterDataStream(string,uint32,address,bytes,uint24)"](
    `Coined: ${t}`, adapterId, provider, cfg(t), 60);
  const rc = await (await create(await coined.getAddress(), term)).wait();
  const sid = rc.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === "DataStreamCreated").args.streamId;
  const gid = await games.binaryGameByStream(sid);
  await (await voting.connect(owner).setGameApproved(gid, true)).wait();
  await (await hub.connect(owner).vote(gid, E(10))).wait();
  await (await registry.updateValue(sid)).wait();
  for (const u of [attacker, honest, holder]) await (await token.connect(owner).transfer(u.address, E(50))).wait();

  const baseline = await coined.priceOf(term);
  expect(await registry.getValue(sid)).to.equal(baseline);
  // A fresh hour, so the next pull is due.
  await time.increaseTo(Math.floor((await time.latest()) / HOUR) * HOUR + 2 * HOUR + 60);
  return { ...fix, attacker, honest, holder, seller, coined, term, adapter, sid, gid, baseline, create };
}

// Sends the txs into one block and returns their receipts. A tx left out of
// the block (e.g. over the block's gas) fails here rather than hanging wait().
async function oneBlock(sends) {
  await network.provider.send("evm_setAutomine", [false]);
  let txs;
  try {
    txs = [];
    for (const s of sends) txs.push(await s());
    await network.provider.send("evm_mine", []);
  } finally {
    await network.provider.send("evm_setAutomine", [true]);
  }
  const rcs = await Promise.all(txs.map((t) => ethers.provider.getTransactionReceipt(t.hash)));
  expect(rcs.every(Boolean), "every tx mined in the one block").to.equal(true);
  for (const r of rcs) expect(r.status).to.equal(1);
  expect(new Set(rcs.map((r) => r.blockNumber)).size).to.equal(1);
  return rcs;
}

const written = (rc, registry, sid) => rc.logs
  .map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
  .filter((p) => p && p.name === "StreamValueUpdated" && p.args[0] === sid)
  .map((p) => p.args[2]);

const predict = (engine, u, gid, dir, overrides = {}) =>
  engine.connect(u).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(dir) }], overrides);

async function nextNonce(u) {
  return ethers.provider.getTransactionCount(u.address, "latest");
}

describe("CoinedAdapter: the price as the block opened (B5)", function () {
  this.timeout(300000);

  before(function () {
    if (!fs.existsSync(ARTIFACT)) {
      console.log(`      skipped: no Coined artifact at ${ARTIFACT} (set COINED_ARTIFACT)`);
      this.skip();
    }
    // Forge records each source's keccak; where the sources sit beside the
    // artifact, they must still be the ones it was built from.
    const root = path.join(path.dirname(ARTIFACT), "../..");
    const { sources } = JSON.parse(fs.readFileSync(ARTIFACT, "utf8")).metadata;
    for (const [file, { keccak256 }] of Object.entries(sources)) {
      const src = path.join(root, file);
      if (fs.existsSync(src)) {
        expect(ethers.keccak256(fs.readFileSync(src)), `${file} changed since the artifact was built (forge build in ${root})`)
          .to.equal(keccak256);
      }
    }
  });

  it("a buy, predict DOWN and sell in one block writes nothing, and the honest UP wins", async function () {
    const { token, engine, hub, rewards, registry, attacker, honest, holder, coined, term, sid, gid, baseline } = await setup();
    const units = await coined.quoteBuy(term, E(100));
    const gas = { gasLimit: 5_000_000n };
    let n = await nextNonce(attacker);
    const [, rPredict] = await oneBlock([
      () => coined.connect(attacker).buy(TEXT, E(100), 0n, { value: E(100), nonce: n++, ...gas }),
      () => predict(engine, attacker, gid, DOWN, { nonce: n++, ...gas }),
      () => coined.connect(attacker).sell(term, units, 0n, { nonce: n++, ...gas }),
    ]);
    const attackTs = (await ethers.provider.getBlock(rPredict.blockNumber)).timestamp;
    expect(written(rPredict, registry, sid)).to.deep.equal([]);
    expect(await registry.getValue(sid)).to.equal(baseline);
    // The pull did run and found the value unchanged; this is not a cadence skip.
    expect((await registry.getLatestUpdateInfo(sid)).lastUpdateTimestamp).to.equal(BigInt(attackTs));

    await (await predict(engine, honest, gid, UP)).wait();

    // The market really rises over the window.
    await time.increaseTo(Math.floor(attackTs / HOUR) * HOUR + 24 * HOUR + 120);
    await (await coined.connect(holder).buy(TEXT, E(1), 0n, { value: E(1) })).wait();
    await (await registry.updateValue(sid)).wait();
    expect(await registry.getValue(sid)).to.be.gt(baseline);

    await (await engine.settlePrediction(attacker.address, gid)).wait();
    await (await engine.settlePrediction(honest.address, gid)).wait();
    expect(await engine.streaks(attacker.address, gid)).to.equal(0n);
    expect(await rewards.unclaimedRewards(attacker.address)).to.equal(0n);
    expect(await engine.streaks(honest.address, gid)).to.equal(1n);
    const owed = await rewards.unclaimedRewards(honest.address);
    expect(owed).to.be.gt(0n);
    const before = await token.balanceOf(honest.address);
    await (await hub.connect(honest)["claim()"]()).wait();
    expect((await token.balanceOf(honest.address)) - before).to.equal(owed);
  });

  it("a holder's sell, predict UP and buy back in one block writes nothing, and the honest DOWN wins", async function () {
    const { engine, rewards, registry, honest, holder, seller, coined, term, sid, gid, baseline } = await setup();
    const units = await coined.holdsOf(holder.address, term);
    const proceeds = await coined.quoteSell(term, units);
    const gas = { gasLimit: 5_000_000n };
    let n = await nextNonce(holder);
    const [, rPredict] = await oneBlock([
      () => coined.connect(holder).sell(term, units, 0n, { nonce: n++, ...gas }),
      () => predict(engine, holder, gid, UP, { nonce: n++, ...gas }),
      () => coined.connect(holder).buy(TEXT, proceeds, 0n, { value: proceeds, nonce: n++, ...gas }),
    ]);
    const dumpTs = (await ethers.provider.getBlock(rPredict.blockNumber)).timestamp;
    expect(written(rPredict, registry, sid)).to.deep.equal([]);
    expect(await registry.getValue(sid)).to.equal(baseline);
    expect((await registry.getLatestUpdateInfo(sid)).lastUpdateTimestamp).to.equal(BigInt(dumpTs));

    await (await predict(engine, honest, gid, DOWN)).wait();

    // The market really falls over the window.
    await time.increaseTo(Math.floor(dumpTs / HOUR) * HOUR + 24 * HOUR + 120);
    await (await coined.connect(seller).sell(term, await coined.holdsOf(seller.address, term), 0n)).wait();
    await (await registry.updateValue(sid)).wait();
    expect(await registry.getValue(sid)).to.be.lt(baseline);

    await (await engine.settlePrediction(holder.address, gid)).wait();
    await (await engine.settlePrediction(honest.address, gid)).wait();
    expect(await engine.streaks(holder.address, gid)).to.equal(0n);
    expect(await rewards.unclaimedRewards(holder.address)).to.equal(0n);
    expect(await engine.streaks(honest.address, gid)).to.equal(1n);
    expect(await rewards.unclaimedRewards(honest.address)).to.be.gt(0n);
  });

  it("matches Coined's priceOf in any block the term has not traded in, and reads only the pinned Coined", async function () {
    const { owner, signers, coined, term, adapter, create } = await setup();
    const coinedAddr = await coined.getAddress();
    expect(await adapter.coined()).to.equal(coinedAddr);
    const read = (t) => adapter.readValue(coinedAddr, cfg(t));

    const never = ethers.id("never coined");
    expect(await read(never)).to.equal(await coined.priceOf(never));
    expect(await read(never)).to.equal(V / K);

    const buyer = signers[9];
    for (const spend of ["0.001", "1", "10", "1000"]) {
      await (await coined.connect(buyer).buy(TEXT, E(spend), 0n, { value: E(spend) })).wait();
      await network.provider.send("evm_mine", []);
      expect(await read(term)).to.equal(await coined.priceOf(term));
    }

    expect(await coined.exists(ethers.ZeroHash)).to.equal(false);
    await expect(create(coinedAddr, ethers.ZeroHash)).to.be.revertedWithCustomError(adapter, "UnknownTerm");

    const art = JSON.parse(fs.readFileSync(ARTIFACT, "utf8"));
    const other = await new ethers.ContractFactory(art.abi, art.bytecode.object, owner).deploy();
    await (await other.connect(buyer).buy(TEXT, E(1), 0n, { value: E(1) })).wait();
    await expect(create(await other.getAddress(), term)).to.be.revertedWithCustomError(adapter, "InvalidProvider");
    await expect(adapter.readValue(await other.getAddress(), cfg(term)))
      .to.be.revertedWithCustomError(adapter, "InvalidProvider");
  });

  it("deploy.js's Coined check passes the real Coined and refuses one without openOf", async function () {
    const { coined } = await setup();
    await checkCoined(ethers.provider, await coined.getAddress());
    const mock = await (await ethers.getContractFactory("MockCoined")).deploy();
    let err;
    try { await checkCoined(ethers.provider, await mock.getAddress()); } catch (e) { err = e; }
    expect(err?.message ?? "").to.match(/does not answer openOf/);
  });

  it("a buy shows from the next block on, even when sold back in that block (B5's leftover)", async function () {
    const { attacker, registry, coined, term, sid, baseline } = await setup();
    await (await coined.connect(attacker).buy(TEXT, E(100), 0n, { value: E(100) })).wait();
    const pumpedUnits = await coined.unitsOf(term);
    const units = await coined.holdsOf(attacker.address, term);
    let n = await nextNonce(attacker);
    const [, rPull] = await oneBlock([
      () => coined.connect(attacker).sell(term, units, 0n, { nonce: n++, gasLimit: 5_000_000n }),
      () => registry.connect(attacker).updateValue(sid, { nonce: n++, gasLimit: 5_000_000n }),
    ]);
    expect(written(rPull, registry, sid)).to.deep.equal([(pumpedUnits + V) / K]);
    expect(await coined.priceOf(term)).to.equal(baseline);
  });
});
