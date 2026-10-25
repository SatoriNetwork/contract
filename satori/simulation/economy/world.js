// The world: a fresh local deployment of the full system (the test fixture), the
// streams the participants play, and a value feed the harness owns. Participants
// never control time or values, exactly as in production.
const { ethers } = require("hardhat");

const HOUR = 3600, DAY = 86400;
const WRITE_EVERY_HOURS = 4; // every Simple stream gets a value at hours 0, 4, 8, ... UTC

// Value paths are generated up front so a "skilled" participant can be right with a
// chosen probability by peeking at the real outcome (anchor vs. the first value at
// least 24 hours later), and so a run replays exactly from its seed.
function makePaths(rng, nWrites) {
  const walk = (start, step) => {
    const out = []; let v = start;
    for (let i = 0; i < nWrites; i++) { v = Math.max(10, v + step(v, i)); out.push(v); }
    return out;
  };
  return {
    // A trending market: drifts up with noise.
    ALPHA: walk(1000, () => rng.range(-20, 26)),
    // Mean-reverting around 2000.
    BETA: walk(2000, (v) => Math.round((2000 - v) * 0.2) + rng.range(-30, 30)),
    // A pure random walk.
    GAMMA: walk(500, () => (rng.bool() ? 1 : -1) * rng.range(1, 15)),
    // Nobody votes on it, so it pays nothing; mostly flat, so it voids often.
    COLD: walk(300, () => (rng.bool(0.15) ? (rng.bool() ? 1 : -1) * rng.range(1, 5) : 0)),
  };
}

async function deployWorld(rng, rounds) {
  const { deploySatoriFixture } = require("../../test/fixtures");
  const fix = await deploySatoriFixture();
  const { hub, token, rewards, voting, registry, games, satori, owner } = fix;
  const engine = await ethers.getContractAt("SatoriEngine", await hub.engine());

  // Every capability on (delegation, voting, ...), as on a fully launched network.
  await (await rewards.connect(owner).setCapabilities(255)).wait();

  const streams = [];
  streams.push({ name: "satori", streamId: 1, gameId: Number(await games.binaryGameByStream(1)), named: true });
  for (const name of ["ALPHA", "BETA", "GAMMA", "COLD"]) {
    const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](name, owner.address, 60);
    const rc = await tx.wait();
    let streamId;
    for (const log of rc.logs) {
      try { const p = registry.interface.parseLog(log); if (p && p.name === "DataStreamCreated") streamId = Number(p.args.streamId); } catch {}
    }
    const gameId = Number(await games.binaryGameByStream(streamId));
    try { await (await voting.connect(owner).setGameApproved(gameId, true)).wait(); } catch {}
    streams.push({ name, streamId, gameId, named: false });
  }

  const nWrites = Math.ceil(((rounds + 6) * 24) / WRITE_EVERY_HOURS) + 2;
  const paths = makePaths(rng, nWrites);
  return { fix, hub, token, rewards, voting, registry, games, engine, owner, streams, paths, HOUR, DAY };
}

// The value a Simple stream holds at write slot `i` (hour = startHour + i*WRITE_EVERY_HOURS).
function pathValue(world, name, slot) { return world.paths[name][slot]; }

module.exports = { deployWorld, pathValue, HOUR, DAY, WRITE_EVERY_HOURS };
