// Deploy the holder-voting governor (HistoricalBalanceGovernor) against the
// already-deployed token, and record it in the network's address book.
//
//   npx hardhat run scripts/deploy-governor.js --network baseSepolia
//
// Env knobs (defaults are the production posture):
//   ACTIVATION_WINDOW_BLOCKS   default 256 — the max the EVM allows, ~8.5 min
//                              on Base; the proof pipeline reacts in seconds.
//   VOTING_PERIOD_SECONDS      default 604800 (7 days). The DRILL uses a short
//                              one; the period is immutable per deployment, so
//                              a rehearsal governor and a real one are simply
//                              different deployments. That is fine: this
//                              contract holds authority over nothing.
//
// Address-book key is `holderGovernor` — NOT `governor`, which already means
// the token's authority address in these files.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const book = JSON.parse(fs.readFileSync(file, "utf8"));
  const token = book.addresses.token;
  if (!token) throw new Error(`no token in ${file}`);

  const windowBlocks = Number(process.env.ACTIVATION_WINDOW_BLOCKS || 256);
  const period = Number(process.env.VOTING_PERIOD_SECONDS || 7 * 24 * 3600);
  const [dep] = await ethers.getSigners();

  console.log(`Deploying HistoricalBalanceGovernor to '${network.name}' as ${dep.address}`);
  console.log(`  token=${token} activationWindow=${windowBlocks} blocks votingPeriod=${period}s`);

  const gov = await (await ethers.getContractFactory("HistoricalBalanceGovernor"))
    .deploy(token, windowBlocks, period);
  await gov.waitForDeployment();
  const addr = await gov.getAddress();
  const block = (await gov.deploymentTransaction().wait()).blockNumber;

  // Read back what the chain believes, not what we asked for. The public
  // Base RPC load-balances across nodes whose state lags a confirmed receipt
  // by a few seconds (the same lag hardhat.config.js documents for nonces),
  // so an immediate read can see empty code. Retry briefly before believing a
  // bad answer.
  for (let i = 0; ; i++) {
    try {
      if ((await gov.TOKEN()).toLowerCase() !== token.toLowerCase()) throw new Error("TOKEN mismatch");
      if (Number(await gov.ACTIVATION_WINDOW()) !== windowBlocks) throw new Error("window mismatch");
      if (Number(await gov.VOTING_PERIOD()) !== period) throw new Error("period mismatch");
      break;
    } catch (e) {
      if (i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  book.addresses.holderGovernor = addr;
  book.holderGovernorBlock = block;
  fs.writeFileSync(file, JSON.stringify(book, null, 2) + "\n");
  console.log(`  holderGovernor=${addr} (block ${block}) -> ${file}`);
  console.log(`\nNext: point the proof pipeline at it (GOVERNOR_ADDRESS=${addr})`);
  console.log(`and it will activate + serve ballots for every proposal automatically.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
