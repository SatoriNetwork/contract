const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");

const ROUND = 86400;
const ONE = 10n ** 18n;
const BASE = 846621902397116230417n;
const PHI_INV = 618033988749894848n;
const STEP_ROUNDS = 730n;
const FLAT_ROUNDS = 1460n;
const RATE_CAP = 1440n * ONE;
const NO_STEP = 2n ** 128n - 1n;
const T0 = FLAT_ROUNDS * BASE;

// Independent of the contract: the same truncating arithmetic, recomputed here
// so a Solidity mistake shows up as a mismatch instead of two copies agreeing.
function stepRate(rate, ratio) {
  const r = (rate * ratio) / ONE;
  return r > RATE_CAP ? RATE_CAP : r;
}

/** [{ rate, next }] for steps 1..n under a fixed ratio; a 0 rate ends it at NO_STEP. */
function ladder(ratio = PHI_INV, rate = BASE, next = T0, max = 200) {
  const rows = [];
  for (let i = 0; i < max; i++) {
    rate = stepRate(rate, ratio);
    if (rate === 0n) { rows.push({ rate: 0n, next: NO_STEP }); break; }
    next += STEP_ROUNDS * rate;
    rows.push({ rate, next });
  }
  return rows;
}

const grossUp = (g, bps) => (g * 10000n) / (10000n - bps);

/** Smallest general amount whose gross-up reaches `delta`. */
function generalReaching(delta, bps) {
  if (delta <= 0n) return 0n;
  let g = (delta * (10000n - bps)) / 10000n;
  while (grossUp(g, bps) < delta) g++;
  return g;
}

/** Largest general amount whose gross-up stays strictly under `delta`. */
function generalBelow(delta, bps) {
  let g = generalReaching(delta, bps);
  while (g > 0n && grossUp(g, bps) >= delta) g--;
  return g;
}

/** SatoriRewards' address as a signer, to drive `noteIssued` directly. */
async function rewardsSigner(rewards) {
  const addr = await rewards.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("100"));
  return ethers.getSigner(addr);
}

const issuedOf = async (hub) => (await hub.emission()).issued;

/**
 * Bumps the counter from SatoriRewards' address so it lands at or just past
 * `target`. Returns { tx, issued } where `issued` is the expected new value.
 */
async function issueTo(hub, token, rw, target) {
  const bps = await token.devFeeBps();
  const before = await issuedOf(hub);
  const g = generalReaching(target - before, bps);
  const tx = await hub.connect(rw).noteIssued(g);
  return { tx, issued: before + grossUp(g, bps) };
}

/** Like issueTo, but stops strictly under `target`. */
async function issueBelow(hub, token, rw, target) {
  const bps = await token.devFeeBps();
  const before = await issuedOf(hub);
  const g = generalBelow(target - before, bps);
  const tx = await hub.connect(rw).noteIssued(g);
  return { tx, issued: before + grossUp(g, bps) };
}

async function currentRound(token) { return BigInt(await token.getCurrentRound()); }

async function atRound(token, r) {
  if (r > (await currentRound(token))) await time.increaseTo(Number(r) * ROUND + 5);
}

async function advanceRound() {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / ROUND) * ROUND + ROUND + 1);
}

function eventsNamed(receipt, contract, name) {
  const out = [];
  for (const log of receipt.logs) {
    let p;
    try { p = contract.interface.parseLog(log); } catch { continue; }
    if (p && p.name === name) out.push(p);
  }
  return out;
}

module.exports = {
  ROUND, ONE, BASE, PHI_INV, STEP_ROUNDS, FLAT_ROUNDS, RATE_CAP, NO_STEP, T0,
  stepRate, ladder, grossUp, generalReaching, generalBelow,
  rewardsSigner, issuedOf, issueTo, issueBelow,
  currentRound, atRound, advanceRound, eventsNamed,
};
