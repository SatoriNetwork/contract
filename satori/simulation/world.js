// The simulated world: a fresh deployment of the full Satori system + a clock the
// harness controls + a handful of prediction markets whose values the harness moves.
//
// Players act ONLY through the action executor against this world; they cannot mutate
// contract code (they can read it). The harness owns time and the data feeds — exactly
// like the real world owns wall-clock and oracles.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("../test/fixtures");

const ROUND = 43200; // 12h, the protocol round length
const BUDGET = ethers.parseEther("720"); // ROUND_REWARD_BUDGET

// Deploy everything, bootstrap the default stream, and spin up `nMarkets` simple
// streams (each auto-creates its one binary game). `owner` (signers[0]) is the data
// provider for every market, so the harness can move values.
async function deployWorld(nMarkets = 3) {
  const fix = await deploySatoriFixture();
  await fix.satori.initializeDefaultStream();

  const world = {
    fix,
    owner: fix.owner,
    ROUND,
    BUDGET,
    deploymentRound: Number(await fix.satori.deploymentRound()),
    nextStreamId: 2, // default stream took id 1
    markets: [],
    pendingMove: {}, // gameId -> +1 (up) | -1 (down): the move that resolves THIS round's predicts
  };

  // The default game is itself a market.
  world.markets.push({
    streamId: 1,
    gameId: Number(await fix.games.binaryGameByStream(1)),
    name: "DEFAULT",
    isDefault: true,
    value: 0,
  });

  for (let i = 0; i < nMarkets; i++) {
    await fix.satori.connect(world.owner)["createSimpleDataStream(string,address)"](
      `MKT${i}`, world.owner.address
    );
    const streamId = world.nextStreamId++;
    const gameId = Number(await fix.games.binaryGameByStream(streamId));
    // No initial value here — the first tickValues writes it (count==0 skips the
    // cadence gate). Subsequent writes land exactly one round (12h) apart, clearing
    // the ~11.5h CADENCE_GAP. Starting JS value is just the model's seed.
    world.markets.push({ streamId, gameId, name: `MKT${i}`, isDefault: false, value: 1000 });
  }
  return world;
}

async function currentRound(world) {
  return Number(await world.fix.satori.getCurrentRound());
}

// Advance cleanly to the next round boundary (avoids the mid-round-boundary flake).
async function advanceRound(world) {
  const now = await time.latest();
  const b = Math.floor(now / ROUND) * ROUND + ROUND;
  await time.increaseTo(b + 5);
}

// Move every non-default market's value by its pre-rolled pendingMove and refresh the
// default stream. Called at the top of each round so predictions made last round become
// resolvable and this round's predictions have a fresh anchor.
async function tickValues(world, rng) {
  for (const m of world.markets) {
    if (m.isDefault) continue;
    const move = world.pendingMove[m.gameId] ?? (rng.bool() ? 1 : -1);
    const step = rng.range(1, 50);
    m.value = Math.max(1, m.value + move * step);
    await world.fix.registry.connect(world.owner).setValue(m.streamId, m.value);
    // Pre-roll NEXT round's move now so honest agents can be skilled about it.
    world.pendingMove[m.gameId] = rng.bool() ? 1 : -1;
  }
}

module.exports = { deployWorld, currentRound, advanceRound, tickValues, ROUND, BUDGET };
