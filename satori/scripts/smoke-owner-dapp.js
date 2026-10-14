// Mimics exactly what the dapp's OwnerTab/useOwner does: attach at the deployed
// addresses and exercise the dial, emission-ratio and Merkle-root reads/writes.
// Run AFTER `hardhat node` + deploy.js --network localhost (with ROOT_PUBLISHER
// set if you want the Merkle section). Addresses come from
// deployments/<network>.json; override with HUB_ADDRESS if needed.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;
const F = (x) => ethers.formatEther(x);

async function main() {
  const bookPath = path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const book = fs.existsSync(bookPath)
    ? JSON.parse(fs.readFileSync(bookPath, "utf8")).addresses || {}
    : {};
  const HUB = process.env.HUB_ADDRESS || book.hub;
  if (!HUB) throw new Error(`hub unknown — run deploy.js first (looked in ${bookPath}) or set HUB_ADDRESS`);

  const [deployer] = await ethers.getSigners();
  const hub = await ethers.getContractAt("SatoriHub", HUB, deployer);
  const rewards = await ethers.getContractAt("SatoriRewards", await hub.satoriRewards(), deployer);
  // Views migrated off the hub in audit LA-4 (onChainRewardCeiling, burn fees,
  // lockedUntil, …) are served by the lens — read them from the child that owns them.
  const LENS = process.env.LENS_ADDRESS || book.lens;
  if (!LENS) throw new Error("lens unknown — run deploy.js first or set LENS_ADDRESS");
  const lens = await ethers.getContractAt("SatoriRewardsLens", LENS, deployer);

  console.log("=== OwnerTab reads ===");
  console.log("admin:", await rewards.admin(), "| connected:", deployer.address);
  const merkleAddr = await hub.merkle();
  console.log("satoriMerkle wired:", merkleAddr);
  console.log("offchainBudget:", F(await rewards.offchainBudget()),
              "| onChainCeil:", F(await lens.onChainRewardCeiling()),
              "| merkleCeil:", F(await hub.merkleReserveCeiling()));

  console.log("\n=== write: Set dial (setOffchainBudget 200) ===");
  await (await rewards.setOffchainBudget(ethers.parseEther("200"))).wait();
  await hre.network.provider.send("evm_mine", []);
  console.log("offchainBudget:", F(await rewards.offchainBudget()),
              "| onChainCeil:", F(await lens.onChainRewardCeiling()),
              "| merkleCeil:", F(await hub.merkleReserveCeiling()));

  console.log("\n=== Emission schedule reads ===");
  const showEmission = async () => {
    try {
      const st = await lens.emissionStatus();
      console.log("emissionStatus:", Object.fromEntries(Object.entries(st.toObject()).map(
        ([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])));
    } catch {
      const e = await hub.emission();
      console.log("(lens has no emissionStatus — hub reads) rateNow:", F(await hub.emissionRateNow()),
                  "| rateNext:", F(await hub.emissionRateNext()), "| ratio:", F(e.ratioWad),
                  "| issued:", F(e.issued), "| nextStepAt:", e.nextStepAt.toString(),
                  "| stepsTaken:", e.stepsTaken.toString(), "| holder:", await hub.emissionHolder());
    }
  };
  await showEmission();

  const holder = await hub.emissionHolder();
  let ratioDone = false;
  if (holder.toLowerCase() === deployer.address.toLowerCase()) {
    // Round-trip through a probe ratio and back. Between two non-1.0 ratios the
    // pending threshold is kept; from 1.0 it is ignored until steps resume, so
    // either way the schedule is left as found.
    const ONE = ethers.WeiPerEther;
    const before = await hub.emission();
    const orig = before.ratioWad;
    const probe = orig === ONE ? await hub.PHI_INV() : (orig === ONE / 2n ? await hub.PHI_INV() : ONE / 2n);
    console.log(`\n=== write: setEmissionRatio round-trip ${F(orig)} -> ${F(probe)} -> ${F(orig)} ===`);
    await (await hub.setEmissionRatio(probe)).wait();
    if ((await hub.emission()).ratioWad !== probe) throw new Error("setEmissionRatio(probe) did not land");
    await (await hub.setEmissionRatio(orig)).wait();
    const after = await hub.emission();
    if (after.ratioWad !== orig) throw new Error("setEmissionRatio(orig) did not restore the ratio");
    if (orig !== ONE && after.stepsTaken === before.stepsTaken && after.nextStepAt !== before.nextStepAt) {
      throw new Error("ratio round-trip moved the pending threshold");
    }
    if ((await hub.emissionRateNext()) !== before.rate) throw new Error("a ratio change moved the next-round rate");
    await showEmission();
    ratioDone = true;
  } else {
    console.log(`\n(emission holder is ${holder}, not the connected signer — skipping setEmissionRatio)`);
  }

  if (merkleAddr !== ethers.ZeroAddress) {
    const merkle = await ethers.getContractAt("SatoriMerkle", merkleAddr, deployer);
    console.log("\n=== write: Publish root (setMerkleRoot) ===");
    console.log("merkleRoot:", await merkle.merkleRoot(), "| rootPublisher:", await merkle.rootPublisher());
    const root = ethers.keccak256(ethers.toUtf8Bytes("dapp-test-root"));
    await (await merkle.setMerkleRoot(root)).wait();
    console.log("merkleRoot now:", await merkle.merkleRoot(), "(expected", root + ")");
  } else {
    console.log("\n(merkle not wired — deploy with ROOT_PUBLISHER to exercise setMerkleRoot)");
  }

  console.log("\n✅ dapp owner surface verified: reads + setOffchainBudget" +
              (ratioDone ? " + setEmissionRatio" : "") +
              (merkleAddr !== ethers.ZeroAddress ? " + setMerkleRoot" : "") + " all work at the deployed addresses.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
