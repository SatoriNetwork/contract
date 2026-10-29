// One-off upgrade of a live stack's SatoriMerkle to the version that lets anyone
// claim a drop for its account (`claimMerkle(account, amount, proof)`).
//
//   ADDRESS_BOOK=deployments/baseSepolia.json SIGNER_KEYS=0x..,0x..,0x.. \
//     [EXECUTE=1] npx hardhat run scripts/upgrade-merkle-claim-for.js --network baseSepolia
//
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

  const merkle = await ethers.getContractAt("SatoriMerkle", A.merkle, deployer);
  const root = await merkle.merkleRoot();
  console.log(`merkle ${A.merkle}, impl ${A.merkleImpl}, root ${root}`);
  if (!process.env.EXECUTE) { console.log("plan only; set EXECUTE=1"); return; }
  if (keys.length === 0) throw new Error("SIGNER_KEYS (the Safe's owner keys) required");

  require("child_process").execFileSync(process.execPath, [path.join(__dirname, "check-upgrade-safety.js")], {
    stdio: "inherit",
    env: { ...process.env, CONTRACT: "SatoriMerkle", NETWORK: process.env.NETWORK || hre.network.name, PROXY: A.merkle, HARDHAT_NETWORK: hre.network.name },
  });

  const Merkle = await ethers.getContractFactory("SatoriMerkle", deployer);
  const impl = await Merkle.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`impl ${implAddr}`);

  await execViaSafe({
    provider: p, safe: book.governor, to: A.merkle, operation: 0,
    data: Merkle.interface.encodeFunctionData("upgradeTo", [implAddr]),
    keys, relayerKey: process.env.RELAYER_KEY || process.env.PRIVATE_KEY, log: console.log,
  });
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const live = ethers.getAddress("0x" + (await p.getStorage(A.merkle, IMPL_SLOT)).slice(26));
  if (live !== implAddr) throw new Error("the Safe ran but the upgrade did not land (inner call reverted)");
  if (await merkle.merkleRoot() !== root) throw new Error("the root changed across the upgrade");
  // An unknown selector reverts with no data; the new form reverts InvalidProof.
  const claimFor = merkle.getFunction("claimMerkle(address,uint256,bytes32[])");
  try { await claimFor.staticCall(ethers.ZeroAddress, 1n, []); throw new Error("an empty proof was accepted"); }
  catch (e) {
    const sel = (e.data || e.info?.error?.data || "").slice(0, 10);
    if (sel !== merkle.interface.getError("InvalidProof").selector) throw new Error(`claim-for is not live: ${e.shortMessage || e.message}`);
  }
  console.log("merkle upgraded; claimMerkle(account, amount, proof) answers");

  A.merkleImpl = implAddr;
  const { layoutOf, TRACKED } = require("./storage-layout-lib");
  book.implLayouts = { ...(book.implLayouts || {}), [implAddr.toLowerCase()]: await layoutOf(TRACKED.find((t) => t.endsWith(":SatoriMerkle"))) };
  fs.writeFileSync(bookPath, JSON.stringify(book, null, 2) + "\n");
  console.log(`book updated: ${bookPath}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
