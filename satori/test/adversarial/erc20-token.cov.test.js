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

// What the schedule backstop lets Rewards still report: the priced rounds'
// allowance less the general already reported to the on-chain lane.
async function allowanceRoom(hub, token) {
  return (await hub.onChainAllowance())
    - ((await token.generalAccrued()) - (await hub.merkleReserveCumulative()));
}

// One round's on-chain gross from the schedule itself (no dial in this
// fixture): the rate net of the senior dev fee. Recomputed here so the hub's
// own pricing is checked against it, not against itself.
async function scheduleGross(hub, token) {
  const rate = await hub.emissionRateNow();
  return rate - (rate * (await token.devFeeBps())) / 10000n;
}

describe("[adversarial-cov] erc20-token", function () {
  // ---------------------------------------------------------------------
  // rewardMint cap (BudgetExceeded) — HIGH
  // ---------------------------------------------------------------------
  describe("rewardMint cumulative cap (BudgetExceeded)", function () {
    it("reverts BudgetExceeded when reporting past the priced rounds or minting past the report, and both boundaries are exact", async function () {
      const { satori, hub, token, rewards } = await deploySatoriFixture();
      const rewardsSigner = await asRewards(satori, rewards);
      const initial = await satori.INITIAL_MINT();
      const recipient = (await ethers.getSigners())[5].address;

      // Pricing grows the report allowance by one gross per round priced; the
      // first boundary is at noteIssued, the second at the mint. Nothing prices the
      // deploy round at bootstrap any more (the default stream is a Sentiment stream
      // with no seed write), so the first freeze prices it together with this one.
      await time.increase(ROUND);
      const roomBefore = await allowanceRoom(hub, token);
      const pricedBefore = await hub.onChainPricedRound();
      await hub.connect(rewardsSigner).freezeRoundGross(await satori.getCurrentRound());
      const room = await allowanceRoom(hub, token);
      const newlyPriced = (await hub.onChainPricedRound()) - pricedBefore;
      expect(newlyPriced).to.equal(2n); // the deploy round and this one
      expect(room - roomBefore).to.equal(newlyPriced * (await scheduleGross(hub, token)));

      await expect(
        hub.connect(rewardsSigner).noteIssued(room + 1n)
      ).to.be.revertedWithCustomError(hub, "BudgetExceeded");
      await hub.connect(rewardsSigner).noteIssued(room);

      const mintedBefore = await satori.totalRewardsMinted();
      expect(mintedBefore).to.equal(initial); // still the genesis bootstrap

      // reported + 1 must revert (the `>` cap fires)
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, room + 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

      // exactly the report must pass (<= cap)
      await satori.connect(rewardsSigner).rewardMint(recipient, room);
      expect(await satori.totalRewardsMinted()).to.equal(initial + room);

      // Now fully saturated again: even 1 wei more reverts, at either step.
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
      await expect(
        hub.connect(rewardsSigner).noteIssued(1n)
      ).to.be.revertedWithCustomError(hub, "BudgetExceeded");
    });
  });

  // ---------------------------------------------------------------------
  // rewardMint access gate (Unauthorized) — HIGH
  // ---------------------------------------------------------------------
  describe("rewardMint access control (Unauthorized)", function () {
    it("rejects every caller other than address(satoriRewards) and never changes supply", async function () {
      const { satori, hub, lens, rewards, voting, owner, signers } = await deploySatoriFixture();
      const attacker = signers[6];

      // Report real room so the budget is NOT the limiting factor (proves it
      // is the access gate, not the budget, that reverts).
      const rewardsSigner = await asRewards(satori, rewards);
      await time.increase(ROUND);
      await hub.connect(rewardsSigner).freezeRoundGross(await satori.getCurrentRound());
      await hub.connect(rewardsSigner).noteIssued(ethers.parseEther("1"));
      expect(await lens.onChainRewardCeiling()).to.be.gt(await satori.onChainMinted());

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
  // Genesis leaves no mint room; the report allowance grows per priced round — MED
  // ---------------------------------------------------------------------
  describe("deploy-round saturation", function () {
    it("genesis leaves zero mint room, time opens none, and each priced round adds exactly one gross of report allowance", async function () {
      const { satori, hub, token, lens, rewards } = await deploySatoriFixture();
      const rewardsSigner = await asRewards(satori, rewards);
      const initial = await satori.INITIAL_MINT();
      const recipient = (await ethers.getSigners())[7].address;
      const GROSS = await scheduleGross(hub, token);
      const BPS = await token.devFeeBps();

      const deployRound = await satori.deploymentRound();
      const curRound = await satori.getCurrentRound();
      expect(curRound).to.equal(deployRound); // fixture deploys within deploy round

      // Genesis is reported and minted in full, so there is zero room: an exact
      // boundary, even 1 wei reverts. Genesis pays the deploy round; the first
      // touch prices it again later (the bootstrap overlap), not at bootstrap.
      const genesisGeneral = await token.generalAccrued();
      expect(genesisGeneral).to.equal((initial * (10000n - BPS)) / 10000n);
      expect(await satori.onChainMinted()).to.equal(genesisGeneral);
      expect(await hub.onChainAllowance()).to.equal(genesisGeneral);
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

      // Rolling the clock opens no mint room: it grows only with reports.
      await time.increase(ROUND);
      expect(await lens.onChainRewardCeiling()).to.equal(genesisGeneral);
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");

      // Price the round: exactly one gross more may be reported; a second
      // freeze of the same round adds nothing. Report and mint all of it.
      let minted = initial;
      for (let i = 0; i < 2; i++) {
        if (i > 0) await time.increase(ROUND);
        const cur = await satori.getCurrentRound();
        const allowance0 = await hub.onChainAllowance();
        // The first freeze also prices the deploy round, which nothing priced yet.
        const priced = i === 0 ? 2n * GROSS : GROSS;
        await hub.connect(rewardsSigner).freezeRoundGross(cur);
        expect(await hub.onChainAllowance()).to.equal(allowance0 + priced);
        await hub.connect(rewardsSigner).freezeRoundGross(cur);
        expect(await hub.onChainAllowance()).to.equal(allowance0 + priced);

        const room = await allowanceRoom(hub, token);
        await hub.connect(rewardsSigner).noteIssued(room);
        await satori.connect(rewardsSigner).rewardMint(recipient, room);
        minted += room;
        expect(await satori.totalRewardsMinted()).to.equal(minted);
      }
      // Two priced rounds plus the deploy round's overlap, no more.
      expect(minted).to.equal(initial + 3n * GROSS);
      await expect(
        satori.connect(rewardsSigner).rewardMint(recipient, 1n)
      ).to.be.revertedWithCustomError(satori, "BudgetExceeded");
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
