// Deterministic (CREATE2) deployment of SatoriToken.
//
// WHY THIS EXISTS
// SuperchainERC20 requirement 4 is that the token sits at the SAME ADDRESS on
// every chain. That is not cosmetic: it is what lets SuperchainTokenBridge skip
// a cross-chain access control list entirely — "same address abstracts away
// cross-chain validation" (OP Stack token-bridging spec). A SATORI at a
// different address on OP Mainnet is simply not the same token as far as the
// bridge is concerned, and would never receive a transfer.
//
// Plain CREATE derives the address from the deployer's NONCE, so it depends on
// how many transactions that key happened to have sent on that chain. It cannot
// be reproduced across chains except by accident. CREATE2 derives it from
// (factory, salt, initCodeHash) instead, none of which involve the deployer's
// history.
//
// THE CONSEQUENCE WORTH SAYING OUT LOUD: initCode includes the CONSTRUCTOR ARGS,
// so `governor`, `devRecipient` and `homeChainId` must be byte-identical on
// every chain or the addresses silently diverge. `deploy-remote-token.js` takes
// those from the home address book rather than from the environment for exactly
// this reason, and refuses to spend gas unless its computed address matches the
// home token's.
const path = require("path");
const { waitForCode } = require("./live-reads-lib");

/// Arachnid's deterministic deployment proxy. An OP Stack *preinstall*, so it is
/// present on Base and every Superchain chain by construction, and separately
/// deployed on most other EVM chains. Chosen over the OP `Create2Deployer`
/// (0x13b0D85CcB8bf860b6b79AF3029fCA081AE9beF2, also a preinstall) because it is
/// present on far more chains, which keeps a non-Superchain deployment possible
/// later without changing the address derivation.
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

/// The salt. A fixed, documented constant: changing it changes every address, so
/// it is versioned rather than edited. If SATORI is ever redeployed as a genuine
/// v2 with different bytecode, bump this so the two cannot collide.
/// v2 (2026-09-01): the v1 Base Sepolia deploy built a full, correctly-seeded
/// stack but aborted before writing the address book, on a post-condition that
/// was stale rather than a real wiring fault (dev fee 86.4 -> 144, see
/// deploy.js). deploy.js refuses to re-run against a live token because it would
/// orphan the first stack's children, so the redeploy takes a new salt. The v1
/// token at 0xC3f1c785c4cd3215F1d692dC1F7448Db22B899fc is abandoned on Base
/// Sepolia and must not be referenced by the dapp.
const SALT_STRING = "satori.token.v2";

function salt(ethers) {
  return ethers.id(SALT_STRING);
}

/// The address `initCode` will land at. Pure arithmetic — no network access, so
/// it is safe (and expected) to call this BEFORE deciding whether to spend
/// anything.
function predictAddress(ethers, initCode) {
  return ethers.getCreate2Address(FACTORY, salt(ethers), ethers.keccak256(initCode));
}

/// initCode = creation bytecode ++ abi-encoded constructor args.
async function buildInitCode(hre, contractName, args) {
  const factory = await hre.ethers.getContractFactory(contractName);
  const tx = await factory.getDeployTransaction(...args);
  return tx.data;
}

/// Guarantee the factory exists.
///
/// Local chains get the mock's runtime bytecode installed at the canonical
/// address via `hardhat_setCode` — not a transaction, so it consumes no nonce
/// and shifts no other address. Only the factory's ADDRESS feeds the CREATE2
/// derivation, never its code, so this produces the same addresses the real
/// proxy would.
///
/// Live chains are checked, never installed. A missing factory is a hard stop
/// with the fix spelled out, because deploying past it would produce a token at
/// an address that can never match the other chains — the one failure this whole
/// module exists to prevent, and one that is unfixable after the fact since the
/// token is immutable.
async function ensureFactory(hre, { log = () => {} } = {}) {
  const net = hre.network.name;
  const local = net === "hardhat" || net === "localhost";
  const code = await hre.ethers.provider.getCode(FACTORY);

  if (code !== "0x") {
    log(`  CREATE2 factory present at ${FACTORY} (${(code.length - 2) / 2} bytes)`);
    return;
  }
  if (!local) {
    throw new Error(
      `No CREATE2 factory at ${FACTORY} on '${net}'.\n` +
      `This is Arachnid's deterministic deployment proxy and an OP Stack preinstall, so its\n` +
      `absence means this chain is NOT a standard OP Stack chain (or is misconfigured).\n` +
      `Do NOT deploy past this: without it the token lands at a nonce-derived address that\n` +
      `can never match the other chains, and the token is immutable so it cannot be fixed.\n` +
      `Fix: send the proxy's presigned deployment transaction to this chain first, then re-run.`
    );
  }
  log(`  installing CREATE2 factory mock at ${FACTORY} (local chain only)`);
  // Runtime bytecode straight off the artifact, NOT deploy-then-getCode. That
  // matters: deploying the mock would consume a deployer nonce, and every other
  // address in the local book is still plain CREATE, so all of them would shift
  // by one and the dapp's committed hardhat addresses would go stale for no
  // reason. `hardhat_setCode` is not a transaction, so this way nothing moves.
  // Safe to take verbatim because this mock has no immutables and no libraries.
  const { deployedBytecode } = await hre.artifacts.readArtifact("Create2FactoryMock");
  await hre.ethers.provider.send("hardhat_setCode", [FACTORY, deployedBytecode]);
}

/// Deploy `contractName(...args)` through the factory and return its address.
///
/// ⚠️ NEVER APPEND ANYTHING TO THIS TRANSACTION'S CALLDATA. ⚠️
///
/// This is the one call in the whole system where trailing calldata is NOT
/// ignored. Everywhere else — every predict, vote, claim, transfer — extra bytes
/// fall off the end of the ABI decode and change nothing, which is exactly the
/// property ERC-8021 Builder Codes rely on to attach attribution suffixes.
///
/// Here the factory consumes `salt ++ EVERYTHING THAT FOLLOWS` as initCode. An
/// appended suffix therefore becomes part of the initCode, changes the
/// initCodeHash, and lands the token at a DIFFERENT ADDRESS on that chain. That
/// silently breaks SuperchainERC20 requirement 4 (identical address everywhere),
/// and on a token with no upgrade path it cannot be fixed afterwards.
///
/// It cannot happen today because deploys run from a node script rather than the
/// dapp. It becomes a live hazard the moment attribution is wired in at the
/// wallet or SDK layer, where it applies to everything by default. If that ever
/// lands, this path must be exempted. See docs/issues/erc-8021-builder-codes.md.
///
/// Idempotent: if code already sits at the predicted address this returns it
/// without sending anything, so a re-run after a crashed deploy re-verifies
/// rather than reverting or double-spending.
///
/// The receipt is NOT taken as proof. Arachnid's proxy returns the zero address
/// on a failed CREATE2 instead of reverting, so a failed deploy produces a
/// perfectly successful-looking transaction. The only sound check is that code
/// exists at the predicted address afterwards, and on a live chain that read is
/// eventually consistent — hence waitForCode rather than a bare getCode.
async function deployDeterministic(hre, contractName, args, { log = () => {} } = {}) {
  const { ethers } = hre;
  const initCode = await buildInitCode(hre, contractName, args);
  const predicted = predictAddress(ethers, initCode);

  const existing = await ethers.provider.getCode(predicted);
  if (existing !== "0x") {
    log(`  ${contractName} ALREADY deployed at ${predicted} — reusing (idempotent re-run)`);
    return { address: predicted, alreadyDeployed: true };
  }

  log(`  ${contractName} -> ${predicted} (CREATE2, salt "${SALT_STRING}")`);
  const [signer] = await ethers.getSigners();
  const tx = await signer.sendTransaction({
    to: FACTORY,
    data: salt(ethers) + initCode.slice(2),
  });
  await tx.wait();

  const size = await waitForCode(ethers.provider, predicted, { log });
  if (size === 0) {
    throw new Error(
      `CREATE2 reported success but NO CODE exists at ${predicted}.\n` +
      `Arachnid's proxy returns the zero address on failure rather than reverting, so the\n` +
      `receipt proves nothing. Likely causes: the address is already taken by different\n` +
      `bytecode, or the constructor reverted. Nothing has been wired — investigate before retrying.`
    );
  }
  return { address: predicted, alreadyDeployed: false };
}

module.exports = {
  FACTORY, SALT_STRING, salt, predictAddress, buildInitCode, ensureFactory, deployDeterministic,
};
