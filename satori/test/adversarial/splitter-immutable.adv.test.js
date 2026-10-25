const { expect } = require("chai");
const { ethers } = require("hardhat");

const ETH = ethers.ZeroAddress;
const E = (n) => ethers.parseEther(String(n));

async function deploy(threshold = 0, shares = [6000, 3000, 1000]) {
  const [owner, manager, authority, r1, r2, r3, other, stranger] = await ethers.getSigners();
  const Immutable = await ethers.getContractFactory("SatoriSplitterImmutable");
  const b = await Immutable.deploy(
    authority.address,
    [r1.address, r2.address, r3.address],
    shares,
    threshold
  );
  return { b, owner, manager, authority, r1, r2, r3, other, stranger };
}

// A is the parent, and it is a SatoriSplitterImmutable too — the shape actually
// deployed. Payees fixed at construction (B 60%, `other` 40%, summing to 10000)
// and NO authority, matching the production top splitter: nothing sits above A,
// so a right to rotate its own slot upward would be meaningless. B can still
// rotate its slot IN A — an immutable parent still exposes rotateRecipient.
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

// Σ of what every slot believes it can take, for a given token.
async function totalOwed(b, token) {
  const n = Number(await b.slotCount());
  let sum = 0n;
  for (let i = 0; i < n; i++) sum += await b.releasable(token, i);
  return sum;
}

describe("SatoriSplitterImmutable — adversarial", function () {
  // ================================================================== voting
  describe("vote tally cannot be inflated", function () {
    it("the same address cannot approve twice to double-count", async function () {
      const { a, b, r1 } = await deployTree();
      const aAddr = await a.getAddress();

      await b.connect(r1).approveRotation(aAddr, r1.address);
      const id = await b.proposalId(aAddr, r1.address);
      expect(await b.approvedShares(id)).to.equal(6000n);

      await expect(b.connect(r1).approveRotation(aAddr, r1.address))
        .to.be.revertedWithCustomError(b, "AlreadyApproved");
      expect(await b.approvedShares(id)).to.equal(6000n);
    });

    it("ATTACK: approve, rotate to a fresh address, approve again", async function () {
      // The vote is recorded against the SLOT, so moving the payee must not
      // hand the same shares a second vote.
      const { a, b, r1, stranger, other } = await deployTree();
      const aAddr = await a.getAddress();
      const id = await b.proposalId(aAddr, stranger.address);

      await b.connect(r1).approveRotation(aAddr, stranger.address);
      expect(await b.approvedShares(id)).to.equal(6000n);

      await b.connect(r1).rotateRecipient(other.address);
      await expect(b.connect(other).approveRotation(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "AlreadyApproved");

      expect(await b.approvedShares(id)).to.equal(6000n);       // still 60%
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(false);
      await expect(b.connect(stranger).rotateAt(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "InsufficientConsent");
    });

    it("ATTACK: rotate through many addresses, voting at each hop", async function () {
      const { a, b, r1, r2, r3, stranger, other, owner, manager } = await deployTree();
      const aAddr = await a.getAddress();
      const id = await b.proposalId(aAddr, stranger.address);
      const hops = [other, owner, manager, r2, r3].map((s) => s.address);

      await b.connect(r1).approveRotation(aAddr, stranger.address);
      let holder = r1;
      for (const hop of hops) {
        if (await b.isRecipient(hop)) continue;               // can't collide
        await b.connect(holder).rotateRecipient(hop);
        holder = await ethers.getSigner(hop);
        await expect(b.connect(holder).approveRotation(aAddr, stranger.address))
          .to.be.revertedWithCustomError(b, "AlreadyApproved");
      }
      expect(await b.approvedShares(id)).to.equal(6000n);
    });

    it("ATTACK: approve / revoke cycled many times cannot drift the tally", async function () {
      const { a, b, r1, r2 } = await deployTree();
      const aAddr = await a.getAddress();
      const id = await b.proposalId(aAddr, r1.address);

      for (let i = 0; i < 6; i++) {
        await b.connect(r1).approveRotation(aAddr, r1.address);
        await b.connect(r1).revokeRotation(aAddr, r1.address);
      }
      expect(await b.approvedShares(id)).to.equal(0n);

      await b.connect(r1).approveRotation(aAddr, r1.address);
      await b.connect(r2).approveRotation(aAddr, r1.address);
      expect(await b.approvedShares(id)).to.equal(9000n);      // exact, no drift
    });

    it("ATTACK: revoking without approving, and revoking twice", async function () {
      const { a, b, r1, r2 } = await deployTree();
      const aAddr = await a.getAddress();
      const id = await b.proposalId(aAddr, r1.address);

      await expect(b.connect(r1).revokeRotation(aAddr, r1.address))
        .to.be.revertedWithCustomError(b, "NotApproved");

      await b.connect(r1).approveRotation(aAddr, r1.address);
      await b.connect(r2).approveRotation(aAddr, r1.address);
      await b.connect(r1).revokeRotation(aAddr, r1.address);
      await expect(b.connect(r1).revokeRotation(aAddr, r1.address))
        .to.be.revertedWithCustomError(b, "NotApproved");
      expect(await b.approvedShares(id)).to.equal(3000n);      // no underflow, r2 intact
    });

    it("a non-recipient cannot vote, and neither can the authority or the parent", async function () {
      const { a, b, authority, stranger } = await deployTree();
      const aAddr = await a.getAddress();
      for (const who of [stranger, authority]) {
        await expect(b.connect(who).approveRotation(aAddr, stranger.address))
          .to.be.revertedWithCustomError(b, "NotARecipient");
      }
    });

    it("votes for one target never count toward another", async function () {
      const { a, b, r1, r2, stranger, other } = await deployTree();
      const aAddr = await a.getAddress();

      await b.connect(r1).approveRotation(aAddr, stranger.address);
      await b.connect(r2).approveRotation(aAddr, stranger.address);
      expect(await b.rotationApproved(aAddr, stranger.address)).to.equal(true);
      expect(await b.rotationApproved(aAddr, other.address)).to.equal(false);
      expect(await b.rotationApproved(other.address, stranger.address)).to.equal(false);

      await expect(b.connect(stranger).rotateAt(aAddr, other.address))
        .to.be.revertedWithCustomError(b, "InsufficientConsent");
    });

    it("two incompatible proposals can both pass; the first to land voids the other", async function () {
      const { a, b, authority, r1, r2, stranger, other } = await deployTree();
      const aAddr = await a.getAddress();
      await b.connect(authority).renounceAuthority();

      for (const target of [stranger.address, other.address]) {
        await b.connect(r1).approveRotation(aAddr, target);
        await b.connect(r2).approveRotation(aAddr, target);
        expect(await b.rotationApproved(aAddr, target)).to.equal(true);
      }

      await b.connect(stranger).rotateAt(aAddr, stranger.address);
      expect((await a.getSlot(0)).payee).to.equal(stranger.address);
      // The losing proposal's approvals died with the epoch.
      expect(await b.rotationApproved(aAddr, other.address)).to.equal(false);
    });

    it("epoch rollover: approvals never survive to authorise a second move", async function () {
      const { a, b, authority, r1, r2, stranger } = await deployTree();
      const aAddr = await a.getAddress();
      await b.connect(authority).renounceAuthority();

      await b.connect(r1).approveRotation(aAddr, stranger.address);
      await b.connect(r2).approveRotation(aAddr, stranger.address);
      await b.connect(stranger).rotateAt(aAddr, stranger.address);
      expect(await b.rotationEpoch(aAddr)).to.equal(1n);

      // Same target, same parent, fresh epoch -> starts from zero.
      await expect(b.connect(stranger).rotateAt(aAddr, stranger.address))
        .to.be.revertedWithCustomError(b, "InsufficientConsent");
      expect(await b.approvedShares(await b.proposalId(aAddr, stranger.address))).to.equal(0n);
    });

    it("revoking against a stale epoch cannot corrupt the live tally", async function () {
      const { a, b, authority, r1, r2, stranger } = await deployTree();
      const aAddr = await a.getAddress();
      await b.connect(authority).renounceAuthority();
      const staleId = await b.proposalId(aAddr, stranger.address);

      await b.connect(r1).approveRotation(aAddr, stranger.address);
      await b.connect(r2).approveRotation(aAddr, stranger.address);
      await b.connect(stranger).rotateAt(aAddr, stranger.address);

      // The stale entry is still in storage; poking it must not touch the new one.
      await b.connect(r1).revokeRotation(aAddr, stranger.address).catch(() => {});
      const liveId = await b.proposalId(aAddr, stranger.address);
      expect(liveId).to.not.equal(staleId);
      expect(await b.approvedShares(liveId)).to.equal(0n);
      await b.connect(r1).approveRotation(aAddr, stranger.address);
      expect(await b.approvedShares(liveId)).to.equal(6000n);
    });

    it("epochs are per-parent: a move at one parent leaves the other's votes alone", async function () {
      const { b, authority, r1, r2, stranger } = await deployTree();
      const Hostile = await ethers.getContractFactory("HostileParent");
      const p1 = await Hostile.deploy();
      const p2 = await Hostile.deploy();
      const [a1, a2] = [await p1.getAddress(), await p2.getAddress()];
      await b.connect(authority).renounceAuthority();

      for (const p of [a1, a2]) {
        await b.connect(r1).approveRotation(p, stranger.address);
        await b.connect(r2).approveRotation(p, stranger.address);
      }
      await b.connect(stranger).rotateAt(a1, stranger.address);

      expect(await b.rotationEpoch(a1)).to.equal(1n);
      expect(await b.rotationEpoch(a2)).to.equal(0n);
      expect(await b.rotationApproved(a2, stranger.address)).to.equal(true);
    });

    it("sibling splitters with identical recipients have distinct proposal ids", async function () {
      const { a, b, r1, r2, r3, authority } = await deployTree();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      const b2 = await F.deploy(authority.address,
        [r1.address, r2.address, r3.address], [6000, 3000, 1000], 0);
      const aAddr = await a.getAddress();

      expect(await b.proposalId(aAddr, r1.address))
        .to.not.equal(await b2.proposalId(aAddr, r1.address));

      await b.connect(r1).approveRotation(aAddr, r1.address);
      expect(await b2.approvedShares(await b2.proposalId(aAddr, r1.address))).to.equal(0n);
    });
  });

  // =============================================================== accounting
  describe("accounting cannot be corrupted", function () {
    it("ATTACK: a slot points itself at the splitter and self-pays to inflate receipts", async function () {
      const { b, r1, stranger } = await deploy();
      const bAddr = await b.getAddress();
      await stranger.sendTransaction({ to: bAddr, value: E(10) });

      // Unguarded, paying "out" to ourselves leaves the balance untouched while
      // `withdrawn` grows — manufacturing receipts from nothing. Measured before
      // the fix: totalReceived 10 -> ~25 ETH, and slots 1/2 went from 3/1 to
      // 7.49/2.50. Not an insolvency, but a silent rewrite of the split, and
      // irreversible because only this contract could move the slot back.
      await expect(b.connect(r1).rotateRecipient(bAddr))
        .to.be.revertedWithCustomError(b, "PayeeIsSelf");

      expect((await b.getSlot(0)).payee).to.equal(r1.address);
      expect(await b.totalReceived(ETH)).to.equal(E(10));
      expect(await totalOwed(b, ETH)).to.be.lte(E(10));
    });

    it("the constructor refuses a self-payee too (the only other writer of .payee)", async function () {
      const [, , auth, r1, r2] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      // Predict the deployment address and try to seed it as a payee.
      const nonce = await ethers.provider.getTransactionCount(auth.address);
      const predicted = ethers.getCreateAddress({ from: auth.address, nonce });
      await expect(
        F.connect(auth).deploy(auth.address, [predicted, r1.address, r2.address],
          [6000, 3000, 1000], 0)
      ).to.be.revertedWithCustomError(F, "PayeeIsSelf");
    });

    it("totalReceived can only ever be moved by real inflows", async function () {
      const { b, r1, r2, r3, stranger } = await deploy();
      const bAddr = await b.getAddress();
      await stranger.sendTransaction({ to: bAddr, value: E(10) });

      // Drain everything through every slot; receipts must not budge.
      for (let i = 0; i < 3; i++) await b.connect(stranger).withdraw(ETH, i);
      expect(await b.totalReceived(ETH)).to.equal(E(10));
      expect(await b.withdrawn(ETH)).to.equal(E(10));
      expect(await ethers.provider.getBalance(bAddr)).to.equal(0n);
      expect(await totalOwed(b, ETH)).to.equal(0n);
    });

    it("one slot's withdrawal never changes what another slot is owed", async function () {
      const { b, r1, r2, r3, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      const before = [await b.releasable(ETH, 1), await b.releasable(ETH, 2)];
      await b.connect(r1).withdrawMine(ETH);
      expect([await b.releasable(ETH, 1), await b.releasable(ETH, 2)]).to.deep.equal(before);
      expect(await b.totalReceived(ETH)).to.equal(E(10));      // invariant across a payout
    });

    it("withdrawal order does not change anyone's total take", async function () {
      const orders = [[0, 1, 2], [2, 1, 0], [1, 0, 2]];
      const results = [];
      for (const order of orders) {
        const { b, r1, r2, r3, stranger } = await deploy();
        const addr = await b.getAddress();
        await stranger.sendTransaction({ to: addr, value: E(7) });
        await stranger.sendTransaction({ to: addr, value: E(3) });
        const paid = {};
        for (const i of order) {
          const who = [r1, r2, r3][i];
          const pre = await ethers.provider.getBalance(who.address);
          await b.connect(stranger).withdraw(ETH, i);
          paid[i] = (await ethers.provider.getBalance(who.address)) - pre;
        }
        results.push([paid[0], paid[1], paid[2]].join(","));
      }
      expect(new Set(results).size).to.equal(1);
      expect(results[0]).to.equal([E(6), E(3), E(1)].join(","));
    });

    it("repeated withdraw attempts cannot extract more than the entitlement", async function () {
      const { b, r1, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      await b.connect(r1).withdrawMine(ETH);
      for (let i = 0; i < 3; i++) {
        await expect(b.connect(r1).withdrawMine(ETH))
          .to.be.revertedWithCustomError(b, "NothingToWithdraw");
      }
      expect(await b.claimed(ETH, 0)).to.equal(E(6));
      expect(await b.withdrawn(ETH)).to.equal(E(6));
    });

    it("stays solvent under randomised arrivals and interleaved withdrawals", async function () {
      const { b, stranger } = await deploy();
      const ERC = await ethers.getContractFactory("MockERC20");
      const token = await ERC.deploy("Tok", "TOK");
      const addr = await token.getAddress();
      const bAddr = await b.getAddress();

      let seed = 987654321n;
      const rand = (n) => {
        seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
        return Number(seed % BigInt(n));
      };

      let minted = 0n;
      for (let step = 0; step < 120; step++) {
        if (rand(3) !== 0) {
          const amt = BigInt(rand(9973) + 1);
          await token.mint(bAddr, amt);
          minted += amt;
        } else {
          const slot = rand(3);
          if ((await b.releasable(addr, slot)) > 0n) await b.connect(stranger).withdraw(addr, slot);
        }
        const owed = await totalOwed(b, addr);
        const held = await token.balanceOf(bAddr);
        expect(owed, `step ${step}: owes ${owed} holds ${held}`).to.be.lte(held);
      }

      for (let i = 0; i < 3; i++) {
        if ((await b.releasable(addr, i)) > 0n) await b.connect(stranger).withdraw(addr, i);
      }
      expect(await token.balanceOf(bAddr)).to.be.lt(3n);       // only sub-share dust remains
      expect(await b.withdrawn(addr)).to.equal(minted - (await token.balanceOf(bAddr)));
    });

    it("tokens are isolated: draining one does not touch another", async function () {
      const { b, r1, stranger } = await deploy();
      const ERC = await ethers.getContractFactory("MockERC20");
      const t1 = await ERC.deploy("A", "A");
      const t2 = await ERC.deploy("B", "B");
      const bAddr = await b.getAddress();

      await t1.mint(bAddr, 1000n);
      await t2.mint(bAddr, 500n);
      await stranger.sendTransaction({ to: bAddr, value: E(10) });

      await b.connect(r1).withdrawMine(await t1.getAddress());
      expect(await b.releasable(await t2.getAddress(), 0)).to.equal(300n);
      expect(await b.releasable(ETH, 0)).to.equal(E(6));
      expect(await b.withdrawn(await t2.getAddress())).to.equal(0n);
    });

    it("a fee-on-transfer token splits what actually arrived, not what was sent", async function () {
      const { b, r1, r2, stranger } = await deploy();
      const Fee = await ethers.getContractFactory("MockFeeERC20");
      const fee = await Fee.deploy("Fee", "FEE", 1000); // 10% burned in transit
      const addr = await fee.getAddress();
      const bAddr = await b.getAddress();

      await fee.mint(stranger.address, 1000n);
      await fee.connect(stranger).transfer(bAddr, 1000n);      // 900 lands
      expect(await fee.balanceOf(bAddr)).to.equal(900n);
      expect(await b.totalReceived(addr)).to.equal(900n);
      expect(await b.releasable(addr, 0)).to.equal(540n);

      // The payout is itself taxed; the contract's books track what it sent.
      await b.connect(r1).withdrawMine(addr);
      expect(await fee.balanceOf(r1.address)).to.equal(486n);  // 540 minus 10%
      expect(await b.withdrawn(addr)).to.equal(540n);
      expect(await totalOwed(b, addr)).to.be.lte(await fee.balanceOf(bAddr));
    });

    it("a rebasing-DOWN token reports zero instead of underflowing, and stays solvent", async function () {
      const { b, r1, stranger } = await deploy();
      const M = await ethers.getContractFactory("BurnableERC20Mock");
      const t = await M.deploy();
      const addr = await t.getAddress();
      const bAddr = await b.getAddress();

      await t.mint(bAddr, 1000n);
      await b.connect(r1).withdrawMine(addr);                  // r1 takes 600
      await t.burn(bAddr, 390n);                               // 400 -> 10 out of band

      for (let i = 0; i < 3; i++) {
        expect(await b.releasable(addr, i)).to.be.a("bigint"); // no revert, no underflow
      }
      expect(await totalOwed(b, addr)).to.be.lte(1000n);

      // The clamp pays what exists and leaves the shortfall claimable.
      await b.connect(stranger).withdraw(addr, 1);
      expect(await t.balanceOf(bAddr)).to.equal(0n);
      await expect(b.connect(stranger).withdraw(addr, 2))
        .to.be.revertedWithCustomError(b, "NothingToWithdraw");
    });

    it("a token with a reverting balanceOf breaks only itself", async function () {
      const { b, r1, stranger } = await deploy();
      const M = await ethers.getContractFactory("RevertingBalanceERC20Mock");
      const bad = await M.deploy();
      const bAddr = await b.getAddress();
      await bad.mint(bAddr, 1000n);
      await stranger.sendTransaction({ to: bAddr, value: E(10) });

      await bad.setBricked(true);
      await expect(b.connect(r1).withdrawMine(await bad.getAddress())).to.be.reverted;

      // ETH and every other token are completely unaffected.
      await b.connect(r1).withdrawMine(ETH);
      expect(await b.claimed(ETH, 0)).to.equal(E(6));
    });

    it("an unknown token address reverts rather than silently reporting zero", async function () {
      const { b, r1, stranger } = await deploy();
      await expect(b.connect(r1).withdrawMine(stranger.address)).to.be.reverted;
      await expect(b.releasable(stranger.address, 0)).to.be.reverted;
    });

    it("ETH forced in by a parent's raw call is split like any other receipt", async function () {
      const { b, r1, stranger } = await deploy();
      const Hostile = await ethers.getContractFactory("HostileParent");
      const p = await Hostile.deploy();
      await stranger.sendTransaction({ to: await p.getAddress(), value: E(10) });
      await p.pay(await b.getAddress(), E(10));

      expect(await b.totalReceived(ETH)).to.equal(E(10));
      expect(await b.releasable(ETH, 0)).to.equal(E(6));
      await b.connect(r1).withdrawMine(ETH);
    });
  });

  // =============================================================== the gate
  // A slot may name the only address allowed to TRIGGER its payout. The thing
  // to attack is the gap between "who may press the button" and "where the
  // money goes" — there must not be one.
  describe("the withdraw gate cannot be abused", function () {
    it("ATTACK: a caller allowed on every slot still receives nothing", async function () {
      const { b, r1, r2, r3, stranger } = await deploy();
      const bAddr = await b.getAddress();
      await stranger.sendTransaction({ to: bAddr, value: E(10) });
      for (const r of [r1, r2, r3]) await b.connect(r).setWithdrawCaller(stranger.address);

      const before = [];
      for (const r of [r1, r2, r3]) before.push(await ethers.provider.getBalance(r.address));
      const sBefore = await ethers.provider.getBalance(stranger.address);

      let gas = 0n;
      for (let i = 0; i < 3; i++) {
        const rc = await (await b.connect(stranger).withdraw(ETH, i)).wait();
        gas += rc.gasUsed * rc.gasPrice;
      }

      // Every wei reached a rightful payee; the privileged caller is out its gas.
      const want = [E(6), E(3), E(1)];
      for (const [i, r] of [r1, r2, r3].entries()) {
        expect(await ethers.provider.getBalance(r.address) - before[i]).to.equal(want[i]);
      }
      expect(await ethers.provider.getBalance(stranger.address)).to.equal(sBefore - gas);
      expect(await ethers.provider.getBalance(bAddr)).to.equal(0n);
    });

    it("a gated slot cannot block, dilute or delay any other slot", async function () {
      const { b, r1, r2, r3, stranger } = await deploy();
      const bAddr = await b.getAddress();
      await stranger.sendTransaction({ to: bAddr, value: E(10) });
      await b.connect(r1).setWithdrawCaller(r1.address);   // slot 0 shuts its door

      await b.connect(stranger).withdraw(ETH, 1);
      await b.connect(stranger).withdraw(ETH, 2);
      expect(await b.releasable(ETH, 0)).to.equal(E(6));   // waiting, not lost
      expect(await totalOwed(b, ETH)).to.be.lte(await ethers.provider.getBalance(bAddr));

      // Slot 0 never claims; later arrivals still divide at the fixed shares.
      await stranger.sendTransaction({ to: bAddr, value: E(10) });
      expect(await b.releasable(ETH, 0)).to.equal(E(12));
      expect(await b.releasable(ETH, 1)).to.equal(E(3));
      expect(await b.releasable(ETH, 2)).to.equal(E(1));
    });

    it("the authority cannot open or close a gate", async function () {
      const { b, authority, r1, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });
      await b.connect(r1).setWithdrawCaller(r1.address);

      await expect(b.connect(authority).setWithdrawCaller(authority.address))
        .to.be.revertedWithCustomError(b, "NotARecipient");
      await expect(b.connect(authority).withdraw(ETH, 0))
        .to.be.revertedWithCustomError(b, "NotWithdrawCaller");
      expect(await b.withdrawCaller(0)).to.equal(r1.address);

      for (const fn of ["setWithdrawCallerFor", "clearWithdrawCaller", "forceWithdraw"]) {
        expect(b.interface.fragments.some((f) => f.name === fn), `${fn} should not exist`)
          .to.equal(false);
      }
    });

    it("releasable ignores the gate entirely", async function () {
      const { b, r1, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      const open = await b.releasable(ETH, 0);
      await b.connect(r1).setWithdrawCaller(r1.address);
      expect(await b.releasable(ETH, 0)).to.equal(open);           // owed is owed
      expect(await b.connect(stranger).releasable(ETH, 0)).to.equal(E(6));
      expect(await b.totalReceived(ETH)).to.equal(E(10));
    });

    it("a gate set from inside a receive hook cannot corrupt the books", async function () {
      const [, , authority, r1, r2, r3, other, stranger] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      const H = await ethers.getContractFactory("HostileRecipient");
      const b = await F.deploy(authority.address,
        [r1.address, r2.address, r3.address], [6000, 3000, 1000], 0);
      const bAddr = await b.getAddress();
      const h = await H.deploy(bAddr);
      await b.connect(r1).rotateRecipient(await h.getAddress());
      await h.setSlot(0);
      await h.setGate(other.address);
      await h.setMode(3);                    // gate itself mid-payout

      await stranger.sendTransaction({ to: bAddr, value: E(10) });
      await b.connect(stranger).withdraw(ETH, 0);   // the gate was open at entry

      // setWithdrawCaller is not nonReentrant and does not need to be: the gate
      // is read once, before any accounting, and moving it afterwards touches
      // nothing the in-flight payout depends on.
      expect(await b.withdrawCaller(0)).to.equal(other.address);
      expect(await b.claimed(ETH, 0)).to.equal(E(6));
      expect(await b.withdrawn(ETH)).to.equal(E(6));
      expect(await b.totalReceived(ETH)).to.equal(E(10));
      expect(await totalOwed(b, ETH)).to.be.lte(await ethers.provider.getBalance(bAddr));

      await stranger.sendTransaction({ to: bAddr, value: E(10) });
      await expect(b.connect(stranger).withdraw(ETH, 0))   // binds the NEXT one
        .to.be.revertedWithCustomError(b, "NotWithdrawCaller");
    });

    it("a rotated-away address cannot re-gate the slot it left", async function () {
      const { b, r1, other, stranger } = await deploy();
      await b.connect(r1).setWithdrawCaller(r1.address);
      await b.connect(r1).rotateRecipient(other.address);

      await expect(b.connect(r1).setWithdrawCaller(r1.address))
        .to.be.revertedWithCustomError(b, "NotARecipient");
      expect(await b.withdrawCaller(0)).to.equal(ethers.ZeroAddress);

      // The choice belongs to whoever holds the slot now.
      await b.connect(other).setWithdrawCaller(other.address);
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });
      await expect(b.connect(stranger).withdraw(ETH, 0))
        .to.be.revertedWithCustomError(b, "NotWithdrawCaller");
      await b.connect(other).withdrawMine(ETH);
    });

    it("gating cannot strand funds, even pointed at an address that can never call", async function () {
      // The freeze the clear-on-rotation rule exists to prevent, aimed at a live
      // slot instead: a gate on the splitter itself, which has no way to
      // originate a call. The payee is still never locked out of its own money.
      const { b, r1, stranger } = await deploy();
      const bAddr = await b.getAddress();
      await stranger.sendTransaction({ to: bAddr, value: E(10) });
      await b.connect(r1).setWithdrawCaller(bAddr);

      await expect(b.connect(stranger).withdraw(ETH, 0))
        .to.be.revertedWithCustomError(b, "NotWithdrawCaller");
      await b.connect(r1).withdrawMine(ETH);                 // always allowed
      expect(await b.claimed(ETH, 0)).to.equal(E(6));

      await b.connect(r1).setWithdrawCaller(ethers.ZeroAddress);   // always reopenable
      await stranger.sendTransaction({ to: bAddr, value: E(10) });
      await b.connect(stranger).withdraw(ETH, 0);
      expect(await b.claimed(ETH, 0)).to.equal(E(12));
    });
  });

  // ============================================================== reentrancy
  describe("reentrancy and hostile counterparties", function () {
    it("a recipient cannot reenter withdraw from its ETH receive hook", async function () {
      const [, , authority, , , , , stranger] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      const H = await ethers.getContractFactory("HostileRecipient");

      // Deploy the splitter first at a predicted address is unnecessary — put a
      // placeholder in, then have the hostile contract take over slot 0.
      const [, , , r1, r2, r3] = await ethers.getSigners();
      const b = await F.deploy(authority.address,
        [r1.address, r2.address, r3.address], [6000, 3000, 1000], 0);
      const h = await H.deploy(await b.getAddress());
      await b.connect(r1).rotateRecipient(await h.getAddress());
      await h.setSlot(0);

      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });
      await h.setMode(2); // reenter withdraw on receive
      await expect(h.pull(ETH)).to.be.reverted;

      // Books untouched by the failed attack.
      expect(await b.claimed(ETH, 0)).to.equal(0n);
      expect(await b.withdrawn(ETH)).to.equal(0n);
      expect(await totalOwed(b, ETH)).to.be.lte(E(10));
    });

    it("a recipient that rejects ETH cannot block the others", async function () {
      const [, , authority, r1, r2, r3, , stranger] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      const H = await ethers.getContractFactory("HostileRecipient");
      const b = await F.deploy(authority.address,
        [r1.address, r2.address, r3.address], [6000, 3000, 1000], 0);
      const h = await H.deploy(await b.getAddress());
      await b.connect(r1).rotateRecipient(await h.getAddress());
      await h.setSlot(0);
      await h.setMode(1); // revert on receive

      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });
      await expect(b.connect(stranger).withdraw(ETH, 0))
        .to.be.revertedWithCustomError(b, "EthTransferFailed");

      await b.connect(r2).withdrawMine(ETH);
      await b.connect(r3).withdrawMine(ETH);
      expect(await b.releasable(ETH, 0)).to.equal(E(6));       // still waiting, not lost
    });

    it("a hostile parent cannot reenter withdraw or rotateAt during rotateAt", async function () {
      const { b, authority, r1, stranger } = await deploy();
      const Hostile = await ethers.getContractFactory("HostileParent");
      const p = await Hostile.deploy();
      await p.setTarget(await b.getAddress());
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      for (const mode of [2, 3]) {
        await p.setMode(mode);
        await expect(b.connect(authority).rotateAt(await p.getAddress(), stranger.address))
          .to.be.reverted;
      }
      // Nothing moved, nothing paid.
      expect(await b.rotationEpoch(await p.getAddress())).to.equal(0n);
      expect(await b.withdrawn(ETH)).to.equal(0n);
      expect(await b.releasable(ETH, 0)).to.equal(E(6));
    });

    it("a hostile parent cannot move the child's own internal slots", async function () {
      const { b, authority, r1, stranger } = await deploy();
      const Hostile = await ethers.getContractFactory("HostileParent");
      const p = await Hostile.deploy();
      await p.setTarget(await b.getAddress());
      await p.setMode(4); // calls back into b.rotateRecipient

      // The parent is not a recipient of b, so its callback cannot take a slot.
      await expect(b.connect(authority).rotateAt(await p.getAddress(), stranger.address))
        .to.be.reverted;
      expect((await b.getSlot(0)).payee).to.equal(r1.address);
    });

    it("a reverting parent leaves the epoch and the whole contract untouched", async function () {
      const { b, authority, stranger } = await deploy();
      const Hostile = await ethers.getContractFactory("HostileParent");
      const p = await Hostile.deploy();
      await p.setMode(1);
      await expect(b.connect(authority).rotateAt(await p.getAddress(), stranger.address))
        .to.be.revertedWith("hostile parent");
      expect(await b.rotationEpoch(await p.getAddress())).to.equal(0n);
    });

    it("a parent that silently ignores the call still burns the epoch (known)", async function () {
      const { b, authority, stranger } = await deploy();
      const Hostile = await ethers.getContractFactory("HostileParent");
      const p = await Hostile.deploy();
      await p.setMode(0);
      await b.connect(authority).rotateAt(await p.getAddress(), stranger.address);
      expect(await p.calls()).to.equal(1n);
      expect(await b.rotationEpoch(await p.getAddress())).to.equal(1n);
    });
  });

  // ============================================================ authority
  describe("authority is bounded to exactly one power", function () {
    it("cannot withdraw, cannot move a payee, cannot mint itself a slot", async function () {
      const { b, authority, r1, stranger } = await deploy();
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });

      await expect(b.connect(authority).withdrawMine(ETH))
        .to.be.revertedWithCustomError(b, "NotARecipient");
      await expect(b.connect(authority).rotateRecipient(authority.address))
        .to.be.revertedWithCustomError(b, "NotARecipient");

      // It CAN trigger a payout — but only ever to the rightful payee.
      const pre = await ethers.provider.getBalance(r1.address);
      await b.connect(authority).withdraw(ETH, 0);
      expect((await ethers.provider.getBalance(r1.address)) - pre).to.equal(E(6));
    });

    it("transferAuthority(0) is a renounce and cannot be undone", async function () {
      const { b, authority, stranger } = await deploy();
      await b.connect(authority).transferAuthority(ethers.ZeroAddress);
      expect(await b.authority()).to.equal(ethers.ZeroAddress);

      await expect(b.connect(authority).transferAuthority(authority.address))
        .to.be.revertedWithCustomError(b, "NotAuthority");
      await expect(b.connect(stranger).rotateAt(stranger.address, stranger.address))
        .to.be.revertedWithCustomError(b, "InsufficientConsent");
    });

    it("a stranger cannot transfer or renounce the authority", async function () {
      const { b, stranger } = await deploy();
      await expect(b.connect(stranger).transferAuthority(stranger.address))
        .to.be.revertedWithCustomError(b, "NotAuthority");
      await expect(b.connect(stranger).renounceAuthority())
        .to.be.revertedWithCustomError(b, "NotAuthority");
    });

    it("no function exists to reinstate an authority or change shares", async function () {
      const { b } = await deploy();
      const names = b.interface.fragments.map((f) => f.name);
      // `acceptAuthority` exists, but only completes an offer a sitting authority made;
      // once the authority is renounced nothing can offer, so it cannot reinstate one.
      for (const forbidden of ["setAuthority", "setShares", "addRecipient",
                               "removeRecipient", "setRotationThreshold", "upgradeTo", "initialize"]) {
        expect(names, `${forbidden} must not exist`).to.not.include(forbidden);
      }
    });

    it("an authority that is also a recipient gains nothing extra", async function () {
      const [, , , r1, r2, r3, , stranger] = await ethers.getSigners();
      const F = await ethers.getContractFactory("SatoriSplitterImmutable");
      const b = await F.deploy(r1.address, [r1.address, r2.address, r3.address],
        [6000, 3000, 1000], 0);
      await stranger.sendTransaction({ to: await b.getAddress(), value: E(10) });
      expect(await b.releasable(ETH, 0)).to.equal(E(6));
      await expect(b.connect(r1).withdraw(ETH, 1)).to.not.be.reverted;
      expect(await b.claimed(ETH, 1)).to.equal(E(3));          // paid r2, not r1
    });
  });

  // ============================================================ slot integrity
  describe("slot set is genuinely fixed", function () {
    it("rotation cannot create a slot, collide, or zero a payee", async function () {
      const { b, r1, r2, stranger } = await deploy();
      await expect(b.connect(stranger).rotateRecipient(stranger.address))
        .to.be.revertedWithCustomError(b, "NotARecipient");
      await expect(b.connect(r1).rotateRecipient(r2.address))
        .to.be.revertedWithCustomError(b, "AlreadyRecipient");
      await expect(b.connect(r1).rotateRecipient(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(b, "ZeroAddress");
      await expect(b.connect(r1).rotateRecipient(r1.address))
        .to.be.revertedWithCustomError(b, "AlreadyRecipient");
      expect(await b.slotCount()).to.equal(3n);
    });

    it("the old address is fully evicted after a rotation", async function () {
      const { b, r1, stranger } = await deploy();
      await b.connect(r1).rotateRecipient(stranger.address);
      expect(await b.isRecipient(r1.address)).to.equal(false);
      await expect(b.slotOf(r1.address)).to.be.revertedWithCustomError(b, "NotARecipient");
      await expect(b.connect(r1).withdrawMine(ETH))
        .to.be.revertedWithCustomError(b, "NotARecipient");
      expect(await b.slotOf(stranger.address)).to.equal(0n);
    });

    it("a rotated-away address cannot reclaim history, and the new one cannot double-claim", async function () {
      const { b, r1, stranger, other } = await deploy();
      await other.sendTransaction({ to: await b.getAddress(), value: E(10) });
      await b.connect(r1).withdrawMine(ETH);                   // 6 paid
      await b.connect(r1).rotateRecipient(stranger.address);

      expect(await b.releasable(ETH, 0)).to.equal(0n);
      await expect(b.connect(stranger).withdrawMine(ETH))
        .to.be.revertedWithCustomError(b, "NothingToWithdraw");
      expect(await b.claimed(ETH, 0)).to.equal(E(6));
    });

    it("shares and threshold are unreachable from outside after deployment", async function () {
      const { b } = await deploy(6100);
      expect((await b.getSlot(0)).shares).to.equal(6000n);
      expect(await b.totalShares()).to.equal(10000n);
      expect(await b.rotationThresholdBps()).to.equal(6100n);
      await expect(b.getSlot(3)).to.be.revertedWithCustomError(b, "UnknownSlot");
      expect(await b.releasable(ETH, 3)).to.equal(0n);         // view is lenient
    });

    it("withdraw and rotateAt reject out-of-range and zero inputs", async function () {
      const { b, authority, stranger } = await deploy();
      await expect(b.connect(stranger).withdraw(ETH, 3))
        .to.be.revertedWithCustomError(b, "UnknownSlot");
      await expect(b.connect(authority).rotateAt(ethers.ZeroAddress, stranger.address))
        .to.be.revertedWithCustomError(b, "ZeroAddress");
      await expect(b.connect(authority).rotateAt(stranger.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(b, "ZeroAddress");
    });
  });

  // ========================================================= real parent tree
  describe("against an immutable parent", function () {
    it("rotating to an address the parent already pays reverts cleanly", async function () {
      const { a, b, authority, other } = await deployTree();
      await expect(b.connect(authority).rotateAt(await a.getAddress(), other.address))
        .to.be.revertedWithCustomError(a, "AlreadyRecipient");
      expect((await a.getSlot(0)).payee).to.equal(await b.getAddress());
    });

    it("the parent is frozen from birth and still honours the child's rotation", async function () {
      // There is nothing to renounce: an immutable parent has no manager and no
      // owner. Its shares are sealed at construction, yet a child moving its OWN
      // slot is still allowed — that separation is the escape hatch the design
      // trades the mutability away for.
      const { a, b, authority, stranger } = await deployTree();
      await b.connect(authority).rotateAt(await a.getAddress(), stranger.address);
      expect((await a.getSlot(0)).payee).to.equal(stranger.address);
    });

    it("funds already banked in the child survive the child being cut off", async function () {
      const { a, b, r1, r2, r3, authority, stranger } = await deployTree();
      const aAddr = await a.getAddress();
      await stranger.sendTransaction({ to: aAddr, value: E(100) });
      await a.connect(stranger).withdraw(ETH, 0);              // B banks 60

      await b.connect(authority).rotateAt(aAddr, stranger.address);
      await stranger.sendTransaction({ to: aAddr, value: E(100) });
      // No distribute(): entitlement comes from the balance at withdrawal time.

      expect(await b.releasable(ETH, 0)).to.equal(E(36));      // old money, old shares
      for (const [i, r] of [[0, r1], [1, r2], [2, r3]]) {
        const pre = await ethers.provider.getBalance(r.address);
        await b.connect(stranger).withdraw(ETH, i);
        expect((await ethers.provider.getBalance(r.address)) - pre)
          .to.equal([E(36), E(18), E(6)][i]);
      }
      expect(await ethers.provider.getBalance(await b.getAddress())).to.equal(0n);
    });
  });
});
