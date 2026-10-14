const { expect } = require("chai");
const { deploySatoriFixtureNoFee } = require("./fixtures");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Verifies the _firstActiveDelegationPeriod cursor: after many delegate /
// undelegate cycles, claim cost should not scale with lifetime delegation
// count. Closed-and-fully-walked periods are skipped on subsequent claims.

async function advanceRound() {
  const t = await time.latest();
  const next = Math.floor(t / 86400) * 86400 + 86400;
  await time.increaseTo(next + 1);
}

describe("Delegation Period cursor", function () {
  it("retired periods are skipped — many delegations don't blow up claim gas", async function () {
    const fix = await deploySatoriFixtureNoFee();
    const { satori, owner } = fix;
    const [, alice, bob, carol] = fix.signers;

    // Fund Alice and the candidate delegates.
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(bob.address, ethers.parseEther("100"));
    await satori.transfer(carol.address, ethers.parseEther("100"));

    // Cycle Alice through N delegate/undelegate pairs to bob, then close them.
    // Each cycle: delegate -> wait a round -> undelegate. Each undelegate closes
    // the prior period so it becomes retired-able after a future claim walks it.
    const N = 5;
    for (let i = 0; i < N; i++) {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await advanceRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress); // undelegate
      await advanceRound();
    }
    // Final state: Alice has N closed periods, no open period.

    // First claim: the cursor walks all N periods (all closed, no rate so all
    // become fully retired). Records gas.
    const tx1 = await satori.connect(alice)['claim()']();
    const r1 = await tx1.wait();
    const gas1 = Number(r1.gasUsed);

    // Second claim: cursor should now sit at N (all retired). Loop body never
    // executes — gas should be much lower than the first claim.
    const tx2 = await satori.connect(alice)['claim()']();
    const r2 = await tx2.wait();
    const gas2 = Number(r2.gasUsed);

    // Assert the cursor advanced — second claim is at least 30% cheaper than
    // the first (gas savings come from skipping the now-retired periods).
    expect(gas2).to.be.lessThan(gas1 * 0.7);
  });
});
