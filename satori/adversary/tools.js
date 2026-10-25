// The attacker's hands. Every tool acts AS the attacker signer, through the
// same public entry points any account has. Reads are unrestricted; actions
// are confined to what a real attacker could do. Contract SOURCE is exposed
// read-only so the agent can plan informed attacks, never edit them.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const CONTRACTS_DIR = path.resolve(__dirname, "../contracts");

function buildTools(world) {
  const { fix, engine, attacker, streamIds, ROUND } = world;
  const { satori, token, registry, voting, rewards, games, hub } = fix;
  const A = attacker.address;
  const as = (c) => c.connect(attacker);

  // ---- source access (read-only, sandboxed to contracts/) ----
  function safeSourcePath(rel) {
    const p = path.resolve(CONTRACTS_DIR, rel);
    if (p !== CONTRACTS_DIR && !p.startsWith(CONTRACTS_DIR + path.sep)) throw new Error("outside contracts/");
    return p;
  }

  const tools = {
    list_source: {
      desc: "List all Solidity source files under contracts/ (read-only).",
      schema: { type: "object", properties: {} },
      run: async () => {
        const out = [];
        (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) walk(fp);
          else if (e.name.endsWith(".sol")) out.push(path.relative(CONTRACTS_DIR, fp));
        }})(CONTRACTS_DIR);
        return out.sort();
      },
    },
    read_source: {
      desc: "Read a Solidity source file under contracts/ by relative path.",
      schema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
      run: async ({ file }) => fs.readFileSync(safeSourcePath(file), "utf8").slice(0, 60000),
    },
    grep_source: {
      desc: "Search all contract sources for a regex; returns matching file:line: text.",
      schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      run: async ({ pattern }) => {
        const re = new RegExp(pattern);
        const hits = [];
        (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) walk(fp);
          else if (e.name.endsWith(".sol")) fs.readFileSync(fp, "utf8").split("\n").forEach((ln, i) => {
            if (re.test(ln)) hits.push(`${path.relative(CONTRACTS_DIR, fp)}:${i + 1}: ${ln.trim()}`);
          });
        }})(CONTRACTS_DIR);
        return hits.slice(0, 200);
      },
    },

    // ---- state reads ----
    state: {
      desc: "Snapshot of the attacker's position and the clock.",
      schema: { type: "object", properties: {} },
      run: async () => ({
        round: (await satori.getCurrentRound()).toString(),
        attackerBalance: (await token.balanceOf(A)).toString(),
        attackerUnclaimed: (await rewards.unclaimedRewards(A)).toString(),
        attackerPower: (await engine.getPredictionPower ? await engine.getPredictionPower(A).catch(() => 0n) : 0n).toString(),
        totalSupply: (await token.totalSupply()).toString(),
        totalMinted: (await token.totalRewardsMinted()).toString(),
        streamIds,
        gameCount: (await games.gameCount()).toString(),
      }),
    },
    stream_info: {
      desc: "Registry info + latest value for a stream id.",
      schema: { type: "object", properties: { streamId: { type: "number" } }, required: ["streamId"] },
      run: async ({ streamId }) => {
        const info = await registry.getDataStreamInfo(streamId);
        const [count, latestHour, lastTs, cad] = await registry.getLatestUpdateInfo(streamId);
        return { name: info[0], value: info[3].toString(), count: count.toString(),
          latestHour: latestHour.toString(), lastTs: lastTs.toString(), cadenceMinutes: cad.toString(),
          approved: await voting.gameLive(streamId) };
      },
    },

    // ---- attacker actions (all AS the attacker) ----
    create_stream: {
      // Routes through the RAW hub, NOT the fixture's auto-approving shim: an
      // attacker-created stream's game is born UNAPPROVED (gameLive=false) and
      // earns nothing until an admin approves it — self-approval is admin-only.
      // The attacker IS the provider (can set values), but an unapproved
      // self-oracle earns zero, exactly as in production.
      desc: "Create a Simple stream (cadence minutes, >=60). Its auto binary game is born UNAPPROVED and cannot earn until an admin approves it; you cannot self-approve.",
      schema: { type: "object", properties: { name: { type: "string" }, cadenceMinutes: { type: "number" } }, required: ["name", "cadenceMinutes"] },
      run: async ({ name, cadenceMinutes }) => {
        const tx = await hub.connect(attacker)["createSimpleDataStream(string,address,uint24)"](name, A, cadenceMinutes);
        const r = await tx.wait();
        for (const log of r.logs) { try { const p = registry.interface.parseLog(log);
          if (p && p.name === "DataStreamCreated") return { streamId: Number(p.args.streamId), approved: false }; } catch {} }
        return { streamId: null };
      },
    },
    create_game: {
      desc: "Create a game on a stream with an explicit target in minutes.",
      schema: { type: "object", properties: { streamId: { type: "number" }, targetMinutes: { type: "number" } }, required: ["streamId", "targetMinutes"] },
      run: async ({ streamId, targetMinutes }) => {
        // Raw hub: the game is born UNAPPROVED like any attacker game.
        const tx = await hub.connect(attacker)["createGame(uint32,uint32,bytes,string,uint24)"](streamId, 0, "0x", "atk", targetMinutes);
        await tx.wait();
        return { gameCount: (await games.gameCount()).toString(), approved: false };
      },
    },
    set_value: {
      desc: "As provider, write a value to a stream the attacker owns.",
      schema: { type: "object", properties: { streamId: { type: "number" }, value: { type: "number" } }, required: ["streamId", "value"] },
      run: async ({ streamId, value }) => { await (await as(registry).setValue(streamId, value)).wait(); return { ok: true }; },
    },
    vote: {
      desc: "Burn SATORI to weight a game (amount in whole SATORI).",
      schema: { type: "object", properties: { gameId: { type: "number" }, amount: { type: "number" } }, required: ["gameId", "amount"] },
      run: async ({ gameId, amount }) => { await (await as(satori).vote(gameId, ethers.parseEther(String(amount)))).wait(); return { ok: true }; },
    },
    predict: {
      desc: "Predict direction (1=up,2=down) on a game.",
      schema: { type: "object", properties: { gameId: { type: "number" }, dir: { type: "number" } }, required: ["gameId", "dir"] },
      run: async ({ gameId, dir }) => {
        await (await as(satori).predictMultipleWithPayloads([{ gameId, payload: "0x0" + dir }])).wait();
        return { ok: true };
      },
    },
    settle: {
      desc: "Settle the attacker's prediction on a game.",
      schema: { type: "object", properties: { gameId: { type: "number" } }, required: ["gameId"] },
      run: async ({ gameId }) => { await (await satori.settlePrediction(A, gameId)).wait(); return { ok: true }; },
    },
    claim: {
      desc: "Claim the attacker's accrued rewards to their own address.",
      schema: { type: "object", properties: {} },
      run: async () => { await (await as(satori)["claim(address)"](A)).wait(); return { balance: (await token.balanceOf(A)).toString() }; },
    },
    advance_time: {
      desc: "Advance the chain clock by N hours. The HONEST market moves with the clock (providers post fresh values, honest players predict) — you are attacking a live market, not a frozen one.",
      schema: { type: "object", properties: { hours: { type: "number" } }, required: ["hours"] },
      run: async ({ hours }) => {
        // Tick the honest market roughly once per round crossed so the world
        // stays alive as time passes.
        const startRound = Number(await satori.getCurrentRound());
        await time.increase(hours * 3600);
        const endRound = Number(await satori.getCurrentRound());
        for (let r = startRound; r < endRound; r++) { try { await world.honestTick(); } catch {} }
        return { round: (await satori.getCurrentRound()).toString() };
      },
    },
  };
  return tools;
}

module.exports = { buildTools };
