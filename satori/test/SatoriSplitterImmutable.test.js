const { expect } = require("chai");
const { ethers } = require("hardhat");

const ETH = ethers.ZeroAddress;
const E = (n) => ethers.parseEther(String(n));

// B is the immutable splitter: 60 / 30 / 10. Threshold 0 => the 90% default.
async function deploy(threshold = 0, shares = [6000, 3000, 1000]) {
  const [owner, manager, authority, r1, r2, r3, other, stranger] = await ethers.getSigners();

  const ERC = await ethers.getContractFactory("MockERC20");
  const token = await ERC.deploy("Tok", "TOK");

  const Immutable = await ethers.getContractFactory("SatoriSplitterImmutable");
  const b = await Immutable.deploy(
    authority.address,
    [r1.address, r2.address, r3.address],
    shares,
    threshold
  );

  return { b, token, owner, manager, authority, r1, r2, r3, other, stranger };
}

// A is the parent, and it is a SatoriSplitterImmutable too — the shape we
// actually deploy. Its payees are fixed at construction (B at 60%, `other` at
// 40%, totalling 10000) and it carries NO authority, matching the production top
// splitter: nothing sits above A, so a right to rotate its own slot upward would
// be meaningless. B can still rotate its slot IN A, which is what these tests
// exercise — an immutable parent still exposes `rotateRecipient`.
async function deployTree(threshold = 0, shares = [6000, 3000, 1000]) {
  const base = await deploy(threshold, shares);
  const Immutable = await ethers.getContractFactory("SatoriSplitterImmutable");
  const a = await Immutable.deploy(
    ethers.ZeroAddress,
    [await base.b.getAddress(), base.other.address],
    [6000, 4000],
    0
  );
  return { ...base, a };
}

describe("SatoriSplitterImmutable", function () {
  describe("construction", function () {
    it("emits every slot and the resolved settings, so the node rebuilds from its deploy logs", async function () {
      const { b, authority, r1, r2, r3 } = await deploy(0, [6000, 3000, 1000]);
      const rc = await b.deploymentTransaction().wait();
      const parsed = rc.logs.map((l) => b.interface.parseLog(l)).filter(Boolean);
      const slots = parsed.filter((p) => p.name === "SlotCreated").map((p) => [Number(p.args.slotId), p.args.payee, Number(p.args.shares)]);
      expect(slots).to.deep.equal([[0, r1.address, 6000], [1, r2.address, 3000], [2, r3.address, 1000]]);
      const created = parsed.filter((p) => p.name === "SplitterCreated");
      expect(created.length).to.equal(1);
      expect(created[0].args.authority).to.equal(authority.address);
      expect(created[0].args.slotCount).to.equal(3n);
      expect(created[0].args.rotationThresholdBps).to.equal(await b.rotationThresholdBps()); // 0 resolved to the default
    });

    it("SplitterCreated records an absent authority, which AuthorityTransferred never does", async function () {
      const { a } = await deployTree();
      const parsed = (await a.deploymentTransaction().wait()).logs.map((l) => a.interface.parseLog(l)).filter(Boolean);
      expect(parsed.find((p) => p.name === "SplitterCreated").args.authority).to.equal(ethers.ZeroAddress);
      expect(parsed.some((p) => p.name === "AuthorityTransferred")).to.equal(false);
    });

    it("rejects a share total that is not exactly 100%", async function () {
      const [, , auth, r1, r2] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      await expect(F.deploy(auth.address, [r1.address, r2.address], [6000, 3000], 0))
        .to.be.revertedWithCustomError(F, "SharesMustTotal100Percent");
      await expect(F.deploy(auth.address, [r1.address, r2.address], [6000, 5000], 0))
        .to.be.revertedWithCustomError(F, "SharesMustTotal100Percent");
    });

    it("rejects duplicates, zero addresses, zero shares and length mismatch", async function () {
      const [, , auth, r1, r2] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      await expect(F.deploy(auth.address, [r1.address, r1.address], [5000, 5000], 0))
        .to.be.revertedWithCustomError(F, "AlreadyRecipient");
      await expect(F.deploy(auth.address, [r1.address, ethers.ZeroAddress], [5000, 5000], 0))
        .to.be.revertedWithCustomError(F, "ZeroAddress");
      await expect(F.deploy(auth.address, [r1.address, r2.address], [10000, 0], 0))
        .to.be.revertedWithCustomError(F, "ZeroShares");
      await expect(F.deploy(auth.address, [r1.address, r2.address], [10000], 0))
        .to.be.revertedWithCustomError(F, "LengthMismatch");
    });

    it("exposes no way to change shares at all", async function () {
      const { b } = await deploy();
      for (const fn of ["setShares", "addRecipient", "removeRecipient", "lockSlot", "trackToken", "distribute"]) {
        expect(b.interface.fragments.some((f) => f.name === fn), `${fn} should not exist`).to.equal(false);
      }
    });
  });

  describe("configurable rotation threshold", function () {
    it("0 selects the 90% default", async function () {
      const { b } = await deploy(0);
      expect(await b.rotationThresholdBps()).to.equal(9000);
      expect(await b.DEFAULT_ROTATION_THRESHOLD_BPS()).to.equal(9000);
    });

    it("stores an explicit threshold and cannot be changed afterwards", async function () {
      const { b } = await deploy(6100);
      expect(await b.rotationThresholdBps()).to.equal(6100);
      expect(b.interface.fragments.some((f) => f.name === "setRotationThreshold")).to.equal(false);
    });

    it("accepts any threshold up to 100%, including minority ones", async function () {
      const [, , auth, r1, r2] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      const mk = (t) => F.deploy(auth.address, [r1.address, r2.address], [5000, 5000], t);

      for (const ok of [1, 100, 2500, 5000, 5001, 6100, 10000]) {
        expect(await (await mk(ok)).rotationThresholdBps(), `${ok} should be accepted`).to.equal(ok);
      }
    });

    it("rejects only an unreachable threshold above 100%", async function () {
      const [, , auth, r1, r2] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      const mk = (t) => F.deploy(auth.address, [r1.address, r2.address], [5000, 5000], t);

      for (const bad of [10001, 20000]) {
        await expect(mk(bad), `${bad} should be rejected`)
          .to.be.revertedWithCustomError(F, "ThresholdOutOfRange");
      }
    });

    it("a minority threshold really does let a minority act alone", async function () {
      const { a, b, authority, r3, stranger } = await deployTree(1000);
      const aAddr = await a.getAddress();
      await b.connect(authority).renounceAuthority();

      await b.connect(r3).approveRotation(aAddr, stranger.address);   // 1000 = 10%
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(true);
      await b.connect(stranger).rotateAt(aAddr, stranger.address);
      expect((await a.getSlot(0)).payee).to.equal(stranger.address);
    });

    it("at 61%: 60% is not enough, 70% executes", async function () {
      const { a, b, authority, r1, r3, stranger } = await deployTree(6100);
      const aAddr = await a.getAddress();
      await b.connect(authority).renounceAuthority();

      await b.connect(r1).approveRotation(aAddr, stranger.address);   // 6000 = 60%
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(false);
      await expect(b.connect(stranger).rotateAt(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "InsufficientConsent");

      await b.connect(r3).approveRotation(aAddr, stranger.address);   // +1000 = 70%
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(true);
      await b.connect(stranger).rotateAt(aAddr, stranger.address);
      expect((await a.getSlot(0)).payee).to.equal(stranger.address);
    });

    it("at 61%: a single 61% holder clears it exactly, alone", async function () {
      const { a, b, authority, r1, stranger } = await deployTree(6100, [6100, 2900, 1000]);
      const aAddr = await a.getAddress();
      await b.connect(authority).renounceAuthority();

      await b.connect(r1).approveRotation(aAddr, stranger.address);   // exactly 6100
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(true);
      await b.connect(stranger).rotateAt(aAddr, stranger.address);
      expect((await a.getSlot(0)).payee).to.equal(stranger.address);
    });

    it("at 100%: unanimity is permitted and genuinely requires everyone", async function () {
      const { a, b, authority, r1, r2, r3, stranger } = await deployTree(10000);
      const aAddr = await a.getAddress();
      await b.connect(authority).renounceAuthority();

      await b.connect(r1).approveRotation(aAddr, stranger.address);
      await b.connect(r2).approveRotation(aAddr, stranger.address);   // 90%
      await expect(b.connect(stranger).rotateAt(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "InsufficientConsent");

      await b.connect(r3).approveRotation(aAddr, stranger.address);   // 100%
      await b.connect(stranger).rotateAt(aAddr, stranger.address);
      expect((await a.getSlot(0)).payee).to.equal(stranger.address);
    });
  });

  describe("splitting — no poke, no registry", function () {
    it("splits ETH by share with no distribute call and no token registration", async function () {
      const { b, r1, r2, r3, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      expect(await b.releasable(ETH, 0)).to.equal(E(6));
      expect(await b.releasable(ETH, 1)).to.equal(E(3));
      expect(await b.releasable(ETH, 2)).to.equal(E(1));

      for (const [i, r] of [[0, r1], [1, r2], [2, r3]]) {
        const before = await ethers.provider.getBalance(r.address);
        await b.connect(stranger).withdraw(ETH, i); // anyone may trigger
        expect(await ethers.provider.getBalance(r.address) - before).to.equal([E(6), E(3), E(1)][i]);
      }
      expect(await ethers.provider.getBalance(await b.getAddress())).to.equal(0n);
    });

    it("splits an ERC20 that was never registered anywhere", async function () {
      const { b, token, r1 } = await deploy();
      const addr = await token.getAddress();
      await token.mint(await b.getAddress(), 1000n);

      expect(await b.releasable(addr, 0)).to.equal(600n);
      await b.connect(r1).withdrawMine(addr);
      expect(await token.balanceOf(r1.address)).to.equal(600n);
    });

    it("handles repeated arrivals and partial withdrawals correctly", async function () {
      const { b, r1, r2, stranger } = await deploy();
      const addr = await b.getAddress();

      await stranger.sendTransaction({ to: addr, value: E(10) });
      await b.connect(r1).withdrawMine(ETH);              // r1 takes 6
      await stranger.sendTransaction({ to: addr, value: E(20) });

      expect(await b.releasable(ETH, 0)).to.equal(E(12));  // 60% of 30, minus 6
      expect(await b.releasable(ETH, 1)).to.equal(E(9));   // 30% of 30
      expect(await b.totalReceived(ETH)).to.equal(E(30));
    });

    it("is solvent and dust-bounded across many uneven arrivals", async function () {
      const { b, token, stranger } = await deploy();
      const addr = await token.getAddress();
      const bAddr = await b.getAddress();

      for (let i = 0; i < 25; i++) await token.mint(bAddr, 7n); // 175 total, never divides evenly
      let owed = 0n;
      for (let i = 0; i < 3; i++) owed += await b.releasable(addr, i);

      expect(owed).to.be.lte(await token.balanceOf(bAddr));       // solvent
      expect(175n - owed).to.be.lt(3n);                           // dust < slotCount, total, forever
      await b.connect(stranger).withdraw(addr, 0);
      await b.connect(stranger).withdraw(addr, 1);
      await b.connect(stranger).withdraw(addr, 2);
      expect(await token.balanceOf(bAddr)).to.be.lt(3n);
    });

    it("reverts on nothing to withdraw and unknown slots", async function () {
      const { b, r1, stranger } = await deploy();
      await expect(b.connect(r1).withdrawMine(ETH)).to.be.revertedWithCustomError(b, "NothingToWithdraw");
      await expect(b.connect(stranger).withdraw(ETH, 9)).to.be.revertedWithCustomError(b, "UnknownSlot");
      await expect(b.connect(stranger).withdrawMine(ETH)).to.be.revertedWithCustomError(b, "NotARecipient");
    });
  });

  // A slot chooses WHO MAY TRIGGER its payout. It never chooses where the money
  // goes — that is always the slot's payee, on every path.
  describe("withdraw gate (who may trigger)", function () {
    it("defaults open: any stranger may still trigger any slot", async function () {
      const { b, r1, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      expect(await b.withdrawCaller(0)).to.equal(ethers.ZeroAddress);
      const before = await ethers.provider.getBalance(r1.address);
      await b.connect(stranger).withdraw(ETH, 0);
      expect(await ethers.provider.getBalance(r1.address) - before).to.equal(E(6));
    });

    it("a gated slot refuses everyone but its chosen caller", async function () {
      const { b, r1, r2, other, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      await expect(b.connect(r1).setWithdrawCaller(other.address))
        .to.emit(b, "WithdrawCallerSet").withArgs(0, other.address);
      expect(await b.withdrawCaller(0)).to.equal(other.address);

      for (const who of [stranger, r2]) {
        await expect(b.connect(who).withdraw(ETH, 0))
          .to.be.revertedWithCustomError(b, "NotWithdrawCaller");
      }

      const before = await ethers.provider.getBalance(r1.address);
      await b.connect(other).withdraw(ETH, 0);
      expect(await ethers.provider.getBalance(r1.address) - before).to.equal(E(6));

      await b.connect(stranger).withdraw(ETH, 1);   // no other slot was gated
    });

    it("the payee may always trigger its own slot, whatever the gate says", async function () {
      const { b, r1, other, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      await b.connect(r1).setWithdrawCaller(other.address);  // delegated elsewhere
      await b.connect(r1).withdrawMine(ETH);                 // and still works
      expect(await b.claimed(ETH, 0)).to.equal(E(6));
    });

    it("setting the gate back to zero reopens the slot", async function () {
      const { b, r1, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      await b.connect(r1).setWithdrawCaller(r1.address);
      await expect(b.connect(stranger).withdraw(ETH, 0))
        .to.be.revertedWithCustomError(b, "NotWithdrawCaller");

      await expect(b.connect(r1).setWithdrawCaller(ethers.ZeroAddress))
        .to.emit(b, "WithdrawCallerSet").withArgs(0, ethers.ZeroAddress);
      await b.connect(stranger).withdraw(ETH, 0);
      expect(await b.claimed(ETH, 0)).to.equal(E(6));
    });

    it("only the payee may set its own gate", async function () {
      const { b, authority, r2, stranger } = await deploy();
      for (const who of [stranger, authority]) {
        await expect(b.connect(who).setWithdrawCaller(who.address))
          .to.be.revertedWithCustomError(b, "NotARecipient");
      }

      // A recipient only ever writes its OWN slot; r2 cannot reach slot 0.
      await b.connect(r2).setWithdrawCaller(stranger.address);
      expect(await b.withdrawCaller(0)).to.equal(ethers.ZeroAddress);
      expect(await b.withdrawCaller(1)).to.equal(stranger.address);
    });

    it("the gate never changes where the money goes", async function () {
      const { b, r1, other, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });
      await b.connect(r1).setWithdrawCaller(other.address);

      const callerBefore = await ethers.provider.getBalance(other.address);
      const payeeBefore = await ethers.provider.getBalance(r1.address);
      const rc = await (await b.connect(other).withdraw(ETH, 0)).wait();

      expect(await ethers.provider.getBalance(r1.address) - payeeBefore).to.equal(E(6));
      expect(await ethers.provider.getBalance(other.address))
        .to.equal(callerBefore - rc.gasUsed * rc.gasPrice);   // paid gas, received nothing
    });

    it("rotating the payee clears the gate", async function () {
      const { b, r1, other, stranger } = await deploy();
      await b.connect(r1).setWithdrawCaller(r1.address);

      await expect(b.connect(r1).rotateRecipient(other.address))
        .to.emit(b, "WithdrawCallerSet").withArgs(0, ethers.ZeroAddress);
      expect(await b.withdrawCaller(0)).to.equal(ethers.ZeroAddress);

      const before = await ethers.provider.getBalance(other.address);
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });
      await b.connect(stranger).withdraw(ETH, 0);   // open again for the new holder
      expect(await ethers.provider.getBalance(other.address) - before).to.equal(E(6));
    });

    it("a splitter payee cannot be gated, so a tree keeps flowing", async function () {
      const { a, b, stranger } = await deployTree();

      // A's slot 0 is the B CONTRACT, and a splitter has no generic outbound
      // call — nothing on it takes calldata — so B can neither set a gate nor
      // trigger a withdraw. The internal hop is permissionless by construction.
      const generic = b.interface.fragments.some(
        (f) => f.type === "function" && f.inputs.some((i) => i.type === "bytes")
      );
      expect(generic, "a splitter has no generic outbound call").to.equal(false);
      expect(await a.withdrawCaller(0)).to.equal(ethers.ZeroAddress);

      await stranger.sendTransaction({ to: await a.getAddress(), value: E(100) });
      await a.connect(stranger).withdraw(ETH, 0);
      expect(await ethers.provider.getBalance(await b.getAddress())).to.equal(E(60));
    });
  });

  describe("payee rotation (own slot)", function () {
    it("a payee may rotate its own address even with no authority", async function () {
      const { b, authority, r1, stranger } = await deploy();
      await b.connect(authority).renounceAuthority();
      await expect(b.connect(r1).rotateRecipient(stranger.address))
        .to.emit(b, "RecipientRotated").withArgs(0, r1.address, stranger.address);
      expect(await b.slotOf(stranger.address)).to.equal(0);
    });

    it("the claimed history follows the slot, not the address", async function () {
      const { b, r1, stranger, other } = await deploy();
      await other.sendTransaction({ to: await b.getAddress(), value: E(10) });
      await b.connect(r1).withdrawMine(ETH);                 // 6 paid against slot 0
      await b.connect(r1).rotateRecipient(stranger.address);
      expect(await b.releasable(ETH, 0)).to.equal(0n);       // new payee inherits, cannot re-claim
    });
  });

  describe("rotateAt — moving our slot in a parent", function () {
    it("the authority may rotate the parent's slot unilaterally", async function () {
      const { a, b, authority, stranger } = await deployTree();
      expect((await a.getSlot(0)).payee).to.equal(await b.getAddress());

      await expect(b.connect(authority).rotateAt(await a.getAddress(), stranger.address))
        .to.emit(b, "RotatedAt");
      expect((await a.getSlot(0)).payee).to.equal(stranger.address);
    });

    it("a non-authority cannot, and 60% consent is not enough", async function () {
      const { a, b, r1, stranger } = await deployTree();
      const aAddr = await a.getAddress();

      await expect(b.connect(stranger).rotateAt(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "InsufficientConsent");

      await b.connect(r1).approveRotation(aAddr, stranger.address);   // 6000 = 60%
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(false);
      await expect(b.connect(stranger).rotateAt(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "InsufficientConsent");
    });

    it("exactly 90% executes, and works after the authority is renounced", async function () {
      const { a, b, authority, r1, r2, r3, stranger } = await deployTree();
      const aAddr = await a.getAddress();
      await b.connect(authority).renounceAuthority();

      await b.connect(r1).approveRotation(aAddr, stranger.address);   // 6000
      await b.connect(r2).approveRotation(aAddr, stranger.address);   // +3000 = 90%
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(true);

      // r3 (10%, the "lost key") never votes, and it does not matter.
      expect(await b.connect(stranger).rotateAt(aAddr, stranger.address)).to.be.ok;
      expect((await a.getSlot(0)).payee).to.equal(stranger.address);
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(false); // epoch consumed
    });

    it("approvals are per-target and revocable", async function () {
      const { a, b, r1, r2, stranger, other } = await deployTree();
      const aAddr = await a.getAddress();

      await b.connect(r1).approveRotation(aAddr, stranger.address);
      await b.connect(r2).approveRotation(aAddr, stranger.address);
      expect(await b.rotationApproved(aAddr, other.address)).to.equal(false); // different target

      await b.connect(r2).revokeRotation(aAddr, stranger.address);
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(false);
      await expect(b.connect(r2).revokeRotation(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "NotApproved");
      await expect(b.connect(r1).approveRotation(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "AlreadyApproved");
      await expect(b.connect(stranger).approveRotation(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "NotARecipient");
    });

    it("a renounced authority is gone forever", async function () {
      const { a, b, authority, stranger } = await deployTree();
      await b.connect(authority).renounceAuthority();
      await expect(b.connect(authority).rotateAt(await a.getAddress(), stranger.address))
        .to.be.revertedWithCustomError(b, "InsufficientConsent");
      await expect(b.connect(authority).transferAuthority(stranger.address))
        .to.be.revertedWithCustomError(b, "NotAuthority");
    });

    it("rotating away does not touch funds already held", async function () {
      const { a, b, authority, r1, stranger, other } = await deployTree();
      await other.sendTransaction({ to: await b.getAddress(), value: E(10) });
      await b.connect(authority).rotateAt(await a.getAddress(), stranger.address);

      expect(await b.releasable(ETH, 0)).to.equal(E(6));  // still owed under the old shares
      await b.connect(r1).withdrawMine(ETH);
    });
  });

  describe("end-to-end through an immutable parent", function () {
    it("fee flows A -> B -> leaves at the composed percentages", async function () {
      const { a, b, r1, r2, r3, stranger } = await deployTree();
      await stranger.sendTransaction({ to: await a.getAddress(), value: E(100) });

      // No distribute() to call: entitlement is derived from the balance at
      // withdrawal time, so withdraw alone settles. That is the simplification
      // the immutable design buys — there is no "arrived vs bucketed" split.
      await a.connect(stranger).withdraw(ETH, 0);          // A pays B its 60
      expect(await ethers.provider.getBalance(await b.getAddress())).to.equal(E(60));

      // B's 60/30/10 of A's 60% => 36 / 18 / 6 of the original 100.
      expect(await b.releasable(ETH, 0)).to.equal(E(36));
      expect(await b.releasable(ETH, 1)).to.equal(E(18));
      expect(await b.releasable(ETH, 2)).to.equal(E(6));

      for (const [i, r] of [[0, r1], [1, r2], [2, r3]]) {
        const before = await ethers.provider.getBalance(r.address);
        await b.connect(stranger).withdraw(ETH, i);
        expect(await ethers.provider.getBalance(r.address) - before).to.equal([E(36), E(18), E(6)][i]);
      }
    });
  });

  // The rotation TALLY is the whole consent mechanism: it decides whether a
  // slot's payees can redirect their branch's income without the authority.
  // It is kept INCREMENTALLY (no loop over recipients), so the only public
  // evidence that the running total is right is the number carried in these
  // two events. Nothing asserted them until 2026-08-21 — the behaviour was
  // covered, the emissions were not, in the contract that permanently receives
  // every platform fee.
  describe("rotation consent events (the tally is only observable here)", function () {
    it("RotationApproved carries the proposal, the slot, the target and the RUNNING tally", async function () {
      const { b, a, r1, r2, other } = await deployTree();
      const aAddr = await a.getAddress();
      const id = await b.proposalId(aAddr, other.address);

      // r1 holds 6000 bps. First approval => tally is exactly r1's shares.
      await expect(b.connect(r1).approveRotation(aAddr, other.address))
        .to.emit(b, "RotationApproved")
        .withArgs(id, 0, aAddr, other.address, 6000);

      // r2 holds 3000. The tally is cumulative, not per-caller.
      await expect(b.connect(r2).approveRotation(aAddr, other.address))
        .to.emit(b, "RotationApproved")
        .withArgs(id, 1, aAddr, other.address, 9000);

      expect(await b.approvedShares(id)).to.equal(9000);
    });

    it("RotationRevoked reports the tally AFTER the withdrawal, not before", async function () {
      const { b, a, r1, r2, other } = await deployTree();
      const aAddr = await a.getAddress();
      const id = await b.proposalId(aAddr, other.address);

      await b.connect(r1).approveRotation(aAddr, other.address); // 6000
      await b.connect(r2).approveRotation(aAddr, other.address); // 9000

      // r1 withdraws: 9000 - 6000 = 3000. An event reporting the PRE value
      // would read 9000 and hide a live approval going away.
      await expect(b.connect(r1).revokeRotation(aAddr, other.address))
        .to.emit(b, "RotationRevoked")
        .withArgs(id, 0, 3000);

      expect(await b.approvedShares(id)).to.equal(3000);
    });

    it("an executed rotation consumes its approvals — the next proposal id is different", async function () {
      const { b, a, r1, r2, other, stranger } = await deployTree();
      const aAddr = await a.getAddress();
      const idBefore = await b.proposalId(aAddr, stranger.address);

      await b.connect(r1).approveRotation(aAddr, stranger.address); // 6000
      await b.connect(r2).approveRotation(aAddr, stranger.address); // 9000 >= 90%
      await b.connect(stranger).rotateAt(aAddr, stranger.address);

      // The parent's rotation epoch advanced, so the SAME (parent, payee) pair
      // now hashes to a new id whose tally starts at zero. This is what stops
      // a spent approval from being replayed.
      const idAfter = await b.proposalId(aAddr, stranger.address);
      expect(idAfter).to.not.equal(idBefore);
      expect(await b.approvedShares(idAfter)).to.equal(0);
    });

    it("re-approving the same proposal reverts rather than double-counting the tally", async function () {
      const { b, a, r1, other } = await deployTree();
      const aAddr = await a.getAddress();
      await b.connect(r1).approveRotation(aAddr, other.address);
      await expect(b.connect(r1).approveRotation(aAddr, other.address))
        .to.be.revertedWithCustomError(b, "AlreadyApproved");
      expect(await b.approvedShares(await b.proposalId(aAddr, other.address))).to.equal(6000);
    });

    it("revoking without an approval reverts rather than underflowing the tally", async function () {
      const { b, a, r1, other } = await deployTree();
      const aAddr = await a.getAddress();
      await expect(b.connect(r1).revokeRotation(aAddr, other.address))
        .to.be.revertedWithCustomError(b, "NotApproved");
    });

    it("a non-payee cannot approve at all", async function () {
      const { b, a, stranger, other } = await deployTree();
      await expect(b.connect(stranger).approveRotation(await a.getAddress(), other.address))
        .to.be.reverted;
    });
  });

  // Constructed with no payees at all. Reachable only at deploy, and the
  // splitter is immutable, so a tree built this way could never be repaired.
  describe("construction: NoRecipients", function () {
    it("rejects an empty payee set", async function () {
      const [, , auth] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      await expect(F.deploy(auth.address, [], [], 0))
        .to.be.revertedWithCustomError(F, "NoRecipients");
    });
  });
});
