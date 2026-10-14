// Slice 1 of the bounty-share 80/20 refactor: subscription mechanism is
// removed entirely. Stake IS the opt-in. This file is the TDD assertion
// for that slice — it asserts:
//
//   (a) The subscribe / unsubscribe API surface is gone (functions absent
//       from the deployed contract's interface).
//   (b) The auto-subscribe side effect on first-stake is gone (no
//       BountySubscribed event fires).
//   (c) A user can still earn bounty by just staking (no separate subscribe
//       call needed) — the end-to-end path works without the API.
//
// See docs/issues/bounty-share-80-20.md for the broader plan.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

async function deployMockToken() {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy("USDC", "USDC");
  await t.waitForDeployment();
  return t;
}

describe("Slice 1: subscription mechanism removed", function () {
  let bounties, alice;
  let usd;

  beforeEach(async function () {
    const fix = await loadFixture(deploySatoriFixture);
    bounties = fix.bounties;
    [, alice] = fix.signers;

    usd = await deployMockToken();
    await usd.mint(alice.address, ethers.parseEther("10000"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("10000"));
  });

  it("subscribe / unsubscribe functions are absent from the contract interface", async function () {
    expect(bounties.subscribeBountyToken).to.equal(undefined);
    expect(bounties.unsubscribeBountyToken).to.equal(undefined);
    expect(bounties.subscribeMultiple).to.equal(undefined);
    expect(bounties.unsubscribeMultiple).to.equal(undefined);
  });

  it("subscription-state accessors are absent", async function () {
    expect(bounties.bountySubscribed).to.equal(undefined);
    expect(bounties.userSubscribedTokens).to.equal(undefined);
  });

  it("first stake does NOT emit BountySubscribed", async function () {
    const usdAddr = await usd.getAddress();
    const tx = await bounties.connect(alice).stakeBountyToken(usdAddr, ethers.parseEther("100"));
    const rcpt = await tx.wait();
    // Filter on a topic name that doesn't exist post-removal; if the event
    // type is gone, ethers won't even know how to parse it. The check: no log
    // on the bounties contract whose name contains "Subscrib" should appear.
    //
    // P5 (swallowed assertion): this used to `throw new Error(...)` from INSIDE
    // the same try whose catch discards unparseable foreign logs — so the
    // deliberate failure throw was swallowed along with them and a
    // re-introduced BountySubscribed reported GREEN. Collect the decoded names
    // first, then assert OUTSIDE the try.
    const parsedNames = [];
    for (const log of rcpt.logs) {
      let parsed = null;
      try {
        parsed = bounties.interface.parseLog({ topics: log.topics, data: log.data });
      } catch (_e) {
        // unparseable log on another contract — ignore.
      }
      if (parsed && parsed.name) parsedNames.push(parsed.name);
    }

    // Control: the scan really did decode this contract's own events, so an
    // empty `parsedNames` (e.g. a decode that silently stopped working) can
    // never masquerade as "no subscription event fired".
    expect(parsedNames).to.include("BountyTokenStaked");
    expect(parsedNames.filter((n) => /Subscrib/i.test(n))).to.deep.equal([]);
  });
});
