// Add the off-chain claim channel to a stack that was deployed WITHOUT it.
//
//   npx hardhat run scripts/wire-merkle.js --network baseSepolia          (plan)
//   MERKLE_EXECUTE=1 npx hardhat run scripts/wire-merkle.js --network baseSepolia
//
// FOR A NEW DEPLOY, DO NOT USE THIS. Set ROOT_PUBLISHER before running deploy.js
// and step 7 wires merkle inline, while the deployer is still governor — one
// script, no multisig coordination on launch day. That is the standard path and
// it is the one the post-conditions cover (43 checks instead of 37).
//
// This script exists for the other case: a stack already live without merkle,
// which is what E4's "deferred, not shipping at launch" produces. By then the
// governor is the Safe, so the final wiring call cannot be signed here — the
// deploy-time path avoids that problem by happening before the handoff.
//
// WHAT IT CANNOT DO, AND WHY THAT IS THE POINT
// `SatoriHub.setSatoriMerkle` is `onlyGovernor` AND one-shot (`AlreadySet` on a
// second call). One-shot is what makes the channel un-redirectable: once a root
// promises someone money, no key can aim the merkle lane at a different contract
// and strand them. So this script deploys and self-wires, then hands the last
// call to the Safe as calldata rather than pretending it can send it.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { runChecks, waitForCode, readPolicy } = require("./live-reads-lib");

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const execute = !!(process.env.MERKLE_EXECUTE || "").trim();
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — set PRIVATE_KEY in .env");

  const bookPath = process.env.ADDRESS_BOOK ||
    path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(bookPath)) throw new Error(`no address book at ${bookPath} — run deploy.js first`);
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const A = book.addresses;

  const rootPublisher = (process.env.ROOT_PUBLISHER || "").trim();
  if (!rootPublisher || !ethers.isAddress(rootPublisher)) {
    throw new Error("ROOT_PUBLISHER is required and must be an address. Point it at the multisig.");
  }
  const publisher = ethers.getAddress(rootPublisher);

  console.log(`\n  network   ${network.name} (chainId ${chainId})`);
  console.log(`  deployer  ${deployer.address}`);
  console.log(`  book      ${bookPath}`);
  console.log(`  mode      ${execute ? "EXECUTE" : "PLAN ONLY — nothing will be sent"}`);

  const hub = await ethers.getContractAt("SatoriHub", A.hub);
  const already = await hub.merkle();
  if (already !== ethers.ZeroAddress) {
    console.log(`\n  The hub already points at a merkle: ${already}`);
    console.log(`  setSatoriMerkle is one-shot, so this stack is finished — nothing to do.\n`);
    return;
  }

  console.log(`\n  hub             ${A.hub}`);
  console.log(`  token           ${A.token}`);
  console.log(`  ROOT_PUBLISHER  ${publisher}`);
  if ((await ethers.provider.getCode(publisher)) === "0x") {
    console.log(`  note: the publisher has no code — an EOA, not a multisig. The contract's`);
    console.log(`        own guidance is to point this at a multisig.`);
  }

  if (!execute) {
    console.log(`\n  Would deploy SatoriMerkle (impl + proxy), bind it to the hub, then print`);
    console.log(`  the governor call for the Safe. Re-run with MERKLE_EXECUTE=1.\n`);
    return;
  }

  // ---- deploy impl + proxy, initialized atomically inside the proxy ctor ----
  console.log(`\n== deploying ==`);
  const F = await ethers.getContractFactory("SatoriMerkle");
  const impl = await F.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`  implementation  ${implAddr}`);

  const initData = F.interface.encodeFunctionData("initialize", [publisher, A.token]);
  const Proxy = await ethers.getContractFactory("SatoriProxy");
  const proxy = await Proxy.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const merkleAddr = await proxy.getAddress();
  console.log(`  proxy (THE channel address)  ${merkleAddr}`);

  const policy = readPolicy(network.name);
  if (!policy.local) {
    for (const [label, addr] of [["implementation", implAddr], ["proxy", merkleAddr]]) {
      if ((await waitForCode(ethers.provider, addr, { log: console.log })) === 0) {
        throw new Error(`could not confirm code at the ${label} (${addr}) — it may still have ` +
          `deployed; check a block explorer before re-running.`);
      }
    }
  }

  // `setSatoriCore` is deployer-only and one-shot; the deployer here is whoever
  // deployed the PROXY, which is this signer.
  const merkle = F.attach(merkleAddr);
  console.log(`\n  binding it to the hub ...`);
  await (await merkle.setSatoriCore(A.hub)).wait();

  // ---- verify everything this script is responsible for ----
  console.log(`\n== verifying ==`);
  const checks = [
    [`merkle.satoriCore == hub`, async () => (await merkle.satoriCore()).toLowerCase() === A.hub.toLowerCase()],
    [`merkle.satoriToken == token (the upgrade anchor)`, async () => (await merkle.satoriToken()).toLowerCase() === A.token.toLowerCase()],
    [`merkle.rootPublisher == ROOT_PUBLISHER`, async () => (await merkle.rootPublisher()).toLowerCase() === publisher.toLowerCase()],
    [`proxy points at the implementation just deployed`, async () => (await merkle.implementation()).toLowerCase() === implAddr.toLowerCase()],
    [`upgrades are not pre-renounced`, async () => !(await merkle.upgradesRenounced())],
    [`the raw implementation is locked`, async () => {
      try { await F.attach(implAddr).initialize.staticCall(publisher, A.token); return false; }
      catch { return true; }
    }],
  ];
  const { failed, lastError } = await runChecks(checks, { ...policy, log: console.log });
  for (const [m] of checks) {
    const bad = failed.some(([x]) => x === m);
    console.log(`  ${bad ? "FAIL" : "ok  "} ${m}${bad && lastError.get(m) ? `  (${lastError.get(m)})` : ""}`);
  }
  if (failed.length) {
    console.error(`\n  ${failed.length} check(s) failed — do NOT wire this into the hub.\n`);
    process.exit(1);
  }

  // ---- record it, then hand the last call to the Safe ----
  book.addresses.merkle = merkleAddr;
  book.addresses.merkleImpl = implAddr;
  fs.writeFileSync(bookPath, JSON.stringify(book, null, 2) + "\n");
  console.log(`\n  address book updated -> ${bookPath}`);

  const data = hub.interface.encodeFunctionData("setSatoriMerkle", [merkleAddr]);
  const governor = await (await ethers.getContractAt("SatoriToken", A.token)).rootAuthority();
  console.log(`\n== THE GOVERNOR MUST NOW WIRE IT ==\n`);
  console.log(`  setSatoriMerkle is onlyGovernor and ONE-SHOT. Read the address back before`);
  console.log(`  signing: whatever goes in is the claim channel for good.\n`);
  console.log(`    from   ${governor}`);
  console.log(`    to     ${A.hub}`);
  console.log(`    value  0`);
  console.log(`    data   ${data}\n`);
  if ((await ethers.provider.getCode(governor)) !== "0x") {
    console.log(`    https://app.safe.global/home?safe=${chainId === 8453 ? "base" : "basesep"}:${governor}\n`);
  }
  console.log(`  Until then the channel is deployed but not connected: it can hold a root,`);
  console.log(`  and it can mint nothing.\n`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
