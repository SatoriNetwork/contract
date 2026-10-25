/**
 * Regression guard — DEFAULT_STREAM_ID==1 squat (was MED finding cov_provider-cut).
 *
 * `createSimpleDataStream` is permissionless, and `DEFAULT_STREAM_ID` is the
 * hard-wired constant 1 (the contract self-upvotes it, `accrueDefaultStreamCut`
 * mints its cut to the core, `_computeReward` special-cases it). Previously
 * `initializeDefaultStream` just called `_createSimpleStream` and took whatever
 * the next sequential id was, with no "must be id 1" check. So a stream created
 * BEFORE init (a pre-init squat or an out-of-order deploy) grabbed id 1, init
 * did NOT revert, the real default landed at id 2, and all the
 * DEFAULT_STREAM_ID==1 privileges silently targeted the squatter's stream.
 *
 * FIX: `initializeDefaultStream` captures the created stream id and reverts
 * `DefaultStreamNotFirst()` unless it equals `DEFAULT_STREAM_ID` (1). So the
 * default is pinned to id 1 or init fails loudly — never silent corruption.
 * (The deploy script already runs init before any other stream; this enforces
 * it against an attacker front-running init.)
 *
 * These tests pin the FIXED behavior.
 */

const { expect } = require("chai");
const { deploySatoriFixtureOpts } = require("../fixtures");
const { ethers } = require("hardhat");

const SIMPLE4 = "createSimpleDataStream(string,address,uint24)";

async function streamIdFrom(tx, satori) {
  const r = await tx.wait();
  const ev = r.logs.find(l => {
    try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; }
    catch { return false; }
  });
  return satori.interface.parseLog(ev).args.streamId;
}

async function deployStackNoInit(platform) {
  // The shared fixture normally calls initializeDefaultStream (matching
  // scripts/deploy.js). These tests exercise the PRE-init state itself, so they
  // opt out and drive the init call by hand.
  return deploySatoriFixtureOpts(2000, { skipDefaultStream: true });
}

describe("default-stream squat: init must pin DEFAULT_STREAM_ID==1 or revert", function () {
  this.timeout(120000);
  let owner, platform;

  beforeEach(async function () {
    [owner, platform] = await ethers.getSigners();
  });

  it("a pre-init createSimpleDataStream squats id 1 -> initializeDefaultStream REVERTS (no silent corruption)", async function () {
    const { satori } = await deployStackNoInit(platform);

    // Permissionless create BEFORE init grabs id 1 for the squatter.
    const pre = await streamIdFrom(
      await satori[SIMPLE4]("squatter", owner.address, 720), satori
    );
    expect(Number(pre)).to.equal(1); // the squatter holds id 1

    // FIXED: init must not silently land the default at id 2 — it reverts.
    await expect(satori.initializeDefaultStream())
      .to.be.revertedWithCustomError(satori, "DefaultStreamNotFirst");
  });

  it("init refuses to run before the Coined adapter is wired (DefaultStreamNotFirst) and nothing is created", async function () {
    const { satori, registry } = await deploySatoriFixtureOpts(2000, { skipNamedAdapter: true });
    expect(await registry.namedAdapterId()).to.equal(0);
    await expect(satori.initializeDefaultStream())
      .to.be.revertedWithCustomError(satori, "DefaultStreamNotFirst");
    expect(await registry.streamExists(1)).to.equal(false);
  });

  it("init-first (the deploy order): default stream is pinned to id 1, owned by the core", async function () {
    const { satori, registry } = await deployStackNoInit(platform);
    const engine = await ethers.getContractAt("SatoriEngine", await satori.engine());

    // init BEFORE any other stream — the deploy.js order. Succeeds.
    await satori.initializeDefaultStream();

    const defId = await satori.DEFAULT_STREAM_ID();
    expect(Number(defId)).to.equal(1);

    // The stream at DEFAULT_STREAM_ID is the protocol's own: the Sentiment stream
    // "satori", provided by the engine.
    const info = await registry.getDataStreamInfo(defId);
    expect(info[0]).to.equal("satori");
    expect(info[1]).to.equal(await engine.getAddress());
    expect(await registry.isNamedStream(defId)).to.equal(true);

    // init is one-shot.
    await expect(satori.initializeDefaultStream())
      .to.be.revertedWithCustomError(satori, "AlreadySet");

    // A user stream created AFTER init lands at id 2+, never colliding with the default.
    const after = await streamIdFrom(
      await satori[SIMPLE4]("user", owner.address, 720), satori
    );
    expect(Number(after)).to.be.gt(1);
  });
});
