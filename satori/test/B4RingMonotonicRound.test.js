// B-4 (block-B audit 2026-07-28) — the history ring must stay strictly
// round-ordered, and the Registry must ENFORCE that rather than assume it.
//
// getFirstTwoValuesAfter walks the ring newest-to-oldest and stops at the first
// entry whose round is <= the prediction round, treating it as the anchor. That
// is only correct while rounds strictly increase in write order. setValue and
// updateValue both guarantee it via the cadence guard, and the cascade forwards
// the base's (increasing) round — but setValueForRound took a caller-supplied
// round with no check at all, on the reasoning that "the core is trusted".
//
// Its only caller (SatoriEngine.flushDefaultStream) does guard it. But the core
// sits behind a proxy, so a future upgrade could write out of order and silently
// mis-score every prediction on that stream instead of failing loudly. The guard
// costs one comparison against an entry already loaded.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

// setValueForRound is onlyCore, and no legitimate flow can call it out of order,
// so drive it as the core itself.
async function asCore(fix) {
  const core = await fix.satori.getAddress();
  await ethers.provider.send("hardhat_impersonateAccount", [core]);
  await ethers.provider.send("hardhat_setBalance", [core, "0x56BC75E2D63100000"]);
  return await ethers.getSigner(core);
}

describe("B-4 — setValueForRound enforces ring round-monotonicity", function () {
  async function newStream(fix, name) {
    const rc = await (
      await fix.satori
        .connect(fix.owner)["createSimpleDataStream(string,address,uint24)"](name, fix.owner.address, 720)
    ).wait();
    for (const log of rc.logs) {
      try {
        const p = fix.registry.interface.parseLog(log);
        if (p && p.name === "DataStreamCreated") return Number(p.args.streamId);
      } catch (e) {}
    }
    throw new Error("DataStreamCreated event missing");
  }

  async function setup() {
    const fix = await loadFixture(deploySatoriFixture);
    const coreSigner = await asCore(fix);
    const streamId = await newStream(fix, "RING");
    const start = Number(await fix.satori.getCurrentRound());
    return { ...fix, coreSigner, streamId, start };
  }

  it("accepts strictly increasing rounds", async function () {
    const { registry, coreSigner, streamId, start } = await loadFixture(setup);

    await expect(registry.connect(coreSigner).setValueForRound(streamId, 10, start + 1))
      .to.not.be.reverted;
    await expect(registry.connect(coreSigner).setValueForRound(streamId, 20, start + 2))
      .to.not.be.reverted;
  });

  it("rejects a repeat of the newest round", async function () {
    const { registry, coreSigner, streamId, start } = await loadFixture(setup);

    await registry.connect(coreSigner).setValueForRound(streamId, 10, start + 5);
    await expect(
      registry.connect(coreSigner).setValueForRound(streamId, 11, start + 5)
    ).to.be.revertedWithCustomError(registry, "NonMonotonicRound");
  });

  it("rejects a round BEFORE the newest — the case that would corrupt the anchor walk", async function () {
    const { registry, coreSigner, streamId, start } = await loadFixture(setup);

    await registry.connect(coreSigner).setValueForRound(streamId, 10, start + 5);
    await expect(
      registry.connect(coreSigner).setValueForRound(streamId, 11, start + 1)
    ).to.be.revertedWithCustomError(registry, "NonMonotonicRound");
  });

  it("does not fire on a virgin ring (no newest entry to compare)", async function () {
    const fix = await loadFixture(setup);
    // count == 0, so the guard must not fire on the first write whatever the round.
    const fresh = await newStream(fix, "FRESH");
    await expect(fix.registry.connect(fix.coreSigner).setValueForRound(fresh, 42, 1))
      .to.not.be.reverted;
  });
});
