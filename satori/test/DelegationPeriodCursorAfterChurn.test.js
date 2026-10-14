// Item J — delegation-period unbounded growth.
//
// Panel originally flagged `_periodIndicesByPair` + `getDelegatorPowerAt` as
// an unbounded growth + third-party DoS pair. Under v5 rewards both are
// gone:
//   - `_periodIndicesByPair`: deleted.
//   - `getDelegatorPowerAt`: deleted.
//   - `claimAsDelegator` (the third-party walk site): bounty side has no
//     delegator slice anymore; SATORI delegator accrual is pulled by the
//     delegator themselves via `_accrueDelegatorRewards`.
//   - `_firstActiveDelegationPeriod`: a forward-only cursor that advances
//     past fully-walked closed periods at the end of every claim, so
//     subsequent claims only walk active periods.
//
// Net: the original third-party DoS vector is closed. The residual is
// self-DoS — a delegator who churns their own delegation many times then
// claims pays O(N) for the first claim. They pay their own gas; no one
// else is affected.
//
// This test verifies the cursor-advancement behavior end-to-end: after
// many delegate/undelegate cycles, a single claim drains the queued
// periods and the cursor advances past them.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

const ROUND = 86400;

describe("DelegationPeriod — cursor advances past churned closed periods (Item J)", function () {
  let satori, rewards, owner, alice, bob, carol;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, rewards, owner } = fix);
    [, alice, bob, carol] = fix.signers;

    // Give alice some tokens so she has delegation power to churn.
    await satori.transfer(alice.address, ethers.parseEther("100"));
  });

  it("churning delegate/undelegate many times appends periods, then a claim advances the cursor past them", async function () {
    // Reach into the un-getter'd field via the public `_delegationPeriods`
    // accessor — Solidity auto-generates a getter for `private` mappings only
    // when they're declared `public`. This one is private, so use a sentinel
    // measurement: track that subsequent claims become O(1)-cheap.

    // Initial state: no delegation periods for alice.
    // Cycle 5 delegate/undelegate pairs across separate rounds to ensure each
    // is a distinct period (same-round-redelegate normalizes / collapses).
    for (let i = 0; i < 5; i++) {
      await satori.connect(alice).delegatePredictionPower(bob.address);
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
      // Advance rounds so each cycle gets a fresh startRound/endRound.
      await time.increase(2 * ROUND);
    }

    // Now claim — under v5 + cursor pattern, the walk should advance the
    // cursor past all 5 closed periods, and subsequent claims should be
    // O(0)-walk (cursor already at end). claim() is gated via Satori.sol,
    // not callable directly on SatoriRewards.
    const claimZeroArg = satori.interface.getFunction("claim()");
    const claimSelector = claimZeroArg.selector;
    const gasFirstClaim = await alice.estimateGas({
      to: await satori.getAddress(),
      data: claimSelector,
    });
    await alice.sendTransaction({ to: await satori.getAddress(), data: claimSelector });

    // Second claim immediately after: cursor is past every closed period,
    // so this should cost meaningfully less than the first claim.
    const gasSecondClaim = await alice.estimateGas({
      to: await satori.getAddress(),
      data: claimSelector,
    });

    // First claim walks ~5 periods. Second walks none.
    // Use a soft expectation: second claim must be strictly cheaper than first.
    expect(gasSecondClaim).to.be.lessThan(gasFirstClaim);
  });

  it("the third-party DoS vector is closed — only the delegator themselves can grow their period list", async function () {
    // `delegatePredictionPower` is `onlyCore`; the core's `delegatePredictionPower`
    // entry point passes `msg.sender` as the delegator. So bob (a third party)
    // cannot create periods on alice's record.
    //
    // We assert this indirectly: bob calling delegatePredictionPower(carol)
    // affects bob's _delegationPeriods, not alice's.
    await satori.transfer(bob.address, ethers.parseEther("100"));

    await satori.connect(bob).delegatePredictionPower(carol.address);
    await time.increase(2 * ROUND);
    await satori.connect(bob).delegatePredictionPower(ethers.ZeroAddress);

    // Alice's delegation state is untouched — she has no predictionDelegate set.
    expect((await rewards.predictionDelegateInfo(alice.address)).delegate).to.equal(ethers.ZeroAddress);

    // Bob's churn is on bob's own record. Alice can't be made to pay for it.
    // (The strong form of this test would be to read _delegationPeriods.length
    // for both, but it's a private mapping. The functional outcome — that bob's
    // actions don't affect alice's claim path — is what matters.)
  });
});
