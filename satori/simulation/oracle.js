// The oracle: a P&L + token-flow ledger and the invariant battery that decides whether
// the system was hacked. This is the heart of the simulation — agents merely drive the
// contract into weird states; THIS is what catches an exploit. The invariants are the
// exact properties our 5-bug campaign turned on (mint conservation, token solvency,
// auth), expressed so any over-mint / drain / unauthorized change trips immediately.
const { ethers } = require("hardhat");

class Ledger {
  constructor() {
    this.agents = new Map();          // name -> { name, address, persona, exploiter, startWealth }
    this.tokensIn = new Map();        // tokenAddr -> bigint (into the bounty subsystem)
    this.tokensOut = new Map();       // tokenAddr -> bigint (out to users via withdraw/unstake)
    this.tokenContracts = new Map();  // tokenAddr -> contract
    this.actionLog = [];              // [{ round, agent, action, ok, error }]
    this.feeRecipient = null;
  }
  async init(world) {
    this.feeRecipient = await world.fix.rewards.PLATFORM_FEE_RECIPIENT();
  }
  registerAgent(a) { this.agents.set(a.name, { ...a, startWealth: 0n }); }
  noteToken(addr, contract) { if (!this.tokenContracts.has(addr)) this.tokenContracts.set(addr, contract); }
  addIn(addr, amt) { this.tokensIn.set(addr, (this.tokensIn.get(addr) || 0n) + amt); }
  addOut(addr, amt) { this.tokensOut.set(addr, (this.tokensOut.get(addr) || 0n) + amt); }
  log(entry) { this.actionLog.push(entry); }
}

async function wealthOf(world, addr) {
  const bal = await world.fix.satori.balanceOf(addr);
  const unclaimed = await world.fix.rewards.unclaimedRewards(addr);
  return bal + unclaimed;
}

async function snapshotStartWealth(world, ledger) {
  for (const a of ledger.agents.values()) a.startWealth = await wealthOf(world, a.address);
}

// Returns { ok, violations: [{ severity, name, detail }] }. A HARD violation means the
// system was provably broken — a successful hack.
async function checkInvariants(world, ledger, startBps) {
  const v = [];
  const S = world.fix.satori;
  const round = Number(await S.getCurrentRound());

  // A. Mint integrity: ALL supply originates from counted mints. If supply and the
  //    counter diverge, a mint bypassed the cap accounting.
  const supply = await S.totalSupply();
  const minted = await S.totalRewardsMinted();
  if (supply !== minted)
    v.push({ severity: "HARD", name: "mint-integrity", detail: `totalSupply ${supply} != totalRewardsMinted ${minted}` });

  // B. Cumulative reward cap: the last-line defense the score/total over-mint bumps
  //    against. Under the pin+cap a game mints at most one pool per round, so the
  //    cumulative total can never exceed budget × roundsElapsed.
  const cap = world.BUDGET * BigInt(round - world.deploymentRound + 1);
  if (minted > cap)
    v.push({ severity: "HARD", name: "mint-cap", detail: `minted ${minted} > cap ${cap} (round ${round})` });

  // C. Bounty-token solvency (H2 was a cross-epoch siphon). For each token used, the
  //    full amount funded/staked must still be accounted for: held by bounties, paid out
  //    to users, or skimmed as fees to the recipient. A drain shows up as a shortfall.
  for (const [addr, tok] of ledger.tokenContracts.entries()) {
    const held = await tok.balanceOf(await world.fix.bounties.getAddress());
    const out = ledger.tokensOut.get(addr) || 0n;
    const feeBal = await tok.balanceOf(ledger.feeRecipient);
    const inn = ledger.tokensIn.get(addr) || 0n;
    if (held + out + feeBal !== inn)
      v.push({ severity: "HARD", name: "bounty-token-solvency",
        detail: `token ${addr}: held ${held} + out ${out} + fee ${feeBal} != in ${inn} (delta ${inn - held - out - feeBal})` });
  }

  // E. Authorization invariants that must hold for the whole run.
  const owner = await S.owner();
  if (owner !== ethers.ZeroAddress)
    v.push({ severity: "HARD", name: "ownerless", detail: `owner() ${owner} != 0` });
  const bps = (await world.fix.rewards.feeSlot()).bps;
  if (Number(bps) > startBps)
    v.push({ severity: "HARD", name: "fee-reduce-only", detail: `fee bps ${bps} > start ${startBps}` });

  return { ok: v.filter(x => x.severity === "HARD").length === 0, violations: v };
}

// Economic (soft) oracle: rank net P&L. Flags the suspicious case where an agent that
// used exploit actions is the most profitable — a sign of value redistribution the hard
// cap can't see (it bounds the TOTAL, not who gets it).
async function economicReport(world, ledger) {
  const rows = [];
  for (const a of ledger.agents.values()) {
    const now = await wealthOf(world, a.address);
    rows.push({ name: a.name, persona: a.persona, exploiter: a.exploiter,
      net: now - a.startWealth });
  }
  rows.sort((x, y) => (y.net > x.net ? 1 : y.net < x.net ? -1 : 0));
  // Flag the suspicious case: an exploiter out-earns every honest player. Redistribution
  // the hard cap can't see — it bounds the TOTAL minted, not who captures it.
  const bestHonest = rows.filter(r => !r.exploiter).reduce((m, r) => (r.net > m ? r.net : m), 0n);
  const flag = rows.some(r => r.exploiter && r.net > bestHonest && r.net > 0n);
  return { rows, flag };
}

module.exports = { Ledger, wealthOf, snapshotStartWealth, checkInvariants, economicReport };
