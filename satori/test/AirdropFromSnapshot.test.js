// scripts/airdrop-from-snapshot.js: SATORIEVR snapshot rows → Base batch files.
const { expect } = require("chai");
const { ethers } = require("ethers");
const { convert } = require("../scripts/airdrop-from-snapshot");

// Private key 1: its Base address is a well-known vector.
const G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const G_BASE = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const evrmore = (pk) => {
  const body = ethers.concat(["0x21", ethers.ripemd160(ethers.sha256("0x" + pk))]);
  return ethers.encodeBase58(ethers.concat([body, ethers.dataSlice(ethers.sha256(ethers.sha256(body)), 0, 4)]));
};
// A row from the 2081199 snapshot, key from the chain.
const REAL = { address: "EH9zbiXW5octzjutLzWtRhryDTMHv89hre", balance: "0.88779146",
  public_key: "02c09a6b19b682e59c7c96ffc3a87ed3224d66650da24caff2806ef23596eea411", status: "revealed" };

describe("airdrop-from-snapshot", function () {
  it("maps a key to its Base address, amount unchanged", function () {
    const { mapped, batches } = convert([{ address: evrmore(G), balance: "12.5", public_key: G, status: "revealed" }]);
    expect(mapped[0].base).to.equal(G_BASE);
    expect(batches).to.deep.equal([{ [G_BASE]: "12.5" }]);
  });

  it("accepts a real snapshot row", function () {
    expect(convert([REAL]).mapped).to.have.length(1);
  });

  it("puts rows with no key in unmapped, not in a batch", function () {
    const burn = { address: "EXBurnXXXXXXXXXXXXXXXXXXXXXXZ8ZjfN", balance: "27002.00000000", public_key: "", status: "burn_address" };
    const { batches, unmapped } = convert([REAL, burn]);
    expect(unmapped).to.deep.equal([burn]);
    expect(Object.keys(batches[0])).to.have.length(1);
  });

  it("refuses a key that does not hash to its address", function () {
    expect(() => convert([{ ...REAL, public_key: G }])).to.throw(/does not hash/);
  });

  it("refuses a zero or malformed balance", function () {
    expect(() => convert([{ ...REAL, balance: "0.00000000" }])).to.throw(/bad balance/);
    expect(() => convert([{ ...REAL, balance: "1.123456789" }])).to.throw(/bad balance/);
  });

  it("splits into batches of the given size", function () {
    const rows = [1, 2, 3].map((k) => {
      const pk = ethers.SigningKey.computePublicKey(ethers.toBeHex(k, 32), true).slice(2);
      return { address: evrmore(pk), balance: "1", public_key: pk, status: "revealed" };
    });
    expect(convert(rows, 2).batches.map((b) => Object.keys(b).length)).to.deep.equal([2, 1]);
  });
});
