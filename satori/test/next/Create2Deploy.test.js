// Deterministic deployment: the property SuperchainERC20 requirement 4 rests on.
//
// A SATORI at a different address on another chain is not the same token as far
// as SuperchainTokenBridge is concerned — same-address is what replaces a
// cross-chain access control list. These tests pin that the deploy path actually
// delivers it, and that the address is sensitive to exactly the inputs it should
// be sensitive to.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const hre = require("hardhat");
const {
  FACTORY, predictAddress, buildInitCode, ensureFactory, deployDeterministic,
} = require("../../scripts/create2-lib");

const HOME = 31337;

describe("CREATE2 deterministic token deployment", function () {
  let deployer, governor, devRecipient, other;

  beforeEach(async function () {
    [deployer, governor, devRecipient, other] = await ethers.getSigners();
    await ensureFactory(hre);
  });

  async function initCodeFor(gov, dev, homeId) {
    return buildInitCode(hre, "SatoriToken", [gov.address, dev.address, homeId]);
  }

  it("installs a factory whose deployments match the CREATE2 formula exactly", async function () {
    // Only the factory's ADDRESS feeds the derivation, never its code — which is
    // what makes a local behavioural mock sound. Assert it rather than assume it.
    expect(await ethers.provider.getCode(FACTORY)).to.not.equal("0x");
    const initCode = await initCodeFor(governor, devRecipient, HOME);
    const { address } = await deployDeterministic(hre, "SatoriToken",
      [governor.address, devRecipient.address, HOME]);
    expect(address).to.equal(predictAddress(ethers, initCode));
    expect(await ethers.provider.getCode(address)).to.not.equal("0x");
  });

  it("lands at the SAME address regardless of the deployer's nonce", async function () {
    // The whole point. Plain CREATE derives from the deployer's nonce, so the
    // address depends on how many transactions that key happened to have sent on
    // that chain — reproducible across chains only by accident.
    const predicted = predictAddress(ethers, await initCodeFor(governor, devRecipient, HOME));

    // Churn the deployer's nonce hard before deploying.
    for (let i = 0; i < 7; i++) {
      await deployer.sendTransaction({ to: other.address, value: 1n });
    }
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.be.greaterThan(6);

    const { address } = await deployDeterministic(hre, "SatoriToken",
      [governor.address, devRecipient.address, HOME]);
    expect(address).to.equal(predicted);
  });

  it("lands at the same address from a DIFFERENT deployer key", async function () {
    // A remote chain may well be deployed from another key. The factory is the
    // CREATE2 sender, so the address must not depend on who called it.
    const predicted = predictAddress(ethers, await initCodeFor(governor, devRecipient, HOME));
    const initCode = await initCodeFor(governor, devRecipient, HOME);
    const { salt } = require("../../scripts/create2-lib");
    await other.sendTransaction({ to: FACTORY, data: salt(ethers) + initCode.slice(2) });
    expect(await ethers.provider.getCode(predicted)).to.not.equal("0x");
  });

  it("a mismatched constructor arg moves the address — the failure this must catch", async function () {
    // initCode includes the ctor args, so a mistyped governor or dev recipient on
    // one chain silently produces a DIFFERENT address and a token the bridge will
    // never recognise. deploy-remote-token.js compares its computed address
    // against the home book before spending precisely because of this.
    const base = predictAddress(ethers, await initCodeFor(governor, devRecipient, HOME));
    const wrongGov = predictAddress(ethers, await initCodeFor(other, devRecipient, HOME));
    const wrongDev = predictAddress(ethers, await initCodeFor(governor, other, HOME));
    const wrongHome = predictAddress(ethers, await initCodeFor(governor, devRecipient, 8453));
    for (const addr of [wrongGov, wrongDev, wrongHome]) {
      expect(addr).to.not.equal(base);
    }
  });

  it("is idempotent — a re-run re-verifies instead of double-spending or reverting", async function () {
    // Distinct args so this test owns a fresh address: chain state persists
    // across `it` blocks here, and the shared args are already deployed by now.
    const args = [other.address, devRecipient.address, HOME];
    const first = await deployDeterministic(hre, "SatoriToken", args);
    expect(first.alreadyDeployed).to.equal(false);

    const before = await ethers.provider.getTransactionCount(deployer.address);
    const second = await deployDeterministic(hre, "SatoriToken", args);
    expect(second.alreadyDeployed).to.equal(true);
    expect(second.address).to.equal(first.address);
    // Nothing was sent — the point is that a re-run after a crashed deploy
    // re-verifies rather than paying twice.
    expect(await ethers.provider.getTransactionCount(deployer.address)).to.equal(before);
  });

  it("home and remote deployments of the same args share one address, with different behaviour", async function () {
    // The end-to-end shape: identical bytecode, identical args, identical
    // address — and the chain-id gate is what makes one of them the emitter.
    // Deployed here as HOME (chainid 31337 == HOME), so this instance emits.
    const { address } = await deployDeterministic(hre, "SatoriToken",
      [governor.address, devRecipient.address, HOME]);
    const home = await ethers.getContractAt("SatoriToken", address);
    expect(await home.totalSupply()).to.equal(await home.INITIAL_MINT());

    // The remote instance is the SAME initCode bar the home id, so it is a
    // different address here only because a single chain cannot host both. On a
    // real remote chain the id would match home's and the address would too —
    // which is exactly what the mismatch test above proves is load-bearing.
    const { address: remoteAddr } = await deployDeterministic(hre, "SatoriToken",
      [governor.address, devRecipient.address, 8453]);
    const remote = await ethers.getContractAt("SatoriToken", remoteAddr);
    expect(await remote.totalSupply()).to.equal(0);
    expect(await remote.HOME_CHAIN_ID()).to.equal(8453);
    await expect(remote.connect(governor).setController(deployer.address))
      .to.be.revertedWithCustomError(remote, "NotHomeChain");
  });
});
