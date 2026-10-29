// One-off upgrade of a live stack to the per-round emission step (owner ruling
// 2026-10-27: FLAT_ROUNDS = STEP_ROUNDS = 1, default ratio 1 − base/2,900,000).
//
//   ADDRESS_BOOK=deployments/baseSepolia.json SIGNER_KEYS=0x..,0x..,0x.. \
//     [EXECUTE=1] npx hardhat run scripts/upgrade-daily-emission.js --network baseSepolia
//
//   1. the Safe upgrades the hub (constants only; the layout gate must say SAFE);
//   2. the emission holder sets the ratio to 1.0 and then to the new default.
//      The live threshold was seeded as 1,460 rounds' worth; leaving 1.0
//      re-bases it to `issued + STEP_ROUNDS × rate`, one round's worth out, so
//      the first step lands after the next round's worth is issued.
// Without EXECUTE it deploys nothing and prints the plan.
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { execViaSafe } = require("./safe-exec");

async function main() {
  const bookPath = process.env.ADDRESS_BOOK || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const A = book.addresses;
  const keys = (process.env.SIGNER_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  const p = ethers.provider;
  const deployer = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY, p) : (await ethers.getSigners())[0];

  const hub = await ethers.getContractAt("SatoriHub", A.hub, deployer);
  const e = await hub.emission();
  const holder = await hub.emissionHolder();
  console.log(`issued ${ethers.formatEther(e.issued)}, nextStepAt ${ethers.formatEther(e.nextStepAt)}, rate ${ethers.formatEther(e.rate)}, ratio ${ethers.formatEther(e.ratioWad)}`);
  console.log(`emission holder ${holder}; deployer ${deployer.address}`);
  if (holder.toLowerCase() !== deployer.address.toLowerCase()) throw new Error("the deployer does not hold the emission lever");
  if (!process.env.EXECUTE) { console.log("plan only; set EXECUTE=1"); return; }
  if (keys.length === 0) throw new Error("SIGNER_KEYS (the Safe's owner keys) required");

  require("child_process").execFileSync(process.execPath, [path.join(__dirname, "check-upgrade-safety.js")], {
    stdio: "inherit",
    env: { ...process.env, CONTRACT: "SatoriHub", NETWORK: process.env.NETWORK || hre.network.name, PROXY: A.hub, HARDHAT_NETWORK: hre.network.name },
  });

  const Hub = await ethers.getContractFactory("SatoriHub", deployer);
  const impl = await Hub.deploy(A.token, A.engine, A.voting, A.rewards, A.registry, A.games, A.bounties);
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`impl ${implAddr}`);

  await execViaSafe({
    provider: p, safe: book.governor, to: A.hub, operation: 0,
    data: Hub.interface.encodeFunctionData("upgradeTo", [implAddr]),
    keys, relayerKey: process.env.RELAYER_KEY || process.env.PRIVATE_KEY, log: console.log,
  });
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const live = ethers.getAddress("0x" + (await p.getStorage(A.hub, IMPL_SLOT)).slice(26));
  if (live !== implAddr) throw new Error("the Safe ran but the upgrade did not land (inner call reverted)");
  if (await hub.STEP_ROUNDS() !== 1n || await hub.FLAT_ROUNDS() !== 1n) throw new Error("the hub does not report the new constants");
  console.log("1. hub upgraded");

  const ratio = await hub.DEFAULT_EMISSION_RATIO();
  await (await hub.setEmissionRatio(ethers.WeiPerEther)).wait();
  await (await hub.setEmissionRatio(ratio)).wait();
  const after = await hub.emission();
  if (after.ratioWad !== ratio || after.nextStepAt !== after.issued + after.rate) throw new Error("the re-base did not land");
  console.log(`2. ratio ${ethers.formatEther(ratio)}; next step at ${ethers.formatEther(after.nextStepAt)} issued (one round's worth out)`);

  A.hubImpl = implAddr;
  const { layoutOf, TRACKED } = require("./storage-layout-lib");
  book.implLayouts = { ...(book.implLayouts || {}), [implAddr.toLowerCase()]: await layoutOf(TRACKED.find((t) => t.endsWith(":SatoriHub"))) };
  fs.writeFileSync(bookPath, JSON.stringify(book, null, 2) + "\n");
  console.log(`book updated: ${bookPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
