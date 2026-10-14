// PR2 R.3 — `vstate(uint32)` implementation on SatoriRegistry.
//
// `ISatoriRegistry.vstate` was declared on the interface at launch but
// never implemented in `SatoriRegistry.sol`. This sweep adds the
// implementation as a thin forwarder to `getValueState` — both return
// the same slim 3-slot `ValueState` view over the 32-slot ring, so
// keeping them in lockstep via delegation removes the drift risk.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

const ROUND = 86400;                            // 24h — one prediction round
const CADENCE_ROUNDS = 2;                       // daily — the finest cadence a PUBLIC stream may have
const CADENCE_SECONDS = ROUND * CADENCE_ROUNDS; // 24h — minimum gap between two registry writes

// These streams are created by `authority` through the PUBLIC entry point, so
// they carry the cadence floor of 2 rounds. Each `setValue` must therefore land
// a full cadence period after the previous one, or the registry rejects it
// (CadenceRoundsNotElapsed / CadenceGapNotElapsed).
async function advanceOneCadence() { await time.increase(CADENCE_SECONDS); }

async function getStreamIdFromTx(tx, satori) {
  const r = await tx.wait();
  for (const log of r.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("vstate (PR2 R.3)", function () {
  let satori, registry, owner, authority;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    ({ satori, registry, owner } = fix);
    [, authority] = fix.signers;
    await satori.transfer(authority.address, ethers.parseEther("100"));
  });

  // ethers v6 returns the struct as a positional Result tuple. `values`
  // is a struct field but also a JS method name on Result — use positional
  // indices instead (vs[0]=values, vs[1]=rounds, vs[2]=currentIdx,
  // vs[3]=count, vs[4]=lastUpdateTimestamp).

  it("empty stream: returns zero-filled struct", async function () {
    const tx = await satori.connect(authority).createSimpleDataStream("S", authority.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    const vs = await registry.vstate(streamId);
    expect(vs[3]).to.equal(0n); // count
    expect(vs[2]).to.equal(0n); // currentIdx
    expect(vs[4]).to.equal(0n); // lastUpdateTimestamp
    for (let i = 0; i < 3; i++) {
      expect(vs[0][i]).to.equal(0n);
      expect(vs[1][i]).to.equal(0n);
    }
  });

  it("populated stream: returns the slim 3-slot view (newest at currentIdx)", async function () {
    const tx = await satori.connect(authority).createSimpleDataStream("S", authority.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    await registry.connect(authority).setValue(streamId, 100);
    await advanceOneCadence();
    await registry.connect(authority).setValue(streamId, 110);
    await advanceOneCadence();
    await registry.connect(authority).setValue(streamId, 120);

    const vs = await registry.vstate(streamId);
    expect(vs[3]).to.equal(3n);     // count
    expect(vs[2]).to.equal(2n);     // currentIdx = count - 1
    // Oldest → newest: 100, 110, 120
    expect(vs[0][0]).to.equal(100n);
    expect(vs[0][1]).to.equal(110n);
    expect(vs[0][2]).to.equal(120n);
    expect(vs[4]).to.be.gt(0n);     // lastUpdateTimestamp
  });

  it("vstate is bit-for-bit identical to getValueState (alias guarantee)", async function () {
    const tx = await satori.connect(authority).createSimpleDataStream("S", authority.address);
    const streamId = await getStreamIdFromTx(tx, satori);

    await registry.connect(authority).setValue(streamId, 42);
    await advanceOneCadence();
    await registry.connect(authority).setValue(streamId, 84);

    const a = await registry.vstate(streamId);
    const b = await registry.getValueState(streamId);

    for (let i = 0; i < 3; i++) {
      expect(a[0][i]).to.equal(b[0][i]); // values
      expect(a[1][i]).to.equal(b[1][i]); // rounds
    }
    expect(a[2]).to.equal(b[2]); // currentIdx
    expect(a[3]).to.equal(b[3]); // count
    expect(a[4]).to.equal(b[4]); // lastUpdateTimestamp
  });
});
