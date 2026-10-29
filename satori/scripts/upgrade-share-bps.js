// One-off upgrade of a live stack from the absolute off-chain dial to the
// percentage share (SatoriRewards.setOffchainShareBps, 2026-10-26).
//
//   ADDRESS_BOOK=deployments/baseSepolia.json SIGNER_KEYS=0x..,0x..,0x.. \
//     [EXECUTE=1] npx hardhat run scripts/upgrade-share-bps.js --network baseSepolia
//
// In ONE round, so no round is priced between the steps:
//   1. the deployer re-sets the old dial to its current value: prices the
//      current round's on-chain gross and banks its reserve at the OLD dial, so
//      the switch cannot touch the round in flight;
//   2. the Safe upgrades the hub and Rewards in one MultiSend, so no block runs
//      a new hub against an old Rewards or the reverse;
//   3. the deployer sets the share (SHARE_BPS, default 5000), effective next round.
// Between 2 and 3 both lanes read a zero share, consistently; the old slots are
// never read again. Then a new lens is deployed (its EmissionStatus changed).
// Without EXECUTE it deploys nothing and prints the plan.
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { execViaSafe } = require("./safe-exec");
const { SAFE, encodeMultiSend } = require("./deploy-lib");

const OLD_REWARDS = [
  "function offchainBudget() view returns (uint256)",
  "function setOffchainBudget(uint256)",
];

async function main() {
  const bookPath = process.env.ADDRESS_BOOK || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const A = book.addresses;
  const shareBps = Number(process.env.SHARE_BPS || 5000);
  const keys = (process.env.SIGNER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  const p = ethers.provider;
  // PRIVATE_KEY directly, so a rehearsal on a localhost fork signs as the real deployer.
  const deployer = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY, p) : (await ethers.getSigners())[0];

  const hub = await ethers.getContractAt("SatoriHub", A.hub, deployer);
  const oldRewards = new ethers.Contract(A.rewards, OLD_REWARDS, deployer);
  const round = await hub.getCurrentRound();
  const dial = await oldRewards.offchainBudget();
  const residual = await hub.residualNext();
  console.log(`round ${round}, old dial ${ethers.formatEther(dial)}, residualNext ${ethers.formatEther(residual)}`);
  console.log(`share ${shareBps} bps banks ${ethers.formatEther(residual * BigInt(shareBps) / 10000n)} next round`);
  if (!process.env.EXECUTE) { console.log("plan only; set EXECUTE=1"); return; }
  if (keys.length === 0) throw new Error("SIGNER_KEYS (the Safe's owner keys) required");

  // The same gate deploy-impl.js runs: each candidate's layout against the
  // implementation its proxy runs now.
  for (const [name, proxy] of [["SatoriHub", A.hub], ["SatoriRewards", A.rewards]]) {
    const net = process.env.NETWORK || hre.network.name;
    require("child_process").execFileSync(process.execPath, [path.join(__dirname, "check-upgrade-safety.js")],
      { stdio: "inherit", env: { ...process.env, CONTRACT: name, NETWORK: net, PROXY: proxy, HARDHAT_NETWORK: hre.network.name } });
  }

  const Hub = await ethers.getContractFactory("SatoriHub", deployer);
  const Rewards = await ethers.getContractFactory("SatoriRewards", deployer);
  const hubImpl = await Hub.deploy(A.token, A.engine, A.voting, A.rewards, A.registry, A.games, A.bounties);
  const rewardsImpl = await Rewards.deploy(A.voting, book.rewardsAdmin, book.marketingFeeRecipient);
  await Promise.all([hubImpl.waitForDeployment(), rewardsImpl.waitForDeployment()]);
  console.log(`impls: hub ${await hubImpl.getAddress()}, rewards ${await rewardsImpl.getAddress()}`);

  // Steps 1-3 must share a round; refuse to start with under 10 minutes left.
  const ts = Number((await p.getBlock("latest")).timestamp);
  if (86400 - (ts % 86400) < 600) throw new Error("under 10 minutes left in the round; rerun after midnight UTC");

  await (await oldRewards.setOffchainBudget(dial)).wait();
  console.log("1. current round priced and banked at the old dial");

  const up = Hub.interface.encodeFunctionData("upgradeTo", [await hubImpl.getAddress()]);
  const upR = Rewards.interface.encodeFunctionData("upgradeTo", [await rewardsImpl.getAddress()]);
  const relayerKey = process.env.RELAYER_KEY || process.env.PRIVATE_KEY;
  await execViaSafe({
    provider: p, safe: book.governor, to: SAFE.multiSendCallOnly, operation: 1,
    data: encodeMultiSend([{ to: A.hub, data: up }, { to: A.rewards, data: upR }]),
    keys, relayerKey, log: console.log,
  });
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implOf = async (a) => ethers.getAddress("0x" + (await p.getStorage(a, IMPL_SLOT)).slice(26));
  if (await implOf(A.hub) !== await hubImpl.getAddress() || await implOf(A.rewards) !== await rewardsImpl.getAddress()) {
    throw new Error("the Safe ran but an upgrade did not land (inner call reverted)");
  }
  console.log("2. hub and rewards upgraded in one Safe transaction");

  const rewards = await ethers.getContractAt("SatoriRewards", A.rewards, deployer);
  await (await rewards.setOffchainShareBps(shareBps)).wait();
  if (await hub.getCurrentRound() !== round) throw new Error("the round rolled over during the upgrade");
  console.log(`3. share set to ${shareBps} bps from round ${round + 1n}`);

  const lens = await (await ethers.getContractFactory("SatoriRewardsLens", deployer)).deploy(A.hub, A.rewards);
  await lens.waitForDeployment();
  console.log(`lens ${await lens.getAddress()}`);

  A.hubImpl = await hubImpl.getAddress();
  A.rewardsImpl = await rewardsImpl.getAddress();
  A.lens = await lens.getAddress();
  const { layoutOf, TRACKED } = require("./storage-layout-lib");
  const fq = (name) => TRACKED.find((t) => t.endsWith(`:${name}`));
  book.implLayouts = {
    ...(book.implLayouts || {}),
    [A.hubImpl.toLowerCase()]: await layoutOf(fq("SatoriHub")),
    [A.rewardsImpl.toLowerCase()]: await layoutOf(fq("SatoriRewards")),
  };
  fs.writeFileSync(bookPath, JSON.stringify(book, null, 2) + "\n");
  console.log(`book updated: ${bookPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
