// Generates STREAM REGISTRY activity for satori-indexer development: two
// simple streams and one named stream, a series of observations, plus a rename
// and a provider handover. Between them these emit every registry event the
// indexer consumes except NamedAdapterSet, which deploy.js already fired:
// DataStreamCreated, NamedStreamCreated, StreamValueUpdated, NameUpdated,
// ProviderChanged.
//
// Separate from dev-activity.js on purpose. That script exercises the
// prediction/bounty/referral surface, which needs the voting capability
// enabled, and it should not become a prerequisite for testing stream
// indexing — the two are independent and the stream half must stay runnable
// against a bare deploy.
//
//   npx hardhat node
//   npx hardhat run scripts/deploy.js      --network localhost
//   npx hardhat run scripts/dev-streams.js --network localhost
const hre = require("hardhat");
const fs = require("fs");
const { ethers } = hre;

const ROUND = 86400;
async function nextRound() {
  const b = await ethers.provider.getBlock("latest");
  const t = b.timestamp;
  await ethers.provider.send("evm_setNextBlockTimestamp", [t - (t % ROUND) + ROUND + 5]);
  await ethers.provider.send("evm_mine", []);
}

async function createStream(hub, registry, name, provider) {
  const rc = await (await hub["createSimpleDataStream(string,address)"](name, provider)).wait();
  for (const log of rc.logs) {
    try {
      const p = registry.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch { /* not a registry log */ }
  }
  throw new Error(`no DataStreamCreated for "${name}"`);
}

async function main() {
  const book = JSON.parse(
    fs.readFileSync(__dirname + "/../deployments/localhost.json", "utf8")
  ).addresses;
  const [deployer, alice] = await ethers.getSigners();

  const hub = await ethers.getContractAt("SatoriHub", book.hub);
  const registry = await ethers.getContractAt("SatoriRegistry", book.registry);

  // Two streams so the /streams list has to actually group by id.
  const a = await createStream(hub, registry, "BTC-USD", deployer.address);
  const b = await createStream(hub, registry, "ETH-USD", deployer.address);
  console.log("created streams", a, b);

  // A named stream too (the deployer is the rewards admin, so the createStream
  // capability gate does not apply): its config is its own id, its provider
  // the engine, cadence exactly 60. Emits NamedStreamCreated beside
  // DataStreamCreated, which is what /streams folds `named` and `nameKey` from.
  const namedId = Number(await registry.namedAdapterId());
  if (namedId !== 0) {
    const sid = await registry.nextStreamId();
    const cfg = ethers.AbiCoder.defaultAbiCoder().encode(["uint32"], [sid]);
    await (await hub["createAdapterDataStream(string,uint16,address,bytes,uint24)"](
      "Bitcoin", namedId, book.engine, cfg, 60)).wait();
    console.log("created named stream", Number(sid));
  }

  // CADENCE. The two-argument `createSimpleDataStream` defaults to
  // minCadenceMinutes = 1440 — one 24h round (the no-cadence default,
  // SatoriHub.sol; the registry's floor is 60 minutes). A write needs one
  // clear round behind it plus the wall-clock guard (cadence period minus
  // 30 minutes of slack). CADENCE = 2 here just over-waits by a round,
  // harmlessly.
  const CADENCE = 2;
  const waitCadence = async () => { for (let i = 0; i < CADENCE; i++) await nextRound(); };

  let va = 100000, vb = 3000;
  for (let i = 0; i < 4; i++) {
    await waitCadence();
    await (await registry.setValue(a, va)).wait();
    await (await registry.setValue(b, vb)).wait();
    va += 250; vb -= 25;   // one rising, one falling
  }
  console.log("pushed 4 observations to each stream");

  // A negative value, because these are int256 and a tick can be below zero.
  // If anything downstream coerces to an unsigned type this is what catches it.
  await waitCadence();
  await (await registry.setValue(b, -42)).wait();
  console.log("pushed a negative observation to stream", b);

  // Metadata that changes AFTER creation. A consumer reading only
  // DataStreamCreated shows the stale name and the wrong provider from here on.
  await (await registry.setDataStreamName(a, "BTC-USD (renamed)")).wait();
  await (await registry.setProvider(b, alice.address)).wait();
  console.log("renamed stream", a, "and handed stream", b, "to", alice.address);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
