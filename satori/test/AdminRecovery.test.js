// GOVERNOR RECOVERY OF A COMPROMISED ADMIN.
//
// The failure this closes: `setAdmin` was admin-only, so an attacker holding the
// admin key could rotate it onward and nothing in the contract could take it
// back. The role would be gone permanently, along with the airdrop loader, the
// capability flags, the off-chain budget dial and the game veto.
//
// The governor arm grants NO new power. The governor already gates `upgradeTo`
// on SatoriRewards, so it could always have shipped an implementation that
// reassigns `admin`. This only makes recovery DIRECT instead of requiring a
// fresh implementation to be written, reviewed and deployed mid-incident —
// exactly when that is hardest to do safely.
const { expect } = require("chai");
const { deploySatoriFixtureOpts } = require("./fixtures");
const { ethers } = require("hardhat");

describe("Admin recovery by the governor", function () {
  let rewards, token, owner, admin, attacker, rescued;

  beforeEach(async function () {
    // A rewards admin DISTINCT from the deployer/governor, so "governor" and
    // "admin" are genuinely different parties here — the separation the code is
    // written for, which a same-address deployment would hide.
    const signers = await ethers.getSigners();
    [owner, admin, attacker, rescued] = signers;
    const fix = await deploySatoriFixtureOpts(2000, { rewardsAdmin: admin.address });
    ;({ rewards, token } = fix);
  });

  it("starts with governor and admin as different parties", async function () {
    expect(await token.rootAuthority()).to.equal(owner.address);
    expect(await rewards.admin()).to.equal(admin.address);
  });

  it("lets the admin rotate itself, as before", async function () {
    await rewards.connect(admin).setAdmin(rescued.address);
    expect(await rewards.admin()).to.equal(rescued.address);
  });

  it("lets the GOVERNOR take the role back after a compromise", async function () {
    // Attacker holds the key and moves it somewhere only they control.
    await rewards.connect(admin).setAdmin(attacker.address);
    expect(await rewards.admin()).to.equal(attacker.address);

    // Before this change that was terminal. Now the governor severs it.
    await rewards.connect(owner).setAdmin(rescued.address);
    expect(await rewards.admin()).to.equal(rescued.address);

    // And the attacker is cold immediately — no pending state to re-trigger.
    await expect(rewards.connect(attacker).setAdmin(attacker.address))
      .to.be.revertedWithCustomError(rewards, "Unauthorized");
  });

  it("still refuses everyone else", async function () {
    await expect(rewards.connect(attacker).setAdmin(attacker.address))
      .to.be.revertedWithCustomError(rewards, "Unauthorized");
    await expect(rewards.connect(rescued).setAdmin(rescued.address))
      .to.be.revertedWithCustomError(rewards, "Unauthorized");
  });

  it("still refuses the zero address from either caller", async function () {
    // Zeroing admin would brick every admin-gated path with no way back —
    // the governor arm must not become a way to do that by accident.
    await expect(rewards.connect(admin).setAdmin(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(rewards, "BadInput");
    await expect(rewards.connect(owner).setAdmin(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(rewards, "BadInput");
  });

  it("follows the APPOINT slot, and rotating the root alone does not move it", async function () {
    // The arm reads `token.appointAuthority()` live rather than caching a
    // deployer, so recovery follows whoever currently holds that slot.
    //
    // It is deliberately NOT the root. Replacing the admin is an appointment;
    // reading it off the root would have meant the key that reassigns every slot
    // also decides day to day who operates the protocol — the exact bundling the
    // governor split exists to undo. So rotating the root changes nothing here
    // until the new root chooses to take the appoint slot as well.
    await token.connect(owner).setRootAuthority(attacker.address);
    await token.connect(attacker).acceptRootAuthority();
    expect(await token.rootAuthority()).to.equal(attacker.address);

    // The new root cannot recover the admin yet...
    await expect(rewards.connect(attacker).setAdmin(rescued.address))
      .to.be.revertedWithCustomError(rewards, "Unauthorized");
    // ...while the standing appoint holder still can.
    await rewards.connect(owner).setAdmin(rescued.address);
    expect(await rewards.admin()).to.equal(rescued.address);

    // Once the root takes the appoint slot, the recovery right moves with it.
    await token.connect(attacker).setAppointAuthority(attacker.address);
    await expect(rewards.connect(owner).setAdmin(admin.address))
      .to.be.revertedWithCustomError(rewards, "Unauthorized");
    await rewards.connect(attacker).setAdmin(admin.address);
    expect(await rewards.admin()).to.equal(admin.address);
  });
});
