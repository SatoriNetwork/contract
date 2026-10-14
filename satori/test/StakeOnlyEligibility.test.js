// Slice 2 of the bounty-share refactor: stake-only eligibility hardened.
//
// The stake-AFTER-predict edge case: the user has zero stake at predict
// time (no snapshot taken in `applyBoost`), but stakes the bounty token
// before score. Without a guard, the user would still enter the
// creditBountyForWin loop because userStakedTokens now contains the
// token, and the share math would fall back to the userW-only slice.
// With the guard, that path also returns zero.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("./fixtures");

const UP = 1;

async function deployMockToken(symbol = "USDC") {
  const M = await ethers.getContractFactory("MockERC20");
  const t = await M.deploy(symbol, symbol);
  await t.waitForDeployment();
  return t;
}

async function advanceOneDay() { await time.increase(86400); }

async function createStream(satori, signer, name, authority) {
  // Admin-created cadence-1 (every-round) stream. SatoriHub floors PUBLIC stream
  // creation at cadence 2, but `rewards.admin()` (the fixture's `owner`) is exempt,
  // and this suite writes a value every round. `authority` stays the provider — it
  // is who may call `registry.setValue`.
  const tx = await satori.connect(signer)["createSimpleDataStream(string,address,uint24)"](name, authority, 720);
  const rcpt = await tx.wait();
  for (const log of rcpt.logs) {
    try {
      const p = satori.interface.parseLog(log);
      if (p && p.name === "DataStreamCreated") return p.args.streamId;
    } catch (e) {}
  }
  throw new Error("DataStreamCreated event missing");
}

describe("Slice 2: stake-only eligibility (stake-after-predict earns zero)", function () {
  it("user who stakes T AFTER predict but BEFORE score earns 0 from T's bounty", async function () {
    const fix = await loadFixture(deploySatoriFixture);
    const { satori, bounties, registry, owner } = fix;
    const [, alice, funder, authority] = fix.signers;

    // Fund: alice predicts with SATORI, authority provides the stream.
    await satori.transfer(alice.address, ethers.parseEther("100"));
    await satori.transfer(funder.address, ethers.parseEther("100"));
    await satori.transfer(authority.address, ethers.parseEther("100"));

    const stream = await createStream(satori, owner, "S", authority.address);
    await voteFor(satori, alice, stream); // burns 10, alice keeps 90 to predict with

    const usd = await deployMockToken();
    await usd.mint(funder.address, ethers.parseEther("10000"));
    await usd.connect(funder).approve(await bounties.getAddress(), ethers.parseEther("10000"));
    await bounties.connect(funder).fundBounty(
      stream, await usd.getAddress(), ethers.parseEther("1000"), ethers.parseEther("100")
    );

    // Predict with NO USD stake — applyBoost iterates an empty staked list.
    await registry.connect(authority).setValue(stream, 100);
    await satori.connect(alice).predictMultipleWithPayloads([{ gameId: stream, payload: pack1(UP) }]);

    // Stake USD AFTER predict.
    await usd.mint(alice.address, ethers.parseEther("100"));
    await usd.connect(alice).approve(await bounties.getAddress(), ethers.parseEther("100"));
    await bounties.connect(alice).stakeBountyToken(await usd.getAddress(), ethers.parseEther("100"));

    // Land post-anchor values, settle.
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 110);
    await advanceOneDay();
    await registry.connect(authority).setValue(stream, 120);
    await satori.settlePrediction(alice.address, stream);

    // Alice's USD stake should be EXACTLY the 100 she staked, no bounty
    // earned. (Without slice-2 guard, she'd earn the userW slice of the
    // pot — the test asserts that side-channel is closed.)
    expect(await bounties.bountyStake(alice.address, await usd.getAddress()))
      .to.equal(ethers.parseEther("100"));
  });
});
