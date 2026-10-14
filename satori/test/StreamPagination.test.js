const { expect } = require("chai");
const { deploySatoriFixture } = require("./fixtures");
const { ethers } = require("hardhat");

describe("StreamPagination - getDataStreams", function () {
  let registry, satori;
  let owner, authority;

  beforeEach(async function () {
    const fix = await deploySatoriFixture();
    ({ satori, registry, owner } = fix);
    authority = fix.signers[0];

    // The fixture calls initializeDefaultStream() (matching deploy.js), which
    // creates the default stream (id 1) and nothing else. Create 5 more through
    // Satori (ids 2-6) so the creation fee is paid and the registry's onlyCore
    // gate is satisfied. Total registry size: 6.
    for (let i = 1; i <= 5; i++) {
      await satori.createSimpleDataStream(`Stream ${i}`, authority.address);
    }
  });

  it("getDataStreams(0, 3) returns the first 3 streams", async function () {
    const [ids, nextOffset] = await registry.getDataStreams(0, 3);
    expect(ids.length).to.equal(3);
    expect(ids[0]).to.equal(1);
    expect(ids[1]).to.equal(2);
    expect(ids[2]).to.equal(3);
    expect(nextOffset).to.equal(3);
  });

  it("getDataStreams(3, 5) returns the remaining 3 streams as a short page", async function () {
    // limit 5 from offset 3; only 3 of the 6 streams remain, so a short page.
    const [ids, nextOffset] = await registry.getDataStreams(3, 5);
    expect(ids.length).to.equal(3);
    for (let i = 0; i < 3; i++) expect(ids[i]).to.equal(4 + i);
    expect(nextOffset).to.equal(6);
  });

  it("getDataStreams(0, 100) returns all 6 streams", async function () {
    const [ids, nextOffset] = await registry.getDataStreams(0, 100);
    expect(ids.length).to.equal(6);
    for (let i = 0; i < 6; i++) {
      expect(ids[i]).to.equal(i + 1);
    }
    expect(nextOffset).to.equal(6);
  });
});
