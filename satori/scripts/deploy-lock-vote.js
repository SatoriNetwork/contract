// Deploy the LockVoteGovernor (the owner's self-contained voting path —
// docs/design/lock-vote-governor.md) and open its one door: the hub's
// lane-B vote-lock passthrough.
//
//   PROPOSER=0x... npx hardhat run scripts/deploy-lock-vote.js --network baseSepolia
//
// PROPOSER is the association — the only address that can open a lock-vote
// proposal. Required, no default: this is exactly the kind of value that
// must be chosen on purpose.
//
// The hub appointment (`setVoteLockGovernor`) is the WIRING AUTHORITY's
// call. When the signer holds it (rehearsal chains), this script wires it;
// when it does not (a Safe holds it), the script prints the call to queue.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const proposer = process.env.PROPOSER;
  if (!proposer || !ethers.isAddress(proposer)) throw new Error("set PROPOSER to the association address");

  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  const book = JSON.parse(fs.readFileSync(file, "utf8"));
  const { token: tokenAddr, hub: hubAddr } = book.addresses;
  if (!tokenAddr || !hubAddr) throw new Error(`no token/hub in ${file}`);

  const [dep] = await ethers.getSigners();
  console.log(`Deploying LockVoteGovernor to '${network.name}' as ${dep.address}`);
  console.log(`  token=${tokenAddr} hub=${hubAddr} proposer=${proposer}`);

  const gov = await (await ethers.getContractFactory("LockVoteGovernor"))
    .deploy(tokenAddr, hubAddr, proposer);
  await gov.waitForDeployment();
  const addr = await gov.getAddress();

  for (let i = 0; ; i++) {   // read-after-write lag: retry before believing
    try {
      if ((await gov.proposer()).toLowerCase() !== proposer.toLowerCase()) throw new Error("proposer mismatch");
      break;
    } catch (e) { if (i >= 10) throw e; await new Promise((r) => setTimeout(r, 3000)); }
  }

  const token = await ethers.getContractAt("SatoriToken", tokenAddr);
  const hub = await ethers.getContractAt("SatoriHub", hubAddr);
  if ((await token.wiringAuthority()).toLowerCase() === dep.address.toLowerCase()) {
    await (await hub.setVoteLockGovernor(addr)).wait();
    console.log(`  hub.voteLockGovernor -> ${addr} (wired by this signer)`);
  } else {
    console.log(`  signer is NOT the wiring authority; queue on it:`);
    console.log(`    hub.setVoteLockGovernor(${addr})`);
  }

  book.addresses.lockVoteGovernor = addr;
  fs.writeFileSync(file, JSON.stringify(book, null, 2) + "\n");
  console.log(`  lockVoteGovernor=${addr} -> ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
