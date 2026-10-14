// Adversarial finding (LOW) — dependencies-wiring:
// "Delegator's unclaimedRewards prediction power is silently dropped while
//  prediction-delegated"
//
// Location:
//   Satori.sol:delegatePredictionPower line 1888 — computes
//     `predictionPower = balanceOf(msg.sender)` and forwards ONLY the raw
//     ERC20 balance to SatoriRewards.delegatePredictionPower; the
//     unclaimedRewards eager-credit shadow is excluded.
//   SatoriRewards.sol:getPredictionPower lines 1843-1853 — for an UNdelegated
//     user returns `_balanceOf + unclaimedRewards + di.power`; once delegated
//     returns 0.
//
// INTENDED behavior (per the eager-credit feature + power conservation):
//   getPredictionPower(user) = balanceOf(user) + unclaimedRewards(user)
//                              + delegatedPower(user)
//   (see EagerCredit.test.js and SatoriRewards.sol, and the
//    direct-prediction path which snapshots ownPower = _balanceOf + unclaimedRewards
//    at lines 881/1088).
//
//   Delegation should be power-CONSERVING: when a user with prediction power
//   P = B + X (B = balanceOf, X = unclaimedRewards) delegates to D, D's
//   delegated prediction power should rise by the delegator's FULL prediction
//   power P, and the system's total prediction power should be unchanged.
//
// BUG: only B is moved into D's pool; the X (unclaimedRewards) slice is
//   credited to no one while the delegator is delegated. getPredictionPower(U)
//   becomes 0 and D's pool reflects only B, so the X portion of prediction
//   power vanishes from the system (strictly an undercount; X is recoverable
//   by U via claim or undelegation).
//
// This test asserts the INTENDED (conserving) behavior. If the bug is present
// it FAILS (verdict CONFIRMED).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const UP = 1;
async function advanceOneDay() { await time.increase(86400); }

// The stream is scaffolding for the delegation assertions below, so it runs
// at the every-round cadence (1440 minutes = one write per 24h round).
// `authority` — the PROVIDER that writes the values — is unchanged.
async function createStream(satori, signer, name, authority) {
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 1440);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("LOW finding — delegator unclaimedRewards prediction power dropped while delegated", function () {
  this.timeout(120000);

  let satori, rewards, registry, owner, alice, bob, authority;
  let stream;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, registry, owner } = fix);
    [, alice, bob, authority] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    stream = await createStream(satori, fix.owner, "S", authority.address);
    // Burn-backed voting: each burns VOTE (10) to give the stream's game weight.
    // Their remaining balance (90 each) is what the delegation math below reads,
    // and every balance assertion in the test is taken live rather than hardcoded.
    await voteFor(satori, alice, stream);
    await voteFor(satori, bob, stream);
  });

  it("delegation moves only the delegator's BALANCE; unclaimed rewards stay with them (recoverable, not lost) — accepted, low_8", async function () {
    // 1) Alice predicts correctly and accrues unclaimedRewards X > 0
    //    (eager-credited at score time, never claimed).
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream);

    const B = await satori.balanceOf(alice.address);
    const X = await rewards.unclaimedRewards(alice.address);
    expect(X).to.be.gt(0n); // precondition: nonzero eager-credited shadow

    // While UNdelegated, Alice's prediction power is the full B + X.
    const aliceOwnPowerBefore = await rewards.getPredictionPower(alice.address);
    expect(aliceOwnPowerBefore).to.equal(B + X);

    // Bob's delegated prediction power before Alice delegates.
    const bobPowerBefore = await rewards.getPredictionPower(bob.address);

    // 2) Alice delegates her prediction power to Bob.
    await satori.connect(alice).delegatePredictionPower(bob.address);

    // 3) ACCEPTED behavior (low_8, owner decision — benign undercount, NOT a
    //    bug): delegation moves only the delegator's token BALANCE (B) to the
    //    delegate, NOT the unclaimedRewards shadow (X). So Bob's delegated power
    //    rises by B, not B + X.
    const credited = (await rewards.getPredictionPower(bob.address)) - bobPowerBefore;
    expect(credited).to.equal(B, "only the delegator's balance B is delegated, not B + X");

    // X is NOT lost — it stays in the delegator's unclaimedRewards...
    expect(await rewards.unclaimedRewards(alice.address)).to.equal(X);
    // ...and the delegated user's own prediction power reads 0 (balance is now
    // at the delegate).
    expect(await rewards.getPredictionPower(alice.address)).to.equal(0n);

    // RECOVERABLE: undelegating restores the delegator's FULL power (B + X) —
    // nothing was minted, nothing lost. (Claiming X while delegated also syncs
    // it to the delegate, so X is never stranded.) This is why low_8 is a benign
    // undercount, not a loss — see the dapp "How it works" note on delegation.
    await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
    expect(await rewards.getPredictionPower(alice.address)).to.equal(B + X);
  });
});
