const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureNoFee } = require("../fixtures");
const {
  ONE, BASE, PHI_INV, STEP_ROUNDS, FLAT_ROUNDS, NO_STEP, T0,
  ladder, rewardsSigner, issueTo, issueBelow,
  currentRound, atRound, advanceRound, eventsNamed,
} = require("./emissionHelpers");

// docs/issues/emission-issuance-indexed-schedule.md §2 — verified by script there.
const SPEC_LADDER = [
  { rate: 523241111301513906395n, next: 1618033988749894848077170n },
  { rate: 323380791095602323633n, next: 1854101966249684544329260n },
  { rate: 199860320205911582521n, next: 1999999999999999999569590n },
  { rate: 123520470889690740962n, next: 2090169943749474240471850n },
  { rate: 76339849316220841466n,  next: 2145898033750315454742030n },
];
const LIFETIME = 2236067977499789695432590n;
const TAIL = 999999999999999999023770n;

describe("SatoriHub — issuance-indexed emission schedule", function () {
  this.timeout(600000);
  let hub, token, rewards, rw, stranger, dep, bps;
  const REF = ladder();

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixtureNoFee);
    ({ hub, token, rewards } = fix);
    stranger = fix.signers[7];
    dep = BigInt(await token.deploymentRound());
    bps = await token.devFeeBps();
    rw = await rewardsSigner(rewards);
  });

  describe("defaults and lockstep", function () {
    it("seeds every field of the schedule at genesis", async function () {
      const e = await hub.emission();
      expect(e.issued).to.equal(BASE);
      expect(e.issued).to.equal(await token.totalRewardsMinted());
      expect(e.nextStepAt).to.equal(1236067977499789696408820n);
      expect(e.nextStepAt).to.equal(FLAT_ROUNDS * BASE);
      expect(e.rate).to.equal(BASE);
      expect(e.prevRate).to.equal(BASE);
      expect(e.from).to.equal(dep);
      expect(e.ratioWad).to.equal(PHI_INV);
      expect(e.stepsTaken).to.equal(0n);
      expect(e.banked).to.equal(0n);
    });

    it("fixes the step constants and starts the holder at rewards.admin()", async function () {
      expect(await hub.STEP_ROUNDS()).to.equal(STEP_ROUNDS);
      expect(await hub.FLAT_ROUNDS()).to.equal(FLAT_ROUNDS);
      expect(await hub.NO_STEP()).to.equal(NO_STEP);
      expect(await hub.PHI_INV()).to.equal(PHI_INV);
      expect(await hub.emissionAuthority()).to.equal(ethers.ZeroAddress);
      expect(await hub.emissionHolder()).to.equal(await rewards.admin());
    });

    it("pins INITIAL_MINT == BASE == emissionRateNow, and the hub's 1440 to the token's", async function () {
      expect(await token.INITIAL_MINT()).to.equal(BASE);
      expect(await hub.BASE_EMISSION_PER_ROUND()).to.equal(BASE);
      expect(await hub.emissionRateNow()).to.equal(BASE);
      expect(await hub.emissionRateNext()).to.equal(BASE);
      expect(await hub.residualNext()).to.equal(BASE - (BASE * bps) / 10000n);
      expect(await hub.ROUND_REWARD_BUDGET()).to.equal(await token.ROUND_REWARD_BUDGET());
      expect(await hub.emissionCeiling()).to.equal(BASE);
    });

    it("the base rate really is (500000/365)*(phi-1) truncated", async function () {
      const phiInvHi = 618033988749894848204586834365n; // (phi-1) x 1e30
      expect(BASE).to.equal((500000n * ONE * phiInvHi) / (365n * 10n ** 30n));
    });

    it("drops the time schedule and the 3M cap from the ABI", async function () {
      for (const name of ["MAX_REWARD_SUPPLY", "currentEpoch", "DECAY_START_ROUND", "EPOCH_ROUNDS"]) {
        expect(hub.interface.getFunction(name), name).to.equal(null);
      }
    });

    it("the clock alone never moves the rate", async function () {
      await atRound(token, 22096n + 3n * 730n); // three of the retired time epochs
      expect(await hub.emissionRateNow()).to.equal(BASE);
      expect((await hub.emission()).nextStepAt).to.equal(T0);
      expect((await hub.emission()).stepsTaken).to.equal(0n);
    });

    it("only SatoriRewards may count issuance", async function () {
      await expect(hub.connect(stranger).noteIssued(1n))
        .to.be.revertedWithCustomError(hub, "Unauthorized");
    });
  });

  describe("the ladder is driven by the counter", function () {
    beforeEach(advanceRound);

    it("the JS reference reproduces the spec table, the tail and the lifetime total", async function () {
      for (let i = 0; i < SPEC_LADDER.length; i++) {
        expect(REF[i].rate, `step ${i + 1} rate`).to.equal(SPEC_LADDER[i].rate);
        expect(REF[i].next, `step ${i + 1} next`).to.equal(SPEC_LADDER[i].next);
      }
      expect(REF.length).to.equal(99);
      expect(REF[98]).to.deep.equal({ rate: 0n, next: NO_STEP });
      expect(REF[97].next).to.equal(LIFETIME);
      let tail = 0n;
      for (const row of REF.slice(0, 98)) tail += STEP_ROUNDS * row.rate;
      expect(tail).to.equal(TAIL);
      expect(T0 + tail).to.equal(LIFETIME);
    });

    it("holds the base rate while issued < the first threshold", async function () {
      const { tx, issued } = await issueBelow(hub, token, rw, T0);
      await expect(tx).to.not.emit(hub, "EmissionStepped");
      const e = await hub.emission();
      expect(e.issued).to.equal(issued);
      expect(e.issued).to.be.lt(T0);
      expect(e.rate).to.equal(BASE);
      expect(e.stepsTaken).to.equal(0n);
      expect(await hub.emissionRateNext()).to.equal(BASE);
    });

    it("the crossing tx leaves this round's rate alone; the next round pays step 1", async function () {
      const cur = await currentRound(token);
      const devBefore = await hub.devRateNow();
      const ceilBefore = await hub.emissionCeiling();
      const { tx, issued } = await issueTo(hub, token, rw, T0);
      await expect(tx).to.emit(hub, "EmissionStepped")
        .withArgs(1n, SPEC_LADDER[0].rate, SPEC_LADDER[0].next, issued, cur + 1n, 0n);

      expect(await hub.emissionRateNow()).to.equal(BASE);
      expect(await hub.devRateNow()).to.equal(devBefore);
      expect(await hub.emissionCeiling()).to.equal(ceilBefore);
      expect(await hub.emissionRateNext()).to.equal(SPEC_LADDER[0].rate);
      expect(await hub.residualNext())
        .to.equal(SPEC_LADDER[0].rate - (SPEC_LADDER[0].rate * bps) / 10000n);
      const e = await hub.emission();
      expect(e.prevRate).to.equal(BASE);
      expect(e.from).to.equal(cur + 1n);
      expect(e.nextStepAt).to.equal(1618033988749894848077170n);
      expect(e.stepsTaken).to.equal(1n);

      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(523241111301513906395n);
      expect(await hub.devRateNow()).to.equal((523241111301513906395n * bps) / 10000n);
    });

    it("walks rows 1-5 of the default ladder to the wei", async function () {
      let threshold = T0;
      for (let i = 0; i < SPEC_LADDER.length; i++) {
        await issueTo(hub, token, rw, threshold);
        await advanceRound();
        const e = await hub.emission();
        expect(await hub.emissionRateNow(), `row ${i + 1} rate`).to.equal(SPEC_LADDER[i].rate);
        expect(e.nextStepAt, `row ${i + 1} nextStepAt`).to.equal(SPEC_LADDER[i].next);
        expect(e.stepsTaken).to.equal(BigInt(i + 1));
        threshold = SPEC_LADDER[i].next;
      }
    });

    it("one bump across three thresholds compounds three times, in one event, next round", async function () {
      const cur = await currentRound(token);
      const target = ethers.parseEther("1900000"); // past row 2's threshold, short of row 3's
      const { tx, issued } = await issueTo(hub, token, rw, target);
      const rc = await tx.wait();
      const ev = eventsNamed(rc, hub, "EmissionStepped");
      expect(ev.length).to.equal(1);
      expect(ev[0].args.stepsTaken).to.equal(3n);
      expect(ev[0].args.newRate).to.equal(SPEC_LADDER[2].rate);
      expect(ev[0].args.nextStepAt).to.equal(SPEC_LADDER[2].next);
      expect(ev[0].args.issued).to.equal(issued);
      expect(ev[0].args.fromRound).to.equal(cur + 1n);

      expect(await hub.emissionRateNow()).to.equal(BASE);
      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(SPEC_LADDER[2].rate);
    });

    it("caps one bump at 32 steps; syncEmission applies the rest", async function () {
      const cur = await currentRound(token);
      const { tx, issued } = await issueTo(hub, token, rw, ethers.parseEther("3000000"));
      await expect(tx).to.emit(hub, "EmissionStepped")
        .withArgs(32n, REF[31].rate, REF[31].next, issued, cur + 1n, 0n);
      expect((await hub.emission()).stepsTaken).to.equal(32n);

      await expect(hub.connect(stranger).syncEmission()).to.emit(hub, "EmissionStepped")
        .withArgs(64n, REF[63].rate, REF[63].next, issued, cur + 1n, 0n);
      await expect(hub.connect(stranger).syncEmission()).to.emit(hub, "EmissionStepped")
        .withArgs(96n, REF[95].rate, REF[95].next, issued, cur + 1n, 0n);
      await expect(hub.connect(stranger).syncEmission()).to.emit(hub, "EmissionStepped")
        .withArgs(99n, 0n, NO_STEP, issued, cur + 1n, 0n);
      await expect(hub.connect(stranger).syncEmission()).to.not.emit(hub, "EmissionStepped");

      expect(await hub.emissionRateNow()).to.equal(BASE);
      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(0n);
    });

    it("exhausts to rate 0 with NO_STEP, after which nothing steps and the ceiling stops", async function () {
      await issueTo(hub, token, rw, LIFETIME);
      for (let i = 0; i < 4; i++) await hub.syncEmission();
      const e = await hub.emission();
      expect(e.rate).to.equal(0n);
      expect(e.nextStepAt).to.equal(NO_STEP);
      expect(e.stepsTaken).to.equal(99n);

      await advanceRound();
      const c = await hub.emissionCeiling();
      const { tx } = await issueTo(hub, token, rw, ethers.parseEther("10000000"));
      await expect(tx).to.not.emit(hub, "EmissionStepped");
      await advanceRound();
      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(0n);
      expect(await hub.emissionCeiling()).to.equal(c);
    });
  });

  describe("the ceiling", function () {
    // Σ of each round's rate over [dep, cur], from a list of (from, rate) segments.
    function refCeiling(segments, cur) {
      let sum = 0n;
      for (let i = 0; i < segments.length; i++) {
        const start = segments[i].from;
        const end = i + 1 < segments.length ? segments[i + 1].from - 1n : cur;
        const last = end < cur ? end : cur;
        if (last >= start) sum += segments[i].rate * (last - start + 1n);
      }
      return sum;
    }

    it("equals a round-by-round reference across steps, constant within a round, non-decreasing, inside the envelope", async function () {
      const segments = [{ from: dep, rate: BASE }];
      let prev = 0n;
      const check = async (label) => {
        const cur = await currentRound(token);
        const c = await hub.emissionCeiling();
        expect(c, label).to.equal(refCeiling(segments, cur));
        expect(c, label).to.be.gte(prev);
        expect(c, label).to.be.lt(await token.rewardCeiling());
        prev = c;
      };

      await check("genesis");
      await atRound(token, dep + 10n);
      await check("dep+10");

      let cur = await currentRound(token);
      let before = await hub.emissionCeiling();
      await issueTo(hub, token, rw, T0);
      expect(await hub.emissionCeiling(), "crossing round").to.equal(before);
      segments.push({ from: cur + 1n, rate: SPEC_LADDER[0].rate });
      await check("crossing round");

      for (const k of [1n, 5n]) { await atRound(token, cur + k); await check(`step1 +${k}`); }

      cur = await currentRound(token);
      before = await hub.emissionCeiling();
      await issueTo(hub, token, rw, SPEC_LADDER[0].next);
      await issueTo(hub, token, rw, SPEC_LADDER[1].next); // two writes in one round
      expect(await hub.emissionCeiling(), "second crossing round").to.equal(before);
      segments.push({ from: cur + 1n, rate: SPEC_LADDER[2].rate });
      await check("second crossing round");

      for (const k of [1n, 2n, 30n, 400n]) { await atRound(token, cur + k); await check(`step3 +${k}`); }
    });

    it("costs the same gas at dep+10 and dep+100000", async function () {
      await atRound(token, dep + 10n);
      const g1 = await hub.emissionCeiling.estimateGas();
      await atRound(token, dep + 100000n);
      const g2 = await hub.emissionCeiling.estimateGas();
      expect(g2).to.equal(g1);
    });
  });
});
