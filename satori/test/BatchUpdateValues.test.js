// Coverage for `updateValues` — the fault-tolerant batch pull entry point.
//
// One function serves EVERY adapter kind (Uniswap / Chainlink / Custom): they are all
// `DataStreamType.Adapter` and dispatch through the same `adapter[adapterId].readValue`,
// so the batch is adapter-agnostic by construction.
//
// The load-bearing property is FAULT TOLERANCE. A caller sweeping their whole stream list
// will hit streams that are not due (cadence guards) and streams whose external source is
// broken (stale Chainlink round, a pool that lost cardinality). A strict batch would revert
// on the first of those and burn the whole transaction, so `updateValues` skips and carries
// on. Crucially a skipped stream must leave NO state behind — in particular
// `lastUpdateTimestamp` must not be bumped, or one failed read would lock the stream out
// for a full cadence period.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
    deploySatoriFixture,
    createCustomStream,
    createChainlinkStream,
} = require("./fixtures");

const ROUND = 86400;                 // 24h
const CADENCE_SECONDS = ROUND * 2;   // adapter streams default to cadence 2 (daily)

async function idFrom(tx, satori) {
    const r = await tx.wait();
    const ev = r.logs.find(l => { try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; } });
    return satori.interface.parseLog(ev).args.streamId;
}

describe("updateValues — batch adapter pull", function () {
    this.timeout(300000);
    let satori, registry, owner, authority, sources, ids;

    beforeEach(async function () {
        const fix = await loadFixture(deploySatoriFixture);
        ({ satori, registry, owner } = fix);
        authority = fix.signers[1];

        const MockDataStream = await ethers.getContractFactory("MockDataStream");
        sources = []; ids = [];
        for (let i = 0; i < 5; i++) {
            const src = await MockDataStream.deploy();
            await src.waitForDeployment();
            await src.setValue(1000 + i);
            sources.push(src);
            ids.push(await idFrom(await createCustomStream(satori, `S${i}`, await src.getAddress(), authority.address), satori));
        }
    });

    const valueOf = async id => (await registry.getDataStreamInfo(id))[3];

    it("updates every due stream in one call and reports the count", async function () {
        const n = await registry.updateValues.staticCall(ids);
        expect(n).to.equal(5n);
        await registry.updateValues(ids);
        for (let i = 0; i < 5; i++) expect(await valueOf(ids[i])).to.equal(BigInt(1000 + i));
    });

    it("is permissionless, like the singular updateValue", async function () {
        const stranger = (await ethers.getSigners())[7];
        await registry.connect(stranger).updateValues(ids);
        expect(await valueOf(ids[0])).to.equal(1000n);
    });

    it("skips not-yet-due streams instead of reverting the batch", async function () {
        await registry.updateValues(ids);                 // all now on cooldown
        for (const s of sources) await s.setValue(7777);

        // Immediately again: every stream fails its cadence guard. Must NOT revert.
        expect(await registry.updateValues.staticCall(ids)).to.equal(0n);
        await registry.updateValues(ids);
        for (const id of ids) expect(await valueOf(id)).to.not.equal(7777n); // nothing written

        // After a full cadence period they all take.
        await time.increase(CADENCE_SECONDS + 60);
        expect(await registry.updateValues.staticCall(ids)).to.equal(5n);
    });

    it("updates the due streams and skips the rest in a MIXED batch", async function () {
        // Bring one stream current on its own, then batch all five. Only the other four
        // are due — the batch must do those and silently pass over the fresh one.
        await registry.updateValue(ids[2]);
        for (const s of sources) await s.setValue(4242);

        expect(await registry.updateValues.staticCall(ids)).to.equal(4n);
        await registry.updateValues(ids);
        for (let i = 0; i < 5; i++) {
            if (i === 2) expect(await valueOf(ids[i]), "fresh stream untouched").to.equal(1002n);
            else expect(await valueOf(ids[i]), `stream ${i} updated`).to.equal(4242n);
        }
    });

    it("skips a stream whose adapter read reverts, and still updates the others", async function () {
        // MockDataStream returns a value that overflows CustomAdapter's int232 sanity
        // check, so readValue reverts for this one stream only.
        await sources[1].setValue(ethers.MaxInt256);

        expect(await registry.updateValues.staticCall(ids)).to.equal(4n);
        await registry.updateValues(ids);
        expect(await valueOf(ids[1]), "broken stream stores nothing").to.equal(0n);
        expect(await valueOf(ids[0])).to.equal(1000n);
        expect(await valueOf(ids[4])).to.equal(1004n);
    });

    // The subtle one. `updateValue` bumps lastUpdateTimestamp BEFORE the adapter call and
    // relies on the tx reverting to undo it. A fault-tolerant batch does not revert, so if
    // the batch path kept that ordering a single failed read would leave the stream
    // cooling down for a full cadence period having never stored a value.
    it("a failed read does not put the stream on cooldown", async function () {
        await sources[1].setValue(ethers.MaxInt256);
        await registry.updateValues(ids);            // stream 1 fails
        expect(await valueOf(ids[1])).to.equal(0n);

        await sources[1].setValue(555);              // source recovers
        expect(await registry.updateValues.staticCall([ids[1]]), "must be retryable immediately").to.equal(1n);
        await registry.updateValues([ids[1]]);
        expect(await valueOf(ids[1])).to.equal(555n);
    });

    it("skips ids that are zero, out of range, or Simple (push) streams", async function () {
        const simpleId = await idFrom(
            await satori["createSimpleDataStream(string,address,uint24)"]("Push", authority.address, 720), satori);
        const outOfRange = 99999;
        const batch = [0, outOfRange, simpleId, ids[0]];

        expect(await registry.updateValues.staticCall(batch)).to.equal(1n);
        await registry.updateValues(batch);
        expect(await valueOf(ids[0])).to.equal(1000n);
    });

    it("handles an empty batch as a no-op", async function () {
        expect(await registry.updateValues.staticCall([])).to.equal(0n);
        await registry.updateValues([]);
    });

    it("covers Chainlink and Custom adapters in a single batch", async function () {
        const Mock = await ethers.getContractFactory("MockChainlinkAggregator");
        const cl = await Mock.deploy();
        await cl.waitForDeployment();
        await cl.setAnswer(3000n);
        const clId = await idFrom(await createChainlinkStream(satori, "ETH/USD", await cl.getAddress(), authority.address), satori);

        expect(await registry.updateValues.staticCall([ids[0], clId])).to.equal(2n);
        await registry.updateValues([ids[0], clId]);
        expect(await valueOf(ids[0])).to.equal(1000n);
        expect(await valueOf(clId)).to.not.equal(0n);
    });

    it("emits StreamValueUpdated per updated stream, exactly as the singular path does", async function () {
        // The event's last arg is the absolute HOUR of the write (block.timestamp / 3600).
        const tx = await registry.updateValues([ids[0], ids[1]]);
        const rcpt = await tx.wait();
        const hour = BigInt((await ethers.provider.getBlock(rcpt.blockNumber)).timestamp) / 3600n;
        await expect(tx)
            .to.emit(registry, "StreamValueUpdated").withArgs(ids[0], 0n, 1000n, hour)
            .and.to.emit(registry, "StreamValueUpdated").withArgs(ids[1], 0n, 1001n, hour);
    });

    // Regression: the refactor must not weaken the singular entry point, whose SPECIFIC
    // custom errors are asserted across the existing suite.
    describe("singular updateValue keeps its exact revert surface", function () {
        it("CadenceRoundsNotElapsed on a repeat pull", async function () {
            await registry.updateValue(ids[0]);
            await expect(registry.updateValue(ids[0])).to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");
        });
        it("InvalidStreamId on a bad id", async function () {
            await expect(registry.updateValue(0)).to.be.revertedWithCustomError(registry, "InvalidStreamId");
            await expect(registry.updateValue(99999)).to.be.revertedWithCustomError(registry, "InvalidStreamId");
        });
        it("NotPullStream on a Simple stream", async function () {
            const simpleId = await idFrom(
                await satori["createSimpleDataStream(string,address,uint24)"]("Push", authority.address, 720), satori);
            await expect(registry.updateValue(simpleId)).to.be.revertedWithCustomError(registry, "NotPullStream");
        });
        it("still reverts when the adapter read fails", async function () {
            await sources[0].setValue(ethers.MaxInt256);
            await expect(registry.updateValue(ids[0])).to.be.reverted;
        });
    });
});
