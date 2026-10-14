// Coverage for `setValues` — the batch push entry point for Simple streams.
//
// This is the PROVIDER-GATED sibling of `updateValues`, and its failure semantics are
// deliberately DIFFERENT, because the caller's relationship to the input is different:
//
//   updateValues — permissionless. A keeper sweeps a public list it does not own and may
//                  not know which ids are valid, pullable, or due. Skip everything.
//   setValues    — the provider posts THEIR OWN data. A stream they do not own, a bad id
//                  or a non-Simple stream in the list is a bug in their posting script,
//                  and silently dropping a price they believed they published is
//                  dangerous. Those revert LOUDLY.
//
// The cadence guards are the exception and are skipped, because a provider sweeping
// streams of mixed cadence (hourly, daily, weekly) will always include some that are not
// due yet — a strict batch would revert on the first and burn the transaction. A cadence
// skip means "the protocol correctly refused a too-early post", not "your data was lost".
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, createCustomStream } = require("./fixtures");

const ROUND = 86400;

async function idFrom(tx, satori) {
    const r = await tx.wait();
    const ev = r.logs.find(l => { try { return satori.interface.parseLog(l)?.name === "DataStreamCreated"; } catch { return false; } });
    return satori.interface.parseLog(ev).args.streamId;
}

describe("setValues — batch push for Simple streams", function () {
    this.timeout(300000);
    let satori, registry, owner, provider, stranger, ids;

    beforeEach(async function () {
        const fix = await loadFixture(deploySatoriFixture);
        ({ satori, registry, owner } = fix);
        provider = fix.signers[1];
        stranger = fix.signers[2];

        // Every-round (1440-minute) streams: one write per 24h round.
        ids = [];
        for (let i = 0; i < 5; i++) {
            ids.push(await idFrom(
                await satori["createSimpleDataStream(string,address,uint24)"](`P${i}`, provider.address, 1440), satori));
        }
    });

    const valueOf = async id => (await registry.getDataStreamInfo(id))[3];
    const vals = a => a.map(v => BigInt(v));

    it("writes every due stream in one call and reports the count", async function () {
        const v = vals([10, 20, 30, 40, 50]);
        expect(await registry.connect(provider).setValues.staticCall(ids, v)).to.equal(5n);
        await registry.connect(provider).setValues(ids, v);
        for (let i = 0; i < 5; i++) expect(await valueOf(ids[i])).to.equal(v[i]);
    });

    it("reverts on an id/value length mismatch", async function () {
        await expect(registry.connect(provider).setValues(ids, vals([1, 2])))
            .to.be.revertedWithCustomError(registry, "ArrayLengthMismatch");
    });

    it("handles an empty batch as a no-op", async function () {
        expect(await registry.connect(provider).setValues.staticCall([], [])).to.equal(0n);
        await registry.connect(provider).setValues([], []);
    });

    it("skips not-yet-due streams instead of reverting the batch", async function () {
        await registry.connect(provider).setValues(ids, vals([10, 20, 30, 40, 50]));

        // Immediately again — every stream fails its cadence guard. Must NOT revert.
        expect(await registry.connect(provider).setValues.staticCall(ids, vals([99, 99, 99, 99, 99]))).to.equal(0n);
        await registry.connect(provider).setValues(ids, vals([99, 99, 99, 99, 99]));
        expect(await valueOf(ids[0]), "nothing overwritten").to.equal(10n);

        await time.increase(ROUND + 60);
        expect(await registry.connect(provider).setValues.staticCall(ids, vals([99, 99, 99, 99, 99]))).to.equal(5n);
    });

    it("writes the due streams and passes over the rest in a MIXED batch", async function () {
        await registry.connect(provider).setValue(ids[2], 777);   // this one is now fresh

        expect(await registry.connect(provider).setValues.staticCall(ids, vals([10, 20, 30, 40, 50]))).to.equal(4n);
        await registry.connect(provider).setValues(ids, vals([10, 20, 30, 40, 50]));
        for (let i = 0; i < 5; i++) {
            if (i === 2) expect(await valueOf(ids[i]), "fresh stream untouched").to.equal(777n);
            else expect(await valueOf(ids[i])).to.equal(BigInt((i + 1) * 10));
        }
    });

    // --- caller errors are LOUD: a dropped price the provider thinks they published
    //     is far worse than a failed transaction they can see and fix.
    describe("caller errors revert the whole batch", function () {
        it("NotStreamProvider when any id is not the caller's", async function () {
            const other = await idFrom(
                await satori["createSimpleDataStream(string,address,uint24)"]("X", stranger.address, 1440), satori);
            await expect(registry.connect(provider).setValues([ids[0], other], vals([1, 2])))
                .to.be.revertedWithCustomError(registry, "NotStreamProvider");
            expect(await valueOf(ids[0]), "no partial write survives the revert").to.equal(0n);
        });

        it("InvalidStreamId on a zero or out-of-range id", async function () {
            await expect(registry.connect(provider).setValues([ids[0], 0], vals([1, 2])))
                .to.be.revertedWithCustomError(registry, "InvalidStreamId");
            await expect(registry.connect(provider).setValues([ids[0], 99999], vals([1, 2])))
                .to.be.revertedWithCustomError(registry, "InvalidStreamId");
        });

        it("NotSimpleStream when an Adapter (pull) stream is in the list", async function () {
            const MockDataStream = await ethers.getContractFactory("MockDataStream");
            const src = await MockDataStream.deploy();
            await src.waitForDeployment();
            await src.setValue(1);
            const adapterId = await idFrom(
                await createCustomStream(satori, "Pull", await src.getAddress(), provider.address), satori);
            await expect(registry.connect(provider).setValues([ids[0], adapterId], vals([1, 2])))
                .to.be.revertedWithCustomError(registry, "NotStreamProvider"); // adapter provider is the source contract
        });

        it("a stranger cannot write the provider's streams", async function () {
            await expect(registry.connect(stranger).setValues(ids, vals([1, 2, 3, 4, 5])))
                .to.be.revertedWithCustomError(registry, "NotStreamProvider");
        });
    });

    it("emits StreamValueUpdated per written stream, exactly as the singular path does", async function () {
        // The event's last arg is the absolute HOUR of the write (block.timestamp / 3600).
        const tx = await registry.connect(provider).setValues([ids[0], ids[1]], vals([11, 22]));
        const rcpt = await tx.wait();
        const hour = BigInt((await ethers.provider.getBlock(rcpt.blockNumber)).timestamp) / 3600n;
        await expect(tx)
            .to.emit(registry, "StreamValueUpdated").withArgs(ids[0], 0n, 11n, hour)
            .and.to.emit(registry, "StreamValueUpdated").withArgs(ids[1], 0n, 22n, hour);
    });

    describe("singular setValue keeps its exact revert surface", function () {
        it("CadenceRoundsNotElapsed on a repeat write", async function () {
            await registry.connect(provider).setValue(ids[0], 1);
            await expect(registry.connect(provider).setValue(ids[0], 2))
                .to.be.revertedWithCustomError(registry, "CadenceRoundsNotElapsed");
        });
        it("NotStreamProvider for a non-provider", async function () {
            await expect(registry.connect(stranger).setValue(ids[0], 1))
                .to.be.revertedWithCustomError(registry, "NotStreamProvider");
        });
        it("InvalidStreamId on a bad id", async function () {
            await expect(registry.connect(provider).setValue(0, 1))
                .to.be.revertedWithCustomError(registry, "InvalidStreamId");
        });
    });
});
