const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixtureOpts, pack1, voteFor } = require("../fixtures");
const {
  ONE, BASE, DEFAULT_RATIO, STEP_ROUNDS, RATE_CAP, NO_STEP, T0,
  stepRate, rewardsSigner, issuedOf, issueTo,
  currentRound, advanceRound,
} = require("./emissionHelpers");

const SIMPLE3 = "createSimpleDataStream(string,address,uint24)";
const UINT64_MAX = 2n ** 64n - 1n;
const HALF = ONE / 2n;
const MIN_RATIO = 10n ** 15n; // SatoriHub.MIN_EMISSION_RATIO

// rewards.admin() is a dedicated signer so the holder, the token's appoint
// authority (the deployer) and a stranger are three different wallets.
async function deployWithSeparateAdmin() {
  const s = await ethers.getSigners();
  return deploySatoriFixtureOpts(2000, { rewardsAdmin: s[5].address });
}

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find((l) => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

describe("SatoriHub — emission ratio lever", function () {
  this.timeout(600000);
  let fix, hub, token, rewards, rw, owner, admin, stranger, carol;

  beforeEach(async function () {
    fix = await loadFixture(deployWithSeparateAdmin);
    ({ hub, token, rewards, owner } = fix);
    admin = fix.signers[5];
    stranger = fix.signers[6];
    carol = fix.signers[7];
    rw = await rewardsSigner(rewards);
    await advanceRound();
  });

  describe("the read model", function () {
    it("initialization logs the starting ratio and threshold", async function () {
      const logs = await hub.queryFilter(hub.filters.EmissionRatioSet(), 0);
      expect(logs.length).to.equal(1);
      expect(logs[0].args.ratioWad).to.equal(DEFAULT_RATIO);
      expect(logs[0].args.nextStepAt).to.equal(T0);
      expect(logs[0].args.setter).to.equal(ethers.ZeroAddress);
    });

    it("a step logs the reserve cumulative it banked through fromRound", async function () {
      await advanceRound();
      await rewards.connect(admin).setOffchainShareBps(9999);
      for (let i = 0; i < 5; i++) await advanceRound();
      // The reserve banked on the way here already counts toward the steps, so
      // cross whichever threshold is next.
      const { tx } = await issueTo(hub, token, rw, (await hub.emission()).nextStepAt);
      const rc = await tx.wait();
      const ev = rc.logs.filter((l) => l.address === hub.target)
        .map((l) => { try { return hub.interface.parseLog(l); } catch { return null; } })
        .find((p) => p && p.name === "EmissionStepped");
      expect(ev.args.reserveCumulative).to.be.gt(0n);
      expect(ev.args.reserveCumulative).to.equal(await hub.merkleReserveCumulative());
      expect(ev.args.fromRound).to.equal((await currentRound(token)) + 1n);
    });
  });

  describe("authority", function () {
    it("the holder defaults to rewards.admin(), distinct from the appoint authority", async function () {
      expect(await rewards.admin()).to.equal(admin.address);
      expect(await token.appointAuthority()).to.equal(owner.address);
      expect(await hub.emissionHolder()).to.equal(admin.address);
    });

    it("the holder may set the ratio; a stranger and the appoint authority may not", async function () {
      await expect(hub.connect(admin).setEmissionRatio(HALF)).to.not.be.reverted;
      expect((await hub.emission()).ratioWad).to.equal(HALF);
      await expect(hub.connect(stranger).setEmissionRatio(ONE))
        .to.be.revertedWithCustomError(hub, "Unauthorized");
      await expect(hub.connect(owner).setEmissionRatio(ONE))
        .to.be.revertedWithCustomError(hub, "Unauthorized");
    });

    it("the holder reassigns the slot; the new holder alone sets the ratio", async function () {
      await expect(hub.connect(admin).setEmissionAuthority(carol.address))
        .to.emit(hub, "EmissionAuthorityChanged").withArgs(admin.address, carol.address);
      expect(await hub.emissionAuthority()).to.equal(carol.address);
      expect(await hub.emissionHolder()).to.equal(carol.address);
      await expect(hub.connect(admin).setEmissionRatio(HALF))
        .to.be.revertedWithCustomError(hub, "Unauthorized");
      await expect(hub.connect(carol).setEmissionRatio(HALF)).to.not.be.reverted;
      await expect(hub.connect(admin).setEmissionAuthority(admin.address))
        .to.be.revertedWithCustomError(hub, "Unauthorized");
    });

    it("the appoint authority recalls the slot; zero falls back to rewards.admin()", async function () {
      await hub.connect(admin).setEmissionAuthority(carol.address);
      await expect(hub.connect(owner).setEmissionAuthority(ethers.ZeroAddress))
        .to.emit(hub, "EmissionAuthorityChanged").withArgs(carol.address, admin.address);
      expect(await hub.emissionAuthority()).to.equal(ethers.ZeroAddress);
      expect(await hub.emissionHolder()).to.equal(admin.address);
      await expect(hub.connect(carol).setEmissionRatio(HALF))
        .to.be.revertedWithCustomError(hub, "Unauthorized");
      await expect(hub.connect(admin).setEmissionRatio(HALF)).to.not.be.reverted;
    });

    it("a stranger cannot reassign the slot", async function () {
      await expect(hub.connect(stranger).setEmissionAuthority(stranger.address))
        .to.be.revertedWithCustomError(hub, "Unauthorized");
    });
  });

  describe("bounds", function () {
    it("accepts the 0.001 floor and uint64 max; rejects 0, dust, and uint64 max + 1", async function () {
      await expect(hub.connect(admin).setEmissionRatio(0n))
        .to.be.revertedWithCustomError(hub, "BadInput");
      await expect(hub.connect(admin).setEmissionRatio(1n))
        .to.be.revertedWithCustomError(hub, "BadInput");
      await expect(hub.connect(admin).setEmissionRatio(MIN_RATIO - 1n))
        .to.be.revertedWithCustomError(hub, "BadInput");
      await expect(hub.connect(admin).setEmissionRatio(MIN_RATIO)).to.not.be.reverted;
      await expect(hub.connect(admin).setEmissionRatio(UINT64_MAX)).to.not.be.reverted;
      expect((await hub.emission()).ratioWad).to.equal(UINT64_MAX);
      await expect(hub.connect(admin).setEmissionRatio(UINT64_MAX + 1n))
        .to.be.revertedWithCustomError(hub, "BadInput");
    });

    it("a uint64-max ratio steps straight to the 1440 clamp", async function () {
      await hub.connect(admin).setEmissionRatio(UINT64_MAX);
      await issueTo(hub, token, rw, T0);
      expect(await hub.emissionRateNext()).to.equal(RATE_CAP);
      expect((await hub.emission()).nextStepAt).to.equal(T0 + STEP_ROUNDS * RATE_CAP);
    });
  });

  describe("ratio 1.0 never steps", function () {
    it("10M of issuance at 1e18 short-circuits: no step, no event, threshold untouched", async function () {
      await hub.connect(admin).setEmissionRatio(ONE);
      const before = await hub.emission();
      const { tx, issued } = await issueTo(hub, token, rw, ethers.parseEther("10000000"));
      await expect(tx).to.not.emit(hub, "EmissionStepped");
      const e = await hub.emission();
      expect(e.issued).to.equal(issued);
      expect(e.stepsTaken).to.equal(before.stepsTaken);
      expect(e.rate).to.equal(BASE);
      expect(e.nextStepAt).to.equal(before.nextStepAt);
      await expect(hub.syncEmission()).to.not.emit(hub, "EmissionStepped");
      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(BASE);
    });

    it("switching 1.0 -> 0.618 rebases the threshold to issued + 730 x rate (no burst)", async function () {
      await hub.connect(admin).setEmissionRatio(ONE);
      await issueTo(hub, token, rw, ethers.parseEther("10000000"));
      const issued = await issuedOf(hub);
      const expected = issued + STEP_ROUNDS * BASE;
      await expect(hub.connect(admin).setEmissionRatio(DEFAULT_RATIO))
        .to.emit(hub, "EmissionRatioSet").withArgs(DEFAULT_RATIO, expected, admin.address);
      expect((await hub.emission()).nextStepAt).to.equal(expected);

      const { tx } = await issueTo(hub, token, rw, expected - ONE);
      await expect(tx).to.not.emit(hub, "EmissionStepped");
      expect((await hub.emission()).stepsTaken).to.equal(0n);

      const { tx: tx2 } = await issueTo(hub, token, rw, expected);
      await expect(tx2).to.emit(hub, "EmissionStepped");
      expect((await hub.emission()).stepsTaken).to.equal(1n);
      expect(await hub.emissionRateNext()).to.equal(stepRate(BASE, DEFAULT_RATIO));
    });

    it("switching to 1.0 leaves the pending threshold in place", async function () {
      await expect(hub.connect(admin).setEmissionRatio(ONE))
        .to.emit(hub, "EmissionRatioSet").withArgs(ONE, T0, admin.address);
      expect((await hub.emission()).nextStepAt).to.equal(T0);
    });
  });

  describe("other ratios", function () {
    it("0.618 -> 0.5 keeps the pending threshold, and the next step uses 0.5", async function () {
      await expect(hub.connect(admin).setEmissionRatio(HALF))
        .to.emit(hub, "EmissionRatioSet").withArgs(HALF, T0, admin.address);
      expect((await hub.emission()).nextStepAt).to.equal(T0);
      await issueTo(hub, token, rw, T0);
      const r1 = (BASE * HALF) / ONE;
      expect(await hub.emissionRateNext()).to.equal(r1);
      expect((await hub.emission()).nextStepAt).to.equal(T0 + STEP_ROUNDS * r1);
    });

    it("2.0 doubles the rate each step and clamps at 1440", async function () {
      await hub.connect(admin).setEmissionRatio(HALF);
      await issueTo(hub, token, rw, T0);
      const r1 = (BASE * HALF) / ONE;
      const t1 = T0 + STEP_ROUNDS * r1;

      await hub.connect(admin).setEmissionRatio(2n * ONE);
      expect((await hub.emission()).nextStepAt).to.equal(t1);
      await issueTo(hub, token, rw, t1);
      const r2 = r1 * 2n;
      const t2 = t1 + STEP_ROUNDS * r2;
      expect(await hub.emissionRateNext()).to.equal(r2);
      expect((await hub.emission()).nextStepAt).to.equal(t2);

      await issueTo(hub, token, rw, t2);
      expect(r2 * 2n).to.be.gt(RATE_CAP);
      expect(await hub.emissionRateNext()).to.equal(RATE_CAP);
      const t3 = t2 + STEP_ROUNDS * RATE_CAP;
      expect((await hub.emission()).nextStepAt).to.equal(t3);

      await issueTo(hub, token, rw, t3);
      expect(await hub.emissionRateNext()).to.equal(RATE_CAP);
      expect((await hub.emission()).stepsTaken).to.equal(4n);

      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(RATE_CAP);
      expect(await hub.emissionCeiling()).to.be.lt(await token.rewardCeiling());
    });

    it("ratio 0 reverts and leaves the schedule untouched (owner ruling 2026-10-14)", async function () {
      const e0 = await hub.emission();
      await expect(hub.connect(admin).setEmissionRatio(0n))
        .to.be.revertedWithCustomError(hub, "BadInput");
      const e1 = await hub.emission();
      expect(e1.ratioWad).to.equal(e0.ratioWad);
      expect(e1.nextStepAt).to.equal(e0.nextStepAt);
      expect(e1.rate).to.equal(e0.rate);
    });
  });

  describe("a ratio change never moves the current or next round", function () {
    it("mid-round sets leave emissionRateNow and emissionRateNext alone", async function () {
      const e0 = await hub.emission();
      await hub.connect(admin).setEmissionRatio(HALF);
      await hub.connect(admin).setEmissionRatio(MIN_RATIO);
      expect(await hub.emissionRateNow()).to.equal(BASE);
      expect(await hub.emissionRateNext()).to.equal(BASE);
      const e1 = await hub.emission();
      expect(e1.rate).to.equal(e0.rate);
      expect(e1.from).to.equal(e0.from);
      expect(e1.banked).to.equal(e0.banked);
      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(BASE);
    });

    it("with a step pending, a ratio change does not touch the stepped rate", async function () {
      await issueTo(hub, token, rw, T0);
      const s1 = stepRate(BASE, DEFAULT_RATIO);
      await hub.connect(admin).setEmissionRatio(HALF);
      expect(await hub.emissionRateNow()).to.equal(BASE);
      expect(await hub.emissionRateNext()).to.equal(s1);
      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(s1);
      await hub.connect(admin).setEmissionRatio(MIN_RATIO);
      expect(await hub.emissionRateNow()).to.equal(s1);
      expect(await hub.emissionRateNext()).to.equal(s1);
      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(s1);
    });
  });

  describe("rate 0 is harmless to the game", function () {
    it("settle and claim do not revert once the rate is 0, and pay 0 for rate-0 rounds", async function () {
      const { satori, registry } = fix;
      const alice = fix.signers[1];
      await satori.transfer(alice.address, ethers.parseEther("100"));
      await advanceRound();

      const sid = await streamIdFrom(await satori[SIMPLE3]("S", owner.address, 1440), satori);
      await registry.setValue(sid, 100);
      await voteFor(satori, alice, sid);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(1) }]);
      await advanceRound();
      await registry.setValue(sid, 110);
      await advanceRound();
      await registry.setValue(sid, 120);
      await satori.settlePrediction(alice.address, sid);
      const earned = await rewards.unclaimedRewards(alice.address);
      expect(earned).to.be.gt(0n);

      // The 0.001 floor is the only way down: each step takes a thousandth, so
      // the rate floors to 0 after enough steps.
      await hub.connect(admin).setEmissionRatio(MIN_RATIO);
      for (let i = 0; i < 12 && (await hub.emissionRateNext()) > 0n; i++) {
        await issueTo(hub, token, rw, (await hub.emission()).nextStepAt + ONE);
      }
      await advanceRound();
      expect(await hub.emissionRateNow()).to.equal(0n);
      expect(await hub.devRateNow()).to.equal(0n);

      await registry.setValue(sid, 130);
      await satori.connect(alice).predictMultipleWithPayloads([{ gameId: sid, payload: pack1(1) }]);
      await advanceRound();
      await registry.setValue(sid, 140);
      await advanceRound();
      await registry.setValue(sid, 150);
      await expect(satori.settlePrediction(alice.address, sid)).to.not.be.reverted;
      expect(await rewards.unclaimedRewards(alice.address)).to.equal(earned);

      const bal = await token.balanceOf(alice.address);
      await expect(satori.connect(alice)["claim()"]()).to.not.be.reverted;
      expect(await token.balanceOf(alice.address)).to.equal(bal + earned);
    });
  });
});
