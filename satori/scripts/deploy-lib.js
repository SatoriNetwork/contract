// Decisions deploy.js, handoff.js and deploy-remote-token.js share, kept out of
// the scripts so the tests can reach them without running a deploy.
const { ethers } = require("ethers");

const BASE_MAINNET = 8453;

// Uniswap V3's own factory per chain; UNISWAP_V3_FACTORY overrides it.
const UNISWAP_V3_FACTORY = { [BASE_MAINNET]: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" };
// Chainlink's L2 sequencer uptime feed per chain; SEQUENCER_UPTIME_FEED overrides it.
const SEQUENCER_UPTIME_FEED = { [BASE_MAINNET]: "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433" };
// The gasless relayer whose fee claims may take after a prediction; OFFICIAL_RELAYER overrides it.
const OFFICIAL_RELAYER = { [BASE_MAINNET]: "0xD858162928c4e4b3e1131FeD62923F5D20924c58" };
// The SatoriMerkle root publisher per chain; ROOT_PUBLISHER (deploy) and NEW_ROOT_PUBLISHER (handoff) override it.
const ROOT_PUBLISHER = { [BASE_MAINNET]: "0xa0d45248752a3C36B03304fE5D150D04D93e811d" };
// The marketing fee recipient per chain; MARKETING_FEE_RECIPIENT overrides it.
const MARKETING_FEE_RECIPIENT = { [BASE_MAINNET]: "0x20A66Ac1c19283AE18063ddabdbC53a0af2a3139" };
// The deploy key per chain (the scripts refuse any other signer there), and the
// rewards admin handoff.js leaves in place; NEW_ADMIN overrides the admin.
const DEPLOYER = { [BASE_MAINNET]: "0x6224b76DC960C42e542f02af2Cd42F385A2B199A" };
const NEW_ADMIN = { [BASE_MAINNET]: "0x6224b76DC960C42e542f02af2Cd42F385A2B199A" };
// The token's root (GOVERNOR) per chain: a Safe deploy-safe.js creates from
// these inputs, so it can be created at the same address on any other chain.
// Base mainnet: Safe #2, wallets 46 and 47, 1-of-2.
const ROOT_SAFE = {
  [BASE_MAINNET]: {
    owners: "0xa5Ab1941012dEdd0d87AF283845bB367190bdc6F,0x969038F6E7223657C4F7AF82dda37A26ec4234d1",
    threshold: "1",
    saltNonce: "0",
    address: "0x18DDEA3eE56a24aCF0745d588C178b7C5Cbdb4c5",
  },
};
// Who holds root and the other token slots on this chain after handoff.js
// (Base mainnet: Safe #1), and whether the outgoing root Safe burns its SATORI.
const NEW_GOVERNOR = { [BASE_MAINNET]: "0xaCEa49E019ae0c5f3AC8BF2018CdCCAF245f17E6" };
const BURN_ROOT_BALANCE = { [BASE_MAINNET]: true };
// The fee-splitter inputs per chain (deploy-splitters.js); the same-named env vars override them.
const SPLITTER_INPUTS = {
  [BASE_MAINNET]: {
    PAYEE_1: "0x7bDE68999a3825f7109068bc598BA347EE9d47b9",              // wallet 31
    PAYEE_2: "0xaCEa49E019ae0c5f3AC8BF2018CdCCAF245f17E6",              // the governor Safe
    PAYEE_3: "0x969038F6E7223657C4F7AF82dda37A26ec4234d1",              // wallet 47
    PAYEE_4: "0x3Bc1B1A9C69460D94AeDb63E0b2641631593D58A",              // wallet 48
    SPLITTER_AUTHORITY_C: "0xaCEa49E019ae0c5f3AC8BF2018CdCCAF245f17E6", // the governor Safe
    SPLITTER_AUTHORITY_B: "0xd50974D1C2EE6AB61da64E8329e8cFC8E3A9b06E", // wallet 49
  },
};
// A chain's preset address is final there: an environment value (say a testnet
// one left in .env) must match it or be empty. Without a preset, the environment.
function presetOr(name, preset) {
  const env = (process.env[name] || "").trim();
  if (!preset) return env;
  if (env && env.toLowerCase() !== preset.toLowerCase()) {
    throw new Error(`${name} is ${env} in the environment, but this chain's preset is ${preset}; unset it or make it match`);
  }
  return preset;
}
async function requireDeployer(provider, deployer) {
  const want = DEPLOYER[Number((await provider.getNetwork()).chainId)];
  if (want && want.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`the deployer on this chain is ${want}, not ${deployer.address}`);
  }
}

// Safe 1.4.1, at the same addresses on every chain the token targets
// (deploy-safe.js verifies them on chain before using them).
const SAFE = {
  factory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
  singleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", // SafeL2
  fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
  multiSendCallOnly: "0x9641d764fc13c8B624c04430C7356C1C7C8102e2",
};

const SAFE_SETUP_ABI = [
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
];

/// The address SafeProxyFactory.createProxyWithNonce gives a Safe with these
/// owners, threshold and salt nonce. Neither the sender nor the chain id enters
/// it, so the same Safe can be created at the same address on any chain that
/// has the factory, and only with these owners.
function predictSafe({ owners, threshold, saltNonce, proxyCreationCode }) {
  const initializer = new ethers.Interface(SAFE_SETUP_ABI).encodeFunctionData("setup", [
    owners, threshold, ethers.ZeroAddress, "0x", SAFE.fallbackHandler, ethers.ZeroAddress, 0, ethers.ZeroAddress,
  ]);
  const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint256"], [ethers.keccak256(initializer), saltNonce]));
  const deploymentData = ethers.concat([proxyCreationCode,
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [SAFE.singleton])]);
  return ethers.getCreate2Address(SAFE.factory, salt, ethers.keccak256(deploymentData));
}

const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/// Who may be the token's root (M02). The root is a constructor argument, so it
/// is part of the CREATE2 address and is root of every copy anyone deploys, on
/// any chain, for good. `safe` is null when the governor is not a Safe (no
/// code, or no owners and threshold to read), else
/// `{ owners, threshold, reproducible, modules, singleton }`. On Base each
/// problem refuses the deploy; elsewhere it is a warning (none on a local chain).
function rootPolicy({ chainId, governor, deployer, safe, local }) {
  const onBase = Number(chainId) === BASE_MAINNET;
  const problems = [];
  const advisories = [];
  if (same(governor, deployer)) {
    problems.push(onBase
      ? "GOVERNOR is the deployer. On Base the token's root must be the association's Safe: the root is in the " +
        "token's address, so whoever holds it is root of every copy on every chain."
      : "GOVERNOR is the deployer: this key is root of every copy of this token on every chain. " +
        "Fine for a rehearsal token; never for Base.");
  } else if (!safe) {
    problems.push(`GOVERNOR ${governor} is not a Safe. On Base the token's root must be the association's Safe.`);
  } else {
    if (Number(safe.threshold) < 2) {
      advisories.push(`GOVERNOR is a ${safe.threshold}-of-${safe.owners.length} Safe: any one owner alone is root.`);
    }
    if (safe.owners.some((o) => same(o, deployer))) {
      problems.push("the deployer is an owner of the GOVERNOR Safe; the deploy key must not be part of root.");
    }
    if (safe.modules.length) {
      problems.push(`the GOVERNOR Safe has modules (${safe.modules.join(", ")}); a module acts as the Safe with no signatures.`);
    }
    if (!same(safe.singleton, SAFE.singleton)) {
      problems.push(`the GOVERNOR Safe runs ${safe.singleton}, not SafeL2 1.4.1.`);
    }
    if (!safe.reproducible) {
      problems.push("GOVERNOR is not the Safe createProxyWithNonce gives its current owners, threshold and " +
        "SAFE_SALT_NONCE, so it could not be created at the same address on other chains and copies there " +
        "would have no root. Use a Safe from deploy-safe.js, unrotated, and pass its SAFE_SALT_NONCE.");
    }
  }
  if (onBase) return { errors: problems, warnings: advisories };
  return { errors: [], warnings: local ? [] : [...problems, ...advisories] };
}

/// Whether a rerun may take over a token that already exists (M06). The token
/// is created first, so a run that fails later leaves it behind; refusing it
/// would strand its address. A finished stack is refused: the default stream is
/// the deploy's last write, so a controller that has initialized it is live.
function adoption({ controller, controllerFinished, frozen }) {
  if (frozen.length) return { error: `the token has frozen levers (${frozen.join(", ")}); it cannot be rewired` };
  if (controller !== ethers.ZeroAddress && controllerFinished) {
    return { error: `the token's controller ${controller} is a finished stack (its default stream exists). ` +
      "Running again would build a second stack and repoint the token away from the live one." };
  }
  return { adopt: true };
}

/// The one Safe transaction a Safe root sends during the deploy: lend the
/// deployer the two slots the wiring needs and the SATORI the one fee needs.
/// handoff.js takes the slots back.
function delegationCalls(tokenInterface, token, deployer, fee) {
  return [
    { to: token, data: tokenInterface.encodeFunctionData("setWiringAuthority", [deployer]), label: `setWiringAuthority(${deployer})` },
    { to: token, data: tokenInterface.encodeFunctionData("setAppointAuthority", [deployer]), label: `setAppointAuthority(${deployer})` },
    { to: token, data: tokenInterface.encodeFunctionData("transfer", [deployer, fee]), label: `transfer(${deployer}, ${fee})` },
  ];
}

function delegated({ wiring, appoint, balance }, deployer, fee) {
  return same(wiring, deployer) && same(appoint, deployer) && BigInt(balance) >= BigInt(fee);
}

/// MultiSendCallOnly's packed format: per call, operation (1 byte, always 0),
/// to (20), value (32), data length (32), data. The Safe delegatecalls it.
function encodeMultiSend(calls) {
  const packed = ethers.concat(calls.map((c) => ethers.solidityPacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [0, c.to, c.value ?? 0, ethers.dataLength(c.data), c.data])));
  return new ethers.Interface(["function multiSend(bytes transactions)"]).encodeFunctionData("multiSend", [packed]);
}

// The Safe Transaction Builder's serializer for its file checksum; without a
// matching checksum the Safe UI warns the signers that the file was changed.
function serializeTxBuilder(json) {
  if (Array.isArray(json)) return `[${json.map(serializeTxBuilder).join(",")}]`;
  if (typeof json === "object" && json !== null) {
    const keys = Object.keys(json).sort();
    return `{${JSON.stringify(keys)}${keys.map((k) => `${serializeTxBuilder(json[k])},`).join("")}}`;
  }
  return JSON.stringify(json === undefined ? null : json);
}

function txBuilderChecksum(batch) {
  return ethers.keccak256(ethers.toUtf8Bytes(serializeTxBuilder({ ...batch, meta: { ...batch.meta, name: null } })));
}

/// The Safe Transaction Builder's batch file, for signers using the Safe UI.
function txBuilderBatch({ chainId, safe, name, calls, createdAt = Date.now() }) {
  const batch = {
    version: "1.0",
    chainId: String(chainId),
    createdAt,
    meta: { name, description: calls.map((c) => c.label).join("; "), txBuilderVersion: "1.16.5", createdFromSafeAddress: safe },
    transactions: calls.map((c) => ({ to: c.to, value: "0", data: c.data, contractMethod: null, contractInputsValues: null })),
  };
  batch.meta.checksum = txBuilderChecksum(batch);
  return batch;
}

/// The tree PLATFORM_FEE_RECIPIENT must be, as deploy-splitters.js builds it:
/// A, with no authority, paying C 60% and B 40%, each a two-slot splitter
/// paying its two payees 50/50. C's and B's authorities, and B's 60% rotation
/// threshold, decide who can move a branch's share of the fee, so they are part
/// of the tree too. The token makes A permanent, so deploy.js checks the tree
/// before the token exists (M05).
const FEE_TREE = {
  top: [6000n, 4000n], leaf: [5000n, 5000n], bps: 10000n,
  // Rotation thresholds in bps; 0 means the contract's default (90%).
  threshold: { A: 0n, C: 0n, B: 6000n },
};
const SPLITTER_ABI = [
  "function slotCount() view returns (uint256)", "function totalShares() view returns (uint256)",
  "function authority() view returns (address)", "function getSlot(uint256) view returns (address, uint256)",
  "function rotationThresholdBps() view returns (uint256)", "function DEFAULT_ROTATION_THRESHOLD_BPS() view returns (uint256)",
];

// null: no code. { error }: code that does not answer like a splitter.
async function readSplitter(provider, addr) {
  const code = await provider.getCode(addr);
  if (code === "0x") return null;
  const c = new ethers.Contract(addr, SPLITTER_ABI, provider);
  try {
    const slots = [];
    for (let i = 0n; i < (await c.slotCount()); i++) {
      const [payee, shares] = await c.getSlot(i);
      slots.push({ payee: ethers.getAddress(payee), shares: BigInt(shares) });
    }
    return {
      code, slots, totalShares: BigInt(await c.totalShares()), authority: ethers.getAddress(await c.authority()),
      threshold: BigInt(await c.rotationThresholdBps()), defaultThreshold: BigInt(await c.DEFAULT_ROTATION_THRESHOLD_BPS()),
    };
  } catch (e) { return { error: e.shortMessage || e.message }; }
}

/// `file` is deploy-splitters.js's splitters-<network>.json, or null.
/// `expect` holds the operator's own inputs when set ({ payees: [4],
/// authorities: { C, B } }). `runtimeFor(threshold)` gives the code
/// SatoriSplitterImmutable deploys with that threshold; with it, a node that
/// answers like a splitter but runs other code is refused. Returns the problems
/// found, the effective split (payee => bps of the fee) and the branches'
/// authorities and thresholds.
async function checkFeeTree(provider, a, file, chainId, { expect = null, runtimeFor = null } = {}) {
  const problems = [];
  const top = await readSplitter(provider, a);
  if (top === null) {
    return { problems: [`no code visible at ${a}: not deployed, or the RPC has not caught up. It must be splitter A from deploy-splitters.js`], split: {}, branches: {} };
  }
  if (top.error) return { problems: [`${a} did not answer like a splitter (${top.error})`], split: {}, branches: {} };
  const resolve = (want, node) => (want === 0n ? node.defaultThreshold : want);
  const shape = async (label, node, want) => {
    if (node.slots.length !== want.length) problems.push(`${label} has ${node.slots.length} slots, not 2 slots`);
    else if (node.slots.some((sl, i) => sl.shares !== want[i])) {
      problems.push(`${label} pays ${node.slots.map((sl) => sl.shares).join("/")}, not ${want.join("/")}`);
    }
    if (node.totalShares !== FEE_TREE.bps) problems.push(`${label}'s totalShares is ${node.totalShares}, not ${FEE_TREE.bps}`);
    const wantThreshold = resolve(FEE_TREE.threshold[label], node);
    if (node.threshold !== wantThreshold) problems.push(`${label}'s rotation threshold is ${node.threshold}, not ${wantThreshold}`);
    if (runtimeFor && node.code !== (await runtimeFor(FEE_TREE.threshold[label]))) {
      problems.push(`${label}'s code is not SatoriSplitterImmutable as this repo builds it`);
    }
  };
  await shape("A", top, FEE_TREE.top);
  if (top.authority !== ethers.ZeroAddress) problems.push(`A has authority ${top.authority}; it must have none`);

  const split = {};
  const branches = {};
  for (const [i, label] of [[0, "C"], [1, "B"]]) {
    const slot = top.slots[i];
    if (!slot) continue;
    const node = await readSplitter(provider, slot.payee);
    if (!node || node.error) { problems.push(`A's slot ${i} (${label}, ${slot.payee}) is not a splitter`); continue; }
    await shape(label, node, FEE_TREE.leaf);
    branches[label] = node;
    for (const leaf of node.slots) split[leaf.payee] = (split[leaf.payee] ?? 0n) + (slot.shares * leaf.shares) / FEE_TREE.bps;
  }

  // Who the tree should pay and who may move its branches: the file
  // deploy-splitters.js wrote, and the operator's own inputs, each when given.
  const sources = [];
  if (file) {
    if (Number(file.chainId) !== Number(chainId)) problems.push(`the splitters file is for chain ${file.chainId}, not ${chainId}`);
    if (top.slots.length === 2 && !(same(top.slots[0].payee, file.c) && same(top.slots[1].payee, file.b))) {
      problems.push(`A pays ${top.slots[0].payee} and ${top.slots[1].payee}, not the file's C ${file.c} and B ${file.b}`);
    }
    sources.push(["in the file", ["PAYEE_1", "PAYEE_2", "PAYEE_3", "PAYEE_4"].map((n) => file.payees?.[n]), file.authorities]);
  }
  if (expect) sources.push(["in the environment", expect.payees, expect.authorities]);
  for (const [where, payees, authorities] of sources) {
    for (const [label, idx] of [["C", [0, 1]], ["B", [2, 3]]]) {
      const node = branches[label];
      if (!node) continue;
      idx.forEach((k, i) => {
        if (payees?.[k] && !same(node.slots[i]?.payee, payees[k])) {
          problems.push(`PAYEE_${k + 1} ${where} is ${payees[k]}, but ${label} pays ${node.slots[i]?.payee}`);
        }
      });
      if (authorities?.[label] && !same(node.authority, authorities[label])) {
        problems.push(`${label}'s authority is ${node.authority}, not ${authorities[label]} ${where}`);
      }
    }
  }
  const described = Object.fromEntries(Object.entries(branches).map(([l, n]) => [l, { authority: n.authority, threshold: n.threshold }]));
  return { problems, split, branches: described };
}

function intInput(name, raw, fallback, max, why) {
  const v = (raw ?? "").trim() || String(fallback);
  if (!/^[0-9]+$/.test(v) || BigInt(v) < 1n || BigInt(v) > max) {
    throw new Error(`${name} must be a whole number in 1..${max} (${why}), got ${raw}`);
  }
  return Number(v);
}

/// Inputs that the chain would otherwise only reject after the token exists.
function validateInputs(env) {
  const window = intInput("ACTIVATION_WINDOW_BLOCKS", env.ACTIVATION_WINDOW_BLOCKS, 256, 256n,
    "HistoricalBalanceGovernor refuses more");
  // The governor stores now + period as a uint48.
  const period = intInput("VOTING_PERIOD_SECONDS", env.VOTING_PERIOD_SECONDS, 7 * 24 * 3600, 2n ** 40n,
    "the governor's deadline is a uint48");
  const publisher = (env.ROOT_PUBLISHER || "").trim();
  if (publisher && (!ethers.isAddress(publisher) || same(publisher, ethers.ZeroAddress))) {
    throw new Error(`ROOT_PUBLISHER is not a valid nonzero address: ${publisher}`);
  }
  return { holderWindow: window, holderPeriod: period, rootPublisher: publisher ? ethers.getAddress(publisher) : null };
}

module.exports = {
  BASE_MAINNET, UNISWAP_V3_FACTORY, SEQUENCER_UPTIME_FEED, OFFICIAL_RELAYER, ROOT_PUBLISHER, MARKETING_FEE_RECIPIENT, DEPLOYER, NEW_ADMIN, requireDeployer, SPLITTER_INPUTS, presetOr, ROOT_SAFE, NEW_GOVERNOR, BURN_ROOT_BALANCE, SAFE, predictSafe, rootPolicy, adoption, delegationCalls, delegated,
  encodeMultiSend, txBuilderBatch, txBuilderChecksum, validateInputs, FEE_TREE, checkFeeTree,
};
