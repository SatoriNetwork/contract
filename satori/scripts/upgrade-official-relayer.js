// One-off upgrade of a live stack's SatoriRewards to the version that keeps a
// round's rewards with the owner after it predicts, lets anyone claim to the
// owner, and names the official relayer (2026-10-29). The hub changed only in
// comments, so it is not upgraded.
//
//   ADDRESS_BOOK=deployments/baseSepolia.json SIGNER_KEYS=0x..,0x..,0x.. \
//     OFFICIAL_RELAYER=0x.. [EXECUTE=1] npx hardhat run scripts/upgrade-official-relayer.js --network baseSepolia
//
// The Safe upgrades Rewards; then the rewards admin (PRIVATE_KEY) sets the
// official relayer. Without EXECUTE it deploys nothing and prints the plan.
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { execViaSafe } = require("./safe-exec");

async function main() {
  const bookPath = process.env.ADDRESS_BOOK || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const A = book.addresses;
  const relayer = ethers.getAddress(process.env.OFFICIAL_RELAYER || "");
  const keys = (process.env.SIGNER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  const p = ethers.provider;
  const deployer = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY, p) : (await ethers.getSigners())[0];

  const rewards = await ethers.getContractAt("SatoriRewards", A.rewards, deployer);
  const admin = await rewards.admin();
  const marketing = await rewards.marketingFeeRecipient();
  const shareBps = await rewards.offchainShareBps();
  console.log(`rewards ${A.rewards}, impl ${A.rewardsImpl}, admin ${admin}, share ${shareBps} bps, official relayer -> ${relayer}`);
  if (!process.env.EXECUTE) { console.log("plan only; set EXECUTE=1"); return; }
  if (keys.length === 0) throw new Error("SIGNER_KEYS (the Safe's owner keys) required");
  if (admin !== deployer.address) throw new Error(`PRIVATE_KEY is ${deployer.address}, not the rewards admin ${admin}`);

  require("child_process").execFileSync(process.execPath, [path.join(__dirname, "check-upgrade-safety.js")], {
    stdio: "inherit",
    env: { ...process.env, CONTRACT: "SatoriRewards", NETWORK: process.env.NETWORK || hre.network.name, PROXY: A.rewards, HARDHAT_NETWORK: hre.network.name },
  });

  const Rewards = await ethers.getContractFactory("SatoriRewards", deployer);
  const impl = await Rewards.deploy(A.voting, admin, marketing);
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`impl ${implAddr}`);

  await execViaSafe({
    provider: p, safe: book.governor, to: A.rewards, operation: 0,
    data: Rewards.interface.encodeFunctionData("upgradeTo", [implAddr]),
    keys, relayerKey: process.env.RELAYER_KEY || process.env.PRIVATE_KEY, log: console.log,
  });
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const live = ethers.getAddress("0x" + (await p.getStorage(A.rewards, IMPL_SLOT)).slice(26));
  if (live !== implAddr) throw new Error("the Safe ran but the upgrade did not land (inner call reverted)");
  if (await rewards.admin() !== admin || await rewards.offchainShareBps() !== shareBps || await rewards.marketingFeeRecipient() !== marketing) {
    throw new Error("state changed across the upgrade");
  }
  console.log("1. rewards upgraded");

  await (await rewards.setOfficialRelayer(relayer)).wait();
  if (await rewards.officialRelayer() !== relayer) throw new Error("official relayer not set");
  console.log(`2. official relayer ${relayer}`);

  A.rewardsImpl = implAddr;
  book.officialRelayer = relayer;
  const { layoutOf, TRACKED } = require("./storage-layout-lib");
  book.implLayouts = { ...(book.implLayouts || {}), [implAddr.toLowerCase()]: await layoutOf(TRACKED.find((t) => t.endsWith(":SatoriRewards"))) };
  fs.writeFileSync(bookPath, JSON.stringify(book, null, 2) + "\n");
  console.log(`book updated: ${bookPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
