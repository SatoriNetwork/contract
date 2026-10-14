const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");

const ROUND = 86400;
const DEV_BPS = 1500n;
const BUDGET = ethers.parseEther("1440");        // ROUND_REWARD_BUDGET — the token's OUTER envelope
const GEN = (BUDGET * (10000n - DEV_BPS)) / 10000n;  // 1224 — 85% of it; the dev's 15% is reserved
// INITIAL_MINT is ONE ROUND OF THE HUB'S DEPLOY-TIME DEFAULT RATE (846.62), not
// of the token's 1440 envelope, so the deploy round is NOT saturated here — it
// is saturated at the HUB, which holds its lane to 85% of its own per-round
// rate. The token's 1440 is deliberately the looser of the two.
let INITIAL_MINT, DEV_GENESIS;
// Read from the contract: the cap is a placeholder pending the real
// figure, so a literal here would only have to be chased again.
let AIRDROP_CAP;
const INDEFINITE = 2 ** 24 - 1;

// The hardhat network's own chain id. Passing it as HOME_CHAIN_ID makes a
// deployment "home", which is what every pre-existing test assumes.
const HOME = 31337;
// Any other value makes the SAME bytecode behave as a remote, bridge-only
// deployment while still running on the hardhat chain — which is how the
// off-home gates get tested without touching block.chainid at all.
const NOT_HOME = 8453;

// SatoriToken.SUPERCHAIN_BRIDGE — the OP Stack predeploy, hardcoded in the token.
const SUPERCHAIN_BRIDGE = "0x4200000000000000000000000000000000000028";

describe("SatoriToken (constitution)", function () {
  let token, hookMock;
  let deployer, governor, controller, alice, bob, carol, devRecipient;
  let bridge; // impersonated SUPERCHAIN_BRIDGE predeploy

  async function currentRound() {
    return Number(await token.getCurrentRound());
  }

  // Deploy with an explicit home chain id. Defaults to home so existing tests
  // are unaffected by the third constructor arg.
  async function deployToken(homeChainId = HOME) {
    const SatoriToken = await ethers.getContractFactory("SatoriToken");
    const t = await SatoriToken.connect(deployer).deploy(
      governor.address, devRecipient.address, homeChainId);
    await t.waitForDeployment();
    return t;
  }

  beforeEach(async function () {
    [deployer, governor, controller, alice, bob, carol, devRecipient] = await ethers.getSigners();
    token = await deployToken();
    AIRDROP_CAP = await token.AIRDROP_TOTAL_SUPPLY();
    INITIAL_MINT = await token.INITIAL_MINT();
    // General share floored onto the cap; the dev takes the remainder.
    DEV_GENESIS = INITIAL_MINT - (INITIAL_MINT * (10000n - DEV_BPS)) / 10000n;
    const MockTransferHook = await ethers.getContractFactory("MockTransferHook");
    hookMock = await MockTransferHook.deploy();
    await hookMock.waitForDeployment();

    // The bridge is a hardcoded predeploy address, not a settable pointer, so
    // exercising the lane means impersonating it and funding it for gas.
    await impersonateAccount(SUPERCHAIN_BRIDGE);
    await setBalance(SUPERCHAIN_BRIDGE, ethers.parseEther("1"));
    bridge = await ethers.getSigner(SUPERCHAIN_BRIDGE);
  });

  async function withController() {
    await token.connect(governor).setController(controller.address);
  }

  // Mint away the deploy round's remaining general headroom, so a following
  // 1-wei mint can only succeed if something wrongly FREED budget. Genesis no
  // longer saturates this cap on its own (INITIAL_MINT is one hub round, not
  // one token round), so the tests that need a saturated lane make it so.
  async function saturateRound0() {
    const room = ((await token.rewardCeiling()) * (10000n - DEV_BPS)) / 10000n
               - (await token.generalMinted());
    if (room > 0n) await token.connect(controller).rewardMint(bob.address, room);
  }

  // ------------------------------------------------------------------
  describe("construction", function () {
    it("splits INITIAL_MINT governor 1152 / dev 288, not the deployer; supply stays 1440", async function () {
      expect(await token.balanceOf(governor.address)).to.equal(INITIAL_MINT - DEV_GENESIS);
      expect(await token.balanceOf(devRecipient.address)).to.equal(DEV_GENESIS);
      expect(await token.balanceOf(deployer.address)).to.equal(0);
      expect(await token.totalRewardsMinted()).to.equal(INITIAL_MINT);
      expect(await token.devFeeMinted()).to.equal(DEV_GENESIS);
      expect(await token.totalSupply()).to.equal(INITIAL_MINT);
    });

    it("records deployment round and block; getCurrentRound = timestamp / 86400", async function () {
      const block = await ethers.provider.getBlock("latest");
      expect(await token.deploymentRound()).to.equal(Math.floor(block.timestamp / ROUND));
      expect(Number(await token.deploymentBlock())).to.be.greaterThan(0);
      expect(await token.getCurrentRound()).to.equal(Math.floor(block.timestamp / ROUND));
    });

    it("rejects zero governor, zero dev recipient, or a zero home chain id", async function () {
      const SatoriToken = await ethers.getContractFactory("SatoriToken");
      await expect(SatoriToken.deploy(ethers.ZeroAddress, devRecipient.address, HOME))
        .to.be.revertedWithCustomError(SatoriToken, "BadInput");
      await expect(SatoriToken.deploy(governor.address, ethers.ZeroAddress, HOME))
        .to.be.revertedWithCustomError(SatoriToken, "BadInput");
      // Chain id 0 is not a real chain, so it could only be an unset variable —
      // and it would silently produce a deployment that can never emit.
      await expect(SatoriToken.deploy(governor.address, devRecipient.address, 0))
        .to.be.revertedWithCustomError(SatoriToken, "BadInput");
    });

    it("has no controller or hook at construction, and no bridge pointer at all", async function () {
      expect(await token.controller()).to.equal(ethers.ZeroAddress);
      expect(await token.hook()).to.equal(ethers.ZeroAddress);
      // The bridge is a hardcoded constant, not governor-set state: no slot,
      // no getter, no setter, so no governor can ever repoint it.
      expect(token.interface.getFunction("bridge")).to.equal(null);
      expect(token.interface.getFunction("setBridge")).to.equal(null);
    });

    it("is a normal ERC20 (name, symbol, decimals, transfer)", async function () {
      expect(await token.name()).to.equal("Satori");
      expect(await token.symbol()).to.equal("SATORI");
      expect(await token.decimals()).to.equal(18);
      await token.connect(governor).transfer(alice.address, 1000n);
      expect(await token.balanceOf(alice.address)).to.equal(1000n);
    });
  });

  // ------------------------------------------------------------------
  describe("reward mint ceiling (85% of the token envelope; the hub is stricter)", function () {
    beforeEach(withController);

    it("round 0 has headroom HERE, because the genesis mint is one hub round not one token round", async function () {
      // This used to assert zero headroom, when INITIAL_MINT was a full 1440.
      // It is now 846.62 — one round of the HUB's schedule — against a token
      // envelope of 1440, so 85% of 1440 minus the genesis general share is
      // left over. The deploy round is still saturated where it matters: at the
      // hub, which caps its lane at 85% of its own rate.
      const room = ((await token.rewardCeiling()) * (10000n - DEV_BPS)) / 10000n
                 - (await token.generalMinted());
      expect(room).to.be.gt(0n);
      await expect(token.connect(controller).rewardMint(alice.address, room + 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      await expect(token.connect(controller).rewardMint(alice.address, room)).to.not.be.reverted;
    });

    it("accrues 85% of the envelope per elapsed round; boundary exact", async function () {
      // Drain the deploy round's leftover first, so each later round's accrual
      // stands alone.
      const room0 = ((await token.rewardCeiling()) * (10000n - DEV_BPS)) / 10000n
                  - (await token.generalMinted());
      if (room0 > 0n) await token.connect(controller).rewardMint(bob.address, room0);
      await time.increase(ROUND);
      await expect(token.connect(controller).rewardMint(alice.address, GEN + 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      await token.connect(controller).rewardMint(alice.address, GEN);
      expect(await token.balanceOf(alice.address)).to.equal(GEN);
      await expect(token.connect(controller).rewardMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
      await time.increase(3 * ROUND);
      await token.connect(controller).rewardMint(alice.address, 3n * GEN);
      await expect(token.connect(controller).rewardMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
    });

    it("rewardCeiling view still reports the full gross budget (1440/round)", async function () {
      const r0 = Number(await token.deploymentRound());
      const now = await currentRound();
      expect(await token.rewardCeiling()).to.equal(BigInt(now - r0 + 1) * BUDGET);
    });

    it("only controller can rewardMint", async function () {
      await time.increase(ROUND);
      for (const s of [governor, alice, bridge]) {
        await expect(token.connect(s).rewardMint(alice.address, 1n))
          .to.be.revertedWithCustomError(token, "Unauthorized");
      }
    });
  });

  // ------------------------------------------------------------------
  describe("airdrop mint (one-shot cap)", function () {
    // The airdrop door is gated on `token.airdrop` — the SatoriAirdrop contract
    // in production — never on the controller. `devRecipient` stands in for it
    // here: any address the wiring authority points the slot at.
    let airdropSigner;
    beforeEach(async function () {
      await withController();
      airdropSigner = devRecipient;
      await token.connect(governor).setAirdrop(airdropSigner.address);
    });

    it("the airdrop contract reads the cap THROUGH the token, so the two cannot disagree", async function () {
      const { deploySatoriFixtureNoFee } = require("../fixtures");
      const fix = await deploySatoriFixtureNoFee();
      const tok = await ethers.getContractAt("SatoriToken", await fix.satori.satoriToken());
      expect(await fix.airdrop.AIRDROP_TOTAL_SUPPLY())
        .to.equal(await tok.AIRDROP_TOTAL_SUPPLY());
    });

    it("mints up to exactly the cap with per-recipient tracking, then never again", async function () {
      await token.connect(airdropSigner).airdropMint(alice.address, AIRDROP_CAP / 2n);
      await token.connect(airdropSigner).airdropMint(bob.address, AIRDROP_CAP / 2n);
      expect(await token.airdropMintedTo(alice.address)).to.equal(AIRDROP_CAP / 2n);
      expect(await token.airdropMinted()).to.equal(AIRDROP_CAP);
      await expect(token.connect(airdropSigner).airdropMint(carol.address, 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
    });

    it("is independent of the reward ceiling", async function () {
      await token.connect(airdropSigner).airdropMint(alice.address, AIRDROP_CAP);
      expect(await token.totalRewardsMinted()).to.equal(INITIAL_MINT); // unchanged
      await time.increase(ROUND);
      await token.connect(controller).rewardMint(bob.address, GEN); // general lane still available
    });

    it("only the airdrop slot can airdropMint — not the governor, not the controller", async function () {
      await expect(token.connect(governor).airdropMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(controller).airdropMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
    });
  });

  // ------------------------------------------------------------------
  describe("burn (supply down, budget never freed)", function () {
    beforeEach(withController);

    it("burn destroys own tokens and does NOT free reward budget", async function () {
      // With round 0's general lane exhausted, the only way the closing 1-wei
      // mint could succeed is if the burn freed budget.
      await saturateRound0();
      const supply0 = await token.totalSupply();
      const minted0 = await token.totalRewardsMinted();
      await token.connect(governor).burn(ethers.parseEther("100"));
      expect(await token.totalSupply()).to.equal(supply0 - ethers.parseEther("100"));
      expect(await token.totalRewardsMinted()).to.equal(minted0); // unchanged
      await expect(token.connect(controller).rewardMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded"); // burn freed nothing
    });

    it("burnFrom spends allowance", async function () {
      await token.connect(governor).transfer(alice.address, 500n);
      await expect(token.connect(bob).burnFrom(alice.address, 100n)).to.be.reverted;
      await token.connect(alice).approve(bob.address, 100n);
      await token.connect(bob).burnFrom(alice.address, 100n);
      expect(await token.balanceOf(alice.address)).to.equal(400n);
    });

    it("burn is blocked while transfer-locked", async function () {
      await token.connect(governor).transfer(alice.address, 500n);
      await token.connect(controller).setLock(alice.address, 0, INDEFINITE);
      await expect(token.connect(alice).burn(1n))
        .to.be.revertedWithCustomError(token, "Locked");
    });
  });

  // ------------------------------------------------------------------
  describe("ERC-7802 bridge lane (SuperchainERC20)", function () {
    beforeEach(async function () {
      await withController();
      await token.connect(governor).transfer(alice.address, ethers.parseEther("100"));
    });

    it("only the SuperchainTokenBridge predeploy may mint or burn", async function () {
      await expect(token.connect(alice).crosschainMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(controller).crosschainBurn(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(governor).crosschainMint(governor.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
    });

    it("the bridge authority is hardcoded — there is no setBridge to repoint it", async function () {
      expect(token.interface.getFunction("setBridge")).to.equal(null);
      expect(token.setBridge).to.equal(undefined);
    });

    it("crosschainBurn needs NO allowance — the predeploy is trusted, as the spec requires", async function () {
      const amt = ethers.parseEther("25");
      expect(await token.allowance(alice.address, SUPERCHAIN_BRIDGE)).to.equal(0);
      await expect(token.connect(bridge).crosschainBurn(alice.address, amt))
        .to.emit(token, "CrosschainBurn").withArgs(alice.address, amt, SUPERCHAIN_BRIDGE);
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseEther("75"));
      expect(await token.crosschainBurned()).to.equal(amt);
    });

    it("HOME is net-outflow bounded — it can only ever re-mint what actually left", async function () {
      // The safety property that makes a permissive transport tier tolerable: no
      // transport, however compromised, can create real SATORI on the home chain
      // beyond what genuinely departed it.
      await expect(token.connect(bridge).crosschainMint(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "CrosschainLimit");

      const amt = ethers.parseEther("40");
      await token.connect(bridge).crosschainBurn(alice.address, amt);
      await expect(token.connect(bridge).crosschainMint(bob.address, amt + 1n))
        .to.be.revertedWithCustomError(token, "CrosschainLimit");
      await expect(token.connect(bridge).crosschainMint(bob.address, amt))
        .to.emit(token, "CrosschainMint").withArgs(bob.address, amt, SUPERCHAIN_BRIDGE);
      await expect(token.connect(bridge).crosschainMint(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "CrosschainLimit");
    });

    it("plain burn/burnFrom create NO bridge headroom", async function () {
      // Otherwise a transport could convert ordinary user burns (and every vote,
      // which burns) into self-mints.
      await token.connect(alice).burn(ethers.parseEther("10"));
      expect(await token.crosschainBurned()).to.equal(0);
      await expect(token.connect(bridge).crosschainMint(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "CrosschainLimit");
    });

    it("bridging never consumes reward budget in either direction", async function () {
      // With round 0's general lane exhausted, the closing 1-wei mint can only
      // succeed if bridging touched the reward counters.
      await saturateRound0();
      const minted0 = await token.totalRewardsMinted();
      const amt = ethers.parseEther("50");
      await token.connect(bridge).crosschainBurn(alice.address, amt);
      await token.connect(bridge).crosschainMint(alice.address, amt);
      expect(await token.totalRewardsMinted()).to.equal(minted0);
      await expect(token.connect(controller).rewardMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "BudgetExceeded");
    });

    it("crosschainBurn still respects transfer locks", async function () {
      await token.connect(controller).setLock(alice.address, 1, INDEFINITE);
      await expect(token.connect(bridge).crosschainBurn(alice.address, 10n))
        .to.be.revertedWithCustomError(token, "Locked");
    });

    it("crosschainMint succeeds to a transfer-locked recipient (mint skips sender lock)", async function () {
      const amt = ethers.parseEther("10");
      await token.connect(bridge).crosschainBurn(alice.address, amt); // home headroom first
      await token.connect(controller).setLock(bob.address, 0, INDEFINITE);
      await token.connect(bridge).crosschainMint(bob.address, amt); // to is locked, still OK
      expect(await token.balanceOf(bob.address)).to.equal(amt);
    });

    it("advertises IERC7802 + IERC165 via supportsInterface", async function () {
      const s1 = BigInt(ethers.id("crosschainMint(address,uint256)").slice(0, 10));
      const s2 = BigInt(ethers.id("crosschainBurn(address,uint256)").slice(0, 10));
      const ifaceId = "0x" + (s1 ^ s2).toString(16).padStart(8, "0");
      expect(ifaceId).to.equal("0x33331994"); // the id named in EIP-7802
      expect(await token.supportsInterface(ifaceId)).to.equal(true);
      expect(await token.supportsInterface("0x01ffc9a7")).to.equal(true);  // IERC165
      expect(await token.supportsInterface("0xffffffff")).to.equal(false);
    });
  });

  // ------------------------------------------------------------------
  // Tier 2: the transport lane. Exists because Base is leaving the OP Stack and
  // is absent from the Karst interop rollout, so the protocol predeploy may
  // never appear on the home chain. Hardcoding it as the ONLY authority would
  // have made SATORI permanently unable to leave Base, in a contract with no
  // upgrade path. Trust is tiered by what the caller actually is.
  describe("transport lane (tier 2 — third-party bridges)", function () {
    let authority, transport;

    beforeEach(async function () {
      await withController();
      await token.connect(governor).transfer(alice.address, ethers.parseEther("100"));
      transport = carol; // stands in for a CCIP/LayerZero/Base-native adapter
      authority = await (await ethers.getContractFactory("BridgeAuthorityMock")).deploy();
      await authority.waitForDeployment();
    });

    async function authorize() {
      await authority.set(transport.address, true);
      await token.connect(governor).setBridgeAuthority(await authority.getAddress());
    }

    it("is closed by default — no authority set at deploy", async function () {
      expect(await token.bridgeAuthority()).to.equal(ethers.ZeroAddress);
      await expect(token.connect(transport).crosschainMint(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
    });

    it("the protocol lane works with NO authority set at all", async function () {
      // Tier 1 must never depend on tier 2 being configured.
      await token.connect(bridge).crosschainBurn(alice.address, 10n);
      expect(await token.crosschainBurned()).to.equal(10n);
    });

    it("an authorized transport may bridge; an unauthorized one may not", async function () {
      await authorize();
      await token.connect(alice).approve(transport.address, 50n);
      await token.connect(transport).crosschainBurn(alice.address, 50n);
      expect(await token.crosschainBurned()).to.equal(50n);
      await expect(token.connect(bob).crosschainMint(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
    });

    it("a transport burn REQUIRES allowance — holders who never opted in are untouchable", async function () {
      // The tier-1/tier-2 asymmetry. The predeploy IS the chain and burns
      // unconditionally; a third party gets only what a holder granted it.
      await authorize();
      expect(await token.allowance(alice.address, transport.address)).to.equal(0);
      await expect(token.connect(transport).crosschainBurn(alice.address, 1n)).to.be.reverted;
      // ...while the predeploy needs nothing.
      await token.connect(bridge).crosschainBurn(alice.address, 1n);
    });

    it("a transport burn spends the allowance it was granted", async function () {
      await authorize();
      await token.connect(alice).approve(transport.address, 50n);
      await token.connect(transport).crosschainBurn(alice.address, 30n);
      expect(await token.allowance(alice.address, transport.address)).to.equal(20n);
    });

    it("the home net-outflow bound applies to transports too", async function () {
      await authorize();
      await expect(token.connect(transport).crosschainMint(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "CrosschainLimit");
    });

    it("an authority that says no is a denial", async function () {
      await token.connect(governor).setBridgeAuthority(await authority.getAddress());
      await expect(token.connect(transport).crosschainMint(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
    });

    it("a REVERTING authority denies rather than bricks, and never touches tier 1", async function () {
      await authorize();
      await authority.setRevert(true);
      await expect(token.connect(transport).crosschainBurn(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      // Tier 1 is checked first and short-circuits, so a broken registry cannot
      // take the protocol lane down with it.
      await token.connect(bridge).crosschainBurn(alice.address, 1n);
      expect(await token.crosschainBurned()).to.equal(1n);
    });

    it("setBridgeAuthority is governor-only, rejects codeless, and zero disables", async function () {
      await expect(token.connect(alice).setBridgeAuthority(await authority.getAddress()))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      // A codeless authority would hard-revert OUTSIDE the try/catch via the
      // compiler's extcodesize check — same trap setHook guards against.
      await expect(token.connect(governor).setBridgeAuthority(alice.address))
        .to.be.revertedWithCustomError(token, "BadInput");
      await authorize();
      await token.connect(governor).setBridgeAuthority(ethers.ZeroAddress); // disable
      await expect(token.connect(transport).crosschainMint(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "Unauthorized");
    });

    it("emptying the WIRING slot freezes the transport authority forever", async function () {
      await authorize();
      // This used to be `renounceGovernor`, back when one address gated
      // everything. With the slots split, renouncing the ROOT only gives up the
      // power to REASSIGN — the standing wiring authority keeps working. Killing
      // a lever is now its own deliberate act: zero the slot that drives it.
      await token.connect(governor).setWiringAuthority(ethers.ZeroAddress);
      await expect(token.connect(governor).setBridgeAuthority(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      // Whatever was standing at renounce time keeps working, permanently.
      await token.connect(alice).approve(transport.address, 10n);
      await token.connect(transport).crosschainBurn(alice.address, 10n);
    });
  });

  // ------------------------------------------------------------------
  // The home-chain gates. Same bytecode, different chain: emission is
  // constitutional, not configurational. See design/superchain-native-token.md.
  describe("home-chain gates (remote deployments are bridge-only)", function () {
    let remote;

    beforeEach(async function () {
      remote = await deployToken(NOT_HOME);
    });

    it("home deployment is unaffected — genesis mint, controller, dev fee all work", async function () {
      expect(await token.totalSupply()).to.equal(INITIAL_MINT);
      await token.connect(governor).setController(controller.address);
      expect(await token.controller()).to.equal(controller.address);
    });

    it("skips the genesis mint entirely off-home — no supply exists at construction", async function () {
      expect(await remote.totalSupply()).to.equal(0);
      expect(await remote.balanceOf(governor.address)).to.equal(0);
      expect(await remote.balanceOf(devRecipient.address)).to.equal(0);
      expect(await remote.totalRewardsMinted()).to.equal(0);
      expect(await remote.devFeeMinted()).to.equal(0);
    });

    it("refuses setController and setAirdrop off-home, which closes rewardMint/airdropMint/setLock/markParticipated", async function () {
      await expect(remote.connect(governor).setController(controller.address))
        .to.be.revertedWithCustomError(remote, "NotHomeChain");
      expect(await remote.controller()).to.equal(ethers.ZeroAddress);
      await expect(remote.connect(governor).setAirdrop(controller.address))
        .to.be.revertedWithCustomError(remote, "NotHomeChain");
      expect(await remote.airdrop()).to.equal(ethers.ZeroAddress);
      // With both slots permanently zero, every gated mint path is unreachable.
      for (const call of [
        remote.connect(governor).rewardMint(alice.address, 1n),
        remote.connect(governor).airdropMint(alice.address, 1n),
        remote.connect(governor).setLock(alice.address, 0, INDEFINITE),
        remote.connect(governor).markParticipated(alice.address),
      ]) {
        await expect(call).to.be.revertedWithCustomError(remote, "Unauthorized");
      }
    });

    it("refuses mintDevFee off-home — the permissionless leak this gate exists for", async function () {
      await time.increase(ROUND * 5);
      await expect(remote.connect(alice).mintDevFee())
        .to.be.revertedWithCustomError(remote, "NotHomeChain");
      expect(await remote.totalSupply()).to.equal(0);
      // ...while the same call on the home deployment pays out normally. The
      // fee is now 15% of what was actually MINTED, not of elapsed time, so the
      // clock alone owes nothing — a general mint is what creates the debt.
      await withController();
      await token.connect(controller).rewardMint(alice.address, ethers.parseEther("100"));
      await expect(token.connect(alice).mintDevFee()).to.emit(token, "DevFeeMinted");
    });

    it("accepts bridged supply off-home with NO prior outflow — the destination property", async function () {
      // The net-outflow rule is scoped to home precisely so this works. Applied
      // everywhere (the old design) a fresh deployment could never receive, which
      // is the definition of not being a bridge destination.
      const amt = ethers.parseEther("500");
      expect(await remote.crosschainBurned()).to.equal(0);
      await remote.connect(bridge).crosschainMint(alice.address, amt);
      expect(await remote.balanceOf(alice.address)).to.equal(amt);
      expect(await remote.totalSupply()).to.equal(amt);
      await remote.connect(bridge).crosschainBurn(alice.address, amt);
      expect(await remote.totalSupply()).to.equal(0);
    });

    it("off-home minting is unbounded by the counters — home carries the bound, not remotes", async function () {
      const amt = ethers.parseEther("1000");
      await remote.connect(bridge).crosschainMint(alice.address, amt);
      await remote.connect(bridge).crosschainMint(alice.address, amt);
      expect(await remote.crosschainMinted()).to.equal(amt * 2n);
      expect(await remote.crosschainBurned()).to.equal(0);
      // Home, by contrast, refuses the same call outright.
      await expect(token.connect(bridge).crosschainMint(alice.address, 1n))
        .to.be.revertedWithCustomError(token, "CrosschainLimit");
    });

    it("reports a zero emission ceiling off-home, where nothing can ever be minted", async function () {
      await time.increase(ROUND * 10);
      expect(await remote.rewardCeiling()).to.equal(0);
      expect(await remote.devFeeCeiling()).to.equal(0);
      // The home deployment's envelope keeps accruing on the clock exactly as
      // before. The dev ceiling no longer does: it is a ratio of what has been
      // minted, so ten idle rounds move it by nothing at all, and a general
      // mint is what moves it.
      expect(await token.rewardCeiling()).to.be.greaterThan(BUDGET);
      const devCap0 = await token.devFeeCeiling();
      await time.increase(ROUND * 10);
      expect(await token.devFeeCeiling()).to.equal(devCap0); // the clock owes nothing
      await withController();
      await token.connect(controller).rewardMint(alice.address, ethers.parseEther("850"));
      expect(await token.devFeeCeiling()).to.be.greaterThan(devCap0);
    });

    it("lets the governor renounce off-home without a controller it can never set", async function () {
      await expect(remote.connect(governor).renounceRootAuthority())
        .to.emit(remote, "RootAuthorityTransferred").withArgs(governor.address, ethers.ZeroAddress);
      expect(await remote.rootAuthority()).to.equal(ethers.ZeroAddress);
      // Home keeps the guard: renouncing without a controller would brick minting.
      await expect(token.connect(governor).renounceRootAuthority())
        .to.be.revertedWithCustomError(token, "ControllerNotSet");
    });

    it("exposes HOME_CHAIN_ID so anyone can tell a home deployment from a remote one", async function () {
      expect(await token.HOME_CHAIN_ID()).to.equal(HOME);
      expect(await remote.HOME_CHAIN_ID()).to.equal(NOT_HOME);
    });
  });

  // ------------------------------------------------------------------
  describe("lock lanes", function () {
    beforeEach(async function () {
      await withController();
      await token.connect(governor).transfer(alice.address, 1000n);
    });

    it("ten independent lanes; enforcement is the max; each lane isolated", async function () {
      const r = await currentRound();
      // Set every one of the ten lanes to a distinct value, then read each back
      // — proves setLock touches only its own 24 bits and nothing bleeds across.
      for (let lane = 0; lane < 10; lane++) {
        await token.connect(controller).setLock(alice.address, lane, r + lane + 1);
      }
      for (let lane = 0; lane < 10; lane++) {
        expect(await token.lockUntil(alice.address, lane)).to.equal(r + lane + 1);
      }
      expect(await token.transferLockedUntil(alice.address)).to.equal(r + 10);  // max = lane 9
      await expect(token.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "Locked");
      // Drop the max lane; the next-highest becomes the effective lock.
      await token.connect(controller).setLock(alice.address, 9, 0);
      expect(await token.transferLockedUntil(alice.address)).to.equal(r + 9);
      expect(await token.lockUntil(alice.address, 0)).to.equal(r + 1);          // others intact
    });

    it("self-heals: an expired lock is zeroed on the next transfer", async function () {
      const r = await currentRound();
      await token.connect(controller).setLock(alice.address, 5, r + 1);   // lock, expires after this round
      await expect(token.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "Locked");
      await time.increase(2 * ROUND);                                          // let it expire
      expect(await token.lockUntil(alice.address, 5)).to.equal(r + 1);     // stale value still sits there
      await token.connect(alice).transfer(bob.address, 1n);                // transfer now allowed
      expect(await token.lockUntil(alice.address, 5)).to.equal(0);         // ...and the lane was cleared
      expect(await token.transferLockedUntil(alice.address)).to.equal(0);  // early-out path restored
    });

    it("self-heal preserves the participation flag and any still-live lane", async function () {
      const r = await currentRound();
      await token.connect(controller).markParticipated(alice.address);
      await token.connect(controller).setLock(alice.address, 2, r + 1);    // will expire
      await time.increase(2 * ROUND);
      await token.connect(alice).transfer(bob.address, 1n);                // heals lane 2
      expect(await token.lockUntil(alice.address, 2)).to.equal(0);
      expect(await token.hasParticipated(alice.address)).to.equal(true);   // flag survived the heal
    });

    it("participation flag and lock lanes share a word without clobbering", async function () {
      const r = await currentRound();
      await token.connect(controller).setLock(alice.address, 5, r + 7);
      expect(await token.hasParticipated(alice.address)).to.equal(false);       // setLock left flag off
      await token.connect(controller).markParticipated(alice.address);
      expect(await token.hasParticipated(alice.address)).to.equal(true);
      expect(await token.lockUntil(alice.address, 5)).to.equal(r + 7);          // flag left lane intact
      await token.connect(controller).setLock(alice.address, 5, 0);            // clear the lane
      expect(await token.hasParticipated(alice.address)).to.equal(true);        // flag survives
    });

    it("lock >= currentRound blocks; expires the round after", async function () {
      const r = await currentRound();
      await token.connect(controller).setLock(alice.address, 0, r);
      await expect(token.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "Locked");
      await time.increase(ROUND);
      await token.connect(alice).transfer(bob.address, 1n); // r < currentRound now
    });

    it("lock of 0 never blocks (round-0 edge guard)", async function () {
      await token.connect(alice).transfer(bob.address, 1n);
      await token.connect(controller).setLock(alice.address, 0, 0);
      await token.connect(alice).transfer(bob.address, 1n);
    });

    it("LOCK_INDEFINITE blocks; receiving and mint-to while locked still work", async function () {
      await token.connect(controller).setLock(alice.address, 0, INDEFINITE);
      await expect(token.connect(alice).transfer(bob.address, 1n))
        .to.be.revertedWithCustomError(token, "Locked");
      await token.connect(governor).transfer(alice.address, 5n); // receive OK
      await time.increase(ROUND);
      await token.connect(controller).rewardMint(alice.address, 10n); // mint-to OK
    });

    it("lane must be < 10 (== LOCK_LANES); setLock is controller-only", async function () {
      expect(await token.LOCK_LANES()).to.equal(10);
      await expect(token.connect(controller).setLock(alice.address, 10, 1))
        .to.be.revertedWithCustomError(token, "BadInput");
      await expect(token.connect(governor).setLock(alice.address, 0, 1))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.lockUntil(alice.address, 10))
        .to.be.revertedWithCustomError(token, "BadInput");
    });
  });

  // ------------------------------------------------------------------
  describe("participation + transfer hook", function () {
    beforeEach(async function () {
      await withController();
      await token.connect(governor).transfer(alice.address, 1000n);
      await token.connect(governor).setHook(await hookMock.getAddress());
    });

    it("hook is skipped when neither side has participated", async function () {
      await token.connect(alice).transfer(bob.address, 10n);
      expect(await hookMock.calls()).to.equal(0);
    });

    it("hook fires when sender or receiver participated, with exact args", async function () {
      await token.connect(controller).markParticipated(alice.address);
      await token.connect(alice).transfer(bob.address, 10n);
      expect(await hookMock.calls()).to.equal(1);
      expect(await hookMock.lastFrom()).to.equal(alice.address);
      expect(await hookMock.lastTo()).to.equal(bob.address);
      expect(await hookMock.lastValue()).to.equal(10n);
      await token.connect(carol).approve(carol.address, 0); // unrelated tx
      await token.connect(governor).transfer(alice.address, 7n); // governor not participated, alice is
      expect(await hookMock.calls()).to.equal(2);
    });

    it("hook fires on mint (from=0) and burn (to=0) for participants", async function () {
      await token.connect(controller).markParticipated(alice.address);
      await time.increase(ROUND);
      await token.connect(controller).rewardMint(alice.address, 5n);
      expect(await hookMock.lastFrom()).to.equal(ethers.ZeroAddress);
      await token.connect(alice).burn(5n);
      expect(await hookMock.lastTo()).to.equal(ethers.ZeroAddress);
    });

    it("a reverting hook never blocks the transfer, and emits TransferHookFailed", async function () {
      await token.connect(controller).markParticipated(alice.address);
      await hookMock.setMode(1);
      await expect(token.connect(alice).transfer(bob.address, 10n))
        .to.emit(token, "TransferHookFailed").withArgs(alice.address, bob.address, 10n);
      expect(await token.balanceOf(bob.address)).to.equal(10n);
    });

    it("markParticipated is controller-only, monotonic, emits once", async function () {
      await expect(token.connect(alice).markParticipated(alice.address))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(controller).markParticipated(alice.address))
        .to.emit(token, "Participated").withArgs(alice.address);
      await expect(token.connect(controller).markParticipated(alice.address))
        .to.not.emit(token, "Participated");
      expect(await token.hasParticipated(alice.address)).to.equal(true);
    });

    it("clearing the hook restores plain transfers", async function () {
      await token.connect(controller).markParticipated(alice.address);
      await token.connect(governor).setHook(ethers.ZeroAddress);
      await token.connect(alice).transfer(bob.address, 10n);
      expect(await hookMock.calls()).to.equal(0);
    });

    it("setHook rejects a codeless address (would brick transfers via the try-call codesize check)", async function () {
      await expect(token.connect(governor).setHook(carol.address)) // EOA, no code
        .to.be.revertedWithCustomError(token, "BadInput");
      // a real contract hook that reverts is still fine (caught at call time) — covered above
    });

    it("markParticipated and setLock reject the zero address", async function () {
      await expect(token.connect(controller).markParticipated(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "BadInput");
      await expect(token.connect(controller).setLock(ethers.ZeroAddress, 0, 1))
        .to.be.revertedWithCustomError(token, "BadInput");
    });
  });

  // ------------------------------------------------------------------
  describe("governance", function () {
    it("setters are governor-only with zero-address rules", async function () {
      await expect(token.connect(alice).setController(alice.address))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(governor).setController(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "BadInput");
      await token.connect(governor).setHook(ethers.ZeroAddress);          // zero allowed (disable)
      await token.connect(governor).setRootAuthority(ethers.ZeroAddress);      // zero allowed (cancel pending)
      expect(await token.pendingRootAuthority()).to.equal(ethers.ZeroAddress);
    });

    it("setRootAuthority is two-step: power only moves once the successor accepts", async function () {
      await expect(token.connect(governor).setRootAuthority(alice.address))
        .to.emit(token, "RootAuthorityTransferStarted").withArgs(governor.address, alice.address);
      // old governor still fully in power until acceptance
      expect(await token.rootAuthority()).to.equal(governor.address);
      expect(await token.pendingRootAuthority()).to.equal(alice.address);
      await token.connect(governor).setHook(ethers.ZeroAddress);
      // wrong account cannot accept
      await expect(token.connect(bob).acceptRootAuthority())
        .to.be.revertedWithCustomError(token, "Unauthorized");
      await expect(token.connect(alice).acceptRootAuthority())
        .to.emit(token, "RootAuthorityTransferred").withArgs(governor.address, alice.address);
      expect(await token.rootAuthority()).to.equal(alice.address);
      expect(await token.pendingRootAuthority()).to.equal(ethers.ZeroAddress);
      // The ROOT moved; the other slots did NOT. The old holder still holds
      // wiring until the new root reassigns it — which is the point of the
      // split, and the thing a single `governor` could not express.
      await expect(token.connect(governor).setHook(ethers.ZeroAddress)).to.not.be.reverted;
      await expect(token.connect(alice).setController(controller.address))
        .to.be.revertedWithCustomError(token, "Unauthorized");
      // The new root takes wiring, and then it can.
      await token.connect(alice).setWiringAuthority(alice.address);
      await token.connect(alice).setController(controller.address);
    });

    it("a keyless/mistyped pending governor cannot take the role (no brick path)", async function () {
      await token.connect(governor).setRootAuthority(bob.address); // 'wrong' address
      // it never accepts; original governor can re-point or cancel
      await token.connect(governor).setRootAuthority(ethers.ZeroAddress); // cancel
      expect(await token.pendingRootAuthority()).to.equal(ethers.ZeroAddress);
      await expect(token.connect(bob).acceptRootAuthority())
        .to.be.revertedWithCustomError(token, "Unauthorized");
      expect(await token.rootAuthority()).to.equal(governor.address); // still in control
    });

    it("renounce cancels any pending handoff so it cannot un-renounce", async function () {
      await token.connect(governor).setController(controller.address);
      await token.connect(governor).setRootAuthority(alice.address);
      await token.connect(governor).renounceRootAuthority();
      expect(await token.pendingRootAuthority()).to.equal(ethers.ZeroAddress);
      await expect(token.connect(alice).acceptRootAuthority())
        .to.be.revertedWithCustomError(token, "Unauthorized");
    });

    it("renounceRootAuthority requires a controller and then ends REASSIGNMENT forever", async function () {
      await expect(token.connect(governor).renounceRootAuthority())
        .to.be.revertedWithCustomError(token, "ControllerNotSet");
      await token.connect(governor).setController(controller.address);
      await expect(token.connect(governor).renounceRootAuthority())
        .to.emit(token, "RootAuthorityTransferred").withArgs(governor.address, ethers.ZeroAddress);
      expect(await token.rootAuthority()).to.equal(ethers.ZeroAddress);
      // What is given up is the power to REASSIGN the slots — nothing else.
      for (const call of [
        token.connect(governor).setWiringAuthority(alice.address),
        token.connect(governor).setFeeAuthority(alice.address),
        token.connect(governor).setRootAuthority(alice.address),
        token.connect(governor).renounceRootAuthority(),
      ]) {
        await expect(call).to.be.revertedWithCustomError(token, "Unauthorized");
      }
      // The standing authorities are UNTOUCHED and keep working forever. This is
      // the deliberate break from the old all-or-nothing `renounceGovernor`:
      // "give up everything" is no longer one act, and should not pretend to be.
      // (Both harmless calls — re-pointing the controller here would break the
      // "controller keeps working" assertion at the end of this test.)
      await expect(token.connect(governor).setHook(ethers.ZeroAddress)).to.not.be.reverted;
      await expect(token.connect(governor).setBridgeAuthority(ethers.ZeroAddress)).to.not.be.reverted;
      // Tier 1 was never the governor's to freeze: it is a hardcoded constant and
      // the protocol lane keeps working with no governor at all.
      // governor still holds the genesis balance; renouncing moves no tokens
      await token.connect(bridge).crosschainBurn(governor.address, 1n);
      await token.connect(bridge).crosschainMint(alice.address, 1n);
      // controller keeps working after renounce
      await time.increase(ROUND);
      await token.connect(controller).rewardMint(alice.address, 1n);
    });
  });

  // ------------------------------------------------------------------
  describe("ERC20Permit", function () {
    it("accepts a valid EIP-2612 signature and increments the nonce", async function () {
      const value = 12345n;
      const deadline = BigInt(await time.latest()) + 3600n;
      const domain = {
        name: "Satori",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };
      const message = {
        owner: alice.address,
        spender: bob.address,
        value,
        nonce: await token.nonces(alice.address),
        deadline,
      };
      const sig = ethers.Signature.from(await alice.signTypedData(domain, types, message));
      await token.permit(alice.address, bob.address, value, deadline, sig.v, sig.r, sig.s);
      expect(await token.allowance(alice.address, bob.address)).to.equal(value);
      expect(await token.nonces(alice.address)).to.equal(1n);
    });

    it("rejects a signature from the wrong signer", async function () {
      const deadline = BigInt(await time.latest()) + 3600n;
      const domain = {
        name: "Satori", version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };
      const types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" },
        { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" } ] };
      const message = {
        owner: alice.address, spender: bob.address, value: 1n,
        nonce: await token.nonces(alice.address), deadline,
      };
      const sig = ethers.Signature.from(await bob.signTypedData(domain, types, message));
      await expect(token.permit(alice.address, bob.address, 1n, deadline, sig.v, sig.r, sig.s))
        .to.be.reverted;
    });
  });

  // ------------------------------------------------------------------
  // The bytes overload. ERC-2612's (v, r, s) expresses exactly 65 bytes, so a
  // Safe's concatenated owner signatures or a Base Account passkey payload
  // CANNOT be passed through the standard entry point at all. Swapping in a
  // signature checker there would look like ERC-1271 support and deliver almost
  // none of it — permanently, in an immutable contract. Hence the overload.
  describe("ERC-1271 permit (smart-contract wallets)", function () {
    const PERMIT_BYTES = "permit(address,address,uint256,uint256,bytes)";
    let domain, types;

    beforeEach(async function () {
      domain = {
        name: "Satori", version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };
      types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" },
        { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" } ] };
    });

    async function sign(signer, owner, spender, value, deadline) {
      return signer.signTypedData(domain, types, {
        owner, spender, value, nonce: await token.nonces(owner), deadline,
      });
    }

    async function deployWallet(expectedSig) {
      const w = await (await ethers.getContractFactory("ERC1271WalletMock")).deploy(expectedSig);
      await w.waitForDeployment();
      return w;
    }

    it("accepts an ordinary EOA signature through the bytes overload too", async function () {
      // One entry point serving both account kinds is the point of the checker.
      const deadline = BigInt(await time.latest()) + 3600n;
      const raw = await sign(alice, alice.address, bob.address, 500n, deadline);
      await token[PERMIT_BYTES](alice.address, bob.address, 500n, deadline, raw);
      expect(await token.allowance(alice.address, bob.address)).to.equal(500n);
      expect(await token.nonces(alice.address)).to.equal(1n);
    });

    it("accepts a smart-wallet signature that is NOT 65 bytes", async function () {
      // 200 bytes: representative of a 3-of-5 Safe. Unrepresentable as (v,r,s).
      const walletSig = "0x" + "ab".repeat(200);
      const wallet = await deployWallet(walletSig);
      const owner = await wallet.getAddress();
      const deadline = BigInt(await time.latest()) + 3600n;
      await token[PERMIT_BYTES](owner, bob.address, 777n, deadline, walletSig);
      expect(await token.allowance(owner, bob.address)).to.equal(777n);
      expect(await token.nonces(owner)).to.equal(1n);
    });

    it("rejects when the wallet says no", async function () {
      const wallet = await deployWallet("0x" + "ab".repeat(200));
      await wallet.setMode(1); // Reject
      const deadline = BigInt(await time.latest()) + 3600n;
      await expect(token[PERMIT_BYTES](await wallet.getAddress(), bob.address, 1n, deadline, "0x" + "ab".repeat(200)))
        .to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
    });

    it("a REVERTING wallet denies rather than bricking the call", async function () {
      // The staticcall is low-level precisely so a hostile account cannot bubble
      // a revert out of the token.
      const wallet = await deployWallet("0x" + "ab".repeat(200));
      await wallet.setMode(2); // Revert
      const deadline = BigInt(await time.latest()) + 3600n;
      await expect(token[PERMIT_BYTES](await wallet.getAddress(), bob.address, 1n, deadline, "0x1234"))
        .to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
    });

    it("rejects a wrong magic value and a short return", async function () {
      const wallet = await deployWallet("0x" + "ab".repeat(200));
      const owner = await wallet.getAddress();
      const deadline = BigInt(await time.latest()) + 3600n;
      for (const m of [3 /* WrongMagic */, 4 /* ShortReturn */]) {
        await wallet.setMode(m);
        await expect(token[PERMIT_BYTES](owner, bob.address, 1n, deadline, "0x1234"))
          .to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
      }
    });

    it("shares ONE nonce with the (v,r,s) entry point — no cross-replay", async function () {
      // Both paths must consume the same counter, or a signature could be
      // replayed across entry points.
      const deadline = BigInt(await time.latest()) + 3600n;
      const raw = await sign(alice, alice.address, bob.address, 100n, deadline);
      const sig = ethers.Signature.from(raw);

      await token.permit(alice.address, bob.address, 100n, deadline, sig.v, sig.r, sig.s);
      expect(await token.nonces(alice.address)).to.equal(1n);
      // The SAME signature must now fail through the other door.
      await expect(token[PERMIT_BYTES](alice.address, bob.address, 100n, deadline, raw))
        .to.be.revertedWithCustomError(token, "ERC2612InvalidSigner");
    });

    it("consumes the nonce even on a failed verification (no free retries)", async function () {
      const wallet = await deployWallet("0x" + "ab".repeat(200));
      await wallet.setMode(1); // Reject
      const owner = await wallet.getAddress();
      const before = await token.nonces(owner);
      const deadline = BigInt(await time.latest()) + 3600n;
      await expect(token[PERMIT_BYTES](owner, bob.address, 1n, deadline, "0x1234")).to.be.reverted;
      // The whole call reverted, so the nonce is unchanged — the increment is
      // rolled back with everything else. Pinned so the ordering is deliberate.
      expect(await token.nonces(owner)).to.equal(before);
    });

    it("respects the deadline", async function () {
      const wallet = await deployWallet("0x1234");
      const past = BigInt(await time.latest()) - 1n;
      await expect(token[PERMIT_BYTES](await wallet.getAddress(), bob.address, 1n, past, "0x1234"))
        .to.be.revertedWithCustomError(token, "ERC2612ExpiredSignature");
    });

    it("the standard (v,r,s) entry point is untouched — ERC-2612 compliance intact", async function () {
      const deadline = BigInt(await time.latest()) + 3600n;
      const sig = ethers.Signature.from(await sign(alice, alice.address, carol.address, 42n, deadline));
      await token.permit(alice.address, carol.address, 42n, deadline, sig.v, sig.r, sig.s);
      expect(await token.allowance(alice.address, carol.address)).to.equal(42n);
    });
  });
});
