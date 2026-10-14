// Phase 6 (targets-on-games): the flagship moment-anchored path — band 1 of
// question 4. An HOURLY stream under a DAILY-target game: the anchor is the
// last sample at or before the prediction's hour, the target is the first
// sample at least the game's target (less the 30-minute allowance) after it.
// Everyone gets a full-length window measured from their own moment.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, VOTE, pack1 } = require("./fixtures");

const HOUR = 3600;

describe("Moment-anchored scoring (band 1: hourly stream, daily game)", function () {
  let satori, registry, voting, games, engine, owner, alice, bob, provider;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, registry, voting, games } = fix);
    owner = fix.owner;
    [alice, bob, provider] = fix.signers.slice(1, 4);
    engine = await ethers.getContractAt("SatoriEngine", await satori.engine());

    await satori.transfer(alice.address, ethers.parseEther("60"));
    await satori.transfer(bob.address, ethers.parseEther("60"));
  });

  // An hourly (60-minute) stream — publicly creatable now; the old cadence
  // floor is gone and the registry's own floor is the 60-minute hour grid.
  async function hourlyStream(startValue) {
    const tx = await satori.connect(alice)["createSimpleDataStream(string,address,uint24)"](
      "HOURLY", provider.address, 60);
    const r = await tx.wait();
    let sid;
    for (const log of r.logs) {
      try {
        const p = registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") { sid = p.args.streamId; break; }
      } catch {}
    }
    // Align to just past an hour boundary so "one hour later" is unambiguous.
    const now = await time.latest();
    await time.increaseTo(Math.floor(now / HOUR) * HOUR + HOUR + 5);
    await registry.connect(provider).setValue(sid, startValue);
    return sid;
  }

  async function writeHourly(sid, values) {
    for (const v of values) {
      await time.increase(HOUR);
      await registry.connect(provider).setValue(sid, v);
    }
  }

  it("the default target rule gives an hourly stream's game a daily target", async function () {
    const sid = await hourlyStream(100);
    expect(await games.targetMinutes(sid)).to.equal(1440); // gameId == streamId here
  });

  it("scores against the first sample at least ~24h after the prediction's hour — not the next sample", async function () {
    const sid = await hourlyStream(100);
    const gid = sid;
    await satori.connect(alice).vote(gid, VOTE);

    // Alice predicts UP right after the first sample.
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);

    // 23 hourly samples DROP the price — if the next-sample rule leaked in,
    // the prediction would already be scorable (and wrong).
    const falling = [];
    for (let i = 1; i <= 23; i++) falling.push(100 - i);
    await writeHourly(sid, falling);
    await satori.settlePrediction(alice.address, gid);
    const before = await satori.streaks(alice.address, gid);
    expect(before).to.equal(0); // nothing settled yet: the 24h target has not landed

    // Hour 24 (and one more for margin): the price recovers ABOVE the anchor.
    await writeHourly(sid, [150, 151]);
    await satori.settlePrediction(alice.address, gid);
    // Settled against the >=24h sample (150 > 100): correct, streak 1.
    expect(await satori.streaks(alice.address, gid)).to.equal(1);
  });

  it("a late entrant gets a full-length window from their own moment", async function () {
    const sid = await hourlyStream(1000);
    const gid = sid;
    await satori.connect(alice).vote(gid, VOTE);

    // Ten hourly samples pass; bob predicts DOWN at hour 10, against the
    // hour-10 anchor — not the stream's opening value.
    await writeHourly(sid, [1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090, 1100]);
    await satori.connect(bob).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(2) }]);

    // The next 23 hours the price keeps climbing (bob is losing vs his OWN
    // anchor 1100, though far above the opening 1000)...
    const rising = [];
    for (let i = 1; i <= 23; i++) rising.push(1100 + i);
    await writeHourly(sid, rising);
    await satori.settlePrediction(bob.address, gid);
    expect(await satori.streaks(bob.address, gid)).to.equal(0); // not yet settled

    // ...and the >=24h sample lands BELOW 1100: bob is right from his moment.
    await writeHourly(sid, [1090]);
    await satori.settlePrediction(bob.address, gid);
    expect(await satori.streaks(bob.address, gid)).to.equal(1);
  });

  it("PredictExpired is gone: predicting works with a stale-but-updated stream, any moment", async function () {
    const sid = await hourlyStream(100);
    const gid = sid;
    await satori.connect(alice).vote(gid, VOTE);
    // Advance two rounds with NO new value: under the old rule this was
    // PredictExpired; moment-anchoring accepts it (anchor = the old sample).
    await time.increase(2 * 24 * HOUR);
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }])
    ).to.not.be.reverted;
  });

  it("StaleValue still binds: no new value since your last prediction, no new prediction", async function () {
    const sid = await hourlyStream(100);
    const gid = sid;
    await satori.connect(alice).vote(gid, VOTE);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);
    await time.increase(24 * HOUR); // next round, but the stream never wrote again
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }])
    ).to.be.revertedWithCustomError(engine, "StaleValue");
  });

  it("once per round still binds within a day", async function () {
    const sid = await hourlyStream(100);
    const gid = sid;
    // Pin to just after a UTC day boundary. hourlyStream aligns to an HOUR
    // boundary, and hardhat seeds genesis time from the wall clock, so a run
    // that starts late in a day would have the +1h fresh sample below cross
    // midnight — making the second prediction a NEW round and the revert never
    // fire. Anchoring early in a fresh day keeps both predictions in one round.
    const DAY = 24 * HOUR;
    const now = await time.latest();
    await time.increaseTo(Math.floor(now / DAY) * DAY + DAY + 5);
    await registry.connect(provider).setValue(sid, 100);
    await satori.connect(alice).vote(gid, VOTE);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }]);
    await writeHourly(sid, [101]); // fresh value, +1h — still the same round
    // The rewards-side per-round guard fires first; either way, one
    // prediction per game per round.
    await expect(
      satori.connect(alice).predictMultipleWithPayloads([{ gameId: gid, payload: pack1(1) }])
    ).to.be.reverted; // AlreadyPredicted (rewards) ahead of DuplicatePrediction (engine)
  });
});
