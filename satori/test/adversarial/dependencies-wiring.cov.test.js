/**
 * dependencies-wiring.cov.test.js
 *
 * Adversarial COVERAGE for the dependencies-wiring subsystem. Targets the
 * high/med priority coverage_gaps from the audit's _raw_review.json that the
 * existing suite does NOT cover:
 *
 *   - setSatoriCore one-shot + access guards for EACH child (Voting, Rewards,
 *     Registry, Games, Bounties): second call reverts, non-deployer reverts,
 *     address(0) reverts.
 *   - onlyCore enforcement: every child mutating entry point reverts when
 *     called directly from a non-core EOA.
 *   - Cross-reference resolution at wiring: after setSatoriCore the resolved
 *     back-references (Registry.satoriRewards, Rewards.satoriRegistry,
 *     Games.satoriRegistry) equal the core's getters.
 *   - _update skip-mask correctness: a transfer into a participant
 *     prediction-delegator from a never-participated sender STILL runs the
 *     sync (delegate pool grows); a transfer between two never-participated
 *     accounts runs NO sync (all child accounting untouched).
 *
 * NOTE (burn voting): the token hook no longer touches SatoriVoting at all —
 * vote weight is bought by BURNING and can never move with a balance — so the
 * skip-mask now guards exactly one call, rewards.syncPredictionDelegation.
 * The vote-delegation half of these assertions is gone with the feature.
 *
 * The already-confirmed HIGH finding (same-round double-receipt checkpoint
 * overwrite, adv_15) is intentionally NOT re-tested here.
 *
 * Intended behavior is asserted from the contracts' own NatSpec contracts:
 *   - SatoriVoting/Registry/Games/Rewards/Bounties: setSatoriCore is a
 *     one-shot, deployer-gated, non-zero-address wiring call; all mutating
 *     entry points are gated by onlyCore.
 *   - Satori._update (line 2011-2018): syncs run iff either side
 *     hasParticipated; they must never be skipped when they would have
 *     mutated child state, and must never run when neither side participates.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1 } = require("../fixtures");
const { TEST_MARKETING_FEE_RECIPIENT } = require("../next/splitFixture");

const UP = 1;
const ZERO = ethers.ZeroAddress;

async function advanceRound() {
    const currentTime = await time.latest();
    const nextMidnight = Math.floor(currentTime / 86400) * 86400 + 86400;
    await time.increaseTo(nextMidnight + 1);
}

async function getStreamIdFromTx(tx, satori) {
    const receipt = await tx.wait();
    const event = receipt.logs.find(log => {
        try {
            const parsed = satori.interface.parseLog(log);
            return parsed && parsed.name === 'DataStreamCreated';
        } catch { return false; }
    });
    if (!event) throw new Error("DataStreamCreated event not found");
    return satori.interface.parseLog(event).args.streamId;
}

describe("COV dependencies-wiring: setSatoriCore guards, onlyCore, cross-refs, skip-mask", function () {
    this.timeout(120000);

    // ------------------------------------------------------------------
    // setSatoriCore one-shot + access guards, per child.
    // We deploy UNWIRED children so we can exercise the guards before/at the
    // wiring window. `deployer` is signers[0]; `stranger` is signers[1].
    // ------------------------------------------------------------------
    describe("setSatoriCore one-shot + access guards (per child)", function () {
        let deployer, stranger, core;

        beforeEach(async function () {
            const signers = await ethers.getSigners();
            deployer = signers[0];
            stranger = signers[1];
            // Any non-zero placeholder works as the "core" — the guards we test
            // (deployer-gate, one-shot, zero-address) fire before any cross-ref
            // resolution that would need a real core. For children that DO
            // resolve cross-refs (Voting/Registry/Games/Rewards), use a real
            // fully-wired core so the happy path also succeeds.
            const f = await deploySatoriFixture();
            core = await f.satori.getAddress();
        });

        it("SatoriVoting: deployer-gate, one-shot, zero-address", async function () {
            const V = await ethers.getContractFactory("SatoriVoting");
            const v = await V.deploy(); await v.waitForDeployment();

            await expect(v.connect(stranger).setSatoriCore(core))
                .to.be.revertedWithCustomError(v, "OnlyDeployer");
            await expect(v.connect(deployer).setSatoriCore(ZERO))
                .to.be.revertedWithCustomError(v, "InvalidCoreAddress");

            await v.connect(deployer).setSatoriCore(core);
            expect(await v.satoriCore()).to.equal(core);

            await expect(v.connect(deployer).setSatoriCore(core))
                .to.be.revertedWithCustomError(v, "CoreAlreadySet");
        });

        it("SatoriRegistry: deployer-gate, one-shot, zero-address", async function () {
            const R = await ethers.getContractFactory("SatoriRegistry");
            const r = await R.deploy(); await r.waitForDeployment();

            await expect(r.connect(stranger).setSatoriCore(core))
                .to.be.revertedWithCustomError(r, "OnlyDeployer");
            await expect(r.connect(deployer).setSatoriCore(ZERO))
                .to.be.revertedWithCustomError(r, "InvalidCoreAddress");

            await r.connect(deployer).setSatoriCore(core);
            expect(await r.satoriCore()).to.equal(core);

            await expect(r.connect(deployer).setSatoriCore(core))
                .to.be.revertedWithCustomError(r, "CoreAlreadyInitialized");
        });

        it("SatoriGames: deployer-gate, one-shot, zero-address", async function () {
            const G = await ethers.getContractFactory("SatoriGames");
            const g = await G.deploy(); await g.waitForDeployment();

            await expect(g.connect(stranger).setSatoriCore(core))
                .to.be.revertedWithCustomError(g, "OnlyDeployer");
            await expect(g.connect(deployer).setSatoriCore(ZERO))
                .to.be.revertedWithCustomError(g, "InvalidCoreAddress");

            await g.connect(deployer).setSatoriCore(core);
            expect(await g.satoriCore()).to.equal(core);

            await expect(g.connect(deployer).setSatoriCore(core))
                .to.be.revertedWithCustomError(g, "CoreAlreadyInitialized");
        });

        it("SatoriRewards: deployer-gate, one-shot, zero-address", async function () {
            const Rw = await ethers.getContractFactory("SatoriRewards");
            // Ctor is now (voting, admin, marketingRecipient): the platform/dev fee
            // moved to the immutable SatoriToken, so initialFeeBps + the platform
            // recipient are gone (see test/next/DevFee.test.js).
            const rw = await Rw.deploy(stranger.address, deployer.address, TEST_MARKETING_FEE_RECIPIENT);
            await rw.waitForDeployment();

            await expect(rw.connect(stranger).setSatoriCore(core))
                .to.be.revertedWithCustomError(rw, "Unauthorized");
            await expect(rw.connect(deployer).setSatoriCore(ZERO))
                .to.be.revertedWithCustomError(rw, "BadInput");

            await rw.connect(deployer).setSatoriCore(core);
            expect(await rw.satoriCore()).to.equal(core);

            await expect(rw.connect(deployer).setSatoriCore(core))
                .to.be.revertedWithCustomError(rw, "AlreadySet");
        });

        it("SatoriBounties: deployer-gate, one-shot, zero-address", async function () {
            const B = await ethers.getContractFactory("SatoriBounties");
            const b = await B.deploy(); await b.waitForDeployment();

            await expect(b.connect(stranger).setSatoriCore(core))
                .to.be.revertedWithCustomError(b, "Unauthorized");
            await expect(b.connect(deployer).setSatoriCore(ZERO))
                .to.be.revertedWithCustomError(b, "BadInput");

            await b.connect(deployer).setSatoriCore(core);
            expect(await b.satoriCore()).to.equal(core);

            await expect(b.connect(deployer).setSatoriCore(core))
                .to.be.revertedWithCustomError(b, "AlreadySet");
        });
    });

    // ------------------------------------------------------------------
    // Cross-reference resolution at wiring: the once-resolved back-references
    // must equal the core's getters after setSatoriCore.
    // ------------------------------------------------------------------
    describe("cross-reference resolution at wiring", function () {
        it("Registry.satoriRewards / Rewards.satoriRegistry / Games.satoriRegistry == core getters", async function () {
            const f = await deploySatoriFixture();
            const core = f.satori;

            const coreRewards  = await core.satoriRewards();
            const coreRegistry = await core.satoriRegistry();

            expect(await f.registry.satoriRewards()).to.equal(coreRewards);
            expect(await f.rewards.satoriRegistry()).to.equal(coreRegistry);
            expect(await f.games.satoriRegistry()).to.equal(coreRegistry);

            // satoriCore on each child equals the core address.
            const coreAddr = await core.getAddress();
            expect(await f.voting.satoriCore()).to.equal(coreAddr);
            expect(await f.rewards.satoriCore()).to.equal(coreAddr);
            expect(await f.registry.satoriCore()).to.equal(coreAddr);
            expect(await f.games.satoriCore()).to.equal(coreAddr);
            expect(await f.bounties.satoriCore()).to.equal(coreAddr);
        });
    });

    // ------------------------------------------------------------------
    // onlyCore enforcement: direct EOA calls to child mutators must revert.
    // These bypass the core's participation marking / lock checks, so they
    // must be unconditionally gated to satoriCore.
    // ------------------------------------------------------------------
    describe("onlyCore enforcement on child mutators", function () {
        let f, attacker;

        beforeEach(async function () {
            f = await deploySatoriFixture();
            attacker = f.signers[6];
        });

        it("SatoriVoting.vote rejects non-core caller", async function () {
            await expect(f.voting.connect(attacker).vote(1, attacker.address, 100))
                .to.be.revertedWithCustomError(f.voting, "OnlySatoriCore");
        });

        // syncVoteDelegation / adjustEligibleCap / snapshotEligibleGamesForRound
        // are gone with vote delegation and the eligibility heap. The surviving
        // onlyCore mutator on SatoriVoting besides `vote` is the round-denominator
        // writer — an EOA that could call it would be able to pin a game's votes
        // into a round it never predicted, so it must stay core-gated.
        it("SatoriVoting.recordGameVotesForRound rejects non-core caller", async function () {
            await expect(f.voting.connect(attacker).recordGameVotesForRound(1, 1))
                .to.be.revertedWithCustomError(f.voting, "OnlySatoriCore");
        });

        it("SatoriVoting.setGameApproved rejects a non-admin caller", async function () {
            await expect(f.voting.connect(attacker).setGameApproved(1, false))
                .to.be.revertedWithCustomError(f.voting, "NotAdmin");
        });

        it("SatoriRewards.syncPredictionDelegation rejects non-core caller", async function () {
            await expect(f.rewards.connect(attacker).syncPredictionDelegation(attacker.address, f.signers[7].address, 100))
                .to.be.revertedWithCustomError(f.rewards, "Unauthorized");
        });

        it("SatoriGames.createGame rejects non-core caller", async function () {
            await expect(f.games.connect(attacker).createGame(attacker.address, 1, 0, "0x", "X"))
                .to.be.revertedWithCustomError(f.games, "OnlySatoriCore");
        });

        it("SatoriRegistry.createSimpleDataStream rejects non-core caller", async function () {
            await expect(f.registry.connect(attacker).createSimpleDataStream(attacker.address, "X", attacker.address, 720))
                .to.be.revertedWithCustomError(f.registry, "OnlySatoriCore");
        });
    });

    // ------------------------------------------------------------------
    // _update skip-mask correctness.
    // ------------------------------------------------------------------
    describe("_update skip-mask never skips a state-changing sync", function () {
        it("transfer from a never-participated sender INTO a participant delegator runs the syncs (delegate pool grows)", async function () {
            const f = await deploySatoriFixture();
            const satori = f.satori;
            const rewards = f.rewards;
            const owner = f.owner;            // deployer holds bootstrap mint; is a participant after registering adapters
            const alice = f.signers[1];       // will delegate (participant)
            const bob   = f.signers[2];       // delegate
            const ghost = f.signers[3];       // funded but NEVER participates

            // Fund alice (so she has a startBalance) and ghost. The deployer
            // (owner) is already a participant, so these seeding transfers run
            // the syncs harmlessly (they have no delegation yet).
            await satori.transfer(alice.address, ethers.parseEther("100"));
            await satori.transfer(ghost.address, ethers.parseEther("100"));

            // alice delegates her prediction power to bob -> alice + bob marked
            // participants; bob's delegate pool == alice's balance (100e18).
            await satori.connect(alice).delegatePredictionPower(bob.address);

            // Sanity: ghost has never participated.
            expect(await satori.hasParticipated(ghost.address)).to.equal(false);
            // alice IS a participant (she delegated).
            expect(await satori.hasParticipated(alice.address)).to.equal(true);

            const poolBefore = await rewards.getPredictionPower(bob.address);

            // The adversarial path: ghost (never-participated SENDER) transfers
            // INTO alice (participant delegator). _update's skip-mask must NOT
            // skip the sync, because the TO side participated. The sync must
            // bump bob's delegate pool by the transferred value.
            const topUp = ethers.parseEther("40");
            await satori.connect(ghost).transfer(alice.address, topUp);

            // adv_6: a mid-round receipt to an already-delegated delegator DEFERS
            // to next round (it activates at R+1, not immediately), so the
            // delegate's prediction power is unchanged THIS round...
            expect(await rewards.getPredictionPower(bob.address)).to.equal(poolBefore);
            // ...and grows by exactly `topUp` once it activates next round —
            // which proves syncPredictionDelegation ran (the skip-mask did NOT
            // skip it, because the TO side participated).
            await advanceRound();
            expect((await rewards.getPredictionPower(bob.address)) - poolBefore).to.equal(topUp);
        });

        it("transfer between two never-participated accounts runs NO sync (child accounting untouched)", async function () {
            const f = await deploySatoriFixture();
            const satori = f.satori;
            const voting = f.voting;
            const rewards = f.rewards;
            const ghostA = f.signers[3];
            const ghostB = f.signers[4];

            // Seed both ghosts from the deployer (a participant). These seeding
            // transfers run the syncs but harmlessly (no delegation set).
            await satori.transfer(ghostA.address, ethers.parseEther("100"));
            await satori.transfer(ghostB.address, ethers.parseEther("100"));

            expect(await satori.hasParticipated(ghostA.address)).to.equal(false);
            expect(await satori.hasParticipated(ghostB.address)).to.equal(false);

            // Snapshot all observable child accounting that a sync would touch.
            const predPowerA_before   = await rewards.getPredictionPower(ghostA.address);
            const predPowerB_before   = await rewards.getPredictionPower(ghostB.address);
            const predDelA_before     = (await rewards.predictionDelegateInfo(ghostA.address)).delegate;
            const predDelB_before     = (await rewards.predictionDelegateInfo(ghostB.address)).delegate;
            // Vote weight is BURNT, never balance-derived, so a transfer can never
            // move it. Pin that too — neither ghost bought weight, and the only
            // weight in the system is the default game's derived floor.
            const burnedBefore        = await voting.totalBurnedWeight();

            // Transfer between two never-participated accounts: skip-mask should
            // run NO sync. Balances still move (raw ERC20), but no child
            // delegation accounting is mutated, and crucially neither ghost
            // is marked as a participant by the transfer.
            await satori.connect(ghostA).transfer(ghostB.address, ethers.parseEther("10"));

            expect(await satori.hasParticipated(ghostA.address)).to.equal(false);
            expect(await satori.hasParticipated(ghostB.address)).to.equal(false);

            // The prediction-delegation back-references must be untouched.
            expect((await rewards.predictionDelegateInfo(ghostA.address)).delegate)
                .to.equal(predDelA_before);
            expect((await rewards.predictionDelegateInfo(ghostB.address)).delegate)
                .to.equal(predDelB_before);

            // Prediction power for an undelegated, never-participated user equals
            // its raw balance (no delegate pool involvement). Verify it simply
            // tracks the balance move, with no extra delegation credit injected.
            expect(await rewards.getPredictionPower(ghostA.address))
                .to.equal(predPowerA_before - ethers.parseEther("10"));
            expect(await rewards.getPredictionPower(ghostB.address))
                .to.equal(predPowerB_before + ethers.parseEther("10"));

            // Burn-backed vote weight is completely inert under a transfer.
            expect(await voting.totalBurnedWeight()).to.equal(burnedBefore);
            expect(await voting.totalBurnedWeight()).to.equal(0n);
        });
    });
});
