/**
 * SATORI MERKLE BEHIND A PROXY (2026-08-01) — the decision recorded in
 * docs/issues/closed/merkle-behind-a-proxy-decision.md, machine-checked.
 *
 * SatoriMerkle was the one non-token contract with NO upgrade path: deployed
 * directly, plain constructor, an `immutable deployer`, zero UUPS surface. It is
 * now the seventh proxy in the system. Two locks used to point the same way —
 * the hub's write-once pointer AND unpatchable bytecode; the decision keeps the
 * first and drops the second, so the promise is now "claims can never be
 * redirected, and the logic can be fixed by the token governor".
 *
 * What this file pins, in the order the failures would hurt:
 *   1. The conversion traps. The `immutable deployer` is the quiet one — an
 *      immutable lives in the IMPLEMENTATION's bytecode, so behind a proxy it
 *      would hold whoever deployed the logic copy, and it gates the write-once
 *      `setSatoriCore`. Wrong silently, not loudly.
 *   2. The upgrade surface itself: governor-gated, identity-pinned, freezable.
 *   3. That claims — cursors, entitlements, the money — survive an upgrade.
 *   4. That lock 1 (the hub pointer) is exactly as write-once as before.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee } = require("../fixtures");
const { deployMerkleProxied } = require("./splitFixture");

const E = (n) => ethers.parseEther(String(n));

async function advanceRounds(n) {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 * n + 1);
}

// OZ StandardMerkleTree leaf: double-hashed abi.encode(account, amount).
const leafOf = (addr, amount) =>
  ethers.keccak256(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount])));

// A merkle proxy wired the way scripts/deploy.js step 7 wires it: publisher +
// token at init, then the two write-once bindings.
async function deployWiredStack(admin, publisher) {
  const fix = await deploySatoriFixtureNoFee();
  const satori = fix.satori;
  const core = await satori.getAddress();
  const merkle = await deployMerkleProxied(publisher.address, fix.token.target);
  await satori.connect(admin).setSatoriMerkle(await merkle.getAddress());
  await merkle.setSatoriCore(core);
  return { ...fix, satori, merkle };
}

describe("SatoriMerkle behind a proxy — upgradeable claim channel", function () {
  this.timeout(180000);

  let fix, satori, rewards, token, merkle;
  let owner, alice, bob, publisher, stranger;

  beforeEach(async function () {
    [owner, alice, bob, publisher, stranger] = await ethers.getSigners();
    fix = await deployWiredStack(owner, publisher);
    ({ satori, rewards, token, merkle } = fix);
    // Give the merkle lane a reserve to draw on (half of each round, 3 rounds).
    await rewards.connect(owner).setOffchainShareBps(5000);
    await advanceRounds(3);
  });

  // ------------------------------------------------------------------
  // 1. Conversion traps
  // ------------------------------------------------------------------
  describe("initialization", function () {
    it("the raw implementation is locked — initialize reverts on it", async function () {
      // An unlocked implementation can be seized by a passer-by, who then owns
      // the publisher role on a contract an operator might still wire up.
      const F = await ethers.getContractFactory("SatoriMerkle");
      const impl = await F.deploy();
      await impl.waitForDeployment();
      await expect(impl.initialize(stranger.address, token.target))
        .to.be.revertedWithCustomError(impl, "AlreadyInitialized");
      // ...and it is inert, not merely un-initializable: the constructor sets NO
      // state at all, so there is no publisher to publish roots and nobody can
      // even bind a core to it. (The other children's constructors do set
      // `deployer`; this one deliberately does not.)
      expect(await impl.rootPublisher()).to.equal(ethers.ZeroAddress);
      expect(await impl.satoriToken()).to.equal(ethers.ZeroAddress);
      await expect(impl.connect(owner).setSatoriCore(await satori.getAddress()))
        .to.be.revertedWithCustomError(impl, "Unauthorized");
    });

    it("initialize is one-shot through the proxy", async function () {
      await expect(merkle.initialize(stranger.address, token.target))
        .to.be.revertedWithCustomError(merkle, "AlreadyInitialized");
      expect(await merkle.rootPublisher()).to.equal(publisher.address);
    });

    it("initialize rejects a zero rootPublisher (the role has no recovery path)", async function () {
      await expect(deployMerkleProxied(ethers.ZeroAddress, token.target)).to.be.reverted;
    });

    it("initialize rejects a bogus upgrade anchor while the deploy can still be redone", async function () {
      // `satoriToken` is the ONLY thing that can authorize an upgrade and there
      // is no setter for it, so a wrong-but-non-zero value is a permanent,
      // invisible freeze of upgradeTo AND renounceUpgrade. Probe it once, loudly.
      for (const bogus of [
        stranger.address,            // an EOA — governor pasted into the token slot
        await satori.getAddress(),   // a real contract with no governor()
        ethers.ZeroAddress,
      ]) {
        await expect(deployMerkleProxied(publisher.address, bogus)).to.be.reverted;
      }
      // ...and the real token still constructs, so the probe is not "reject everything".
      await expect(deployMerkleProxied(publisher.address, token.target)).to.not.be.reverted;
    });

    it("THE TRAP: setSatoriCore authenticates the PROXY deployer, not the implementation deployer", async function () {
      // `deployer` used to be `address private immutable` — a value in the
      // IMPLEMENTATION's bytecode. Behind a proxy an immutable is read from the
      // logic copy, so the one-shot core binding would have been gated to
      // whoever deployed the logic (often a different key, or a shared impl),
      // and the deploy script's own setSatoriCore would revert Unauthorized.
      const F = await ethers.getContractFactory("SatoriMerkle");
      const implFromStranger = await F.connect(stranger).deploy(); // impl deployed by X
      await implFromStranger.waitForDeployment();
      const initData = F.interface.encodeFunctionData(
        "initialize", [publisher.address, token.target]);
      const proxy = await (await ethers.getContractFactory("SatoriProxy"))
        .connect(owner).deploy(await implFromStranger.getAddress(), initData); // proxy deployed by Y
      await proxy.waitForDeployment();
      const m = F.attach(await proxy.getAddress());

      const core = await satori.getAddress();
      await expect(m.connect(stranger).setSatoriCore(core))
        .to.be.revertedWithCustomError(m, "Unauthorized"); // impl deployer has NO power here
      await (await m.connect(owner).setSatoriCore(core)).wait(); // proxy deployer does
      expect(await m.satoriCore()).to.equal(core);
    });

    it("setSatoriCore is still write-once", async function () {
      await expect(merkle.setSatoriCore(await satori.getAddress()))
        .to.be.revertedWithCustomError(merkle, "AlreadySet");
    });

    it("the reentrancy guard works even though its constructor never ran", async function () {
      // OZ ReentrancyGuard is slot 0 and sets _status = NOT_ENTERED (1) in a
      // CONSTRUCTOR, which a proxy never runs — so behind the proxy it starts at
      // 0. That is still correct (0 != ENTERED), it just pays the cold-slot write
      // once. Assert the actual slot rather than trusting the reasoning.
      expect(await ethers.provider.getStorage(merkle.target, 0)).to.equal(ethers.ZeroHash);
      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(10)));
      await (await merkle.connect(alice).claimMerkle(E(10), [])).wait();
      expect(BigInt(await ethers.provider.getStorage(merkle.target, 0))).to.equal(1n); // NOT_ENTERED
    });
  });

  // ------------------------------------------------------------------
  // 2. The upgrade surface
  // ------------------------------------------------------------------
  describe("upgradeTo", function () {
    const freshMerkleImpl = async () => {
      const impl = await (await ethers.getContractFactory("SatoriMerkle")).deploy();
      await impl.waitForDeployment();
      return await impl.getAddress();
    };

    it("is gated to the token governor", async function () {
      const impl = await freshMerkleImpl();
      await expect(merkle.connect(stranger).upgradeTo(impl))
        .to.be.revertedWithCustomError(merkle, "UpgradeUnauthorized");
      await (await merkle.connect(owner).upgradeTo(impl)).wait();
      expect(await merkle.implementation()).to.equal(impl);
    });

    it("anchors on the token in PROXY storage, and that token's live governor", async function () {
      expect(await merkle.satoriToken()).to.equal(token.target);
      expect(await token.rootAuthority()).to.equal(owner.address);
    });

    it("rejects a non-UUPS contract and a codeless address", async function () {
      await expect(merkle.connect(owner).upgradeTo(token.target))
        .to.be.revertedWithCustomError(merkle, "UpgradeBadImplementation");
      await expect(merkle.connect(owner).upgradeTo(stranger.address))
        .to.be.revertedWithCustomError(merkle, "UpgradeBadImplementation");
    });

    it("rejects a sibling implementation (contractId identity pin)", async function () {
      // Every contract in the stack answers the same ERC-1967 slot, so the
      // ERC-1822 handshake alone cannot tell a Games impl from a Merkle impl.
      // A cross-install would land foreign code on live claim storage.
      const games = await (await ethers.getContractFactory("SatoriGames")).deploy();
      await games.waitForDeployment();
      await expect(merkle.connect(owner).upgradeTo(await games.getAddress()))
        .to.be.revertedWithCustomError(merkle, "UpgradeBadImplementation");
    });

    it("renounceUpgrade freezes THIS proxy forever and nothing else", async function () {
      await (await merkle.connect(owner).renounceUpgrade()).wait();
      expect(await merkle.upgradesRenounced()).to.equal(true);
      await expect(merkle.connect(owner).upgradeTo(await freshMerkleImpl()))
        .to.be.revertedWithCustomError(merkle, "UpgradeUnauthorized");
      // the rest of the stack is untouched — the freeze is per-proxy
      expect(await fix.rewards.upgradesRenounced()).to.equal(false);
      expect(await fix.hub.upgradesRenounced()).to.equal(false);
    });

    // ------------------------------------------------------------------
    // 3. The money survives
    // ------------------------------------------------------------------
    it("an upgrade preserves every byte of claim state, and claims continue across it", async function () {
      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(100)));
      await (await merkle.connect(alice).claimMerkle(E(100), [])).wait();

      const before = {
        core: await merkle.satoriCore(),
        publisher: await merkle.rootPublisher(),
        root: await merkle.merkleRoot(),
        cursor: await merkle.alreadyMintedTo(alice.address),
        total: await satori.merkleMinted(),
        token: await merkle.satoriToken(),
      };

      const impl = await freshMerkleImpl();
      await (await merkle.connect(owner).upgradeTo(impl)).wait();

      expect(await merkle.satoriCore()).to.equal(before.core);
      expect(await merkle.rootPublisher()).to.equal(before.publisher);
      expect(await merkle.merkleRoot()).to.equal(before.root);
      expect(await merkle.alreadyMintedTo(alice.address)).to.equal(before.cursor);
      expect(await satori.merkleMinted()).to.equal(before.total);
      expect(await merkle.satoriToken()).to.equal(before.token);

      // the channel is not merely readable — it still pays, cumulatively, off
      // the pre-upgrade cursor (a fresh contract would mint the full 250 again)
      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(250)));
      await (await merkle.connect(alice).claimMerkle(E(250), [])).wait();
      expect(await token.balanceOf(alice.address)).to.equal(E(250));
      expect(await satori.merkleMinted()).to.equal(E(250));
    });

    it("a publisher rotation started before an upgrade completes after it", async function () {
      await merkle.connect(publisher).setRootPublisher(bob.address);
      await (await merkle.connect(owner).upgradeTo(await freshMerkleImpl())).wait();
      expect(await merkle.pendingRootPublisher()).to.equal(bob.address);
      await (await merkle.connect(bob).acceptRootPublisher()).wait();
      expect(await merkle.rootPublisher()).to.equal(bob.address);
    });
  });

  // ------------------------------------------------------------------
  // 4. Lock 1 is untouched
  // ------------------------------------------------------------------
  describe("the hub pointer is still write-once (lock 1 kept)", function () {
    it("a second setSatoriMerkle reverts AlreadySet — claims can never be redirected", async function () {
      const other = await deployMerkleProxied(publisher.address, token.target);
      await expect(satori.connect(owner).setSatoriMerkle(await other.getAddress()))
        .to.be.revertedWithCustomError(satori, "AlreadySet");
    });

    it("an upgrade cannot move the lane: the hub still points at the same proxy", async function () {
      const hubPointer = await fix.hub.merkle();
      expect(hubPointer).to.equal(merkle.target);
      const impl = await (await ethers.getContractFactory("SatoriMerkle")).deploy();
      await impl.waitForDeployment();
      await (await merkle.connect(owner).upgradeTo(await impl.getAddress())).wait();
      expect(await fix.hub.merkle()).to.equal(hubPointer); // the address users claim against
    });
  });
});
