const { expect } = require("chai");
const { ethers } = require("hardhat");

// PER-LEVER RENOUNCEMENT — giving up ONE governor power permanently.
//
// humble.md 4, owner-approved 2026-09-12. `renounceGovernor()` is
// all-or-nothing: it kills every proxy upgrade and all three
// token pointers in one call. That welds the most valuable thing the governor
// can do — re-pointing mint authority — to the things the protocol still needs
// a governor for, which means a DAO handed `governor` is a DAO whose vote can
// reach the banked mint headroom.
//
// WHY THE HEADROOM IS REAL. The token's envelope is `1440 x rounds` on
// everything reported (general plus fee); the hub reports a decaying schedule
// far below that. The unreported gap banks up forever and nothing in normal
// operation touches it. Only a re-pointed controller can report and mint it.
//
// The token is immutable, so this could only ever be added before D5.

describe("SatoriToken — per-lever renouncement", function () {
  let token;
  let deployer, governor, controller, dev, stranger, other;

  beforeEach(async function () {
    [deployer, governor, controller, dev, stranger, other] = await ethers.getSigners();
    const SatoriToken = await ethers.getContractFactory("SatoriToken");
    token = await SatoriToken.connect(deployer).deploy(
      governor.address, dev.address, (await ethers.provider.getNetwork()).chainId);
    await token.waitForDeployment();
  });

  // A codeful address, for the hook / bridge-authority setters (both reject
  // codeless non-zero addresses).
  const someContract = () => token.getAddress();

  describe("nothing is frozen at deploy", function () {
    it("every lever starts live and every view says so", async function () {
      for (const f of ["controllerFrozen", "hookFrozen", "bridgeAuthorityFrozen"]) {
        expect(await token[f](), f).to.equal(false);
      }
      for (const f of ["controllerLocked", "hookLocked", "bridgeAuthorityLocked", "airdropLocked"]) {
        expect(await token[f](), f).to.equal(false);
      }
    });
  });

  describe("freezing the controller — the one this exists for", function () {
    it("refuses to freeze an UNSET controller (that would brick minting forever)", async function () {
      // The same guard renounceGovernor carries, for the same reason: with no
      // controller, rewardMint / setLock / markParticipated are all unreachable,
      // and freezing would make that permanent.
      await expect(token.connect(governor).freezeController())
        .to.be.revertedWithCustomError(token, "ControllerNotSet");
    });

    it("freezes mint authority at the standing controller, one-way", async function () {
      await token.connect(governor).setController(controller.address);
      await expect(token.connect(governor).freezeController())
        .to.emit(token, "ControllerFrozen").withArgs(controller.address);

      expect(await token.controllerFrozen()).to.equal(true);
      expect(await token.controllerLocked()).to.equal(true);
      // The pointer itself is untouched and still working.
      expect(await token.controller()).to.equal(controller.address);

      // And it can never move again — not by the governor, not by anyone.
      await expect(token.connect(governor).setController(other.address))
        .to.be.revertedWithCustomError(token, "Frozen");
      // Freezing twice is a harmless no-op rather than a revert.
      await expect(token.connect(governor).freezeController()).to.not.be.reverted;
      expect(await token.controller()).to.equal(controller.address);
    });

    it("does NOT freeze mint LOGIC — the controller is a proxy", async function () {
      // The trade this lever makes: you give up pointing at a DIFFERENT address,
      // NOT the ability to change how minting behaves. In the real stack the
      // controller is the hub's proxy, so upgrading the hub still changes
      // everything. Pinned here as the property, since the whole case for
      // freezing rests on it.
      await token.connect(governor).setController(controller.address);
      await token.connect(governor).freezeController();
      // Reporting and minting through the frozen controller still work normally.
      await expect(token.connect(controller).accrueRewards(1n)).to.not.be.reverted;
      await expect(token.connect(controller).rewardMint(stranger.address, 1n))
        .to.not.be.reverted;
    });

    it("leaves every OTHER governor power alive", async function () {
      await token.connect(governor).setController(controller.address);
      await token.connect(governor).freezeController();

      await expect(token.connect(governor).setHook(ethers.ZeroAddress)).to.not.be.reverted;
      await expect(token.connect(governor).setBridgeAuthority(ethers.ZeroAddress)).to.not.be.reverted;
      // Governor handoff still works, so the role is still transferable.
      await expect(token.connect(governor).setRootAuthority(other.address)).to.not.be.reverted;
    });
  });

  describe("the other two levers", function () {
    it("freezes the hook where it stands", async function () {
      const addr = await someContract();
      await token.connect(governor).setHook(addr);
      await expect(token.connect(governor).freezeHook())
        .to.emit(token, "HookFrozen").withArgs(addr);
      expect(await token.hook()).to.equal(addr);
      await expect(token.connect(governor).setHook(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "Frozen");
    });

    it("freezing the hook at zero is the safe end state — no hook can ever exist", async function () {
      expect(await token.hook()).to.equal(ethers.ZeroAddress);
      await token.connect(governor).freezeHook();
      await expect(token.connect(governor).setHook(await someContract()))
        .to.be.revertedWithCustomError(token, "Frozen");
    });

    it("freezes the bridge authority where it stands", async function () {
      await expect(token.connect(governor).freezeBridgeAuthority())
        .to.emit(token, "BridgeAuthorityFrozen").withArgs(ethers.ZeroAddress);
      await expect(token.connect(governor).setBridgeAuthority(await someContract()))
        .to.be.revertedWithCustomError(token, "Frozen");
    });
  });

  describe("authority and scope", function () {
    it("is governor-only on all three", async function () {
      await token.connect(governor).setController(controller.address);
      for (const call of [
        token.connect(stranger).freezeController(),
        token.connect(stranger).freezeHook(),
        token.connect(stranger).freezeBridgeAuthority(),
        token.connect(controller).freezeController(),
      ]) {
        await expect(call).to.be.revertedWithCustomError(token, "Unauthorized");
      }
    });

    it("the home-chain-only ones are the ones whose levers are home-only", async function () {
      const SatoriToken = await ethers.getContractFactory("SatoriToken");
      const remote = await SatoriToken.connect(deployer).deploy(
        governor.address, dev.address, 999999);
      await remote.waitForDeployment();
      // Minting does not exist off-home, so freezing it does not either.
      await expect(remote.connect(governor).freezeController())
        .to.be.revertedWithCustomError(remote, "NotHomeChain");
      // The hook and the transport lane DO exist off-home, so these must work.
      await expect(remote.connect(governor).freezeHook()).to.not.be.reverted;
      await expect(remote.connect(governor).freezeBridgeAuthority()).to.not.be.reverted;
    });

    it("renouncing the ROOT does NOT lock the levers — emptying their slots does", async function () {
      // This used to assert that renounceGovernor subsumed all the freezes,
      // which was true when one address gated everything. Since the split
      // (dao-governance.md v2) the root only grants the power to REASSIGN: give
      // it up and the standing authorities keep working, permanently.
      await token.connect(governor).setController(controller.address);
      await token.connect(governor).renounceRootAuthority();

      for (const f of ["controllerLocked", "hookLocked", "bridgeAuthorityLocked"]) {
        expect(await token[f](), f).to.equal(false);
      }
      await expect(token.connect(governor).setController(other.address)).to.not.be.reverted;
    });

    it("emptying a slot locks exactly ITS levers and says nothing about the others", async function () {
      // The sharper reading the split buys. Before, one question ("did the role
      // go away?") stood in for each; now each view names the slot that actually
      // drives it.
      await token.connect(governor).setController(controller.address);
      await token.connect(governor).setWiringAuthority(ethers.ZeroAddress);

      expect(await token.controllerLocked()).to.equal(true);
      expect(await token.hookLocked()).to.equal(true);
      expect(await token.bridgeAuthorityLocked()).to.equal(true);
      await expect(token.connect(governor).setController(other.address))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      // ...and the freeze slot's levers still work, because it is a different slot.
      await expect(token.connect(governor).freezeHook()).to.not.be.reverted;
    });
  });
});
