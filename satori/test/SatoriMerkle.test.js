/**
 * SATORI MERKLE CHANNEL (Phase 2a) — the off-chain reward channel as an isolated
 * SECOND core minter. Behind SatoriProxy since 2026-08-01: the hub's pointer to it
 * is still write-once, its logic is now patchable by the token governor
 * (docs/issues/closed/merkle-behind-a-proxy-decision.md). The proxy-specific properties
 * live in test/next/MerkleProxy.test.js; this file is the CHANNEL's behaviour.
 *
 * SatoriMerkle mints through the core's shared `1440 × rounds` cap (via
 * core.rewardMint), completely independent of SatoriRewards. A cumulative Merkle
 * root of {user => lifetime E} drives claims: claimMerkle(E, proof) mints
 * E − alreadyMintedTo[user] and advances the cursor. Monotonic, idempotent,
 * bounded by the shared cap.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee } = require("./fixtures");
const { deployMerkleProxied } = require("./next/splitFixture");

const E = (n) => ethers.parseEther(String(n));

async function advanceRounds(n) {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 * n + 1);
}

// OZ StandardMerkleTree leaf: double-hashed abi.encode(account, amount).
function leafOf(addr, amount) {
  const inner = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount]));
  return ethers.keccak256(inner);
}
// Commutative (sorted-pair) hash — matches OZ MerkleProof.
function hashPair(a, b) {
  return a.toLowerCase() < b.toLowerCase()
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

async function deployStack(admin, publisher) {
  // Restructured stack (SatoriToken + SatoriEngine + SatoriHub + children)
  // behind the monolith-shaped shim. `satori.getAddress()` is the HUB — the
  // core identity that owns the reserve-lane accounting and the merkle wiring,
  // and the ISatoriCore the merkle contract calls rewardMint on. Zero platform
  // fee mirrors the old inline `SatoriRewards.deploy(voting, admin, 0)`.
  const fix = await deploySatoriFixtureNoFee();
  const satori = fix.satori;
  const rewards = fix.rewards;
  const core = await satori.getAddress();

  // Behind its own SatoriProxy since 2026-08-01 — publisher + upgrade anchor
  // set by initialize (docs/issues/closed/merkle-behind-a-proxy-decision.md).
  const merkle = await deployMerkleProxied(publisher.address, fix.token.target);
  await satori.connect(admin).setSatoriMerkle(await merkle.getAddress()); // admin (== governor here) wires it, write-once
  await merkle.setSatoriCore(core);                                        // proxy deployer wires the core, write-once
  return { satori, rewards, merkle };
}

describe("SatoriMerkle (Phase 2a) — isolated second-minter cumulative drop", function () {
  let satori, rewards, merkle;
  let owner, alice, bob, publisher, stranger;

  beforeEach(async function () {
    [owner, alice, bob, publisher, stranger] = await ethers.getSigners();
    ({ satori, rewards, merkle } = await deployStack(owner, publisher)); // owner = admin+deployer
    // Phase 2b: the Merkle lane mints ONLY against its accrued reserve. Dial
    // budget to the off-chain side and let it accrue so these claim tests have a
    // lane to draw on. The dial is effective NEXT round, so 3 advances bank 3
    // rounds (the current round included): reserve = 360 × 3 = 1080, well past what any small test claims.
    await rewards.connect(owner).setOffchainBudget(E(360));
    await advanceRounds(3);
  });

  it("mints a cumulative claim through the core's shared cap", async function () {
    const root = leafOf(alice.address, E(100)); // single-recipient root == the leaf
    await merkle.connect(publisher).setMerkleRoot(root);

    const mintedBefore = await satori.totalRewardsMinted();
    await merkle.connect(alice).claimMerkle(E(100), []);
    expect(await satori.balanceOf(alice.address)).to.equal(E(100));
    expect(await satori.totalRewardsMinted() - mintedBefore).to.equal(E(100)); // shared counter
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(100));
    expect(await satori.merkleMinted()).to.equal(E(100));
  });

  it("is cumulative + idempotent: a higher root mints only the delta; re-claim reverts", async function () {
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(100)));
    await merkle.connect(alice).claimMerkle(E(100), []);
    // republish a higher cumulative entitlement
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(250)));
    await merkle.connect(alice).claimMerkle(E(250), []);
    expect(await satori.balanceOf(alice.address)).to.equal(E(250)); // 100 + delta 150
    // re-claiming the same root mints nothing
    await expect(merkle.connect(alice).claimMerkle(E(250), []))
      .to.be.revertedWithCustomError(merkle, "NothingToClaim");
  });

  it("is monotonic: a lowered entitlement reverts, never underflows", async function () {
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(200)));
    await merkle.connect(alice).claimMerkle(E(200), []);
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(50))); // rolled back / lowered
    await expect(merkle.connect(alice).claimMerkle(E(50), []))
      .to.be.revertedWithCustomError(merkle, "NothingToClaim"); // 50 <= cursor 200 → no underflow
  });

  it("rejects a bad proof / wrong amount", async function () {
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(100)));
    await expect(merkle.connect(alice).claimMerkle(E(101), []))     // amount not in the root
      .to.be.revertedWithCustomError(merkle, "InvalidProof");
    await expect(merkle.connect(bob).claimMerkle(E(100), []))       // wrong claimant
      .to.be.revertedWithCustomError(merkle, "InvalidProof");
  });

  it("verifies a real 2-leaf proof (both recipients claim)", async function () {
    const la = leafOf(alice.address, E(100));
    const lb = leafOf(bob.address, E(200));
    const root = hashPair(la, lb);
    await merkle.connect(publisher).setMerkleRoot(root);
    await merkle.connect(alice).claimMerkle(E(100), [lb]); // proof for alice is [bob's leaf]
    await merkle.connect(bob).claimMerkle(E(200), [la]);
    expect(await satori.balanceOf(alice.address)).to.equal(E(100));
    expect(await satori.balanceOf(bob.address)).to.equal(E(200));
  });

  it("bounded by the Merkle lane reserve: an over-sized claim pays exactly the reserve (partial pay), never past it", async function () {
    // A 5000e18 entitlement blows past the accrued reserve. Under partial pay
    // (pre-launch review) it mints EXACTLY the reserve; the cursor advances by
    // what was PAID; a full lane then refuses loudly at the core.
    const reserve = await satori.merkleReserveCeiling();
    await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(5000)));
    await merkle.connect(alice).claimMerkle(E(5000), []);
    expect(await satori.merkleMinted()).to.equal(reserve);
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(reserve);
    // Zero headroom left → the clamp stands down and the core refuses (CEI: the
    // revert leaves the cursor exactly where the partial pay put it).
    await expect(merkle.connect(alice).claimMerkle(E(5000), []))
      .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    expect(await merkle.alreadyMintedTo(alice.address)).to.equal(reserve);
    expect(await satori.balanceOf(alice.address)).to.equal(reserve);
  });

  it("the core admits BOTH satoriRewards and satoriMerkle as minters — nobody else", async function () {
    await expect(satori.connect(stranger).rewardMint(stranger.address, E(1)))
      .to.be.revertedWithCustomError(satori, "Unauthorized");
    // satoriMerkle minting (via a claim) is authorized — proven by the tests above.
  });

  describe("wiring is write-once / locked", function () {
    it("core.setSatoriMerkle is write-once", async function () {
      await expect(satori.connect(owner).setSatoriMerkle(stranger.address))
        .to.be.revertedWithCustomError(satori, "AlreadySet");
    });
    it("core.setSatoriMerkle is deployer-only (core-local, not routed through rewards.admin)", async function () {
      // fresh, unwired (no-merkle) stack — the shim's `satori` is the hub, whose
      // setSatoriMerkle is gated on the token governor, not the rewards admin.
      const fix2 = await deploySatoriFixtureNoFee();
      const s2 = fix2.satori;
      await expect(s2.connect(stranger).setSatoriMerkle(stranger.address))
        .to.be.revertedWithCustomError(s2, "Unauthorized");
    });
    it("merkle.setSatoriCore is write-once", async function () {
      await expect(merkle.setSatoriCore(await satori.getAddress()))
        .to.be.revertedWithCustomError(merkle, "AlreadySet");
    });
  });

  describe("rootPublisher", function () {
    it("initialize emits RootPublisherSet(0, publisher), so the publisher is in the log from the start", async function () {
      const logs = await merkle.queryFilter(merkle.filters.RootPublisherSet(), 0);
      expect(logs.length).to.equal(1);
      expect(logs[0].args.oldPublisher).to.equal(ethers.ZeroAddress);
      expect(logs[0].args.newPublisher).to.equal(publisher.address);
    });
    it("only the publisher can set the root", async function () {
      await expect(merkle.connect(stranger).setMerkleRoot(ethers.ZeroHash))
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
    });
    it("the publisher can rotate itself (two-step: propose then accept)", async function () {
      await merkle.connect(publisher).setRootPublisher(stranger.address);
      await merkle.connect(stranger).acceptRootPublisher();
      expect(await merkle.rootPublisher()).to.equal(stranger.address);
      await merkle.connect(stranger).setMerkleRoot(leafOf(alice.address, E(1))); // new publisher works
      await expect(merkle.connect(publisher).setMerkleRoot(ethers.ZeroHash))     // old one no longer
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
    });

    // AUDIT LA-1. SatoriMerkle has no governor/admin/deployer override of its
    // own, so a role handed to an address nobody controls is unrecoverable by
    // any in-contract path — the off-chain channel could never publish another
    // root. (An upgrade could repair it while the governor key lives, but not
    // after renounceUpgrade, which is the end state this is written for.) The
    // token guards the identical failure mode with a two-step handoff
    // (SatoriToken.setRootAuthority/acceptRootAuthority, "no brick path"); these pin the
    // same protection here.
    it("a proposal alone does NOT transfer the role", async function () {
      await merkle.connect(publisher).setRootPublisher(stranger.address);
      expect(await merkle.rootPublisher()).to.equal(publisher.address); // unchanged
      expect(await merkle.pendingRootPublisher()).to.equal(stranger.address);
      // the incumbent still works; the nominee does not
      await merkle.connect(publisher).setMerkleRoot(ethers.ZeroHash);
      await expect(merkle.connect(stranger).setMerkleRoot(ethers.ZeroHash))
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
    });

    it("a keyless/mistyped publisher cannot take the role (no brick path)", async function () {
      const keyless = "0x000000000000000000000000000000000000BEEF"; // nobody holds this key
      await merkle.connect(publisher).setRootPublisher(keyless);
      // it never accepts, so the incumbent keeps the role and can re-point or cancel
      expect(await merkle.rootPublisher()).to.equal(publisher.address);
      await merkle.connect(publisher).setRootPublisher(ethers.ZeroAddress); // cancel
      expect(await merkle.pendingRootPublisher()).to.equal(ethers.ZeroAddress);
      await merkle.connect(publisher).setMerkleRoot(ethers.ZeroHash); // still in control
    });

    it("only the pending publisher can accept", async function () {
      await merkle.connect(publisher).setRootPublisher(stranger.address);
      await expect(merkle.connect(bob).acceptRootPublisher())
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
      await expect(merkle.connect(publisher).acceptRootPublisher())
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
    });

    it("acceptance clears the pending slot, so it cannot be replayed", async function () {
      await merkle.connect(publisher).setRootPublisher(stranger.address);
      await merkle.connect(stranger).acceptRootPublisher();
      expect(await merkle.pendingRootPublisher()).to.equal(ethers.ZeroAddress);
      await expect(merkle.connect(stranger).acceptRootPublisher())
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
    });

    it("a non-publisher cannot propose a rotation", async function () {
      await expect(merkle.connect(stranger).setRootPublisher(stranger.address))
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
    });
  });

  // ================================================================
  // PARTIAL PAY (pre-launch review). A claim larger than the lane's accrued
  // reserve used to revert entirely — so a large claimant could be starved
  // indefinitely by smaller ones draining the reserve first. Now it pays what
  // the lane can afford, the cursor advances only by what was PAID, and the
  // SAME entitlement + proof collect the remainder as more reserve accrues.
  // The clamp engages only when something is available: a lane with zero
  // headroom still falls through to the core's loud BudgetExceeded.
  // ================================================================
  describe("partial pay against the accrued reserve", function () {
    it("an over-sized claim drains the reserve, then the same proof collects the rest over time", async function () {
      // beforeEach: rate 360, effective next round, 3 rounds banked -> 1080.
      const reserve0 = await satori.merkleReserveCeiling();
      expect(reserve0).to.equal(E(1080));
      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(5000)));

      // First claim: pays exactly the accrued reserve; the event reports the
      // proved entitlement alongside the partial mint; cursor == paid.
      await expect(merkle.connect(alice).claimMerkle(E(5000), []))
        .to.emit(merkle, "MerkleClaimed").withArgs(alice.address, E(5000), reserve0);
      expect(await satori.balanceOf(alice.address)).to.equal(reserve0);
      expect(await merkle.alreadyMintedTo(alice.address)).to.equal(reserve0);
      expect(await satori.merkleMinted()).to.equal(reserve0);

      // Two more rounds accrue 720 — the SAME root and proof pay it out.
      await advanceRounds(2);
      await merkle.connect(alice).claimMerkle(E(5000), []);
      expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(1800));

      // Enough accrual to cover the remainder: the clamp yields to the smaller
      // entitlement remainder (3200 < the 3600 newly affordable) — never
      // over-pays past the proved lifetime total.
      await advanceRounds(10);
      await merkle.connect(alice).claimMerkle(E(5000), []);
      expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(5000));
      expect(await satori.balanceOf(alice.address)).to.equal(E(5000));

      // Fully paid: the entitlement is exhausted, not the reserve.
      await expect(merkle.connect(alice).claimMerkle(E(5000), []))
        .to.be.revertedWithCustomError(merkle, "NothingToClaim");
    });

    it("small claimants can no longer starve a large one: it takes what is left, then the remainder", async function () {
      // Two-leaf tree: alice 1000, bob 200 (reserve is 1080 — see beforeEach).
      const la = leafOf(alice.address, E(1000));
      const lb = leafOf(bob.address, E(200));
      await merkle.connect(publisher).setMerkleRoot(hashPair(la, lb));

      // Bob (small) drains first — 880 left.
      await merkle.connect(bob).claimMerkle(E(200), [la]);
      // Alice's 1000 exceeds the remaining 880. Before partial pay this
      // reverted outright; now she takes the 880 immediately...
      await merkle.connect(alice).claimMerkle(E(1000), [lb]);
      expect(await satori.balanceOf(alice.address)).to.equal(E(880));
      expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(880));
      // ...and the remaining 120 as soon as the reserve accrues it (a round
      // at 360 more than covers it; the clamp stops at her entitlement).
      await advanceRounds(2);
      await merkle.connect(alice).claimMerkle(E(1000), [lb]);
      expect(await satori.balanceOf(alice.address)).to.equal(E(1000));
      expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(1000));
    });
  });
});
