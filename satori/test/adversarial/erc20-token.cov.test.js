const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture, pack1, voteFor } = require("../fixtures");

const ROUND = 86400; // timeUnitSeconds
const UP = 1;
const DOWN = 2;

// Helpers ------------------------------------------------------------------

async function getStreamIdFromTx(tx, satoriContract) {
  const receipt = await tx.wait();
  const event = receipt.logs.find((log) => {
    try {
      const parsed = satoriContract.interface.parseLog(log);
      return parsed && parsed.name === "DataStreamCreated";
    } catch {
      return false;
    }
  });
  if (!event) throw new Error("DataStreamCreated event not found");
  return satoriContract.interface.parseLog(event).args.streamId;
}

// Drive rewardMint directly by impersonating address(satoriRewards).
async function asRewards(satori, rewards) {
  const addr = await rewards.getAddress();
  await impersonateAccount(addr);
  await setBalance(addr, ethers.parseEther("10"));
  return await ethers.getSigner(addr);
}

describe("[adversarial-cov] erc20-token", function () {
  // ---------------------------------------------------------------------
  // rewardMint cap (BudgetExceeded) — HIGH
  // ---------------------------------------------------------------------
  describe("rewardMint cumulative cap (BudgetExceeded)", function () {
    it("reverts BudgetExceeded when minting beyond the general lane's cap, and the boundary is exact", async function () {
      const { satori, rewards } = await deploySatoriFixture();
      const rewardsSigner = await asRewards(satori, rewards);

      // The binding cap here is the HUB's: its emission ceiling net of
      // the fee's flat 15%. The token's `1440 × rounds` is the outer envelope
      // and sits well outside it, so it is not what fires.
      const RATE = await satori.emissionRateNow();
      const BPS = await satori.devFeeBps();
      const genCap = (e) => (RATE * e * (10000n - BPS)) / 10000n;
      const initial = await satori.INITIAL_MINT();
      const recipient = (await ethers.getSigners())[5].address;

      // The genesis mint is ONE ROUND of the hub's schedule: its 85% seeds the
      // general lane and exactly saturates the deploy round's cap. Advance one
      // round; the new headroom is the second round's share.
      await time.increase(ROUND);
      const headroom = genCap(2n) - genCap(1n);

      const mintedBefore = await satori.totalRewardsMinted();
      expect(mintedBefore).to.equal(initial); // still the genesis bootstrap

      // headroom + 1 must revert (the `>` cap fires)
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, headroom + 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

      // exactly headroom must pass (<= cap)
      await satori.connect(rewardsSigner).rewardMint(recipient, headroom);
      expect(await satori.totalRewardsMinted()).to.equal(initial + headroom);

      // Now fully saturated again: even 1 wei more reverts.
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
    });
  });

  // ---------------------------------------------------------------------
  // rewardMint access gate (Unauthorized) — HIGH
  // ---------------------------------------------------------------------
  describe("rewardMint access control (Unauthorized)", function () {
    it("rejects every caller other than address(satoriRewards) and never changes supply", async function () {
      const { satori, voting, owner, signers } = await deploySatoriFixture();
      const attacker = signers[6];

      // advance a round so the cap is NOT the limiting factor (proves it is
      // the access gate, not the budget, that reverts)
      await time.increase(ROUND);

      const mintedBefore = await satori.totalRewardsMinted();
      const supplyBefore = await satori.totalSupply();

      // arbitrary attacker
      await expect(
        satori.connect(attacker).rewardMint(attacker.address, 1n)
      ).to.be.revertedWithCustomError(satori, "Unauthorized");

      // the deployer / fee recipient holds no minting authority
      await expect(
        satori.connect(owner).rewardMint(owner.address, 1n)
      ).to.be.revertedWithCustomError(satori, "Unauthorized");

      // even SatoriVoting (an exempt address elsewhere) cannot mint
      const votingAddr = await voting.getAddress();
      await impersonateAccount(votingAddr);
      await setBalance(votingAddr, ethers.parseEther("10"));
      const votingSigner = await ethers.getSigner(votingAddr);
      await expect(
        satori.connect(votingSigner).rewardMint(votingSigner.address, 1n)
      ).to.be.revertedWithCustomError(satori, "Unauthorized");

      expect(await satori.totalRewardsMinted()).to.equal(mintedBefore);
      expect(await satori.totalSupply()).to.equal(supplyBefore);
    });
  });

  // ---------------------------------------------------------------------
  // Deploy-round saturation, unlocks next round — MED
  // ---------------------------------------------------------------------
  describe("deploy-round saturation", function () {
    it("deploy round is exactly saturated at genesis (zero headroom); the general cap grows one round's share at a time", async function () {
      const { satori, rewards } = await deploySatoriFixture();
      const rewardsSigner = await asRewards(satori, rewards);
      const RATE = await satori.emissionRateNow();
      const BPS = await satori.devFeeBps();
      const genCap = (e) => (RATE * e * (10000n - BPS)) / 10000n;
      const initial = await satori.INITIAL_MINT();
      const recipient = (await ethers.getSigners())[7].address;

      const deployRound = await satori.deploymentRound();
      const curRound = await satori.getCurrentRound();
      expect(curRound).to.equal(deployRound); // fixture deploys within deploy round

      // On the deploy round the general lane's genesis share IS its cap: zero
      // headroom — an exact boundary, even 1 wei reverts at e == 1.
      expect(await satori.onChainMinted()).to.equal(genCap(1n));
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

      // Roll one round forward: exactly that round's share of headroom appears.
      await time.increase(ROUND);
      await satori.connect(rewardsSigner).rewardMint(recipient, genCap(2n) - genCap(1n));
      expect(await satori.totalRewardsMinted()).to.equal(initial + genCap(2n) - genCap(1n));

      // And again for the round after.
      await time.increase(ROUND);
      await satori.connect(rewardsSigner).rewardMint(recipient, genCap(3n) - genCap(2n));
      expect(await satori.totalRewardsMinted()).to.equal(initial + genCap(3n) - genCap(1n));
    });
  });

  // ---------------------------------------------------------------------
  // burn fees are flat — MED
  // ---------------------------------------------------------------------
  describe("flat burn fees", function () {
    it("streamBurn / gameBurn / bountyBurn are fixed and do not change with round", async function () {
      const { satori } = await deploySatoriFixture();
      expect(await satori.streamBurn()).to.equal(ethers.parseEther("0.001"));
      expect(await satori.gameBurn()).to.equal(ethers.parseEther("0.1"));
      expect(await satori.bountyBurn()).to.equal(ethers.parseEther("0.1"));
      for (const _ of [1, 2, 5, 10]) {
        await time.increase(ROUND);
        expect(await satori.streamBurn()).to.equal(ethers.parseEther("0.001"));
        expect(await satori.gameBurn()).to.equal(ethers.parseEther("0.1"));
      }
    });
  });

  // ---------------------------------------------------------------------
  // Lock cannot be bypassed via transferFrom — MED
  // ---------------------------------------------------------------------
  describe("locked balance cannot be drained via transferFrom", function () {
    this.timeout(120000);

    async function setupPredictableStream() {
      const ctx = await deploySatoriFixture();
      const { satori, rewards, registry, owner, signers } = ctx;
      const [, alice, , spender] = signers;

      // Eligibility no longer depends on a vote SHARE against other games — any
      // game with burnt weight earns — so the two dummy streams that used to
      // dilute the old threshold are gone. One stream, one burn.
      const tx1 = await satori.createSimpleDataStream("S1", owner.address);
      const stream1 = await getStreamIdFromTx(tx1, satori);

      const INITIAL_MINT = await satori.INITIAL_MINT();
      const UNIT = INITIAL_MINT / 20n;
      await satori.transfer(alice.address, UNIT * 6n);

      await voteFor(satori, alice, stream1); // burns 10 of alice's 216

      await registry.setValue(stream1, 100);
      return { ...ctx, alice, spender, stream1 };
    }

    it("an approved spender cannot move a locked owner's tokens; succeeds after lock expiry", async function () {
      const { satori, alice, spender, stream1 } = await setupPredictableStream();

      const dayD = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
      ]);
      expect(await satori.lockedUntil(alice.address)).to.equal(dayD + 1n);

      // alice approves spender for her whole balance
      const bal = await satori.balanceOf(alice.address);
      await satori.connect(alice).approve(spender.address, bal);

      // advance to the lock-EXPIRY round (D+1) — still locked for transfers (>=)
      await time.increase(ROUND);
      expect(await satori.getCurrentRound()).to.equal(dayD + 1n);

      // The lock is on `from` (the owner), not msg.sender. transferFrom must revert.
      await expect(
        satori.connect(spender).transferFrom(alice.address, spender.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(satori, "Locked");

      // advance one more round (D+2): lock fully expired, transferFrom now works
      await time.increase(ROUND);
      await expect(
        satori.connect(spender).transferFrom(alice.address, spender.address, ethers.parseEther("1"))
      ).to.not.be.reverted;
    });
  });

  // ---------------------------------------------------------------------
  // Permanent delegation lock releases on undelegate — MED
  // ---------------------------------------------------------------------
  describe("permanent delegation lock releases on undelegate (no permanent freeze)", function () {
    this.timeout(120000);

    it("delegate sets LOCKED_UNTIL_UNDELEGATION and blocks transfer; undelegate downgrades to next-round lock", async function () {
      const { satori, token, signers } = await deploySatoriFixture();
      const [owner, alice, bob] = signers;

      // fund alice and bob (delegate)
      const INITIAL_MINT = await satori.INITIAL_MINT();
      const UNIT = INITIAL_MINT / 20n;
      await satori.transfer(alice.address, UNIT * 4n);
      await satori.transfer(bob.address, UNIT * 2n);

      const SENTINEL = await token.LOCK_INDEFINITE();

      // Delegate prediction power to bob -> permanent lock on alice.
      await satori.connect(alice).delegatePredictionPower(bob.address);
      expect(await satori.lockedUntil(alice.address)).to.equal(SENTINEL);

      // Transfer must be blocked while permanently locked.
      await expect(
        satori.connect(alice).transfer(owner.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(satori, "Locked");

      // Undelegate -> downgrade to currentRound+1 (lockUntilNextRound), NOT
      // left frozen forever. Per the lock semantics (erc20.md lines 66-70,
      // 168-174): a value R means "locked through round R inclusive; free on
      // round R+1", and the transfer gate uses `>=`. So a lock value of
      // r+1 means transfers are blocked on rounds r and r+1 and free on r+2.
      // The key invariant under test is that the PERMANENT sentinel is
      // downgraded to a finite, self-expiring lock — no funds-frozen-forever.
      const r = await satori.getCurrentRound();
      await satori.connect(alice).delegatePredictionPower(ethers.ZeroAddress);
      expect(await satori.lockedUntil(alice.address)).to.equal(r + 1n);
      // definitively no longer the permanent sentinel
      expect(await satori.lockedUntil(alice.address)).to.not.equal(SENTINEL);

      // Still locked on the undelegation round itself (r+1 >= r) ...
      await expect(
        satori.connect(alice).transfer(owner.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(satori, "Locked");

      // ... still locked on round r+1 (the lock-expiry round itself, >= check) ...
      await time.increase(ROUND);
      expect(await satori.getCurrentRound()).to.equal(r + 1n);
      await expect(
        satori.connect(alice).transfer(owner.address, ethers.parseEther("1"))
      ).to.be.revertedWithCustomError(satori, "Locked");

      // ... and FREE on round r+2: the lock self-expires, proving the
      // permanent delegation lock cannot strand the delegator's funds.
      await time.increase(ROUND);
      expect(await satori.getCurrentRound()).to.equal(r + 2n);
      await expect(
        satori.connect(alice).transfer(owner.address, ethers.parseEther("1"))
      ).to.not.be.reverted;
    });
  });

  // ---------------------------------------------------------------------
  // Spam-fee creation paths blocked while sender is locked — LOW
  // ---------------------------------------------------------------------
  describe("spam-fee creation paths blocked while sender is locked", function () {
    this.timeout(120000);

    it("registerCommunityAdapter reverts Locked while sender locked, succeeds after expiry", async function () {
      const { satori, registry, signers, customAdapter } = await deploySatoriFixture();
      const [owner, alice] = signers;

      // build an eligible stream so alice can predict and become locked. Under
      // burn voting a single burn makes the game eligible outright — the old
      // dummy streams existed only to satisfy a vote-SHARE threshold that no
      // longer exists.
      const tx1 = await satori.createSimpleDataStream("S1", owner.address);
      const stream1 = await getStreamIdFromTx(tx1, satori);

      const INITIAL_MINT = await satori.INITIAL_MINT();
      const UNIT = INITIAL_MINT / 20n;
      await satori.transfer(alice.address, UNIT * 6n);
      await voteFor(satori, alice, stream1); // burns 10 of alice's 216
      await registry.setValue(stream1, 100);

      const dayD = await satori.getCurrentRound();
      await satori.connect(alice).predictMultipleWithPayloads([
        { gameId: stream1, payload: pack1(UP) },
      ]);
      expect(await satori.lockedUntil(alice.address)).to.equal(dayD + 1n);

      // alice has balance to pay the fee, but the fee _transfer hits _update's
      // lock gate on from==alice. Advance to the lock-expiry round (still >=).
      await time.increase(ROUND);
      expect(await satori.getCurrentRound()).to.equal(dayD + 1n);

      // A fresh impl address to register (must be a contract implementing the iface;
      // reuse the deployed customAdapter address, name is informational).
      const implAddr = await customAdapter.getAddress();
      await expect(
        satori.connect(alice).registerCommunityAdapter(implAddr, "by-alice")
      ).to.be.revertedWithCustomError(satori, "Locked");

      // After one more round the lock expired; the same call now succeeds.
      await time.increase(ROUND);
      await expect(
        satori.connect(alice).registerCommunityAdapter(implAddr, "by-alice-2")
      ).to.not.be.reverted;
    });
  });
});
