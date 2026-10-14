const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

// AUDIT F27 — the predictions() view must report the FULL packed streak
// multiplier (48 bits), not a uint32-truncated copy. On-chain scoring always
// read the full 48-bit `_predMult` (SatoriEngine._deriveWeight); only
// `_viewPred` narrowed it to uint32, so the view — and the lens weight it
// feeds — WRAPPED for a multiplier > 2^32 (under the old quadratic curve that
// needed streak >= 6554, ~9 years of perfect play; under the √streak×1000
// curve it is even less reachable — √streak×1000 > 2^32 needs streak ~1.8e13),
// while the reward stayed exact. The fix widens both the memory DTO
// field (SatoriTypes.Prediction.multiplier) and the `_viewPred` cast to uint48,
// matching the packed field.
//
// A > 2^32 multiplier is unreachable naturally (~9 years of zero-miss rounds
// under the old curve; effectively never under the √streak×1000 curve), so we
// craft the packed prediction directly in the engine's `userPredictions`
// slot and read it back through the view.
//
// Mutant this KILLS: reverting `_viewPred`'s cast to `uint32(_predMult(pred))`
// wraps the returned multiplier to `mult % 2^32` (== 12345 here), failing the
// equality below.

describe("F27 — predictions view reports the full 48-bit multiplier (no uint32 wrap)", function () {
  it("a multiplier > 2^32 is returned un-truncated by getLatestPrediction", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori } = fix;
    const user = fix.signers[1];
    const engineAddr = await fix.engine.getAddress();
    const gameId = 1n;

    // Prediction bit-codec (SatoriEngine): dir @ bits 0-1, multiplier @ bit 4
    // (48 bits wide). Prediction A occupies bits [0,119); leaving B and the
    // header zero makes getLatestPrediction pick A.
    const DIR_UP = 1n;
    const MULT_OFFSET = 4n;
    const mult = (1n << 32n) + 12345n; // 4,294,979,641 — just past uint32 (2^32-1)
    const predA = DIR_UP | (mult << MULT_OFFSET);

    // Storage slot of userPredictions[user][gameId]; userPredictions is at slot 12
    // (mapping(address => mapping(uint32 => uint256))).
    const baseSlot = ethers.zeroPadValue("0x0c", 32);
    const inner = ethers.keccak256(
      ethers.concat([ethers.zeroPadValue(user.address, 32), baseSlot])
    );
    const slot = ethers.keccak256(
      ethers.concat([ethers.zeroPadValue(ethers.toBeHex(gameId), 32), inner])
    );

    await ethers.provider.send("hardhat_setStorageAt", [
      engineAddr,
      slot,
      ethers.toBeHex(predA, 32),
    ]);

    const pred = await satori.getLatestPrediction(user.address, gameId);
    expect(pred.direction).to.equal(1n); // sanity: the crafted slot decoded
    // The defining assertion: a uint32 view would report `mult % 2^32` == 12345.
    expect(pred.multiplier).to.equal(mult);
  });
});
