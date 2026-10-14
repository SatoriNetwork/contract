// Deploy preflight: confirm you are pointed at the chain you think you are, with
// a funded signer, BEFORE running deploy.js.
//
//   npx hardhat run scripts/check-network.js --network baseSepolia
//   npx hardhat run scripts/check-network.js --network base
//
// Reports the resolved chain, block height, gas price, the deploy signer and its
// balance, and whether the protocol-address env vars are set. Read-only — it
// sends nothing and costs nothing.
const { ethers, network } = require("hardhat");

// Chains this repo is wired for. Anything else is reported but flagged, because
// deploying to an unexpected chain is a mistake you only make once.
const EXPECTED = {
  84532: { name: "Base Sepolia", role: "rehearsal target" },
  8453:  { name: "Base mainnet", role: "PRODUCTION — see docs/LAUNCH_CHECKLIST.md section C" },
  31337: { name: "Hardhat local", role: "local dev" },
};

// Rough upper bound for the full deploy (engine + hub + 5 children, each behind
// a proxy, plus wiring). Measured locally at ~48M gas; padded for headroom.
const DEPLOY_GAS_ESTIMATE = 60_000_000n;

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const known = EXPECTED[chainId];

  console.log(`\n  network      ${network.name}`);
  console.log(`  chainId      ${chainId}  ${known ? `— ${known.name}` : "— UNRECOGNIZED"}`);
  if (known) console.log(`  role         ${known.role}`);
  else console.log(`  role         !! this repo is not wired for this chain`);

  console.log(`  block        ${await ethers.provider.getBlockNumber()}`);

  const fee = await ethers.provider.getFeeData();
  const gwei = (v) => (v == null ? "n/a" : `${Number(ethers.formatUnits(v, "gwei")).toFixed(4)} gwei`);
  console.log(`  gas price    ${gwei(fee.gasPrice)}`);

  const signers = await ethers.getSigners();
  if (signers.length === 0) {
    console.log(`\n  signer       NONE — set PRIVATE_KEY in .env (see .env.example)`);
  } else {
    const who = signers[0];
    const bal = await ethers.provider.getBalance(who.address);
    console.log(`\n  signer       ${who.address}`);
    console.log(`  balance      ${ethers.formatEther(bal)} ETH`);

    if (fee.gasPrice != null) {
      const need = DEPLOY_GAS_ESTIMATE * fee.gasPrice;
      console.log(`  est. deploy  ~${ethers.formatEther(need)} ETH (${DEPLOY_GAS_ESTIMATE / 1_000_000n}M gas at current price)`);
      if (bal < need) {
        console.log(`  >> UNDERFUNDED: short ~${ethers.formatEther(need - bal)} ETH`);
      } else {
        console.log(`  >> funded`);
      }
    }
  }

  // deploy.js requires both fee recipients, so surface them here rather than
  // letting the deploy fail on them. Only PLATFORM_FEE_RECIPIENT is permanent:
  // it is immutable on SatoriToken, which has no upgrade path. The marketing
  // recipient is rotatable by the recipient itself (two-step), so a wrong value
  // there is recoverable.
  // PLATFORM_FEE_RECIPIENT has a SECOND, preferred source that this preflight
  // used to be blind to: the Phase 1 file `deployments/splitters-<net>.json`.
  // deploy.js reads it from there whenever the env var is unset, which is the
  // intended path — the whole point of Phase 1 writing that file is that nobody
  // has to retype the one address that can never be corrected.
  //
  // Reporting it as "MISSING (required)" was therefore actively dangerous: it
  // pushes whoever is deploying to set the env var by hand, which is the exact
  // retyping the file exists to prevent, and a mistyped value here is permanent.
  const fs2 = require("fs");
  const path2 = require("path");
  const phase1 = path2.join(__dirname, "..", "deployments", `splitters-${hre.network.name}.json`);
  let phase1Recipient = null;
  if (fs2.existsSync(phase1)) {
    try { phase1Recipient = JSON.parse(fs2.readFileSync(phase1, "utf8")).platformFeeRecipient; }
    catch { /* deploy.js will report it properly */ }
  }

  console.log(`\n  protocol addresses`);
  const show = (k, required, permanent) => {
    const v = (process.env[k] || "").trim();
    if (k === "PLATFORM_FEE_RECIPIENT" && !v && phase1Recipient) {
      console.log(`    ${k.padEnd(24)} ${phase1Recipient}`);
      console.log(`    ${"".padEnd(24)} ^ from Phase 1 file, not env. This is the intended path.`);
      console.log(`    ${"".padEnd(24)}   Do NOT also set the env var — if the two disagree,`);
      console.log(`    ${"".padEnd(24)}   deploy.js hard-stops rather than guessing.`);
      return;
    }
    const mark = v ? "set" : (required ? "MISSING (required)" : "unset (defaults)");
    console.log(`    ${k.padEnd(24)} ${v || mark}${v && permanent ? "   <- PERMANENT, no way to change it later" : ""}`);
  };
  show("GOVERNOR", false, false);
  show("REWARDS_ADMIN", false, false);
  show("PLATFORM_FEE_RECIPIENT", true, true);
  show("MARKETING_FEE_RECIPIENT", true, false);
  show("ROOT_PUBLISHER", false, false);

  if (chainId === 8453) {
    console.log(`\n  !! Base MAINNET. PLATFORM_FEE_RECIPIENT is immutable on a token`);
    console.log(`     with no upgrade path — it can never be changed. Point it at a`);
    console.log(`     locked splitter contract, not an EOA. Confirm before deploying.`);
  }
  console.log("");
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
