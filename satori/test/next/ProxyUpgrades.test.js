const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySplitCompatFixture, TEST_PLATFORM_FEE_RECIPIENT, TEST_MARKETING_FEE_RECIPIENT } = require("./splitFixture");
const { VOTE } = require("../fixtures");
const { ROUND, FLAT_ROUNDS, rewardsSigner, generalReaching } = require("./emissionHelpers");

// Phase 2 (PHASE2-PROXY-ALL.md): the hub and all five children live behind
// SatoriProxy with governor-gated, individually-renounceable upgradeTo.
// This suite proves the four load-bearing properties per contract:
//   1. upgradeTo is gated to the token's governor,
//   2. an upgrade swaps logic while every byte of state survives,
//   3. renounceUpgrade is per-proxy and permanent,
//   4. initialize is one-shot on the proxy and locked on raw implementations.

const fix = () => deploySplitCompatFixture(2000);

// Deploy a fresh implementation of `name` (same code, new address) suitable
// as an upgrade target. ctorArgs must satisfy the implementation constructor;
// its storage is throwaway (the proxy keeps its own).
async function freshImpl(name, ctorArgs) {
  const F = await ethers.getContractFactory(name);
  const impl = await F.deploy(...ctorArgs);
  await impl.waitForDeployment();
  return impl;
}

// Parse the streamId out of a create tx (DataStreamCreated is emitted by the
// registry, not the hub, so decode against the registry's interface).
async function streamIdFrom(tx, registry) {
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = registry.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
    } catch {}
  }
  throw new Error("DataStreamCreated event missing");
}

function implCtorArgs(name, f) {
  switch (name) {
    // Burn voting removed the top-N eligible cap, so SatoriVoting's constructor
    // no longer takes one — it takes nothing at all.
    case "SatoriVoting": return [];
    case "SatoriRewards": return [f.voting.target, f.owner.address, TEST_MARKETING_FEE_RECIPIENT];
    case "SatoriRegistry": return [];
    case "SatoriGames": return [];
    case "SatoriBounties": return [];
    case "SatoriHub": return [f.token.target, f.engine.target, f.voting.target, f.rewards.target, f.registry.target, f.games.target, f.bounties.target];
    case "SatoriMerkle": return [];
    default: throw new Error(name);
  }
}

const PROXIED = [
  ["SatoriVoting", "voting"],
  ["SatoriRewards", "rewards"],
  ["SatoriRegistry", "registry"],
  ["SatoriGames", "games"],
  ["SatoriBounties", "bounties"],
  ["SatoriHub", "hub"],
  // Joined 2026-08-01 — docs/issues/closed/merkle-behind-a-proxy-decision.md. The
  // fixture's instance is deliberately unwired; the channel's own behaviour
  // lives in test/next/MerkleProxy.test.js.
  ["SatoriMerkle", "merkle"],
];

describe("Phase-2 proxies: upgrade-with-state for hub + children", function () {
  it("upgradeTo is governor-only on every proxied contract", async function () {
    const f = await loadFixture(fix);
    const attacker = f.signers[5];
    for (const [name, key] of PROXIED) {
      const impl = await freshImpl(name, implCtorArgs(name, f));
      await expect(
        f[key].connect(attacker).upgradeTo(await impl.getAddress())
      ).to.be.revertedWithCustomError(f[key], "UpgradeUnauthorized");
    }
  });

  it("upgradeTo rejects a codeless implementation", async function () {
    const f = await loadFixture(fix);
    await expect(
      f.voting.connect(f.owner).upgradeTo(f.signers[7].address)
    ).to.be.revertedWithCustomError(f.voting, "UpgradeBadImplementation");
  });

  it("upgradeTo rejects a contract that is not a UUPS impl (ERC-1822 handshake)", async function () {
    // The token is a real contract but exposes no proxiableUUID() — a stand-in
    // for pasting the wrong address. Without the handshake this would install
    // and brick the proxy forever (phase-2 review, Finding 1).
    const f = await loadFixture(fix);
    await expect(
      f.voting.connect(f.owner).upgradeTo(f.token.target)
    ).to.be.revertedWithCustomError(f.voting, "UpgradeBadImplementation");
  });

  // ---- Engine: its own inline UUPS block (not SatoriUUPS) — audit F5 ----
  it("engine upgradeTo is governor-only", async function () {
    const f = await loadFixture(fix);
    const impl = await freshImpl("SatoriEngine", []);
    await expect(
      f.engine.connect(f.signers[5]).upgradeTo(await impl.getAddress())
    ).to.be.revertedWithCustomError(f.engine, "UpgradeUnauthorized");
  });

  it("engine upgradeTo rejects a non-UUPS impl (ERC-1822 handshake) — audit F5", async function () {
    // The token is a real contract with no proxiableUUID() — a stand-in for a
    // mistyped address. Without the handshake the engine would INSTALL it and
    // brick prediction/scoring forever (the engine owns all predict storage and
    // there is no re-point path: hub holds it immutable, children one-shot, and
    // setChild is gone). This is exactly the F5 gap.
    const f = await loadFixture(fix);
    await expect(
      f.engine.connect(f.owner).upgradeTo(f.token.target)
    ).to.be.revertedWithCustomError(f.engine, "UpgradeBadImplementation");
  });

  it("engine upgradeTo accepts a genuine engine impl (handshake passes)", async function () {
    const f = await loadFixture(fix);
    const impl = await freshImpl("SatoriEngine", []);
    await (await f.engine.connect(f.owner).upgradeTo(await impl.getAddress())).wait();
    expect(await f.engine.implementation()).to.equal(await impl.getAddress());
  });

  it("rewards upgradeTo ALLOWS an impl compiled with a different marketing recipient — storage wins", async function () {
    // The marketing recipient used to be an `immutable`, i.e. a value in the
    // implementation's BYTECODE, so an otherwise-valid UUPS impl compiled with a
    // different one would silently re-route the cut. A `_validateNewImplementation`
    // pin rejected that (phase-2 review, Finding 1) — and this test asserted the
    // rejection.
    //
    // The recipient now lives in PROXY STORAGE, which is the stronger form: an
    // upgrade swaps code, not storage, so a differently-compiled impl cannot move
    // it at all. There is nothing left to reject, so the upgrade is simply
    // ALLOWED and the live value is unaffected. (The old pin was only a speed
    // bump anyway — it ran in the outgoing impl, so a second upgrade that dropped
    // the check defeated it.)
    const f = await loadFixture(fix);
    const before = await f.rewards.marketingFeeRecipient();
    const other = await freshImpl("SatoriRewards", [
      f.voting.target, f.owner.address,
      "0x2222222222222222222222222222222222222222", // != TEST_MARKETING_FEE_RECIPIENT
    ]);
    await expect(f.rewards.connect(f.owner).upgradeTo(await other.getAddress()))
      .to.emit(f.rewards, "Upgraded");
    expect(await f.rewards.marketingFeeRecipient()).to.equal(before);
  });

  it("hub upgradeTo rejects an impl compiled with a different token/engine", async function () {
    // A hub impl wired to a different token would migrate upgrade authority and
    // break the transfer-hook gate (phase-2 review, Findings 1 & 2).
    const f = await loadFixture(fix);
    const otherToken = await (await ethers.getContractFactory("SatoriToken")).deploy(
      f.owner.address, TEST_PLATFORM_FEE_RECIPIENT, (await ethers.provider.getNetwork()).chainId);
    await otherToken.waitForDeployment();
    const evil = await freshImpl("SatoriHub", [
      await otherToken.getAddress(), f.engine.target,
      f.voting.target, f.rewards.target, f.registry.target, f.games.target, f.bounties.target,
    ]);
    await expect(
      f.hub.connect(f.owner).upgradeTo(await evil.getAddress())
    ).to.be.revertedWithCustomError(f.hub, "UpgradeBadImplementation");
  });

  it("upgrading every proxy preserves state and the system keeps working", async function () {
    const f = await loadFixture(fix);
    const { satori, owner, registry, rewards, voting, games, bounties, hub } = f;

    // --- build real pre-upgrade state across every child ---
    // The fixture initializes the default stream at id 1, so this one is id 2.
    const sid = await streamIdFrom(
      await satori["createSimpleDataStream(string,address,uint24)"]("UP/GRADE", owner.address, 720),
      registry
    );
    expect(sid).to.be.a("number");
    const gid = Number(await games.binaryGameByStream(sid));
    expect(gid).to.be.greaterThan(0);
    // Games are opt-in now; this fixture has no auto-approving wrapper.
    await (await voting.connect(owner).setGameApproved(gid, true)).wait();
    await (await registry.setValue(sid, 1000)).wait();
    // Burn-backed vote: destroys VOTE SATORI and buys the game that much
    // permanent weight, which is the voting-side state the upgrade must preserve.
    await (await satori.vote(gid, VOTE)).wait();
    await (await satori.predictMultipleWithPayloads([{ gameId: gid, payload: "0x01" }])).wait();

    const pre = {
      streamName: (await registry.getDataStreamInfo(sid)).name,
      cadence: await registry.streamMinCadenceMinutes(sid),
      gameVotes: await voting.gameWeight(gid),
      burnedTotal: await voting.totalBurnedWeight(),
      admin: await rewards.admin(),
      offchainBudget: await rewards.offchainBudget(),
      onChainMinted: await hub.onChainMinted(),
      gamesCount: await games.gameCount(),
      predictedCount: await satori.predictedStreamsCount(owner.address, await satori.getCurrentRound()),
    };

    // --- upgrade ALL SIX mid-flight (same code, fresh implementations) ---
    for (const [name, key] of PROXIED) {
      const impl = await freshImpl(name, implCtorArgs(name, f));
      await (await f[key].connect(owner).upgradeTo(await impl.getAddress())).wait();
      expect(await f[key].implementation()).to.equal(await impl.getAddress());
    }

    // --- every byte of state survived ---
    expect((await registry.getDataStreamInfo(sid)).name).to.equal(pre.streamName);
    expect(await registry.streamMinCadenceMinutes(sid)).to.equal(pre.cadence);
    expect(await voting.gameWeight(gid)).to.equal(pre.gameVotes);
    expect(await voting.totalBurnedWeight()).to.equal(pre.burnedTotal);
    expect(await rewards.admin()).to.equal(pre.admin);
    expect(await rewards.offchainBudget()).to.equal(pre.offchainBudget);
    expect(await hub.onChainMinted()).to.equal(pre.onChainMinted);
    expect(await games.gameCount()).to.equal(pre.gamesCount);
    expect(await satori.predictedStreamsCount(owner.address, await satori.getCurrentRound())).to.equal(pre.predictedCount);
    expect(await bounties.satoriToken()).to.equal(f.token.target);

    // --- and the upgraded system settles the pre-upgrade prediction ---
    const ROUND = 86400;
    const bump = async () => {
      const t = (await ethers.provider.getBlock("latest")).timestamp;
      // a full round + slack from the LAST block, so both the round-index and
      // the wall-clock (cadence - 30min) guards on setValue are satisfied
      await ethers.provider.send("evm_setNextBlockTimestamp", [t + ROUND + 5]);
      await ethers.provider.send("evm_mine", []);
    };
    await bump();
    await (await registry.setValue(sid, 1100)).wait(); // above anchor -> UP wins
    await bump();
    await (await registry.setValue(sid, 1200)).wait();
    await (await satori.settlePrediction(owner.address, gid)).wait();
    expect(await satori.streaks(owner.address, gid)).to.equal(1n);
  });

  it("a real V2 implementation lands with old state intact and new behavior live", async function () {
    const f = await loadFixture(fix);

    // Real, hard-won state: SATORI burned to buy a game permanent weight. If an
    // upgrade lost this, the burn would be unrecoverable — nothing can re-mint it.
    const sid = await streamIdFrom(
      await f.satori.createSimpleDataStream("V2", f.owner.address), f.registry
    );
    const gid = Number(await f.games.binaryGameByStream(sid));
    await (await f.voting.connect(f.owner).setGameApproved(gid, true)).wait();
    await (await f.satori.vote(gid, VOTE)).wait();
    const weightBefore = await f.voting.gameWeight(gid);
    const totalBefore = await f.voting.totalBurnedWeight();
    expect(weightBefore).to.equal(VOTE);

    const v2 = await freshImpl("VotingV2Mock", []);
    await (await f.voting.connect(f.owner).upgradeTo(await v2.getAddress())).wait();

    const upgraded = (await ethers.getContractFactory("VotingV2Mock")).attach(f.voting.target);
    expect(await upgraded.version()).to.equal(2n);                      // new behavior
    expect(await upgraded.gameWeight(gid)).to.equal(weightBefore);      // old state
    expect(await upgraded.totalBurnedWeight()).to.equal(totalBefore);
  });

  it("renounceUpgrade is per-proxy and permanent", async function () {
    const f = await loadFixture(fix);
    await (await f.games.connect(f.owner).renounceUpgrade()).wait();
    expect(await f.games.upgradesRenounced()).to.equal(true);

    const impl = await freshImpl("SatoriGames", []);
    await expect(
      f.games.connect(f.owner).upgradeTo(await impl.getAddress())
    ).to.be.revertedWithCustomError(f.games, "UpgradeUnauthorized");

    // per-proxy: voting is untouched and still upgradeable
    expect(await f.voting.upgradesRenounced()).to.equal(false);
    const vImpl = await freshImpl("SatoriVoting", []);
    await (await f.voting.connect(f.owner).upgradeTo(await vImpl.getAddress())).wait();
  });

  it("initialize is one-shot on every proxy", async function () {
    const f = await loadFixture(fix);
    const t = f.token.target;
    await expect(f.voting.initialize(t)).to.be.revertedWithCustomError(f.voting, "AlreadyInitialized");
    await expect(f.rewards.initialize(f.voting.target, f.owner.address, t, f.owner.address)).to.be.revertedWithCustomError(f.rewards, "AlreadyInitialized");
    await expect(f.registry.initialize(t)).to.be.revertedWithCustomError(f.registry, "AlreadyInitialized");
    await expect(f.games.initialize(t)).to.be.revertedWithCustomError(f.games, "AlreadyInitialized");
    await expect(f.bounties.initialize(t)).to.be.revertedWithCustomError(f.bounties, "AlreadyInitialized");
    await expect(f.hub.initialize(f.voting.target, f.rewards.target, f.registry.target, f.games.target, f.bounties.target))
      .to.be.revertedWithCustomError(f.hub, "AlreadyInitialized");
    await expect(f.merkle.initialize(f.owner.address, t)).to.be.revertedWithCustomError(f.merkle, "AlreadyInitialized");
  });

  it("neither a re-initialize nor an upgrade resets the hub's emission schedule", async function () {
    const f = await loadFixture(fix);
    const { hub, rewards, token, owner } = f;
    const rw = await rewardsSigner(rewards);
    const e0 = await hub.emission();
    const allowance0 = await hub.onChainAllowance();
    // Untouched rounds are priced together at the next touch, so after this
    // warp one real report reaches the first step inside both the allowance
    // and the token's envelope.
    await time.increase(Number(FLAT_ROUNDS) * ROUND);
    await (await hub.connect(rw).freezeRoundGross(await token.getCurrentRound())).wait();
    const toStep = e0.nextStepAt - (await hub.emission()).issued;
    await (await hub.connect(rw).noteIssued(generalReaching(toStep, await token.devFeeBps()))).wait();
    await (await hub.connect(owner).setEmissionRatio(10n ** 18n)).wait();
    await (await hub.connect(owner).setEmissionAuthority(f.signers[1].address)).wait();
    const moved = await hub.emission();
    const allowance = await hub.onChainAllowance();
    const priced = await hub.onChainPricedRound();
    expect(moved.stepsTaken).to.equal(1n);
    expect(moved.issued).to.be.gt(e0.issued);
    expect(allowance).to.be.gt(allowance0);

    await expect(hub.initialize(f.voting.target, f.rewards.target, f.registry.target, f.games.target, f.bounties.target))
      .to.be.revertedWithCustomError(hub, "AlreadyInitialized");
    const impl = await freshImpl("SatoriHub", implCtorArgs("SatoriHub", f));
    await (await hub.connect(owner).upgradeTo(await impl.getAddress())).wait();
    await expect(hub.initialize(f.voting.target, f.rewards.target, f.registry.target, f.games.target, f.bounties.target))
      .to.be.revertedWithCustomError(hub, "AlreadyInitialized");

    expect(await hub.emission()).to.deep.equal(moved);
    expect(await hub.onChainAllowance()).to.equal(allowance);
    expect(await hub.onChainPricedRound()).to.equal(priced);
    expect(await hub.emissionHolder()).to.equal(f.signers[1].address);
  });

  // A hub proxy that predates the schedule never ran `_init`'s seeding, so an
  // in-place upgrade leaves slots 18-21 zero. Redeploy-only: that state must
  // revert, never take a ratio-0 step that ends emission for good.
  it("an upgraded hub whose emission slots were never written fails loudly instead of ending emission", async function () {
    const f = await loadFixture(fix);
    const { hub, rewards, owner } = f;
    for (let slot = 18; slot <= 21; slot++) {
      await ethers.provider.send("hardhat_setStorageAt", [hub.target, ethers.toBeHex(slot), ethers.ZeroHash]);
    }
    const impl = await freshImpl("SatoriHub", implCtorArgs("SatoriHub", f));
    await (await hub.connect(owner).upgradeTo(await impl.getAddress())).wait();
    expect((await hub.emission()).from).to.equal(0n);

    await expect(hub.syncEmission()).to.be.revertedWithCustomError(hub, "EmissionUnseeded");
    await expect(hub.emissionCeiling()).to.be.revertedWithCustomError(hub, "EmissionUnseeded");
    const rw = await rewardsSigner(rewards);
    // Nothing is reported (0), so the allowance check does not fire first: the
    // step logic itself must refuse an unseeded schedule.
    await expect(hub.connect(rw).noteIssued(0n)).to.be.revertedWithCustomError(hub, "EmissionUnseeded");
    expect((await hub.emission()).nextStepAt).to.equal(0n);
  });

  it("raw (direct-deployed) implementations are locked against initialize", async function () {
    const f = await loadFixture(fix);
    for (const [name] of PROXIED) {
      const impl = await freshImpl(name, implCtorArgs(name, f));
      const args = {
        SatoriVoting: [f.token.target],
        SatoriRewards: [f.voting.target, f.owner.address, f.token.target, f.owner.address],
        SatoriRegistry: [f.token.target],
        SatoriGames: [f.token.target],
        SatoriBounties: [f.token.target],
        SatoriHub: [f.voting.target, f.rewards.target, f.registry.target, f.games.target, f.bounties.target],
        SatoriMerkle: [f.owner.address, f.token.target],
      }[name];
      await expect(impl.initialize(...args)).to.be.revertedWithCustomError(impl, "AlreadyInitialized");
    }
  });
});
