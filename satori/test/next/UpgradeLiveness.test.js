// UPGRADE LIVENESS — "can this proxy still be upgraded?" as a first-class,
// machine-checked property of EVERY proxy, at EVERY point in its life.
//
// WHY THIS FILE EXISTS (the SatoriRewards near-miss, commit 3d898dd8):
// SatoriRewards overrode `_validateNewImplementation` to pin an immutable
// MARKETING_FEE_RECIPIENT read off the CANDIDATE's address. When that value
// moved to proxy storage, the same pin started reading a raw implementation's
// own (or uninitialized) storage. Every future upgrade would have reverted —
// a permanent brick — and the 13 tests in ProxyUpgrades.test.js would have
// stayed GREEN, because they only ever upgrade a proxy ONCE, from a pristine
// fixture, to an implementation deployed with the fixture's own arguments.
//
// Three structural blind spots, one test group each:
//   A. ONE upgrade proves nothing about the NEXT one. `upgradeTo` runs the
//      OUTGOING implementation's validator; the INCOMING one is never exercised.
//      -> "upgrade closure": every proxy upgrades three times in a row.
//   B. A validator is only tested against a candidate built from the SAME
//      arguments as the live contract, so a validator that compares against
//      MUTABLE state is indistinguishable from one that compares against
//      bytecode. -> "validator satisfiability after state moves".
//   C. Nothing asserts the NEGATIVE space: which addresses must NOT install.
//      -> "poison address matrix" (proxies and siblings must be rejected).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySplitCompatFixture,
  TEST_PLATFORM_FEE_RECIPIENT,
  TEST_MARKETING_FEE_RECIPIENT,
} = require("./splitFixture");
const { VOTE } = require("../fixtures");

const fix = () => deploySplitCompatFixture(2000);

// Every upgradeable contract in the system. The engine is INCLUDED: it carries a
// hand-copied upgrade block rather than inheriting SatoriUUPS, so it must be
// swept by the same tests or hardening silently skips the one proxy with no
// re-point path.
const ALL = [
  ["SatoriVoting", "voting"],
  ["SatoriRewards", "rewards"],
  ["SatoriRegistry", "registry"],
  ["SatoriGames", "games"],
  ["SatoriBounties", "bounties"],
  ["SatoriHub", "hub"],
  ["SatoriEngine", "engine"],
  // SatoriMerkle became upgradeable 2026-08-01
  // (docs/issues/closed/merkle-behind-a-proxy-decision.md). It is swept here for the
  // same reason the engine is: a proxy nobody proves is still upgradeable is a
  // proxy that quietly stops being one.
  ["SatoriMerkle", "merkle"],
];

function ctorArgs(name, f) {
  switch (name) {
    case "SatoriVoting": return [];
    case "SatoriRewards": return [f.voting.target, f.owner.address, TEST_MARKETING_FEE_RECIPIENT];
    case "SatoriRegistry": return [];
    case "SatoriGames": return [];
    case "SatoriBounties": return [];
    case "SatoriEngine": return [];
    case "SatoriHub": return [f.token.target, f.engine.target, f.voting.target,
      f.rewards.target, f.registry.target, f.games.target, f.bounties.target];
    case "SatoriMerkle": return [];
    default: throw new Error(name);
  }
}

async function freshImpl(name, args) {
  const F = await ethers.getContractFactory(name);
  const impl = await F.deploy(...args);
  await impl.waitForDeployment();
  return await impl.getAddress();
}

// A cheap liveness probe usable from ANY test: the proxy must still accept a
// canonical fresh implementation of its own contract. Exported so other suites
// can assert "whatever I just did, upgrades still work".
async function assertUpgradePathAlive(f, name, key) {
  const impl = await freshImpl(name, ctorArgs(name, f));
  await (await f[key].connect(f.owner).upgradeTo(impl)).wait();
  expect(await f[key].implementation()).to.equal(impl);
}

describe("Upgrade liveness: a proxy that can be upgraded once can always be upgraded again", function () {
  this.timeout(300000);

  // ------------------------------------------------------------------
  // A. UPGRADE CLOSURE — the property a single upgrade cannot prove.
  // ------------------------------------------------------------------
  it("A1: every proxy upgrades THREE times in a row (upgrade closure)", async function () {
    // `upgradeTo` executes the OUTGOING implementation's code: its
    // onlyUpgradeGovernor, its renounce check, its _validateNewImplementation.
    // So a SINGLE upgrade tells you the OLD code accepted the new one — it says
    // nothing about whether the NEW code can move on. Only the second hop
    // exercises the newly-installed validator; the third proves it is stable
    // rather than alternating.
    const f = await loadFixture(fix);
    for (const [name, key] of ALL) {
      const hops = [];
      for (let i = 0; i < 3; i++) {
        const impl = await freshImpl(name, ctorArgs(name, f));
        await (await f[key].connect(f.owner).upgradeTo(impl)).wait();
        expect(await f[key].implementation(), `${name} hop ${i + 1}`).to.equal(impl);
        hops.push(impl);
      }
      expect(new Set(hops).size, `${name} hops must be distinct addresses`).to.equal(3);
      // still not frozen, still readable
      expect(await f[key].upgradesRenounced(), `${name} must not have self-renounced`).to.equal(false);
    }
  });

  it("A2: upgrade closure holds when the proxy carries real, mutated state", async function () {
    // A1 runs on a pristine fixture. A validator that compares a candidate's
    // bytecode value against LIVE PROXY STORAGE passes trivially while the two
    // still agree. Build state first, then upgrade twice.
    const f = await loadFixture(fix);
    const { satori, owner, registry, games } = f;

    // The old 4th arg was the per-stream valueProviderCutBps; providers are no
    // longer paid at all, so the overload is (name, provider, minCadenceRounds).
    const rcpt = await (await satori["createSimpleDataStream(string,address,uint24)"](
      "LIVENESS", owner.address, 720)).wait();
    let sid;
    for (const log of rcpt.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") { sid = Number(p.args.streamId); break; }
      } catch { /* not ours */ }
    }
    const gid = Number(await games.binaryGameByStream(sid));
    await (await f.voting.connect(owner).setGameApproved(gid, true)).wait();
    await (await registry.setValue(sid, 1000)).wait();
    await (await satori.vote(gid, VOTE)).wait();
    await (await satori.predictMultipleWithPayloads([{ gameId: gid, payload: "0x01" }])).wait();

    for (const [name, key] of ALL) {
      await assertUpgradePathAlive(f, name, key);
      await assertUpgradePathAlive(f, name, key); // the hop that matters
    }
    // state survived both hops
    expect((await registry.getDataStreamInfo(sid)).name).to.equal("LIVENESS");
  });

  it("A3: a MODERNIZED implementation is itself upgradeable (V1 -> V2 -> V1 -> V2)", async function () {
    // ProxyUpgrades.test.js upgrades voting to VotingV2Mock and stops. If V2 had
    // introduced a validator, a renounce, or a broken _upgradeGovernor, the
    // suite would still be green and the proxy would be dead. An upgrade target
    // is only acceptable if you can also upgrade AWAY from it.
    const f = await loadFixture(fix);
    // Real, non-default voting state to carry across the hops: burn for a game
    // so `weightOf`/`totalBurnedWeight` are non-zero (the old probe read the
    // heap's `maxEligibleGames`, which burn voting removed).
    const rcpt = await (await f.satori["createSimpleDataStream(string,address,uint24)"](
      "V2STATE", f.owner.address, 720)).wait();
    let sid;
    for (const log of rcpt.logs) {
      try {
        const p = f.registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") { sid = Number(p.args.streamId); break; }
      } catch { /* not ours */ }
    }
    const gid = Number(await f.games.binaryGameByStream(sid));
    await (await f.voting.connect(f.owner).setGameApproved(gid, true)).wait();
    await (await f.satori.vote(gid, VOTE)).wait();
    const weightBefore = await f.voting.weightOf(gid);
    const burnedBefore = await f.voting.totalBurnedWeight();
    expect(weightBefore).to.equal(VOTE);

    const v2 = await freshImpl("VotingV2Mock", []);
    await (await f.voting.connect(f.owner).upgradeTo(v2)).wait();
    const asV2 = (await ethers.getContractFactory("VotingV2Mock")).attach(f.voting.target);
    expect(await asV2.version()).to.equal(2n);
    expect(await asV2.weightOf(gid)).to.equal(weightBefore);
    expect(await asV2.totalBurnedWeight()).to.equal(burnedBefore);

    // ...and back off it, and onto it again.
    await assertUpgradePathAlive(f, "SatoriVoting", "voting");
    const v2b = await freshImpl("VotingV2Mock", []);
    await (await f.voting.connect(f.owner).upgradeTo(v2b)).wait();
    expect(await asV2.version()).to.equal(2n);
    expect(await asV2.weightOf(gid)).to.equal(weightBefore);
    expect(await asV2.totalBurnedWeight()).to.equal(burnedBefore);
    await assertUpgradePathAlive(f, "SatoriVoting", "voting");
  });

  // ------------------------------------------------------------------
  // B. VALIDATOR SATISFIABILITY — the exact shape of the L1 near-miss.
  // ------------------------------------------------------------------
  it("B1: rewards stays upgradeable AFTER the marketing recipient is rotated", async function () {
    // THE REGRESSION TEST FOR commit 3d898dd8. The removed pin read
    // MARKETING_FEE_RECIPIENT off the candidate and compared it to the live
    // value. While the value was an immutable and every fresh impl was compiled
    // with the same constructor argument, that comparison was tautologically
    // true and untestable. Rotating the live value first makes the two sources
    // DISAGREE, which is what any storage-vs-bytecode validator cannot survive.
    const f = await loadFixture(fix);
    const newRecipient = f.signers[8];

    await ethers.provider.send("hardhat_impersonateAccount", [TEST_MARKETING_FEE_RECIPIENT]);
    await ethers.provider.send("hardhat_setBalance", [TEST_MARKETING_FEE_RECIPIENT, "0x56bc75e2d63100000"]);
    const cur = await ethers.getSigner(TEST_MARKETING_FEE_RECIPIENT);
    await (await f.rewards.connect(cur).transferMarketingFeeRecipient(newRecipient.address)).wait();
    await (await f.rewards.connect(newRecipient).acceptMarketingFeeRecipient()).wait();
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [TEST_MARKETING_FEE_RECIPIENT]);
    expect(await f.rewards.marketingFeeRecipient()).to.equal(newRecipient.address);

    // The live value now differs from every impl the deploy scripts can build.
    await assertUpgradePathAlive(f, "SatoriRewards", "rewards");
    await assertUpgradePathAlive(f, "SatoriRewards", "rewards");
    expect(await f.rewards.marketingFeeRecipient()).to.equal(newRecipient.address);
  });

  it("B2: every validator is satisfiable by an impl built ONLY from public on-chain reads", async function () {
    // An operator preparing an upgrade has the deployed addresses and the public
    // getters — nothing else. If a validator can only be satisfied by a value
    // that is not readable on chain (a lost constructor argument, a rotated
    // storage value baked into old bytecode), the proxy is bricked for anyone
    // who was not present at deploy. So: rebuild each candidate from live reads.
    const f = await loadFixture(fix);
    const hubImpl = await freshImpl("SatoriHub", [
      await f.hub.satoriToken(),   // live read, not the fixture variable
      await f.hub.engine(),
      await f.hub.voting(), await f.hub.rewards(), await f.hub.registry(),
      await f.hub.games(), await f.hub.bounties(),
    ]);
    await (await f.hub.connect(f.owner).upgradeTo(hubImpl)).wait();
    expect(await f.hub.implementation()).to.equal(hubImpl);

    const rewardsImpl = await freshImpl("SatoriRewards", [
      await f.rewards.satoriVoting(), await f.rewards.admin(),
      await f.rewards.marketingFeeRecipient(),
    ]);
    await (await f.rewards.connect(f.owner).upgradeTo(rewardsImpl)).wait();
    expect(await f.rewards.implementation()).to.equal(rewardsImpl);
  });

  it("B3: upgrade authority resolves to the real token's live governor on all 8", async function () {
    // `_upgradeGovernor()` is a staticcall into whatever address the initializer
    // wrote. A wrong-but-non-zero value there kills upgradeTo AND renounceUpgrade
    // for every caller, with no on-chain symptom. Assert the anchor, not just
    // that today's governor happens to work.
    const f = await loadFixture(fix);
    const tokenAddr = f.token.target;
    for (const [name, key] of ALL) {
      const anchor = name === "SatoriEngine" ? await f.engine.token() : await f[key].satoriToken();
      expect(anchor, `${name} upgrade anchor`).to.equal(tokenAddr);
      // and it actually resolves to a live, non-zero governor
      const gov = await f.token.rootAuthority();
      expect(gov).to.not.equal(ethers.ZeroAddress);
      expect(gov).to.equal(f.owner.address);
    }
  });

  it("B4: a BOGUS upgrade anchor is rejected at construction, not silently years later", async function () {
    // B3 asserts a good deploy has a good anchor. That is the positive case, and
    // it cannot fail for the reason we care about: the anchor is write-once with
    // no setter, so a wrong-but-non-zero value is a permanent, INVISIBLE freeze
    // of both upgradeTo and renounceUpgrade. Business logic keeps working, so
    // nothing surfaces until the first attempted upgrade — potentially years in,
    // with all state already committed to that proxy.
    //
    // The pre-fix guard was `_token != address(0)`, which catches none of the
    // realistic slips. Assert the NEGATIVE case: each of them must revert while
    // the deploy can still simply be re-run.
    const f = await loadFixture(fix);
    const F = await ethers.getContractFactory("SatoriRegistry");
    const impl = await F.deploy();
    await impl.waitForDeployment();
    const P = await ethers.getContractFactory("SatoriProxy");
    const initWith = (t) => F.interface.encodeFunctionData("initialize", [t]);

    const bogus = [
      ["an EOA (governor address pasted into the token slot)", f.signers[9].address],
      ["a wrong contract with no governor()", await f.voting.getAddress()],
      ["the zero address", ethers.ZeroAddress],
    ];
    for (const [why, addr] of bogus) {
      await expect(P.deploy(impl.target, initWith(addr)), why).to.be.reverted;
    }

    // ...and the real token still constructs, so the probe is not just
    // "reject everything".
    await expect(P.deploy(impl.target, initWith(f.token.target))).to.not.be.reverted;
  });

  // ------------------------------------------------------------------
  // C. NEGATIVE SPACE — which addresses must NEVER install.
  // ------------------------------------------------------------------
  it("C1: NO SatoriProxy address is installable as an implementation (8x8 = 64)", async function () {
    // A SatoriProxy answers proxiableUUID() correctly, because its fallback
    // delegatecalls the live implementation, whose proxiableUUID is `pure` and
    // therefore survives the staticcall. So the ERC-1822 handshake — the guard
    // the docs describe as making a mistyped address "never installed and
    // bricked" — is blind to the seven addresses an operator actually handles.
    // Installing one makes the proxy delegatecall itself forever.
    // OZ guards this with `notDelegated` on proxiableUUID; this asserts it.
    const failures = [];
    for (const [name, key] of ALL) {
      for (const [candName, candKey] of ALL) {
        // fresh fixture per attempt: a successful install is unrecoverable, so a
        // single leak would poison every later assertion in the loop
        const g = await loadFixture(fix);
        try {
          await (await g[key].connect(g.owner).upgradeTo(g[candKey].target)).wait();
          failures.push(`${name}.upgradeTo(${candName} PROXY) INSTALLED`);
        } catch { /* rejected — good */ }
      }
    }
    expect(failures, `proxy addresses must never install:\n${failures.join("\n")}`).to.deep.equal([]);
  });

  it("C2: NO sibling implementation is installable (8x7 = 56)", async function () {
    // Every contract in the stack reports the same ERC-1967 slot, so the
    // handshake cannot tell a Rewards impl from a Voting impl. A cross-install
    // lands foreign code on live storage, and the victim's `_upgradeGovernor()`
    // then reads a slot that is zero in the host layout — upgrades dead — while
    // the foreign `initialize` becomes callable by anyone.
    const f = await loadFixture(fix);
    const failures = [];
    for (const [name, key] of ALL) {
      for (const [otherName] of ALL) {
        if (otherName === name) continue;
        const g = await loadFixture(fix);
        const impl = await freshImpl(otherName, ctorArgs(otherName, g));
        try {
          await (await g[key].connect(g.owner).upgradeTo(impl)).wait();
          failures.push(`${name}.upgradeTo(${otherName}Impl) INSTALLED`);
        } catch { /* rejected — good */ }
      }
    }
    expect(failures, `sibling impls must never install:\n${failures.join("\n")}`).to.deep.equal([]);
  });

  it("C3: proxiableUUID() must REVERT when reached through a proxy", async function () {
    // The single root-cause assertion behind C1. One line, no fixture state, and
    // it fails the instant anyone re-adds a `pure`/unguarded proxiableUUID to any
    // upgrade block — including a future hand-copied one.
    const f = await loadFixture(fix);
    for (const [name, key] of ALL) {
      const probe = new ethers.Contract(
        f[key].target, ["function proxiableUUID() view returns (bytes32)"], ethers.provider);
      await expect(probe.proxiableUUID(), `${name} proxy answered proxiableUUID`).to.be.reverted;
    }
    // ...and must still answer correctly on the raw implementation, or the
    // handshake would reject every legitimate upgrade.
    for (const [name] of ALL) {
      const impl = await freshImpl(name, ctorArgs(name, f));
      const probe = new ethers.Contract(
        impl, ["function proxiableUUID() view returns (bytes32)"], ethers.provider);
      expect(await probe.proxiableUUID(), `${name} impl`).to.equal(
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
    }
  });

  it("C4: a proxy that rejected a bad candidate is still fully upgradeable", async function () {
    // Rejection must be a no-op, not a partial write. Sweep every bad-candidate
    // class, then prove the proxy still takes a good one.
    const f = await loadFixture(fix);
    const bad = [f.signers[9].address, f.token.target, f.voting.target, f.games.target];
    for (const [name, key] of ALL) {
      const before = await f[key].implementation();
      for (const b of bad) {
        try { await (await f[key].connect(f.owner).upgradeTo(b)).wait(); } catch { /* expected */ }
        expect(await f[key].implementation(), `${name} impl moved on a rejected candidate`).to.equal(before);
      }
      await assertUpgradePathAlive(f, name, key);
    }
  });
});

module.exports = { assertUpgradePathAlive, ALL, ctorArgs, freshImpl };
