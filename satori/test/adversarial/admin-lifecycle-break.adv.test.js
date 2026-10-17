// admin-lifecycle-break.adv.test.js
//
// ADVERSARIAL break-testing of the FULL PRIVILEGED SURFACE + dangerous
// ORDERINGS / emergency lifecycle paths.
//
// Round 1 (dial-merkle-break.adv.test.js) already exercised the per-lane cap
// ARITHMETIC (walls, floor, piecewise accrual, basic wiring gates, one
// publisher rotation). This file attacks a DIFFERENT
// axis: it drives every privileged entry point as a hostile caller and, more
// importantly, sequences them in the WORST plausible orders an admin (or a
// compromised admin key) could try — asking, at each step, whether a
// privileged action can retroactively rewrite a frozen round, over-mint,
// resurrect a drained lane, strand funds, or break a global invariant.
//
// NOTE (audit F3): the hub's setChild(uint8,address) wholesale child-repoint
// lever and the StopgapRewards contract were REMOVED — children are now fixed
// only via each child proxy's storage-preserving upgradeTo. Tests whose subject
// was that repoint lever (emergency rewards swap, the stopgap hatch, the
// setChild gate) are gone. Where a test used setChild(1, mock) purely to inject
// an over-mint / reserve-rate move, it now impersonates the REAL rewards proxy
// and calls the hub directly AS the authorized rewards child (see asRewards).
//
// Privileged surface under test:
//   Satori.setSatoriMerkle        (deployer, write-once)
//   Satori.rewardMint gate        (only satoriRewards / satoriMerkle)
//   SatoriToken.airdropMint gate  (only the SatoriAirdrop contract)
//   Satori.setMerkleReserveRate   (only satoriRewards)
//   SatoriRewards.setAdmin        (admin rotation)
//   SatoriRewards.setOffchainBudget         (merkle-reserve dial)
//   SatoriAirdrop.loadAirdropBatch / finalizeAirdropLoading (loader; ordering vs claims)
//   SatoriMerkle.setMerkleRoot / setRootPublisher (publisher; rotation)
//   *.setSatoriCore / setSatoriRewards / setSatoriBounties (deployer wiring)
//
// GLOBAL INVARIANTS asserted throughout:
//   INV-CAP    totalRewardsMinted <= 1440 * roundsElapsed  (all lanes summed)
//   INV-SPLIT  totalRewardsMinted == devFeeMinted + onChainMinted + merkleMinted
//              (the senior dev lane on the immutable token is the third lane)
//   INV-LANE   onChainMinted <= onChainRewardCeiling  &&
//              merkleMinted  <= merkleReserveCeiling
//   INV-AIR    airdrop lane is walled off from the reward cap
//
// Every attack below is proven to FAIL (or to behave exactly as designed).
// The suite is fully green; no bug is encoded as it.skip.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureOpts } = require("../fixtures");
const { deployMerkleProxied } = require("../next/splitFixture");

const E = (n) => ethers.parseEther(String(n));
const ROUND_BUDGET = E(1440); // ROUND_REWARD_BUDGET — the token's outer envelope
// The residual general lane: the hub's per-round emission net of the fee's flat
// 15%. The fee is senior, so the merkle reserve rate can never reach this
// residual — the hub caps setMerkleReserveRate strictly below it. READ FROM THE
// HUB, because the emission is the hub's decaying schedule now.
let RESERVE_MAX;
async function loadReserveMax(satori) {
  RESERVE_MAX = (await satori.emissionRateNow()) - (await satori.devRateNow());
}
const DAY = 24n * 3600n; // SatoriAirdrop.CLAIM_DELAY

async function advanceRounds(n) {
  const t = await time.latest();
  await time.increaseTo(Math.floor(t / 86400) * 86400 + 86400 * n + 1);
}

// OZ StandardMerkleTree single-leaf (double-hashed abi.encode(addr,amount)).
function leafOf(addr, amount) {
  const inner = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [addr, amount])
  );
  return ethers.keccak256(inner);
}

// The restructured stack (immutable SatoriToken + UUPS SatoriEngine + SatoriHub
// + children) behind the monolith-shaped `satori` shim, PLUS a hand-wired
// SatoriMerkle so we can drive the dial + merkle reserve lane directly. The
// shared fixture builds the child/adapter stack; we layer the merkle on top.
// `admin` is the token governor (== the fixture deployer == owner) which now
// gates setSatoriMerkle; `publisher` owns the merkle root.
// `coreAddr` is the HUB — the core address children authorize and the merkle
// calls into. Optionally initializes the default stream FIRST so the auto fee
// schedule can be ticked through the real flushDefaultStream path.
async function deployStack(admin, publisher, { feeBps = 0, withDefaultStream = false } = {}) {
  const fix = await deploySatoriFixtureOpts(feeBps);
  const { satori, rewards, voting, registry, games, bounties } = fix;
  const coreAddr = await satori.getAddress(); // the HUB

  const merkle = await deployMerkleProxied(publisher.address, fix.token.target);
  await satori.connect(admin).setSatoriMerkle(await merkle.getAddress());
  await merkle.setSatoriCore(coreAddr);

  if (withDefaultStream) {
    // MUST be the first stream so it lands at DEFAULT_STREAM_ID == 1.
    await satori.connect(admin).initializeDefaultStream();
  }
  return { satori, rewards, merkle, voting, registry, games, bounties, coreAddr,
           airdrop: fix.airdrop, token: fix.token };
}

// Impersonate the REAL rewards proxy so we can force arbitrary on-chain-lane
// mints / reserve-rate moves AS the authorized rewards child (simulating a
// mis-behaving or hostile rewards path — the correct rewards would never
// over-issue). The real rewards stays wired; we just inject calls as it.
//   satori.connect(rw).rewardMint(to, amt)        forces an on-chain mint
//   satori.connect(rw).setMerkleReserveRate(rate) forces a reserve-rate move
async function asRewards(rewards) {
  const rewardsAddr = await rewards.getAddress();
  await impersonateAccount(rewardsAddr);
  await setBalance(rewardsAddr, E(10));
  return ethers.getSigner(rewardsAddr);
}

// The four global invariants, checked against live state.
async function assertGlobalInvariants(satori) {
  const dr = await satori.deploymentRound();
  const cap = ROUND_BUDGET * ((await satori.getCurrentRound()) - dr + 1n);
  const total = await satori.totalRewardsMinted();
  const devMinted = await satori.devFeeMinted();
  const onMinted = await satori.onChainMinted();
  const mkMinted = await satori.merkleMinted();
  expect(total).to.be.lte(cap, "INV-CAP");
  // Three-lane identity: the senior dev fee accrues on the immutable token, so
  // the split is dev + on-chain + merkle (was on-chain + merkle pre-dev-fee).
  expect(total).to.equal(devMinted + onMinted + mkMinted, "INV-SPLIT");
  expect(onMinted).to.be.lte(await satori.onChainRewardCeiling(), "INV-LANE on-chain");
  expect(mkMinted).to.be.lte(await satori.merkleReserveCeiling(), "INV-LANE merkle");
}

describe("[adv] ADMIN / AUTH / LIFECYCLE / EMERGENCY — full privileged surface", function () {
  this.timeout(600000);

  let owner, alice, bob, publisher, stranger, newAdmin, sink;

  beforeEach(async function () {
    [owner, alice, bob, publisher, stranger, newAdmin, sink] = await ethers.getSigners();
  });

  // ================================================================
  // WRONG-CALLER: every privileged function rejects a hostile caller.
  // ================================================================
  describe("wrong-caller rejection across the whole surface", function () {
    it("core mint/rate/airdrop gates reject an EOA and an unwired contract", async function () {
      const { satori, coreAddr, token } = await deployStack(owner, publisher);
      // rewardMint: only satoriRewards / satoriMerkle.
      await expect(satori.connect(stranger).rewardMint(stranger.address, 1n))
        .to.be.revertedWithCustomError(satori, "Unauthorized");
      // airdropMint (on the token): only the SatoriAirdrop contract.
      await expect(token.connect(stranger).airdropMint(stranger.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(owner).airdropMint(owner.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      // setMerkleReserveRate: only satoriRewards.
      await expect(satori.connect(stranger).setMerkleReserveRate(E(1)))
        .to.be.revertedWithCustomError(satori, "Unauthorized");
      await expect(satori.connect(owner).setMerkleReserveRate(E(1)))
        .to.be.revertedWithCustomError(satori, "Unauthorized");
      // An unwired contract calling rewardMint is NOT recognized as a minter.
      const rogue = await (await ethers.getContractFactory("MockRewardsMinter")).deploy();
      await expect(rogue.mint(coreAddr, stranger.address, 1n))
        .to.be.revertedWithCustomError(satori, "Unauthorized");
    });

    it("official-adapter registration rejects a non-admin", async function () {
      const { satori } = await deployStack(owner, publisher);
      await expect(satori.connect(stranger).registerAdapter(stranger.address, "x"))
        .to.be.revertedWithCustomError(satori, "Unauthorized");
      await expect(satori.connect(stranger).registerGameAdapter(stranger.address, "x"))
        .to.be.revertedWithCustomError(satori, "Unauthorized");
    });

    it("rewards admin surface (setAdmin / setOffchainBudget) and the airdrop loader reject a stranger", async function () {
      const { rewards, airdrop } = await deployStack(owner, publisher);
      await expect(rewards.connect(stranger).setAdmin(stranger.address))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
      await expect(airdrop.connect(stranger).loadAirdropBatch([stranger.address], [E(1)]))
        .to.be.revertedWithCustomError(airdrop, "Unauthorized");
      await expect(rewards.connect(stranger).setOffchainBudget(E(1)))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
    });

    it("merkle publisher surface (setMerkleRoot / setRootPublisher) rejects non-publisher", async function () {
      const { merkle } = await deployStack(owner, publisher);
      await expect(merkle.connect(stranger).setMerkleRoot(ethers.ZeroHash))
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
      await expect(merkle.connect(stranger).setRootPublisher(stranger.address))
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
      // The core ADMIN is NOT the publisher — admin cannot publish.
      await expect(merkle.connect(owner).setMerkleRoot(ethers.ZeroHash))
        .to.be.revertedWithCustomError(merkle, "Unauthorized");
    });

    // platform fee moved to immutable token (see test/next/DevFee.test.js):
    // rewards.applyFeeSchedule() no longer exists (the auto fee schedule is gone),
    // so the wrong-caller assertion on it is dropped.
  });

  // ================================================================
  // DANGEROUS ORDERING #1 — dial + accrue reserve BEFORE satoriMerkle is
  // even wired, then late-wire and try to over-claim.
  // ================================================================
  describe("ordering: accrue reserve while Merkle is un-wired, then late-wire", function () {
    it("reserve accrued pre-wiring is claimable AFTER late-wiring, never past the global cap", async function () {
      // Fully wired stack EXCEPT satoriMerkle (the fixture never wires merkle).
      const { satori, rewards } = await deploySatoriFixtureOpts(0);
      const coreAddr = await satori.getAddress();

      // Dial the reserve and let it accrue while Merkle does not exist yet.
      await rewards.connect(owner).setOffchainBudget(E(500));
      // Dial is effective from the NEXT round (genesis round D uses dial 0), so
      // 4 rounds elapse to accrue 3 effective rounds at 500 == 1500.
      await advanceRounds(4); // reserve accrues 1500
      expect(await satori.merkleReserveCeiling()).to.equal(E(1500));

      // Late-wire the Merkle contract (deployer-only, still available: write-once slot empty).
      const merkle = await deployMerkleProxied(publisher.address, await satori.satoriToken());
      await satori.connect(owner).setSatoriMerkle(await merkle.getAddress());
      await merkle.setSatoriCore(coreAddr);

      // The pre-accrued reserve is legitimately claimable, bounded by the cap.
      const reserve = await satori.merkleReserveCeiling();
      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));
      await merkle.connect(alice).claimMerkle(reserve, []);
      expect(await satori.merkleMinted()).to.equal(reserve);
      await assertGlobalInvariants(satori);

      // One wei beyond the accrued reserve is refused, cursor uncorrupted.
      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve + 1n));
      await expect(merkle.connect(alice).claimMerkle(reserve + 1n, []))
        .to.be.revertedWithCustomError(satori, "BudgetExceeded");
    });

    it("un-wired Merkle cannot mint at all — rewardMint sees satoriMerkle==0", async function () {
      // Same partial stack, but deploy a merkle and DON'T wire it into the core.
      const { satori, rewards } = await deploySatoriFixtureOpts(0);
      const coreAddr = await satori.getAddress();
      await rewards.connect(owner).setOffchainBudget(E(300));
      await advanceRounds(2);

      const merkle = await deployMerkleProxied(publisher.address, await satori.satoriToken());
      await merkle.setSatoriCore(coreAddr); // merkle knows the core...
      // ...but the core does NOT know the merkle (setSatoriMerkle never called).
      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(100)));
      await expect(merkle.connect(alice).claimMerkle(E(100), []))
        .to.be.revertedWithCustomError(satori, "Unauthorized");
    });
  });

  // ================================================================
  // DANGEROUS ORDERING #3 — dial the reserve UP AFTER the on-chain lane has
  // already consumed early headroom. Can the shrinking on-chain ceiling drop
  // below onChainMinted, or can the combined lanes breach the cap?
  // ================================================================
  describe("ordering: dial reserve UP after the on-chain lane already minted", function () {
    it("shrinking the on-chain ceiling never drops it below already-minted (per-round +1 slack)", async function () {
      const { satori, rewards } = await deployStack(owner, publisher);
      await loadReserveMax(satori);
      const rw = await asRewards(rewards);
      // Drain the on-chain lane to the cap every round for 5 rounds, reserve 0.
      for (let i = 0; i < 5; i++) {
        await advanceRounds(1);
        const room = (await satori.onChainRewardCeiling()) - (await satori.onChainMinted());
        if (room > 0n) await satori.connect(rw).rewardMint(stranger.address, room);
      }
      const onMinted = await satori.onChainMinted();

      // Now dial the reserve to the MAX legal rate and let it balloon 100 rounds.
      await satori.connect(rw).setMerkleReserveRate(RESERVE_MAX - 1n);
      await advanceRounds(100);

      // The on-chain ceiling shrank by the reserve, but the general cap grew by
      // the emission's 85% each round while the reserve grew at most
      // RESERVE_MAX-1: onChainMinted stays <= ceiling (+1 wei/round slack).
      expect(onMinted).to.be.lte(await satori.onChainRewardCeiling());
      await assertGlobalInvariants(satori);
    });

    it("combined lanes can NEVER exceed the global cap even racing the dial post-drain", async function () {
      const { satori, rewards, merkle } = await deployStack(owner, publisher);
      await loadReserveMax(satori);
      const rw = await asRewards(rewards);
      await advanceRounds(1);
      const headroom = (await satori.onChainRewardCeiling()) - (await satori.onChainMinted());
      await satori.connect(rw).rewardMint(stranger.address, headroom); // on-chain at its (dev-net) cap
      await satori.connect(rw).setMerkleReserveRate(RESERVE_MAX - 1n);
      await advanceRounds(2);

      const reserve = await satori.merkleReserveCeiling();
      const onMinted = await satori.onChainMinted();
      const dr = await satori.deploymentRound();
      const cap = ROUND_BUDGET * ((await satori.getCurrentRound()) - dr + 1n);

      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, reserve));
      if (onMinted + reserve > cap) {
        await expect(merkle.connect(alice).claimMerkle(reserve, []))
          .to.be.revertedWithCustomError(satori, "BudgetExceeded");
      } else {
        await merkle.connect(alice).claimMerkle(reserve, []);
      }
      await assertGlobalInvariants(satori);
    });
  });

  // ================================================================
  // DANGEROUS ORDERING #4 — dial idempotency within a single round; the
  // dial can be toggled repeatedly with no reserve gain or loss.
  // ================================================================
  describe("ordering: rapid dial toggling within one round is exact", function () {
    it("toggling the dial many times in the same round neither mints nor strands reserve", async function () {
      const { satori, rewards } = await deployStack(owner, publisher);
      await rewards.connect(owner).setOffchainBudget(E(100));
      await advanceRounds(2); // 200 pending at next touch
      // Three toggles in the SAME round: the first banks 200, the rest bank 0.
      // (All rates stay under the residual cap — the dev fee is senior.)
      await rewards.connect(owner).setOffchainBudget(E(300));
      await rewards.connect(owner).setOffchainBudget(E(500));
      await rewards.connect(owner).setOffchainBudget(E(50));
      expect(await satori.merkleReserveCeiling()).to.equal(E(200));
      // The most recent rate (50) governs the NEXT round only; advance 2 rounds
      // so one full round accrues at 50 (the live ceiling lags one round).
      await advanceRounds(2);
      expect(await satori.merkleReserveCeiling()).to.equal(E(250));
    });
  });

  // ================================================================
  // ADMIN ROTATION — rotating rewards.admin re-points the core's admin gate.
  // ================================================================
  describe("rewards admin rotation (setAdmin)", function () {
    it("after setAdmin, the rewards-admin surface re-homes to the new admin", async function () {
      const { rewards } = await deployStack(owner, publisher);
      await rewards.connect(owner).setAdmin(newAdmin.address);
      // The rewards-side admin surface re-homes to the new admin (it is gated by
      // rewards.admin(), which rotation moves): the OLD admin loses it and the
      // NEW admin gains it.
      await expect(rewards.connect(owner).setCapabilities(0n))
        .to.be.revertedWithCustomError(rewards, "Unauthorized");
      await rewards.connect(newAdmin).setCapabilities(0n);
    });

    it("admin cannot be rotated to the zero address (would brick the gate)", async function () {
      const { rewards } = await deployStack(owner, publisher);
      await expect(rewards.connect(owner).setAdmin(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(rewards, "BadInput");
    });
  });

  // ================================================================
  // WRITE-ONCE / IMMUTABILITY of the Merkle wiring — it can never be
  // repointed or reset.
  // ================================================================
  describe("Merkle wiring is write-once and un-repointable", function () {
    it("setSatoriMerkle reverts AlreadySet on a second wire", async function () {
      const { satori, merkle } = await deployStack(owner, publisher);
      const other = await deployMerkleProxied(publisher.address, await satori.satoriToken());
      await expect(satori.connect(owner).setSatoriMerkle(await other.getAddress()))
        .to.be.revertedWithCustomError(satori, "AlreadySet");
      // The wired merkle is still the original.
      expect(await satori.satoriMerkle()).to.equal(await merkle.getAddress());
    });

    it("setSatoriMerkle is gated on the token GOVERNOR, not the rewards admin", async function () {
      // A fresh, un-wired stack (the fixture never wires merkle): rotate the
      // rewards admin, then confirm the NEW rewards-admin still cannot wire
      // merkle — only the token governor can (setSatoriMerkle is onlyGovernor).
      const { satori, rewards } = await deploySatoriFixtureOpts(0);

      // Rotate the rewards admin to newAdmin.
      await rewards.connect(owner).setAdmin(newAdmin.address);
      const merkle = await deployMerkleProxied(publisher.address, await satori.satoriToken());
      // The rewards admin is NOT the governor — cannot wire merkle.
      await expect(satori.connect(newAdmin).setSatoriMerkle(await merkle.getAddress()))
        .to.be.revertedWithCustomError(satori, "Unauthorized");
      // The governor (owner) still can.
      await satori.connect(owner).setSatoriMerkle(await merkle.getAddress());
      expect(await satori.satoriMerkle()).to.equal(await merkle.getAddress());
    });
  });

  // ================================================================
  // PUBLISHER ROTATION mid-claim — monotonic cursor protects against a
  // rogue/rotated publisher lowering entitlements.
  // ================================================================
  describe("rootPublisher rotation mid-claim", function () {
    it("rotating the publisher mid-stream; a lowered root can never claw back a cursor", async function () {
      const { satori, rewards, merkle } = await deployStack(owner, publisher);
      await rewards.connect(owner).setOffchainBudget(E(300));
      await advanceRounds(3); // 2 effective rounds at 300 == reserve 600
      await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(400)));
      await merkle.connect(alice).claimMerkle(E(400), []); // cursor 400

      // Rotate the publisher to bob (two-step, audit LA-1); the old publisher is
      // powerless afterward.
      await merkle.connect(publisher).setRootPublisher(bob.address);
      await merkle.connect(bob).acceptRootPublisher();
      await expect(merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, E(800))))
        .to.be.revertedWithCustomError(merkle, "Unauthorized");

      // The NEW publisher LOWERS alice's entitlement below her cursor. A claim
      // reverts NothingToClaim (monotonic; no underflow, no clawback).
      await merkle.connect(bob).setMerkleRoot(leafOf(alice.address, E(100)));
      await expect(merkle.connect(alice).claimMerkle(E(100), []))
        .to.be.revertedWithCustomError(merkle, "NothingToClaim");
      expect(await merkle.alreadyMintedTo(alice.address)).to.equal(E(400));

      // A HIGHER root from the new publisher mints only the delta.
      await merkle.connect(bob).setMerkleRoot(leafOf(alice.address, E(600)));
      await merkle.connect(alice).claimMerkle(E(600), []);
      expect(await satori.balanceOf(alice.address)).to.equal(E(600));
      await assertGlobalInvariants(satori);
    });

    it("a rotated publisher still cannot mint past the accrued reserve (lane wall survives rotation)", async function () {
      const { satori, rewards, merkle } = await deployStack(owner, publisher);
      await rewards.connect(owner).setOffchainBudget(E(10));
      await advanceRounds(2); // 1 effective round at 10 == reserve 10
      await merkle.connect(publisher).setRootPublisher(bob.address);
      await merkle.connect(bob).acceptRootPublisher();
      // The new publisher publishes a huge root, but the core wall holds at the
      // accrued reserve: under partial pay the claim collects EXACTLY that and
      // nothing more — rotation buys the publisher no extra headroom.
      const reserve = await satori.merkleReserveCeiling();
      await merkle.connect(bob).setMerkleRoot(leafOf(alice.address, E(5000)));
      await merkle.connect(alice).claimMerkle(E(5000), []);
      expect(await satori.merkleMinted()).to.equal(reserve);
      expect(await merkle.alreadyMintedTo(alice.address)).to.equal(reserve);
      // Lane exactly full → a re-claim has no headroom and the core refuses it.
      await expect(merkle.connect(alice).claimMerkle(E(5000), []))
        .to.be.revertedWithCustomError(satori, "BudgetExceeded");
      expect(await merkle.alreadyMintedTo(alice.address)).to.equal(reserve);
    });
  });

  // ================================================================
  // FROZEN-ROUND immutability — no privileged action retroactively rewrites
  // an already-touched round's fee schedule or budget dial.
  // ================================================================
  describe("no privileged action retroactively rewrites a frozen state", function () {
    // platform fee moved to immutable token (see test/next/DevFee.test.js): the
    // auto fee schedule (feeSlot stepping 1200->600->300 via applyFeeSchedule /
    // flushDefaultStream) no longer exists in rewards — feeSlot() is INERT and
    // returns (0,0). The two step-down-schedule it()s are dropped; the immutable
    // token's 20/10/5 dev-fee schedule is covered by DevFee.test.js.

    it("setOffchainBudget hits the reserve-cap floor: >= the residual reverts, and the core mirror agrees", async function () {
      const { satori, rewards } = await deployStack(owner, publisher);
      await loadReserveMax(satori);
      // The rewards dial still refuses a full-round budget so gross >= 1...
      await expect(rewards.connect(owner).setOffchainBudget(ROUND_BUDGET))
        .to.be.revertedWithCustomError(rewards, "BadInput");
      // ...and the core mirror is TIGHTER: the merkle reserve rate can never
      // reach the residual, since the dev fee is senior — so the dial reverts AT
      // the residual too (BadInput bubbles up from the hub).
      await expect(rewards.connect(owner).setOffchainBudget(RESERVE_MAX))
        .to.be.revertedWithCustomError(rewards, "BadInput");
      // Exactly one wei under the residual is allowed and keeps the on-chain ceiling >= 1.
      await rewards.connect(owner).setOffchainBudget(RESERVE_MAX - 1n);
      await advanceRounds(1);
      expect(await satori.onChainRewardCeiling()).to.be.gte(1n);
    });
  });

  // ================================================================
  // AIRDROP LIFECYCLE ORDERING — claims only after finalize, loading never
  // after it; the airdrop lane is walled off from the reward cap.
  // ================================================================
  describe("airdrop loading ordering + lane isolation", function () {
    it("no claim before finalize; no load, top-up or re-timing after it; claimed cursors untouched", async function () {
      const { satori, airdrop } = await deployStack(owner, publisher);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(100000)]);
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "ClaimsNotOpen");

      await airdrop.connect(owner).finalizeAirdropLoading();
      const opens = await airdrop.claimsOpenAt();
      // During the day: the table is closed, and claims are still shut.
      await expect(airdrop.connect(owner).loadAirdropBatch([bob.address], [E(100000)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await expect(airdrop.connect(alice).claimAirdrop())
        .to.be.revertedWithCustomError(airdrop, "ClaimsNotOpen");

      await time.increase(DAY);
      await airdrop.connect(alice).claimAirdrop();
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(E(100000));

      // After claims started the admin can neither add bob, RETROACTIVELY bump
      // alice, nor re-finalize to move the opening.
      await expect(airdrop.connect(owner).loadAirdropBatch([bob.address], [E(100000)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await expect(airdrop.connect(owner).loadAirdropBatch([alice.address], [E(999999)]))
        .to.be.revertedWithCustomError(airdrop, "AirdropLoadingClosed");
      await expect(airdrop.connect(owner).finalizeAirdropLoading())
        .to.be.revertedWithCustomError(airdrop, "AlreadySet");
      expect(await airdrop.claimsOpenAt()).to.equal(opens);
      expect(await airdrop.airdropAllocation(alice.address)).to.equal(E(100000));
      expect(await airdrop.airdropAllocation(bob.address)).to.equal(0n);
      expect(await airdrop.airdropClaimed(alice.address)).to.equal(E(100000));
      expect(await satori.balanceOf(alice.address)).to.equal(E(100000));
    });

    it("an airdrop claim NEVER touches the reward cap counters (separate lane)", async function () {
      const { satori, airdrop } = await deployStack(owner, publisher);
      await airdrop.connect(owner).loadAirdropBatch([alice.address], [E(500000)]);
      await airdrop.connect(owner).finalizeAirdropLoading();
      await time.increase(DAY);

      const rmintBefore = await satori.totalRewardsMinted();
      const onBefore = await satori.onChainMinted();
      await airdrop.connect(alice).claimAirdrop();
      expect(await satori.balanceOf(alice.address)).to.equal(E(500000));
      // Reward-lane counters are unchanged by the airdrop mint.
      expect(await satori.totalRewardsMinted()).to.equal(rmintBefore);
      expect(await satori.onChainMinted()).to.equal(onBefore);
      await assertGlobalInvariants(satori);
    });

    it("airdropMint respects its OWN cap even when driven directly by the airdrop address", async function () {
      const { airdrop, token } = await deployStack(owner, publisher);
      const TOTAL = await airdrop.AIRDROP_TOTAL_SUPPLY();
      // Impersonate the airdrop contract and attempt to over-mint.
      const { impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
      const airdropAddr = await airdrop.getAddress();
      await impersonateAccount(airdropAddr);
      await setBalance(airdropAddr, E(100));
      const ad = await ethers.getSigner(airdropAddr);
      await expect(token.connect(ad).airdropMint(alice.address, TOTAL + 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
    });
  });

  // ================================================================
  // FULL-LIFECYCLE STRESS — an adversarial admin runs the WHOLE privileged
  // playbook in an ugly interleaving; every global invariant holds at each step.
  // ================================================================
  describe("adversarial admin runs the whole playbook; invariants hold at every step", function () {
    it("interleave dial moves, on-chain mints, and merkle claims (invariants hold at each step)", async function () {
      const { satori, rewards, merkle } = await deployStack(owner, publisher);

      // 1) dial 100, advance, then drive precise on-chain mints / reserve moves
      // AS the authorized rewards child (impersonation), and claim merkle.
      await rewards.connect(owner).setOffchainBudget(E(100));
      await advanceRounds(2);
      await assertGlobalInvariants(satori);

      // Impersonate the real rewards to inject an over-riding reserve rate so the
      // reserve keeps accruing, then advance.
      const rw = await asRewards(rewards);
      await satori.connect(rw).setMerkleReserveRate(E(150));
      await advanceRounds(3);
      await assertGlobalInvariants(satori);

      // drive a partial on-chain mint (within the lane).
      let room = (await satori.onChainRewardCeiling()) - (await satori.onChainMinted());
      if (room > E(300)) room = E(300);
      if (room > 0n) await satori.connect(rw).rewardMint(stranger.address, room);
      await assertGlobalInvariants(satori);

      // claim a slice of the merkle reserve.
      const reserve = await satori.merkleReserveCeiling();
      const claim = reserve > E(200) ? E(200) : reserve;
      if (claim > 0n) {
        await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, claim));
        await merkle.connect(alice).claimMerkle(claim, []);
      }
      await assertGlobalInvariants(satori);

      // 2) re-dial down (via impersonation), advance, invariants still hold.
      await satori.connect(rw).setMerkleReserveRate(E(50));
      await advanceRounds(4);
      await assertGlobalInvariants(satori);

      // 3) drain what is left of the on-chain lane, still bounded by the cap.
      let room2 = (await satori.onChainRewardCeiling()) - (await satori.onChainMinted());
      if (room2 > 0n) await satori.connect(rw).rewardMint(sink.address, room2);
      await assertGlobalInvariants(satori);

      // Any remaining banked merkle reserve is still exactly claimable.
      const remaining = (await satori.merkleReserveCeiling()) - (await satori.merkleMinted());
      if (remaining > 0n) {
        const prev = await merkle.alreadyMintedTo(alice.address);
        await merkle.connect(publisher).setMerkleRoot(leafOf(alice.address, prev + remaining));
        await merkle.connect(alice).claimMerkle(prev + remaining, []);
      }
      await assertGlobalInvariants(satori);
    });
  });
});
