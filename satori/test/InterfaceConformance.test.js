const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

// G06 — the lens reaches the hub, the token and Rewards through interfaces the
// implementations cannot inherit (IHubForLens declares the pointers as address,
// the hub's getters return typed contracts). So every member is called through
// the interface's own ABI on the deployed contract: a renamed or retyped getter
// fails here instead of in a lens call on a deployed chain.

async function callEveryMember(interfaceName, address, sampleUser) {
  const c = await ethers.getContractAt(interfaceName, address);
  const members = c.interface.fragments.filter((f) => f.type === "function");
  expect(members.length, `${interfaceName} has members`).to.be.gt(0);
  for (const f of members) {
    const args = f.inputs.map((i) => (i.type === "address" ? sampleUser : 1));
    try {
      await c[f.name].staticCall(...args);
    } catch (e) {
      // A getter that indexes a list may revert on the sample argument (a panic
      // or a custom error from inside the contract). A missing selector or a
      // return the interface cannot decode has no revert data of its own.
      const reached = typeof e.data === "string" && e.data.length > 2;
      expect(reached, `${interfaceName}.${f.name}: ${e.shortMessage || e.message}`).to.equal(true);
    }
  }
}

describe("Lens interfaces match the deployed contracts (G06)", function () {
  this.timeout(600000);
  let fix, user;
  before(async function () {
    fix = await loadFixture(deploySatoriFixture);
    user = fix.signers[1].address;
  });

  it("IHubForLens, on the hub", async function () {
    await callEveryMember("IHubForLens", await fix.hub.getAddress(), user);
  });

  it("ITokenForLens, on the token", async function () {
    await callEveryMember("ITokenForLens", await fix.token.getAddress(), user);
  });

  it("IRewardsForLens, on Rewards", async function () {
    await callEveryMember("IRewardsForLens", await fix.rewards.getAddress(), user);
  });

  it("IRegistryForLens and IRegistryForBounties, on the registry", async function () {
    await callEveryMember("IRegistryForLens", await fix.registry.getAddress(), user);
    await callEveryMember("IRegistryForBounties", await fix.registry.getAddress(), user);
  });
});
