// M27 and M26 — a round's bounty pot is reserved at its first boost, and a boosted
// prediction that finalizes without a win gives its share straight back.
//
// Before: the pot was drawn at the first winner's settle from whatever the pool and
// rate were then, so a later round could drain a short pool first and a top-up
// re-rated rounds already played; a loser's share stayed parked until the history
// ring rolled past the round.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, warmUpStreak, VOTE } = require("../fixtures");

const UP = 1;
const DOWN = 2;
const HOUR = 3600;
const DAY = 86400;
const E = (n) => ethers.parseEther(String(n));

describe("Bounty pot reserved at the first boost, forfeits released at finalize (M27, M26)", function () {
  this.timeout(600000);

  let satori, bounties, registry, engine, owner, alice, bob, funder, authority;
  let stream, usd, usdAddr, base;
  const STAKE = E(100);

  async function setup(pot, rate) {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, bounties, registry, owner } = fix);
    [, alice, bob, funder, authority] = fix.signers;
    engine = await ethers.getContractAt("SatoriEngine", await satori.engine());
    for (const u of [alice, bob, funder]) await satori.transfer(u.address, E(100));

    const rcpt = await (await satori.connect(owner)["createSimpleDataStream(string,address,uint24)"](
      "S", authority.address, 60)).wait();
    stream = rcpt.logs.map((l) => { try { return satori.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "DataStreamCreated").args.streamId;
    await warmUpStreak(satori, registry, authority, [alice, bob], stream);
    await satori.connect(alice).vote(stream, VOTE);
    await satori.connect(bob).vote(stream, VOTE);

    const M = await ethers.getContractFactory("MockERC20");
    usd = await M.deploy("USDC", "USDC");
    await usd.waitForDeployment();
    usdAddr = await usd.getAddress();
    const ba = await bounties.getAddress();
    await usd.mint(funder.address, E(100000));
    await usd.connect(funder).approve(ba, E(100000));
    await bounties.connect(funder).fundBounty(stream, usdAddr, pot, rate);
    for (const u of [alice, bob]) {
      await usd.mint(u.address, STAKE);
      await usd.connect(u).approve(ba, STAKE);
      await bounties.connect(u).stakeBountyToken(usdAddr, STAKE);
    }
    base = Math.floor((await time.latest()) / DAY) * DAY + DAY;
  }

  const at = (d, h, m = 5) => time.increaseTo(base + d * DAY + h * HOUR + m * 60);
  const write = (v) => registry.connect(authority).setValue(stream, v);
  const predict = (who, dir) =>
    satori.connect(who).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(dir) }]);
  const earned = async (who) => (await bounties.bountyStake(who.address, usdAddr)) - STAKE;

  describe("M27: the pot is fixed when the round is first boosted", function () {
    it("a later round cannot drain an earlier round's pot, whatever order they settle in", async function () {
      await setup(E(150), E(100)); // two rounds of drip do not fit: 100 + 50
      await at(0, 0, 30); await write(100);
      await at(0, 1); await predict(alice, UP);
      const r1 = await satori.getCurrentRound();
      expect(await bounties.roundBountyPot(stream, r1, usdAddr)).to.equal(E(100));
      expect(await bounties.pool(stream, usdAddr)).to.equal(E(50));

      await at(1, 1, 30); await write(150);
      await at(1, 2); await predict(bob, UP);
      const r2 = await satori.getCurrentRound();
      expect(await bounties.roundBountyPot(stream, r2, usdAddr)).to.equal(E(50));
      expect(await bounties.pool(stream, usdAddr)).to.equal(0n);

      await at(2, 2, 30); await write(200);
      // The later round settles first and takes only its own reserved pot.
      await satori.settlePrediction(bob.address, stream);
      expect(await earned(bob)).to.equal(E(50));
      await satori.settlePrediction(alice.address, stream);
      expect(await earned(alice)).to.equal(E(100));
    });

    it("a prediction in a round whose first boost emptied the pool still shares that round's pot", async function () {
      await setup(E(100), E(100)); // one drip empties the pool
      await at(0, 0, 30); await write(100);
      await at(0, 1); await predict(alice, UP);
      const round = await satori.getCurrentRound();
      expect(await bounties.pool(stream, usdAddr)).to.equal(0n);

      await at(0, 2); await predict(bob, UP);
      expect(await bounties.roundBountyPot(stream, round, usdAddr)).to.equal(E(100));

      await at(1, 1, 30); await write(150);
      await at(1, 2, 30); await write(200);
      await satori.settlePrediction(alice.address, stream);
      await satori.settlePrediction(bob.address, stream);
      expect(await earned(alice)).to.equal(E(50));
      expect(await earned(bob)).to.equal(E(50));
    });

    it("a top-up after a round was boosted does not re-rate it", async function () {
      await setup(E(1000), E(100));
      await at(0, 0, 30); await write(100);
      await at(0, 1); await predict(alice, UP);
      const r1 = await satori.getCurrentRound();
      const potBefore = await bounties.roundBountyPot(stream, r1, usdAddr);
      expect(potBefore).to.equal(E(100));

      // A sponsor tops up at a much lower rate, which re-rates the pool going forward.
      await bounties.connect(funder).fundBounty(stream, usdAddr, E(5000), E(10));
      expect(await bounties.roundBountyPot(stream, r1, usdAddr)).to.equal(potBefore);

      await at(1, 1, 30); await write(150);
      await satori.settlePrediction(alice.address, stream);
      expect(await earned(alice)).to.equal(potBefore);
    });
  });

  describe("M26: a boosted prediction that finalizes without a win releases its share", function () {
    it("a loss returns the loser's share to the pool at once, and the winner is paid exactly", async function () {
      await setup(E(1000), E(100));
      await at(0, 0, 30); await write(100);
      await at(0, 1); await predict(alice, UP);
      const round = await satori.getCurrentRound();
      await at(0, 12, 30); await write(200);
      await at(0, 13); await predict(bob, DOWN);
      await at(1, 1, 30); await write(150);   // alice's window closes: UP wins
      await at(1, 13, 30); await write(250);  // bob's window closes: DOWN loses

      expect(await bounties.pool(stream, usdAddr)).to.equal(E(900));
      await satori.settlePrediction(alice.address, stream);
      expect(await earned(alice)).to.equal(E(50)); // half of the 100 pot
      const tx = await satori.settlePrediction(bob.address, stream);

      await expect(tx).to.emit(bounties, "StrandedPotReclaimed")
        .withArgs(stream, round, usdAddr, E(50), E(950), (v) => v > 0n);
      expect(await earned(bob)).to.equal(0n);
      expect(await bounties.pool(stream, usdAddr)).to.equal(E(950));
      // Nothing is left to reclaim, and the whole pot is accounted for.
      expect(await bounties.roundBountyPotClaimed(stream, round, usdAddr)).to.equal(E(100));
      await expect(bounties.reclaimStrandedPot(stream, round, usdAddr))
        .to.be.revertedWithCustomError(bounties, "NothingToReclaim");
      expect(await bounties.boostStakeForPrediction(bob.address, stream, round, usdAddr)).to.equal(0n);
      expect(await usd.balanceOf(await bounties.getAddress())).to.equal(E(1000) + 2n * STAKE);
    });

    it("both sides winning releases nothing: each takes half and the pool is untouched", async function () {
      await setup(E(1000), E(100));
      await at(0, 0, 30); await write(100);
      await at(0, 1); await predict(alice, UP);
      const round = await satori.getCurrentRound();
      await at(0, 12, 30); await write(200);
      await at(0, 13); await predict(bob, DOWN);
      await at(1, 1, 30); await write(150);
      await at(1, 13, 30); await write(50);
      await satori.settlePrediction(alice.address, stream);
      await satori.settlePrediction(bob.address, stream);

      expect(await earned(alice)).to.equal(E(50));
      expect(await earned(bob)).to.equal(E(50));
      expect(await bounties.pool(stream, usdAddr)).to.equal(E(900));
      expect(await bounties.roundBountyPotClaimed(stream, round, usdAddr)).to.equal(E(100));
    });

    it("a void releases the whole share of a lone booster", async function () {
      await setup(E(1000), E(100));
      await at(0, 0, 30); await write(100);
      await at(0, 1); await predict(alice, UP);
      const round = await satori.getCurrentRound();
      await at(1, 1, 30); await write(100); // equal readings: the prediction voids

      const tx = await satori.settlePrediction(alice.address, stream);
      await expect(tx).to.emit(engine, "PredictionVoided");
      expect(await earned(alice)).to.equal(0n);
      expect(await bounties.pool(stream, usdAddr)).to.equal(E(1000));
      expect(await bounties.roundBountyPotClaimed(stream, round, usdAddr)).to.equal(E(100));
    });

    it("an unrecoverable prediction (its anchor left the ring) releases its share too", async function () {
      await setup(E(1000), E(100));
      await at(0, 0, 30); await write(100);
      await at(0, 1); await predict(alice, UP);
      const round = await satori.getCurrentRound();
      // Roll the 768-entry hourly ring past the prediction's anchor.
      let t = base + 0 * DAY + 1 * HOUR + 5 * 60;
      for (let i = 0; i < 770; i++) {
        t += HOUR;
        await time.increaseTo(t);
        await write(100 + i);
      }
      const tx = await satori.settlePrediction(alice.address, stream);
      await expect(tx).to.emit(engine, "PredictionUnrecoverable");
      expect(await bounties.pool(stream, usdAddr)).to.equal(E(1000));
      expect(await bounties.roundBountyPotClaimed(stream, round, usdAddr)).to.equal(E(100));
    });

    it("only the engine may release", async function () {
      await setup(E(1000), E(100));
      await expect(bounties.connect(alice).releaseForfeit(alice.address, stream, 1))
        .to.be.revertedWithCustomError(bounties, "Unauthorized");
    });
  });
});
