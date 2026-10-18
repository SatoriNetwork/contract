const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySplitCompatFixture } = require("./splitFixture");

// Progressive-rollout capability flags. Ids must match SatoriHub's CAP_* and the
// bit positions read by SatoriRewards.capabilityAllowed. The flag storage + admin
// setter live on SatoriRewards (it owns the `admin` role); the hub and bounties
// gate their user entry points against it.
//
// The ids are a dense 0..7. Removing a capability renumbers the ones above it —
// intended pre-launch, because the policy is one stored word and every
// deployment starts it at zero. That stops being safe only once a live bitmap
// has to survive a change.
const CAP = {
  CREATE_STREAM: 0,
  AUTHOR_GAME: 1,
  REGISTER_STREAM_ADAPTER: 2,
  REGISTER_GAME_ADAPTER: 3,
  BOUNTY: 4,
  DELEGATE_PREDICTION: 5,
  DELEGATE_CLAIM: 6,
  VOTE: 7,
};
const LIVE = Object.values(CAP);           // every bit gates something
const ALL_ON = 0xff;  // bits 0..7 — what the fixture sets
const LAST = 7; // highest capability bit

const fix = () => deploySplitCompatFixture(2000);

describe("Capability flags (progressive rollout)", () => {
  // Every gated entry point + the contract whose CapabilityDisabled error fires.
  // Args are dummies on purpose: the capability gate runs before any other
  // validation in each function.
  function gatedCalls(f, caller) {
    const hub = f.hub.connect(caller);
    const bounties = f.bounties.connect(caller);
    const addr = f.owner.address; // nonzero and not the caller: for the two delegation gates, 0 or the caller is an exit, which is never gated
    const tok = f.token.target;
    return {
      [CAP.CREATE_STREAM]: { c: f.hub, call: () => hub.createSimpleDataStream("x", addr) },
      [CAP.AUTHOR_GAME]: { c: f.hub, call: () => hub.createGame(1, 0, "0x", "x") },
      [CAP.REGISTER_STREAM_ADAPTER]: { c: f.hub, call: () => hub.registerCommunityAdapter(addr, "x") },
      [CAP.REGISTER_GAME_ADAPTER]: { c: f.hub, call: () => hub.registerCommunityGameAdapter(addr, "x") },
      [CAP.BOUNTY]: { c: f.bounties, call: () => bounties.fundBounty(1, tok, 1, 1) },
      [CAP.DELEGATE_PREDICTION]: { c: f.hub, call: () => hub.delegatePredictionPower(addr) },
      [CAP.DELEGATE_CLAIM]: { c: f.hub, call: () => hub.delegateClaimAbility(addr) },
      [CAP.VOTE]: { c: f.hub, call: () => hub.vote(2, 1n) },
    };
  }

  it("setCapabilities is admin-only", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    await expect(f.rewards.connect(stranger).setCapabilities(ALL_ON))
      .to.be.revertedWithCustomError(f.rewards, "Unauthorized");
    await expect(f.rewards.connect(f.owner).setCapabilities(ALL_ON)).to.not.be.reverted;
  });

  it("the fixture leaves every capability enabled (full-featured test env)", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    for (const c of LIVE) {
      expect(await f.rewards.capabilityAllowed(c, stranger.address), `cap ${c}`).to.equal(true);
    }
  });

  it("unset bits read as disabled (default OFF), but the admin is always allowed", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    // Cap 8 — nothing above voting exists — is never set -> disabled.
    expect(await f.rewards.capabilityAllowed(LAST + 1, stranger.address)).to.equal(false);
    // Clear the whole policy: every flag then reads disabled for a non-admin...
    await f.rewards.connect(f.owner).setCapabilities(0);
    for (const c of LIVE) {
      expect(await f.rewards.capabilityAllowed(c, stranger.address), `cap ${c} public`).to.equal(false);
      // ...yet the admin bypasses every flag.
      expect(await f.rewards.capabilityAllowed(c, f.owner.address), `cap ${c} admin`).to.equal(true);
    }
  });

  it("with a capability OFF, a non-admin call reverts CapabilityDisabled (all 8 live caps)", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    await f.rewards.connect(f.owner).setCapabilities(0); // all off
    const calls = gatedCalls(f, stranger);
    for (const c of LIVE) {
      await expect(calls[c].call(), `cap ${c} must be gated`)
        .to.be.revertedWithCustomError(calls[c].c, "CapabilityDisabled");
    }
  });

  it("the removed features have no entry point left on the hub", async () => {
    // Vote bounties and vote delegation were removed with burn voting. Their
    // capability ids were reclaimed rather than burned, so what pins the
    // numbering is this: the functions must be gone from the ABI entirely.
    const f = await loadFixture(fix);
    const names = f.hub.interface.fragments.filter((fr) => fr.type === "function").map((fr) => fr.name);
    expect(names).to.not.include("createVoteBounty");
    expect(names).to.not.include("acceptVoteBounty");
    expect(names).to.not.include("cancelVoteBounty");
    expect(names).to.not.include("setVoteDelegation");
    expect(names).to.not.include("clearVote");
    // Dense ids, no holes. Off-chain game adapters held 7 until 2026-08-20;
    // removing them COMPACTED the list, moving voting 8 -> 7.
    expect(LIVE.slice().sort((a, b) => a - b)).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("stakeBountyToken is gated by CAP_BOUNTY as well", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    await f.rewards.connect(f.owner).setCapabilities(0);
    await expect(f.bounties.connect(stranger).stakeBountyToken(f.token.target, 1))
      .to.be.revertedWithCustomError(f.bounties, "CapabilityDisabled");
  });

  it("the admin bypasses the flag even when the capability is OFF", async () => {
    const f = await loadFixture(fix);
    await f.rewards.connect(f.owner).setCapabilities(0); // all off
    // delegateClaimAbility needs no fee/balance; the admin (owner) passes the gate.
    await expect(f.hub.connect(f.owner).delegateClaimAbility(f.signers[7].address))
      .to.not.be.reverted;
  });

  it("enabling one capability opens exactly that one to the public", async () => {
    const f = await loadFixture(fix);
    const stranger = f.signers[6];
    await f.rewards.connect(f.owner).setCapabilities(0); // all off

    // Off -> the public is blocked.
    await expect(f.hub.connect(stranger).delegateClaimAbility(f.owner.address))
      .to.be.revertedWithCustomError(f.hub, "CapabilityDisabled");

    // Enable ONLY CAP_DELEGATE_CLAIM -> the public may now use it...
    await f.rewards.connect(f.owner).setCapabilities(1 << CAP.DELEGATE_CLAIM);
    await expect(f.hub.connect(stranger).delegateClaimAbility(f.owner.address)).to.not.be.reverted;

    // ...but a sibling capability stays closed.
    await expect(f.hub.connect(stranger).delegatePredictionPower(f.owner.address))
      .to.be.revertedWithCustomError(f.hub, "CapabilityDisabled");
  });
});

describe("Capability flags gate joining, never leaving", () => {
  const { ethers } = require("hardhat");
  const { time } = require("@nomicfoundation/hardhat-network-helpers");
  const { deploySplitFixture } = require("./splitFixture");

  const ROUND = 86400;
  const E = (n) => ethers.parseEther(String(n));
  const BIT = (i) => 1 << i;
  const LANE_A = 0;
  const LOCK_INDEFINITE = 2n ** 24n - 1n;
  const FAR_FUTURE = 4102444800n;
  const RELAY_DELEGATE_PREDICTION = 3;
  const NO_PERMIT = { value: 0n, deadline: 0n, signature: "0x" };
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const full = () => deploySplitFixture();

  async function nextRound() {
    const t = await time.latest();
    await time.increaseTo(Math.floor(t / ROUND) * ROUND + ROUND + 1);
  }

  async function approvedGame({ hub, registry, games, voting, owner }) {
    const rc = await (await hub.connect(owner)["createSimpleDataStream(string,address,uint24)"]("A", owner.address, 1440)).wait();
    const streamId = rc.logs.map((l) => { try { return registry.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "DataStreamCreated").args.streamId;
    const gameId = await games.binaryGameByStream(streamId);
    await voting.connect(owner).setGameApproved(gameId, true);
    return { streamId, gameId };
  }

  async function relayUndelegate(hub, user, relayer) {
    const req = {
      user: user.address, action: RELAY_DELEGATE_PREDICTION,
      data: abi.encode(["address"], [ethers.ZeroAddress]),
      fee: 0n, relayer: relayer.address, nonce: await hub.relayNonces(user.address), deadline: FAR_FUTURE,
    };
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = { name: "SatoriHub", version: "1", chainId, verifyingContract: await hub.getAddress() };
    const types = { RelayRequest: [
      { name: "user", type: "address" }, { name: "action", type: "uint8" }, { name: "data", type: "bytes" },
      { name: "fee", type: "uint256" }, { name: "relayer", type: "address" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
    ] };
    return hub.connect(relayer).relay(req, await user.signTypedData(domain, types, req), NO_PERMIT);
  }

  it("with prediction delegation off, a delegator still leaves (to 0, to itself, by relay) and its tokens move again", async () => {
    const { token, hub, rewards, owner, signers } = await loadFixture(full);
    const [, alice, bob, dave, carol, relayer, sink] = signers;
    await rewards.connect(owner).setCapabilities(BIT(CAP.DELEGATE_PREDICTION));
    for (const u of [alice, bob, dave]) {
      await token.connect(owner).transfer(u.address, E(100));
      await hub.connect(u).delegatePredictionPower(carol.address);
      expect(await token.lockUntil(u.address, LANE_A)).to.equal(LOCK_INDEFINITE);
    }

    await rewards.connect(owner).setCapabilities(0);
    await hub.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    await hub.connect(bob).delegatePredictionPower(bob.address);
    await relayUndelegate(hub, dave, relayer);

    expect((await rewards.predictionDelegateInfo(carol.address)).power).to.equal(0n);
    // Nothing left in the pool carol predicts with.
    expect(await rewards.getPredictionPower(carol.address))
      .to.equal((await token.balanceOf(carol.address)) + (await rewards.unclaimedRewards(carol.address)));
    await nextRound();
    await nextRound();
    for (const u of [alice, bob, dave]) {
      expect((await rewards.predictionDelegateInfo(u.address)).delegate).to.equal(ethers.ZeroAddress);
      await token.connect(u).transfer(sink.address, E(100));
    }
    expect(await token.balanceOf(sink.address)).to.equal(E(300));
  });

  it("with prediction delegation off, joining, switching and returning are still refused", async () => {
    const { token, hub, rewards, owner, signers } = await loadFixture(full);
    const [, alice, bob, dave, carol, erin] = signers;
    await rewards.connect(owner).setCapabilities(BIT(CAP.DELEGATE_PREDICTION));
    for (const u of [alice, bob, dave]) await token.connect(owner).transfer(u.address, E(100));
    await hub.connect(alice).delegatePredictionPower(carol.address);
    await hub.connect(bob).delegatePredictionPower(carol.address);

    await rewards.connect(owner).setCapabilities(0);
    await expect(hub.connect(dave).delegatePredictionPower(carol.address))
      .to.be.revertedWithCustomError(hub, "CapabilityDisabled");
    await expect(hub.connect(alice).delegatePredictionPower(erin.address))
      .to.be.revertedWithCustomError(hub, "CapabilityDisabled");
    // Same round, same delegate: the return door that bit 5 on lets through.
    await hub.connect(bob).delegatePredictionPower(ethers.ZeroAddress);
    await expect(hub.connect(bob).delegatePredictionPower(carol.address))
      .to.be.revertedWithCustomError(hub, "CapabilityDisabled");
  });

  it("with prediction delegation off, a delegator still votes and keeps its delegate", async () => {
    const f = await loadFixture(full);
    const { token, hub, rewards, owner, signers } = f;
    const [, alice, carol] = signers;
    const { gameId } = await approvedGame(f);
    await token.connect(owner).transfer(alice.address, E(100));
    await hub.connect(alice).delegatePredictionPower(carol.address);

    await rewards.connect(owner).setCapabilities(BIT(CAP.VOTE));
    await hub.connect(alice).vote(gameId, E(10));
    expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(carol.address);
    expect((await rewards.predictionDelegateInfo(carol.address)).power).to.equal(E(90));
  });

  it("with claim delegation off, an owner still revokes (to 0 or to itself) and claims its own rewards", async () => {
    const { token, hub, engine, rewards, registry, games, voting, owner, signers } = await loadFixture(full);
    const [, alice, bob, carol, dave] = signers;
    await token.connect(owner).transfer(bob.address, E(100));
    await token.connect(owner).transfer(carol.address, E(50));

    // Bob earns a reward on a weighted game.
    const { streamId, gameId } = await approvedGame({ hub, registry, games, voting, owner });
    await hub.connect(carol).vote(gameId, E(10));
    await nextRound();
    await registry.connect(owner).setValue(streamId, 100);
    await engine.connect(bob).predictMultipleWithPayloads([{ gameId, payload: "0x01" }]);
    await nextRound();
    await registry.connect(owner).setValue(streamId, 110);
    await nextRound();
    await registry.connect(owner).setValue(streamId, 120);
    await engine.connect(carol).settlePrediction(bob.address, gameId);
    const owed = await rewards.unclaimedRewards(bob.address);
    expect(owed).to.be.gt(0n);

    await hub.connect(bob).delegateClaimAbility(dave.address);
    await hub.connect(alice).delegateClaimAbility(dave.address);
    await rewards.connect(owner).setCapabilities(BIT(CAP.DELEGATE_PREDICTION));
    await expect(hub.connect(bob)["claim()"]()).to.be.revertedWithCustomError(rewards, "ClaimDelegatedAway");

    await hub.connect(bob).delegateClaimAbility(ethers.ZeroAddress);
    await hub.connect(alice).delegateClaimAbility(alice.address);
    await expect(hub.connect(dave).claimFor(bob.address, dave.address))
      .to.be.revertedWithCustomError(rewards, "Unauthorized");
    const before = await token.balanceOf(bob.address);
    await hub.connect(bob)["claim()"]();
    expect((await token.balanceOf(bob.address)) - before).to.equal(owed);
    await expect(hub.connect(alice)["claim()"]()).to.not.be.reverted;

    await expect(hub.connect(bob).delegateClaimAbility(dave.address))
      .to.be.revertedWithCustomError(hub, "CapabilityDisabled");
  });
});

// ---------------------------------------------------------------------------
// The capability numbering is a DOCUMENTED interface, and the docs drifted.
//
// On 2026-08-20 LAUNCH_CHECKLIST H1 still listed `VOTE_BOUNTY(4)` and
// `DELEGATE_VOTE(8)` — features the burn-voting migration deleted — and the ids
// after them were shifted by one, because the survivors were COMPACTED rather
// than left with holes. Anyone assembling a bitmap from that list would have
// opened a DIFFERENT capability than the one they named — silently, with no
// error, because every bit is a valid bit. That is the whole risk and it is
// enough: an operator reaching for claim delegation gets something else.
// (An earlier version of this comment inflated that into a specific catastrophe.
// It was wrong on the specifics and the plain version above is the real point.)
//
// The tests above were right the whole time. Nothing connected them to the
// prose, so nothing failed. This does.
describe("Capability numbering matches the canonical docs", () => {
  const fs = require("fs");
  const path = require("path");
  const docs = path.join(__dirname, "..", "..", "..", "docs");

  it("docs/design/capability-rollout.md's table matches the CAP ids in this file", () => {
    const md = fs.readFileSync(path.join(docs, "design", "capability-rollout.md"), "utf8");
    // Rows look like: | 4 | Bounties | `SatoriBounties.fundBounty`, ... |
    const rows = [...md.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|/gm)]
      .map((m) => [Number(m[1]), m[2]]);
    const documented = [...new Set(rows.filter(([b]) => b <= LAST).map(([b]) => b))];
    expect(documented.sort((a, b) => a - b))
      .to.deep.equal(LIVE.slice().sort((a, b) => a - b),
        "capability-rollout.md documents a different set of bits than the tests pin");
  });

  it("no canonical doc still names a capability that was deleted", () => {
    const offenders = [];
    for (const dir of ["design", "questions", "narratives"]) {
      const d = path.join(docs, dir);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".md"))) {
        const text = fs.readFileSync(path.join(d, f), "utf8");
        text.split("\n").forEach((line, i) => {
          // A mention is fine when it is explaining the REMOVAL; flag only lines
          // that read as a live capability id.
          if (/CAP_VOTE_BOUNTY|CAP_DELEGATE_VOTE/.test(line) &&
              !/remove|delete|reclaim|corrected|burn|no longer|used to/i.test(line)) {
            offenders.push(`${dir}/${f}:${i + 1}`);
          }
        });
      }
    }
    expect(offenders, `deleted capabilities named as live in: ${offenders.join(", ")}`).to.deep.equal([]);
  });

  it("'all on' is 0xff — eight capabilities at bits 0..7, densely numbered", () => {
    expect(ALL_ON).to.equal((1 << (LAST + 1)) - 1);
    expect(LIVE.length).to.equal(LAST + 1);
  });
});
