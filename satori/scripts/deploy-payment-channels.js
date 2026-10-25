// Deploy PaymentChannels at ONE address on every chain: CREATE2 through
// Arachnid's deterministic deployment proxy (an OP Stack preinstall, see
// create2-lib.js). The contract has no constructor arguments and the build
// sets bytecodeHash "none", so the address depends only on the bytecode and
// the salt below; a change to the contract moves it, so bump the salt's
// version with it.
//
//   RPC_URL=http://127.0.0.1:8545 DEPLOY_KEY=0x… npx hardhat run scripts/deploy-payment-channels.js
//
// Without DEPLOY_KEY it prints the address and whether it is deployed there.
// It records each chain in deployments/payment-channels.json, except through a
// local RPC: a fork of Base Sepolia answers Base Sepolia's chain id.
const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");
const { waitForCode } = require("./live-reads-lib");

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SALT = ethers.id("satori.payment-channels.v3");
const GRACE = 7n * 24n * 3600n;

async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL is required");
  const provider = new ethers.JsonRpcProvider(rpc);
  const { chainId } = await provider.getNetwork();
  const art = await hre.artifacts.readArtifact("PaymentChannels");
  const initCodeHash = ethers.keccak256(art.bytecode);
  const address = ethers.getCreate2Address(FACTORY, SALT, initCodeHash);
  console.log(`PaymentChannels on chain ${chainId}: ${address}`);

  if ((await provider.getCode(FACTORY)) === "0x") throw new Error(`no CREATE2 proxy at ${FACTORY} on chain ${chainId}`);
  let tx = null;
  if ((await provider.getCode(address)) === "0x") {
    if (!process.env.DEPLOY_KEY) {
      console.log("  not deployed (set DEPLOY_KEY to deploy)");
      return;
    }
    const wallet = new ethers.Wallet(process.env.DEPLOY_KEY, provider);
    console.log(`  deploying as ${wallet.address}`);
    const sent = await wallet.sendTransaction({ to: FACTORY, data: ethers.concat([SALT, art.bytecode]) });
    tx = await sent.wait();
    console.log(`  tx ${tx.hash} in block ${tx.blockNumber}`);
  } else {
    console.log("  already deployed");
  }

  // Code at the CREATE2 address can only come from this init code; the runtime
  // code differs from the artifact's by EIP712's immutables, so compare behaviour.
  if (!(await waitForCode(provider, address, { log: console.log }))) throw new Error(`no code at ${address}`);
  const channels = new ethers.Contract(address, art.abi, provider);
  const domain = ethers.TypedDataEncoder.hashDomain({ name: "PaymentChannels", version: "1", chainId, verifyingContract: address });
  const checks = [
    [await channels.CLOSE_GRACE_PERIOD(), GRACE, "CLOSE_GRACE_PERIOD"],
    [await channels.VOUCHER_TYPEHASH(), ethers.id("Voucher(bytes32 channelId,uint96 cumulativeAmount)"), "VOUCHER_TYPEHASH"],
    [await channels.domainSeparator(), domain, "domainSeparator"],
  ];
  for (const [got, want, name] of checks) if (got !== want) throw new Error(`${name}: ${got} != ${want}`);
  console.log("  verified: grace period, voucher type, EIP-712 domain");

  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpc)) {
    console.log("  a local RPC: not recorded");
    return;
  }
  const file = path.join(__dirname, "..", "deployments", "payment-channels.json");
  const book = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (book.address && book.address !== address) {
    book.previous = { address: book.address, salt: book.salt, initCodeHash: book.initCodeHash, chains: book.chains, note: book.note };
    book.chains = {};
    delete book.note;
  }
  book.contract = "PaymentChannels";
  book.address = address;
  book.factory = FACTORY;
  book.salt = SALT;
  book.initCodeHash = initCodeHash;
  book.chains = book.chains || {};
  const prev = book.chains[String(chainId)] || {};
  book.chains[String(chainId)] = tx ? { tx: tx.hash, block: tx.blockNumber } : prev;
  fs.writeFileSync(file, JSON.stringify(book, null, 2) + "\n");
  console.log(`  recorded in ${path.relative(process.cwd(), file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
