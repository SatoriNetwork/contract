// The world the adversary attacks: a fresh local deployment (the real test
// fixture), an honest cast running scripted background activity across rounds,
// and an attacker wallet holding ~half the circulating supply. Everything here
// uses only the public entry points a real actor would.
const { ethers } = require("hardhat");
const { deploySatoriFixture, VOTE, pack1 } = require("../test/fixtures");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const HOUR = 3600, ROUND = 86400;

async function buildWorld({ honestRounds = 20, attackerShareBps = 5000 } = {}) {
  const fix = await deploySatoriFixture();
  const { satori, token, registry, voting, rewards, games, owner, signers } = fix;
  const engine = await ethers.getContractAt("SatoriEngine", await satori.engine());

  // Cast: honest predictors/voters, plus the attacker (signers[9]).
  const honest = signers.slice(1, 6);
  const attacker = signers[9];

  // Two hourly streams the honest cast plays; approve their auto games.
  const streamIds = [];
  for (const name of ["ALPHA", "BETA"]) {
    const tx = await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](name, owner.address, 60);
    const r = await tx.wait();
    for (const log of r.logs) {
      try { const p = registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") streamIds.push(Number(p.args.streamId)); } catch {}
    }
  }
  for (const sid of streamIds) await (await voting.connect(owner).setGameApproved(sid, true)).wait();

  // Fund the cast; give the attacker ~attackerShareBps of the governor's stash.
  const govBal = await token.balanceOf(owner.address);
  for (const h of honest) await (await token.connect(owner).transfer(h.address, govBal / 40n)).wait();
  const attackerStake = (govBal * BigInt(attackerShareBps)) / 10000n;
  await (await token.connect(owner).transfer(attacker.address, attackerStake)).wait();

  // Honest votes to give the games a denominator.
  for (const sid of streamIds) for (const h of honest.slice(0, 2)) {
    await (await satori.connect(h).vote(sid, VOTE)).wait();
  }

  // Background activity: each round, honest providers post a value and honest
  // predictors predict; a price path that actually moves so skill matters.
  const align = await time.latest();
  await time.increaseTo(Math.floor(align / HOUR) * HOUR + HOUR + 5);
  let base = 1000;
  for (let round = 0; round < honestRounds; round++) {
    base += (round % 3 === 0 ? 40 : -25);
    for (const sid of streamIds) await (await registry.connect(owner).setValue(sid, base)).wait();
    for (const h of honest) for (const sid of streamIds) {
      try {
        await (await satori.connect(h).predictMultipleWithPayloads(
          [{ gameId: sid, payload: pack1(base > 1000 ? 1 : 2) }])).wait();
      } catch {}
      try { await (await satori.settlePrediction(h.address, sid)).wait(); } catch {}
    }
    await time.increase(ROUND);
  }

  // A live-market tick: honest providers post a fresh (moving) value to each
  // approved stream and honest players predict + settle. The executor drives
  // this as the clock advances so the attacker operates inside a MOVING market
  // — the only setting in which a sustained ~100% win-rate is anomalous.
  const crypto = require("crypto");
  let liveBase = base;
  async function world_honestTick() {
    // A genuine RANDOM WALK, drawn from crypto entropy at tick time — the next
    // direction does not exist (and cannot be foreseen) until the round the
    // attacker predicts toward actually arrives. This is what makes a sustained
    // >=90% win-rate a real signal (foresight/control of the scored value)
    // rather than a scripted-price artifact. A fixed strategy scores ~50%.
    liveBase += crypto.randomInt(0, 2) ? crypto.randomInt(15, 45) : -crypto.randomInt(15, 45);
    if (liveBase < 100) liveBase = 100;
    for (const sid of streamIds) { try { await registry.connect(owner).setValue(sid, liveBase); } catch {} }
    for (const h of honest) for (const sid of streamIds) {
      try { await satori.connect(h).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(crypto.randomInt(0, 2) ? 1 : 2) }]); } catch {}
      try { await satori.settlePrediction(h.address, sid); } catch {}
    }
  }

  return { fix, engine, honest, attacker, streamIds, HOUR, ROUND, honestTick: world_honestTick, owner };
}

module.exports = { buildWorld };
