// The action executor — the single boundary between a player's DECISION (scripted policy
// today, an LLM "human who read the code" tomorrow) and EXECUTION + accounting.
//
// Every contract interaction funnels through execute(). It maps a structured action to a
// call, records exact on-chain token flows into the ledger (delta-measured, so it stays
// honest even with weird tokens), and never throws on a contract revert — a revert is
// data, not a crash. The runner decides which reverts are bugs (e.g. an unexpected
// NoPendingPrediction on a believed-pending settle = a strand).
const { ethers } = require("hardhat");
const { pack1 } = require("../test/fixtures");

function errName(e) {
  const m = (e.message || "").match(/custom error '([^']+)'|reverted with reason string '([^']+)'|VM Exception.*?: (.*)/);
  return (m && (m[1] || m[2] || m[3])) || (e.shortMessage) || (e.message || "").slice(0, 80);
}

async function gameIdFrom(tx, games) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try { const p = games.interface.parseLog(log); if (p && p.name === "GameCreated") return Number(p.args.gameId); }
    catch (e) { /* not a games event */ }
  }
  return null;
}

// Deploy a fresh mock ERC20, mint `amount` to `agent`, approve the bounties contract.
async function provisionToken(world, agent, amount, ledger, symbol = "MOCK") {
  const M = await ethers.getContractFactory("MockERC20");
  const tok = await M.deploy(symbol, symbol);
  await tok.waitForDeployment();
  await tok.mint(agent.address, amount);
  await tok.connect(agent.signer).approve(await world.fix.bounties.getAddress(), ethers.MaxUint256);
  const addr = await tok.getAddress();
  ledger.noteToken(addr, tok);
  return { tok, addr };
}

async function execute(world, agent, action, ledger, round) {
  const S = world.fix.satori.connect(agent.signer);
  const B = world.fix.bounties.connect(agent.signer);
  const bountiesAddr = await world.fix.bounties.getAddress();
  let ok = true, errorName = null, data = null;
  try {
    switch (action.type) {
      case "predict":
        await S.predictMultipleWithPayloads([{ gameId: action.gameId, payload: pack1(action.dir) }]);
        break;

      case "predictMany":
        await S.predictMultipleWithPayloads(action.entries.map(e => ({ gameId: e.gameId, payload: pack1(e.dir) })));
        break;

      case "vote":
        await S.vote(action.gameId);
        break;

      case "claim":
        await S.claim();
        break;

      case "settle":
        await world.fix.satori.settlePrediction(action.user, action.gameId); // permissionless
        break;

      case "transfer":
        await S.transfer(action.to, action.amount);
        break;

      case "fundBounty": {
        const tok = ledger.tokenContracts.get(action.tokenAddr);
        const before = await tok.balanceOf(bountiesAddr);
        await B.fundBounty(action.gameId, action.tokenAddr, action.amount, action.rate);
        const after = await tok.balanceOf(bountiesAddr);
        ledger.addIn(action.tokenAddr, after - before);
        break;
      }
      case "stakeBounty": {
        const tok = ledger.tokenContracts.get(action.tokenAddr);
        const before = await tok.balanceOf(bountiesAddr);
        await B.stakeBountyToken(action.tokenAddr, action.amount);
        const after = await tok.balanceOf(bountiesAddr);
        ledger.addIn(action.tokenAddr, after - before);
        break;
      }
      case "unstakeBounty": {
        const tok = ledger.tokenContracts.get(action.tokenAddr);
        const before = await tok.balanceOf(agent.address);
        await B.unstakeBountyToken(action.tokenAddr, action.amount, agent.address);
        const after = await tok.balanceOf(agent.address);
        ledger.addOut(action.tokenAddr, after - before);
        break;
      }
      case "withdrawBounty": {
        const befores = {};
        for (const t of action.tokenAddrs) befores[t] = await ledger.tokenContracts.get(t).balanceOf(agent.address);
        await B.withdrawBounty(action.tokenAddrs, agent.address);
        for (const t of action.tokenAddrs) {
          const after = await ledger.tokenContracts.get(t).balanceOf(agent.address);
          ledger.addOut(t, after - befores[t]);
        }
        break;
      }

      // ---- Attacker primitives: deploy hostile code (read-only on the protocol, but it
      //      can register its own adapters and bet on them) ----
      case "deployEvilGameAdapter": {
        const factory = action.kind === "reentrant" ? "ReentrantGameAdapter" : "EveryoneWinsGame";
        const F = await ethers.getContractFactory(factory);
        const evil = await F.deploy(await world.fix.satori.getAddress());
        await evil.waitForDeployment();
        const evilAddr = await evil.getAddress();
        const tid = Number(await S.registerCommunityGameAdapter.staticCall(evilAddr, action.name || "evil"));
        await S.registerCommunityGameAdapter(evilAddr, action.name || "evil");
        data = { adapter: evil, adapterAddr: evilAddr, typeId: tid };
        break;
      }
      case "createAdapterGame": {
        const tx = await S.createGame(action.streamId, action.adapterTypeId, action.config || "0x", action.name || "g");
        data = { gameId: await gameIdFrom(tx, world.fix.games) };
        break;
      }
      case "noop":
        break;
      default:
        throw new Error(`unknown action ${action.type}`);
    }
  } catch (e) {
    ok = false;
    errorName = errName(e);
  }
  ledger.log({ round, agent: agent.name, action: { type: action.type, gameId: action.gameId }, ok, error: errorName });
  return { ok, errorName, data };
}

module.exports = { execute, provisionToken, gameIdFrom, errName };
