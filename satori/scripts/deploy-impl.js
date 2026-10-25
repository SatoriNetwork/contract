// Deploy a fresh IMPLEMENTATION for a UUPS proxy upgrade.
//
//   CONTRACT=SatoriRewards PROXY=0x… [ARGS=0xa,0xb,0xc] \
//     npx hardhat run scripts/deploy-impl.js --network baseSepolia
//
// ARGS are the implementation's CONSTRUCTOR arguments, comma-separated. Several
// of these contracts take some: the constructor locks the raw implementation
// instance (sets `_initialized`) so nobody can initialize it directly. Those
// values land in the IMPLEMENTATION's own storage, which the proxy never reads —
// the proxy's copy comes from its initializer. Pass the live values anyway, so
// the stranded instance is locked with sane state rather than junk.
//
// Touches nothing live: the proxy keeps running the old implementation until the
// governor calls upgradeTo. Reads the CURRENT impl off the ERC-1967 slot first,
// so the rollback target comes from the chain rather than from a deploy file
// that may already be stale.
const hre = require("hardhat");
const { ethers } = hre;

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function main() {
  const name = process.env.CONTRACT;
  const proxy = process.env.PROXY;
  if (!name || !proxy) throw new Error("set CONTRACT= and PROXY=");

  // GATE: never hand out upgrade calldata for a candidate whose layout has
  // drifted from the deployed proxy. This runs BEFORE the deploy so a failure
  // costs nothing.
  const net = process.env.NETWORK || hre.network.name;
  require("child_process").execFileSync(
    process.execPath, [require("path").join(__dirname, "check-upgrade-safety.js")],
    // HARDHAT_NETWORK so the checker can read the proxy's live implementation.
    { stdio: "inherit", env: { ...process.env, CONTRACT: name, NETWORK: net, PROXY: proxy, HARDHAT_NETWORK: net } },
  );

  const [signer] = await ethers.getSigners();
  const p = ethers.provider;
  const before = ethers.getAddress("0x" + (await p.getStorage(proxy, IMPL_SLOT)).slice(26));
  console.log("contract            ", name);
  console.log("deployer            ", signer.address);
  console.log("proxy               ", proxy);
  console.log("impl BEFORE         ", before, "  <-- rollback target");

  const args = (process.env.ARGS || "").split(",").map((a) => a.trim()).filter(Boolean);
  console.log("ctor args           ", args.length ? args.join(", ") : "(none)");

  const F = await ethers.getContractFactory(name);
  const impl = await F.deploy(...args);
  await impl.waitForDeployment();
  const addr = await impl.getAddress();
  console.log("impl NEW            ", addr);

  // Record the new implementation's layout under its address. The next upgrade
  // is checked against the layout of whatever the proxy runs then, and without
  // this entry that check would have nothing to compare with (M08).
  const fs = require("fs");
  const bookPath = require("path").join(__dirname, "..", "deployments", `${net}.json`);
  const { layoutOf, TRACKED } = require("./storage-layout-lib");
  const fq = TRACKED.find((t) => t.endsWith(`:${name}`));
  if (fq && fs.existsSync(bookPath)) {
    const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
    book.implLayouts = { ...(book.implLayouts || {}), [addr.toLowerCase()]: await layoutOf(fq) };
    fs.writeFileSync(bookPath, JSON.stringify(book, null, 2));
    console.log("layout recorded     ", `${net}.json implLayouts[${addr.toLowerCase()}]`);
  }

  console.log("\nSAFE TX  to   ", proxy);
  console.log("SAFE TX  data ", F.interface.encodeFunctionData("upgradeTo", [addr]));
}
main().catch((e) => { console.error(e); process.exit(1); });
