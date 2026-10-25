// Supersim harness — the ONLY place a real Superchain bridge hop can be
// exercised before the token becomes permanent.
//
// WHY THIS EXISTS
// Superchain interop was not live on mainnet as of 2026-08, so the crosschain
// lane cannot be tested on Base before it ships. The token is immutable. If the
// lane is wrong it is wrong forever, on every chain, and we would find out only
// when interop lands and someone tries to use it. Supersim runs real OP Stack
// chains locally with the actual SuperchainTokenBridge predeploy, so the hop can
// be proven now.
//
// WHAT IT PROVES — the two divergences the redesign fixed, end to end against
// the real predeploy rather than a mock:
//
//   1. crosschainBurn works with NO ALLOWANCE. The bridge calls
//      crosschainBurn(msg.sender, amount) directly. The old allowance gate made
//      the canonical predeploy revert, so SATORI was not bridgeable at all.
//   2. crosschainMint works on a chain whose crosschainBurned is ZERO. The old
//      net-outflow rule made a fresh deployment permanently unable to receive,
//      which is the definition of not being a bridge destination.
//
// Plus SuperchainERC20 requirement 4 — the identical address on both chains —
// on genuine separate chains rather than one chain pretending.
//
// This is a standalone node script, NOT `hardhat run`: it drives two chains at
// once and hardhat binds one network per invocation.
//
//   supersim --interop.autorelay      # in another terminal
//   npm run supersim
const { ethers } = require("ethers");
const path = require("path");
const fs = require("fs");

const HOME = { name: "OPChainA", chainId: 901, url: "http://127.0.0.1:9545" };
const REMOTE = { name: "OPChainB", chainId: 902, url: "http://127.0.0.1:9546" };

// Anvil's first prefunded account, which supersim funds on every chain.
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SUPERCHAIN_BRIDGE = "0x4200000000000000000000000000000000000028";

// A RUN-SCOPED salt, not the production `satori.token.v1`.
//
// The sharpest checks here are first-run-only: that a destination with
// crosschainBurned == 0 can still receive, and that the home chain starts with no
// bridge headroom. Against a long-lived supersim a second run inherits the first
// run's state and those assertions go false — reporting a contract defect where
// there is none. Cost a confusing red run before it was fixed.
//
// A fresh salt per run gives fresh instances on both chains, so every run is a
// genuine first run. The property under test is that the address is IDENTICAL
// ACROSS CHAINS within a run, which a varying salt proves just as well; the
// specific address value is not what matters here. Override with SUPERSIM_SALT
// to pin one.
const SALT = ethers.id(process.env.SUPERSIM_SALT || `satori.supersim.${Date.now()}`);

const BRIDGE_ABI = [
  "function sendERC20(address _token, address _to, uint256 _amount, uint256 _chainId) external returns (bytes32)",
];

const ART = path.join(__dirname, "..", "artifacts", "contracts", "next", "SatoriToken.sol", "SatoriToken.json");

let failures = 0;
function check(label, pass, detail = "") {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!pass) failures++;
}

async function connect({ name, chainId, url }) {
  const provider = new ethers.JsonRpcProvider(url);
  let actual;
  try { actual = Number((await provider.getNetwork()).chainId); }
  catch {
    throw new Error(
      `Cannot reach ${name} at ${url}.\n` +
      `Start supersim first, in another terminal:\n` +
      `    supersim --interop.autorelay\n` +
      `Install it with: brew install ethereum-optimism/tap/supersim\n` +
      `(or a release binary from github.com/ethereum-optimism/supersim/releases)\n` +
      `NOTE: supersim shells out to anvil, so foundry must be on PATH —\n` +
      `      export PATH="$HOME/.foundry/bin:$PATH"\n` +
      `      Without it supersim reports a misleading "anvil version too old" error.`
    );
  }
  if (actual !== chainId) {
    throw new Error(`${url} reports chain ${actual}, expected ${chainId} — is this really supersim?`);
  }
  return { name, chainId, provider, wallet: new ethers.Wallet(KEY, provider) };
}

/// CREATE2 through Arachnid's proxy, which supersim carries as an OP Stack
/// preinstall — no mock anywhere in this harness.
async function deployDeterministic(chain, initCode) {
  const predicted = ethers.getCreate2Address(FACTORY, SALT, ethers.keccak256(initCode));
  if ((await chain.provider.getCode(predicted)) !== "0x") return { address: predicted, reused: true };
  const tx = await chain.wallet.sendTransaction({ to: FACTORY, data: SALT + initCode.slice(2) });
  await tx.wait();
  if ((await chain.provider.getCode(predicted)) === "0x") {
    throw new Error(`CREATE2 on ${chain.name} left no code at ${predicted} (the proxy returns zero rather than reverting)`);
  }
  return { address: predicted, reused: false };
}

/// True when `fn` reverts with `errSignature`. Selector comparison rather than
/// message parsing, for the same reason as deploy-remote-token.js: clients nest
/// revert data differently and a missed shape reads as "did not revert".
function revertsWith(fn, errSignature) {
  const want = ethers.id(errSignature).slice(0, 10);
  return async () => {
    try { await fn(); return false; }
    catch (e) {
      for (const c of [e?.data, e?.data?.data, e?.error?.data, e?.error?.data?.data, e?.info?.error?.data]) {
        if (typeof c === "string" && c.startsWith("0x") && c.length >= 10) return c.slice(0, 10) === want;
      }
      return false;
    }
  };
}

async function waitForBalance(token, who, want, { tries = 40, delayMs = 500 } = {}) {
  for (let i = 0; i < tries; i++) {
    if ((await token.balanceOf(who)) === want) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

async function main() {
  if (!fs.existsSync(ART)) throw new Error(`No SatoriToken artifact at ${ART} — run \`npx hardhat compile\` first.`);
  const { abi, bytecode } = JSON.parse(fs.readFileSync(ART, "utf8"));

  console.log("Supersim harness — real Superchain bridge hop\n");
  const home = await connect(HOME);
  const remote = await connect(REMOTE);
  const me = home.wallet.address;

  // Identical constructor args on both chains — the requirement that makes the
  // addresses match. HOME_CHAIN_ID is 901 on BOTH, so chain 902 is off-home.
  const ctorArgs = [me, me, HOME.chainId];
  const initCode = ethers.concat([
    bytecode,
    new ethers.AbiCoder().encode(["address", "address", "uint256"], ctorArgs),
  ]);

  console.log("Deploying via the CREATE2 preinstall on both chains...");
  for (const a of [FACTORY, SUPERCHAIN_BRIDGE]) {
    for (const c of [home, remote]) {
      if ((await c.provider.getCode(a)) === "0x") throw new Error(`${a} has no code on ${c.name} — not a real OP Stack chain?`);
    }
  }
  const h = await deployDeterministic(home, initCode);
  const r = await deployDeterministic(remote, initCode);
  console.log(`  ${home.name} (${home.chainId}): ${h.address}${h.reused ? " (reused)" : ""}`);
  console.log(`  ${remote.name} (${remote.chainId}): ${r.address}${r.reused ? " (reused)" : ""}\n`);

  const homeToken = new ethers.Contract(h.address, abi, home.wallet);
  const remoteToken = new ethers.Contract(r.address, abi, remote.wallet);

  console.log("SuperchainERC20 requirement 4 — identical address:");
  check("token address is identical on both chains", h.address === r.address, `${h.address}`);

  console.log("\nHome-chain gate, on genuinely separate chains:");
  const homeSupply = await homeToken.totalSupply();
  check("home minted genesis 720", homeSupply === ethers.parseEther("720"), ethers.formatEther(homeSupply));
  check("remote minted nothing", (await remoteToken.totalSupply()) === 0n);
  check("remote HOME_CHAIN_ID points home", Number(await remoteToken.HOME_CHAIN_ID()) === HOME.chainId);
  check("remote setController reverts NotHomeChain",
    await revertsWith(() => remoteToken.setController.staticCall(me), "NotHomeChain()")());
  check("remote mintDevFee reverts NotHomeChain",
    await revertsWith(() => remoteToken.mintDevFee.staticCall(), "NotHomeChain()")());
  check("remote emission ceiling reads zero", (await remoteToken.rewardCeiling()) === 0n);

  // ---------------------------------------------------------------
  // The hop. This is the part that cannot be done anywhere else.
  // ---------------------------------------------------------------
  const AMOUNT = ethers.parseEther("100");
  const bridge = new ethers.Contract(SUPERCHAIN_BRIDGE, BRIDGE_ABI, home.wallet);

  console.log(`\nBridging ${ethers.formatEther(AMOUNT)} SATORI  ${home.chainId} -> ${remote.chainId}:`);
  const homeBefore = await homeToken.balanceOf(me);
  // No approve() anywhere on purpose: the predeploy calls crosschainBurn
  // directly. Under the old allowance gate this call reverted, which is what
  // made SATORI unbridgeable.
  check("remote has never burned anything (fresh destination)", (await remoteToken.crosschainBurned()) === 0n);
  const sent = await bridge.sendERC20(h.address, me, AMOUNT, remote.chainId);
  await sent.wait();
  check("sendERC20 succeeded with NO allowance granted", true);
  check("home balance fell by the amount", (await homeToken.balanceOf(me)) === homeBefore - AMOUNT);

  const arrived = await waitForBalance(remoteToken, me, AMOUNT);
  check("tokens arrived on the remote chain (autorelay)", arrived,
    `remote balance ${ethers.formatEther(await remoteToken.balanceOf(me))}`);
  check("crosschainMint succeeded despite zero prior outflow there",
    (await remoteToken.crosschainMinted()) === AMOUNT);
  check("remote supply is exactly the bridged amount", (await remoteToken.totalSupply()) === AMOUNT);

  console.log(`\nBridging back  ${remote.chainId} -> ${home.chainId}:`);
  const remoteBridge = new ethers.Contract(SUPERCHAIN_BRIDGE, BRIDGE_ABI, remote.wallet);
  const back = await remoteBridge.sendERC20(r.address, me, AMOUNT, home.chainId);
  await back.wait();
  const returned = await waitForBalance(homeToken, me, homeBefore);
  check("round trip returns the full amount", returned, `home balance ${ethers.formatEther(await homeToken.balanceOf(me))}`);
  check("remote supply back to zero", (await remoteToken.totalSupply()) === 0n);

  // The home bound, proven against a real chain rather than only in unit tests.
  // Needs impersonation because it calls the predeploy directly; supersim runs
  // anvil underneath, so this normally works. Skipped loudly if it does not,
  // rather than silently passing.
  console.log("\nHome net-outflow bound, against the live predeploy:");
  try {
    await home.provider.send("anvil_impersonateAccount", [SUPERCHAIN_BRIDGE]);
    await home.provider.send("anvil_setBalance", [SUPERCHAIN_BRIDGE, "0xde0b6b3a7640000"]);
    const asBridge = new ethers.JsonRpcSigner(home.provider, SUPERCHAIN_BRIDGE);
    const minted = await homeToken.crosschainMinted();
    const burned = await homeToken.crosschainBurned();
    check("home has no unspent headroom after the round trip", minted === burned,
      `${ethers.formatEther(minted)} / ${ethers.formatEther(burned)}`);
    let refused = false;
    try { await homeToken.connect(asBridge).crosschainMint.staticCall(me, 1n); }
    catch (e) {
      const want = ethers.id("CrosschainLimit()").slice(0, 10);
      for (const c of [e?.data, e?.data?.data, e?.error?.data, e?.error?.data?.data]) {
        if (typeof c === "string" && c.startsWith("0x") && c.slice(0, 10) === want) refused = true;
      }
    }
    check("an unbacked mint on HOME is refused (CrosschainLimit)", refused);
    await home.provider.send("anvil_stopImpersonatingAccount", [SUPERCHAIN_BRIDGE]);
  } catch (e) {
    console.log(`  SKIPPED — impersonation unavailable on this node (${e.shortMessage || e.message})`);
    console.log("  (the bound is still covered by test/next/SatoriToken.test.js)");
  }

  console.log("\nGlobal supply audit from the telemetry counters:");
  const minted = (await homeToken.crosschainMinted()) + (await remoteToken.crosschainMinted());
  const burned = (await homeToken.crosschainBurned()) + (await remoteToken.crosschainBurned());
  check("sum(minted) == sum(burned) across chains — nothing in flight, nothing invented",
    minted === burned, `${ethers.formatEther(minted)} / ${ethers.formatEther(burned)}`);
  check("home emission budget untouched by all of it",
    (await homeToken.totalRewardsMinted()) === (await homeToken.INITIAL_MINT()));

  console.log(failures === 0
    ? "\nAll checks passed. The lane works against the real predeploy."
    : `\n${failures} CHECK(S) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("\n" + (e.message || e)); process.exit(1); });
