const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

// AUDIT F62 — predictions(user, gameId, round) computed `round - deploymentRound`
// with no guard, so querying a round BEFORE deployment (round 0, or an indexer
// scanning history) reverted with a Panic(0x11) underflow instead of returning
// an empty Prediction. deploymentRound is ~41,000 in 2026, so round 0 always
// underflows. Fix: return an empty Prediction for round < deploymentRound — a
// pre-deploy round is a no-prediction case by definition (matching the lens
// NatSpec promise of zero when no prediction exists). View-only, no funds.
//
// Mutant this KILLS: removing the `round < deploymentRound` guard restores the
// unchecked subtraction, so this call reverts Panic(0x11) instead of returning.

describe("F62 — predictions() returns empty for pre-deploy rounds (no underflow revert)", function () {
  it("querying round 0 (< deploymentRound) returns an empty Prediction, not a revert", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const user = fix.signers[1];
    const gameId = 1n;

    // round 0 is far below deploymentRound (~41,000) — the old code underflows.
    const pred = await fix.engine.predictions(user.address, gameId, 0);
    expect(pred.direction).to.equal(0n);
    expect(pred.roundMade).to.equal(0n);
    expect(pred.multiplier).to.equal(0n);
  });
});
