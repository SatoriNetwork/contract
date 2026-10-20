const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const GRACE = 7 * 24 * 3600;
const MAX96 = (1n << 96n) - 1n;
const E = (n) => ethers.parseEther(String(n));

async function deploy() {
  const [deployer, payer, payee, identity, funder, stranger] = await ethers.getSigners();
  const channels = await (await ethers.getContractFactory("PaymentChannels")).deploy();
  const token = await (await ethers.getContractFactory("MockERC20Permit")).deploy("Satori", "SATORI", 18);
  for (const s of [payer, funder, stranger]) {
    await token.mint(s.address, E(1000));
    await token.connect(s).approve(await channels.getAddress(), ethers.MaxUint256);
  }
  return { channels, token, deployer, payer, payee, identity, funder, stranger };
}

async function voucher(channels, signer, id, cumulative) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: "PaymentChannels", version: "1", chainId, verifyingContract: await channels.getAddress() };
  const types = { Voucher: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint96" }] };
  return signer.signTypedData(domain, types, { channelId: id, cumulativeAmount: cumulative });
}

async function openChannel(f, { deposit = E(10), salt = ethers.ZeroHash, from = f.payer } = {}) {
  const { channels, token, payer, payee, identity } = f;
  const t = await token.getAddress();
  const id = await channels.computeChannelId(payer.address, payee.address, t, identity.address, salt);
  await channels.connect(from).open(payer.address, payee.address, t, identity.address, deposit, salt);
  return id;
}

describe("PaymentChannels", function () {
  describe("open", function () {
    it("pulls the deposit from the caller and records the channel", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, payee, identity } = f;
      const t = await token.getAddress();
      const id = await channels.computeChannelId(payer.address, payee.address, t, identity.address, ethers.ZeroHash);
      await expect(channels.connect(payer).open(payer.address, payee.address, t, identity.address, E(10), ethers.ZeroHash))
        .to.emit(channels, "Opened")
        .withArgs(id, payer.address, payee.address, t, identity.address, payer.address, ethers.ZeroHash, E(10));
      expect(await token.balanceOf(await channels.getAddress())).to.equal(E(10));
      const c = await channels.getChannel(id);
      expect([c.payer, c.payee, c.token, c.signer]).to.deep.equal([payer.address, payee.address, t, identity.address]);
      expect([c.deposit, c.settled, c.closeRequestedAt, c.closed]).to.deep.equal([E(10), 0n, 0n, false]);
    });

    it("lets another wallet fund a channel whose refunds go to the payer", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, funder, identity } = f;
      const before = await token.balanceOf(payer.address);
      const id = await openChannel(f, { from: funder });
      expect(await token.balanceOf(funder.address)).to.equal(E(990));
      await channels.connect(identity).requestClose(id);
      await time.increase(GRACE);
      await channels.connect(identity).withdraw(id);
      expect(await token.balanceOf(payer.address)).to.equal(before + E(10));
    });

    it("refuses zero addresses, the contract itself and an empty deposit", async function () {
      const { channels, token, payer, payee, identity } = await loadFixture(deploy);
      const t = await token.getAddress();
      const Z = ethers.ZeroAddress;
      const cases = [
        [Z, payee.address, t, identity.address, E(1)],
        [payer.address, Z, t, identity.address, E(1)],
        [payer.address, payee.address, Z, identity.address, E(1)],
        [payer.address, payee.address, t, Z, E(1)],
        [payer.address, payee.address, t, identity.address, 0n],
      ];
      const self = await channels.getAddress();
      cases.push([self, payee.address, t, identity.address, E(1)], [payer.address, self, t, identity.address, E(1)]);
      for (const [a, b, c, d, e] of cases) {
        await expect(channels.connect(payer).open(a, b, c, d, e, ethers.ZeroHash)).to.be.revertedWithCustomError(channels, "BadInput");
      }
    });

    it("never reuses an id, even after the channel closed", async function () {
      const f = await loadFixture(deploy);
      const { channels, payee } = f;
      const id = await openChannel(f);
      await expect(openChannel(f)).to.be.revertedWithCustomError(channels, "ChannelExists");
      await channels.connect(payee).close(id, 0, "0x");
      await expect(openChannel(f)).to.be.revertedWithCustomError(channels, "ChannelExists");
      await openChannel(f, { salt: ethers.id("2") });
    });

    it("refuses a fee-on-transfer token", async function () {
      const { channels, payer, payee, identity } = await loadFixture(deploy);
      const fee = await (await ethers.getContractFactory("MockFeeERC20")).deploy("Fee", "FEE", 100);
      await fee.mint(payer.address, E(100));
      await fee.connect(payer).approve(await channels.getAddress(), ethers.MaxUint256);
      await expect(channels.connect(payer).open(payer.address, payee.address, await fee.getAddress(), identity.address, E(1), ethers.ZeroHash))
        .to.be.revertedWithCustomError(channels, "UnsupportedToken");
    });
  });

  describe("openWithPermit", function () {
    async function permit(token, owner, spender, value) {
      const { chainId } = await ethers.provider.getNetwork();
      const deadline = BigInt((await time.latest()) + 3600);
      const sig = ethers.Signature.from(await owner.signTypedData(
        { name: await token.name(), version: "1", chainId, verifyingContract: await token.getAddress() },
        { Permit: [
          { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        { owner: owner.address, spender, value, nonce: await token.nonces(owner.address), deadline }));
      return { deadline, v: sig.v, r: sig.r, s: sig.s };
    }

    it("opens in one transaction with no prior approval", async function () {
      const { channels, token, payee, identity } = await loadFixture(deploy);
      const [, , , , , , fresh] = await ethers.getSigners();
      await token.mint(fresh.address, E(5));
      const c = await channels.getAddress();
      const p = await permit(token, fresh, c, E(5));
      await channels.connect(fresh).openWithPermit(fresh.address, payee.address, await token.getAddress(), identity.address,
        E(5), ethers.ZeroHash, p.deadline, p.v, p.r, p.s);
      expect(await token.balanceOf(c)).to.equal(E(5));
    });

    it("still opens when someone front-ran the permit", async function () {
      const { channels, token, payee, identity, stranger } = await loadFixture(deploy);
      const [, , , , , , fresh] = await ethers.getSigners();
      await token.mint(fresh.address, E(5));
      const c = await channels.getAddress();
      const p = await permit(token, fresh, c, E(5));
      await token.connect(stranger).permit(fresh.address, c, E(5), p.deadline, p.v, p.r, p.s);
      await channels.connect(fresh).openWithPermit(fresh.address, payee.address, await token.getAddress(), identity.address,
        E(5), ethers.ZeroHash, p.deadline, p.v, p.r, p.s);
      expect(await token.balanceOf(c)).to.equal(E(5));
    });
  });

  describe("openWithPermit without a working permit", function () {
    it("falls back to an allowance for a token with no permit, and fails without one", async function () {
      const { channels, payer, payee, identity } = await loadFixture(deploy);
      const plain = await (await ethers.getContractFactory("MockERC20")).deploy("Plain", "PL");
      await plain.mint(payer.address, E(10));
      const t = await plain.getAddress();
      const args = (salt) => [payer.address, payee.address, t, identity.address, E(2), salt, 0, 27, ethers.ZeroHash, ethers.ZeroHash];
      await expect(channels.connect(payer).openWithPermit(...args(ethers.ZeroHash))).to.be.reverted;
      await plain.connect(payer).approve(await channels.getAddress(), E(2));
      await channels.connect(payer).openWithPermit(...args(ethers.id("1")));
      expect(await plain.balanceOf(await channels.getAddress())).to.equal(E(2));
    });
  });

  describe("settle", function () {
    it("pays the payee what is new in each voucher", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, payee, identity, stranger } = f;
      const id = await openChannel(f);
      await expect(channels.connect(stranger).settle(id, E(1), await voucher(channels, identity, id, E(1))))
        .to.emit(channels, "Settled").withArgs(id, payer.address, payee.address, E(1), E(1), E(1));
      await channels.connect(payee).settle(id, E(3), await voucher(channels, identity, id, E(3)));
      expect(await token.balanceOf(payee.address)).to.equal(E(3));
      expect((await channels.getChannel(id)).settled).to.equal(E(3));
    });

    it("pays nothing twice: an older or the same voucher has nothing to settle", async function () {
      const f = await loadFixture(deploy);
      const { channels, payee, identity } = f;
      const id = await openChannel(f);
      const v1 = await voucher(channels, identity, id, E(1));
      const v2 = await voucher(channels, identity, id, E(2));
      await channels.connect(payee).settle(id, E(2), v2);
      await expect(channels.connect(payee).settle(id, E(2), v2)).to.be.revertedWithCustomError(channels, "NothingToSettle");
      await expect(channels.connect(payee).settle(id, E(1), v1)).to.be.revertedWithCustomError(channels, "NothingToSettle");
    });

    it("accepts only the channel's signer, for this channel, this contract and this chain", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, payee, identity, stranger } = f;
      const id = await openChannel(f);
      const other = await openChannel(f, { salt: ethers.id("other") });
      await expect(channels.connect(payee).settle(id, E(1), await voucher(channels, payer, id, E(1))))
        .to.be.revertedWithCustomError(channels, "BadSignature");
      await expect(channels.connect(payee).settle(id, E(1), await voucher(channels, stranger, id, E(1))))
        .to.be.revertedWithCustomError(channels, "BadSignature");
      await expect(channels.connect(payee).settle(id, E(1), await voucher(channels, identity, other, E(1))))
        .to.be.revertedWithCustomError(channels, "BadSignature");
      await expect(channels.connect(payee).settle(id, E(2), await voucher(channels, identity, id, E(1))))
        .to.be.revertedWithCustomError(channels, "BadSignature");
      const twin = await (await ethers.getContractFactory("PaymentChannels")).deploy();
      const { chainId } = await ethers.provider.getNetwork();
      const types = { Voucher: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint96" }] };
      const elsewhere = await identity.signTypedData(
        { name: "PaymentChannels", version: "1", chainId, verifyingContract: await twin.getAddress() }, types,
        { channelId: id, cumulativeAmount: E(1) });
      const otherChain = await identity.signTypedData(
        { name: "PaymentChannels", version: "1", chainId: 8453n, verifyingContract: await channels.getAddress() }, types,
        { channelId: id, cumulativeAmount: E(1) });
      for (const sig of [elsewhere, otherChain, "0x", "0x1234"]) {
        await expect(channels.connect(payee).settle(id, E(1), sig)).to.be.revertedWithCustomError(channels, "BadSignature");
      }
      expect(await token.balanceOf(payee.address)).to.equal(0n);
    });

    it("pays up to the deposit, and the rest of the same voucher after a top-up", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payee, identity } = f;
      const id = await openChannel(f, { deposit: E(2) });
      const v = await voucher(channels, identity, id, E(5));
      await expect(channels.connect(payee).settle(id, E(5), v))
        .to.emit(channels, "Settled").withArgs(id, f.payer.address, payee.address, E(5), E(2), E(2));
      await expect(channels.connect(payee).settle(id, E(5), v)).to.be.revertedWithCustomError(channels, "NothingToSettle");
      await channels.connect(f.payer).topUp(id, E(10));
      await channels.connect(payee).settle(id, E(5), v);
      expect(await token.balanceOf(payee.address)).to.equal(E(5));
    });

    it("takes a smart-contract signer's ERC-1271 approval", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, payee } = f;
      const blob = "0x" + "ab".repeat(100);
      const wallet = await (await ethers.getContractFactory("ERC1271WalletMock")).deploy(blob);
      const t = await token.getAddress();
      const w = await wallet.getAddress();
      const id = await channels.computeChannelId(payer.address, payee.address, t, w, ethers.ZeroHash);
      await channels.connect(payer).open(payer.address, payee.address, t, w, E(4), ethers.ZeroHash);
      await channels.connect(payee).settle(id, E(1), blob);
      expect(await token.balanceOf(payee.address)).to.equal(E(1));
      for (const mode of [1, 2, 3, 4]) {
        await wallet.setMode(mode);
        await expect(channels.connect(payee).settle(id, E(2), blob)).to.be.revertedWithCustomError(channels, "BadSignature");
      }
    });

    it("keeps honouring ECDSA vouchers after the signer's address gains code (EIP-7702)", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, payee, identity } = f;
      const id = await openChannel(f);
      const v5 = await voucher(channels, identity, id, E(5));
      const rejecter = await (await ethers.getContractFactory("ERC1271WalletMock")).deploy("0x");
      const { chainId } = await ethers.provider.getNetwork();
      const auth = await identity.authorize({ address: await rejecter.getAddress(), nonce: await identity.getNonce(), chainId });
      const [relayer] = await ethers.getSigners();
      await (await relayer.sendTransaction({ type: 4, to: relayer.address, value: 0, authorizationList: [auth], gasLimit: 100000 })).wait();
      expect((await ethers.provider.getCode(identity.address)).slice(0, 8)).to.equal("0xef0100");
      await channels.connect(payer).requestClose(id);
      await channels.connect(payee).settle(id, E(5), v5);
      expect(await token.balanceOf(payee.address)).to.equal(E(5));
      await expect(channels.connect(payee).settle(id, E(6), "0xdeadbeef")).to.be.revertedWithCustomError(channels, "BadSignature");
    });

    it("checks a contract signer's ERC-1271 answer against this voucher's digest", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, payee, identity } = f;
      const account = await (await ethers.getContractFactory("MockOwnedSigner")).deploy(identity.address);
      const t = await token.getAddress();
      const a = await account.getAddress();
      const id = await channels.computeChannelId(payer.address, payee.address, t, a, ethers.ZeroHash);
      await channels.connect(payer).open(payer.address, payee.address, t, a, E(4), ethers.ZeroHash);
      const v2 = await voucher(channels, identity, id, E(2)); // the owner key signs; the account answers for it
      await expect(channels.connect(payee).settle(id, E(3), v2)).to.be.revertedWithCustomError(channels, "BadSignature");
      await channels.connect(payee).settle(id, E(2), v2);
      expect(await token.balanceOf(payee.address)).to.equal(E(2));
    });

    it("settles many channels at once, skipping what can't pay", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payee, identity, stranger } = f;
      const a = await openChannel(f, { salt: ethers.id("a") });
      const b = await openChannel(f, { salt: ethers.id("b") });
      const closed = await openChannel(f, { salt: ethers.id("c") });
      await channels.connect(payee).close(closed, 0, "0x");
      const va = await voucher(channels, identity, a, E(1));
      await channels.connect(payee).settle(a, E(1), va);
      const ids = [a, b, closed, ethers.id("never"), b, a];
      const amounts = [E(1), E(2), E(1), E(1), E(3), E(4)];
      const sigs = [va, await voucher(channels, identity, b, E(2)), await voucher(channels, identity, closed, E(1)), "0x",
        await voucher(channels, stranger, b, E(3)), await voucher(channels, identity, a, E(4))];
      expect(await channels.connect(stranger).settleMany.staticCall(ids, amounts, sigs)).to.equal(2n);
      await channels.connect(stranger).settleMany(ids, amounts, sigs);
      expect(await token.balanceOf(payee.address)).to.equal(E(1) + E(2) + E(3)); // a: 1 then 4 (3 more); b: 2
      await expect(channels.settleMany([a], [], [])).to.be.revertedWithCustomError(channels, "BadInput");
    });

    it("can't be re-entered on the way in (the deposit) or out (the refund)", async function () {
      const { channels, payer, payee, identity } = await loadFixture(deploy);
      const c = await channels.getAddress();
      for (const incoming of [true, false]) {
        const re = await (await ethers.getContractFactory("MockReentrantERC20")).deploy();
        const t = await re.getAddress();
        await re.mint(payer.address, E(10));
        await re.connect(payer).approve(c, ethers.MaxUint256);
        const id = await channels.computeChannelId(payer.address, payee.address, t, identity.address, ethers.ZeroHash);
        if (!incoming) await channels.connect(payer).open(payer.address, payee.address, t, identity.address, E(5), ethers.ZeroHash);
        await re.arm(c, channels.interface.encodeFunctionData("requestClose", [id]), incoming);
        if (incoming) await channels.connect(payer).open(payer.address, payee.address, t, identity.address, E(5), ethers.ZeroHash);
        else await channels.connect(payee).close(id, 0, "0x");
        expect(channels.interface.parseError(await re.reentryError()).name).to.equal("ReentrancyGuardReentrantCall");
      }
    });

    it("can't be re-entered by the token to pay twice", async function () {
      const { channels, payer, payee, identity } = await loadFixture(deploy);
      const re = await (await ethers.getContractFactory("MockReentrantERC20")).deploy();
      const c = await channels.getAddress();
      const t = await re.getAddress();
      await re.mint(payer.address, E(10));
      await re.connect(payer).approve(c, ethers.MaxUint256);
      const id = await channels.computeChannelId(payer.address, payee.address, t, identity.address, ethers.ZeroHash);
      await channels.connect(payer).open(payer.address, payee.address, t, identity.address, E(10), ethers.ZeroHash);
      const v = await voucher(channels, identity, id, E(4));
      await re.arm(c, channels.interface.encodeFunctionData("settle", [id, E(4), v]), false);
      await channels.connect(payee).settle(id, E(4), v);
      expect(await re.reentered()).to.equal(true);
      expect(channels.interface.parseError(await re.reentryError()).name).to.equal("ReentrancyGuardReentrantCall");
      expect(await re.balanceOf(payee.address)).to.equal(E(4));
      expect(await re.balanceOf(c)).to.equal(E(6));
    });
  });

  describe("top-up and closing", function () {
    it("lets anyone top up without touching a close; only the payer cancels a close", async function () {
      const f = await loadFixture(deploy);
      const { channels, payer, payee, identity, stranger } = f;
      const id = await openChannel(f);
      await expect(channels.connect(payer).cancelClose(id)).to.be.revertedWithCustomError(channels, "CloseNotRequested");
      await channels.connect(identity).requestClose(id);
      await expect(channels.connect(stranger).topUp(id, E(1))).to.emit(channels, "ToppedUp")
        .withArgs(id, payer.address, payee.address, stranger.address, E(1), E(11));
      await channels.connect(payer).topUp(id, E(1));
      expect((await channels.getChannel(id)).closeRequestedAt).to.not.equal(0n);
      for (const who of [identity, payee, stranger]) {
        await expect(channels.connect(who).cancelClose(id)).to.be.revertedWithCustomError(channels, "NotPayer");
      }
      await expect(channels.connect(payer).cancelClose(id)).to.emit(channels, "CloseCancelled").withArgs(id, payer.address, payee.address);
      expect((await channels.getChannel(id)).closeRequestedAt).to.equal(0n);
      await expect(channels.connect(payer).withdraw(id)).to.be.revertedWithCustomError(channels, "CloseNotRequested");
      await expect(channels.connect(stranger).topUp(id, 0)).to.be.revertedWithCustomError(channels, "BadInput");
    });

    it("refuses a deposit past uint96", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, stranger } = f;
      const id = await openChannel(f, { deposit: 1n });
      await token.mint(stranger.address, MAX96);
      await expect(channels.connect(stranger).topUp(id, MAX96)).to.be.revertedWithCustomError(channels, "BadInput");
      await channels.connect(stranger).topUp(id, MAX96 - 1n);
    });

    it("refunds the payer only after the grace period, and the payee can settle until then", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, payee, identity, stranger } = f;
      const id = await openChannel(f);
      const before = await token.balanceOf(payer.address);
      await expect(channels.connect(stranger).requestClose(id)).to.be.revertedWithCustomError(channels, "NotPayerOrSigner");
      await expect(channels.connect(payer).withdraw(id)).to.be.revertedWithCustomError(channels, "CloseNotRequested");
      const tx = await channels.connect(identity).requestClose(id);
      const at = BigInt((await ethers.provider.getBlock(tx.blockNumber)).timestamp);
      await expect(tx).to.emit(channels, "CloseRequested").withArgs(id, payer.address, payee.address, identity.address, at + BigInt(GRACE));
      await time.increase(3600);
      await expect(channels.connect(payer).requestClose(id)).to.not.emit(channels, "CloseRequested");
      expect((await channels.getChannel(id)).closeRequestedAt).to.equal(at);
      await expect(channels.connect(payer).withdraw(id)).to.be.revertedWithCustomError(channels, "CloseNotReady");
      await channels.connect(payee).settle(id, E(3), await voucher(channels, identity, id, E(3)));
      await time.setNextBlockTimestamp(at + BigInt(GRACE) - 1n);
      await expect(channels.connect(payer).withdraw(id)).to.be.revertedWithCustomError(channels, "CloseNotReady");
      await expect(channels.connect(stranger).withdraw(id)).to.be.revertedWithCustomError(channels, "NotPayerOrSigner");
      await expect(channels.connect(payer).withdraw(id)).to.emit(channels, "Closed").withArgs(id, payer.address, payee.address, payer.address, E(3), E(7));
      expect(await token.balanceOf(payer.address)).to.equal(before + E(7));
      expect((await channels.getChannel(id)).closed).to.equal(true);
      const v4 = await voucher(channels, identity, id, E(4));
      for (const call of [
        () => channels.connect(payee).settle(id, E(4), v4),
        () => channels.connect(payer).withdraw(id),
        () => channels.connect(payer).requestClose(id),
        () => channels.connect(payer).topUp(id, 1n),
        () => channels.connect(payee).close(id, 0, "0x"),
      ]) await expect(call()).to.be.revertedWithCustomError(channels, "ChannelClosed");
    });

    it("lets the payee close at once, settling a last voucher and refunding the rest", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, payee, identity, stranger } = f;
      const id = await openChannel(f);
      const v = await voucher(channels, identity, id, E(4));
      await expect(channels.connect(stranger).close(id, E(4), v)).to.be.revertedWithCustomError(channels, "NotPayee");
      const before = await token.balanceOf(payer.address);
      await expect(channels.connect(payee).close(id, E(4), v))
        .to.emit(channels, "Settled").withArgs(id, payer.address, payee.address, E(4), E(4), E(4))
        .and.to.emit(channels, "Closed").withArgs(id, payer.address, payee.address, payee.address, E(4), E(6));
      expect(await token.balanceOf(payee.address)).to.equal(E(4));
      expect(await token.balanceOf(payer.address)).to.equal(before + E(6));
    });

    it("closes on a stale voucher without paying it again", async function () {
      const f = await loadFixture(deploy);
      const { channels, token, payer, payee, identity } = f;
      const id = await openChannel(f);
      const v3 = await voucher(channels, identity, id, E(3));
      await channels.connect(payee).settle(id, E(3), v3);
      const before = await token.balanceOf(payer.address);
      await expect(channels.connect(payee).close(id, E(2), await voucher(channels, identity, id, E(2))))
        .to.emit(channels, "Closed").withArgs(id, payer.address, payee.address, payee.address, E(3), E(7))
        .and.not.to.emit(channels, "Settled");
      expect(await token.balanceOf(payer.address)).to.equal(before + E(7));
    });

    it("withdraws at exactly the end of the grace period", async function () {
      const f = await loadFixture(deploy);
      const { channels, payer } = f;
      const id = await openChannel(f);
      const tx = await channels.connect(payer).requestClose(id);
      const at = BigInt((await ethers.provider.getBlock(tx.blockNumber)).timestamp);
      await time.setNextBlockTimestamp(at + BigInt(GRACE));
      await expect(channels.connect(payer).withdraw(id)).to.emit(channels, "Closed");
    });

    it("refuses a payee's close with a forged last voucher", async function () {
      const f = await loadFixture(deploy);
      const { channels, payee, stranger } = f;
      const id = await openChannel(f);
      await expect(channels.connect(payee).close(id, E(10), await voucher(channels, stranger, id, E(10))))
        .to.be.revertedWithCustomError(channels, "BadSignature");
    });

    it("answers UnknownChannel for an id never opened", async function () {
      const { channels, payer } = await loadFixture(deploy);
      await expect(channels.connect(payer).requestClose(ethers.id("nope"))).to.be.revertedWithCustomError(channels, "UnknownChannel");
    });
  });

  describe("SATORI's transfer lock", function () {
    async function satori() {
      const f = await loadFixture(deploy);
      const [, , , , , , governor, controller, dev] = await ethers.getSigners();
      const sat = await (await ethers.getContractFactory("SatoriToken")).deploy(governor.address, dev.address, 31337);
      await sat.connect(governor).setController(controller.address);
      const c = await f.channels.getAddress();
      for (const s of [f.payer, f.funder]) {
        await sat.connect(governor).transfer(s.address, E(100));
        await sat.connect(s).approve(c, ethers.MaxUint256);
      }
      const lock = (who) => sat.connect(controller).setLock(who.address, 0, 2 ** 24 - 1);
      return { ...f, sat, lock };
    }

    it("a locked payer can't fund a channel, but another wallet can fund it for them", async function () {
      const { channels, sat, payer, payee, identity, funder, lock } = await satori();
      const t = await sat.getAddress();
      await lock(payer);
      await expect(channels.connect(payer).open(payer.address, payee.address, t, identity.address, E(5), ethers.ZeroHash))
        .to.be.revertedWithCustomError(sat, "Locked");
      await channels.connect(funder).open(payer.address, payee.address, t, identity.address, E(5), ethers.ZeroHash);
    });

    it("a channel funded before the lock keeps paying, a locked payee receives, a locked payer is refunded", async function () {
      const { channels, sat, payer, payee, identity, lock } = await satori();
      const t = await sat.getAddress();
      const id = await channels.computeChannelId(payer.address, payee.address, t, identity.address, ethers.ZeroHash);
      await channels.connect(payer).open(payer.address, payee.address, t, identity.address, E(5), ethers.ZeroHash);
      await lock(payer);
      await lock(payee);
      await channels.connect(identity).settle(id, E(2), await voucher(channels, identity, id, E(2)));
      expect(await sat.balanceOf(payee.address)).to.equal(E(2));
      const before = await sat.balanceOf(payer.address);
      await channels.connect(identity).requestClose(id);
      await channels.connect(payer).cancelClose(id); // moves no tokens, so the lock doesn't stop it
      await channels.connect(identity).requestClose(id);
      await time.increase(GRACE);
      await channels.connect(identity).withdraw(id);
      expect(await sat.balanceOf(payer.address)).to.equal(before + E(3));
    });
  });

  describe("SATORI's transfer hook (a payee who is a prediction delegator)", function () {
    it("pays through the hook, survives a hook that reverts with a reason, and reverts whole when the hook runs out of gas", async function () {
      const f = await loadFixture(deploy);
      const { channels, payer, payee, identity } = f;
      const [, , , , , , governor, controller, dev] = await ethers.getSigners();
      const sat = await (await ethers.getContractFactory("SatoriToken")).deploy(governor.address, dev.address, 31337);
      await sat.connect(governor).setController(controller.address);
      const hook = await (await ethers.getContractFactory("MockTransferHook")).deploy();
      await sat.connect(governor).setHook(await hook.getAddress());
      await sat.connect(controller).markParticipated(payee.address);
      await sat.connect(governor).transfer(payer.address, E(10));
      await sat.connect(payer).approve(await channels.getAddress(), E(10));
      const t = await sat.getAddress();
      const id = await channels.computeChannelId(payer.address, payee.address, t, identity.address, ethers.ZeroHash);
      await channels.connect(payer).open(payer.address, payee.address, t, identity.address, E(10), ethers.ZeroHash);

      await channels.connect(identity).settle(id, E(1), await voucher(channels, identity, id, E(1)));
      expect(await hook.calls()).to.equal(1n);
      await hook.setMode(1);
      await expect(channels.connect(identity).settle(id, E(2), await voucher(channels, identity, id, E(2))))
        .to.emit(sat, "TransferHookFailed");
      await hook.setMode(3);
      const v3 = await voucher(channels, identity, id, E(3));
      await expect(channels.connect(identity).settle(id, E(3), v3, { gasLimit: 300000 }))
        .to.be.revertedWithCustomError(sat, "HookFailedWithoutReason");
      expect((await channels.getChannel(id)).settled).to.equal(E(2));
      await hook.setMode(0);
      await channels.connect(identity).settle(id, E(3), v3);
      expect(await sat.balanceOf(payee.address)).to.equal(E(3));
    });
  });

  it("holds exactly what open channels still owe, through any sequence (randomized)", async function () {
    const f = await loadFixture(deploy);
    const { channels, token, payee, identity, payer, stranger } = f;
    const c = await channels.getAddress();
    let seed = 0x5eed;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const open = [];
    const owed = new Map();
    let n = 0;
    const check = async () => {
      let sum = 0n;
      for (const id of open) {
        const ch = await channels.getChannel(id);
        expect(ch.settled <= ch.deposit).to.equal(true);
        sum += ch.deposit - ch.settled;
      }
      expect(await token.balanceOf(c)).to.equal(sum);
    };
    for (let step = 0; step < 120; step++) {
      const action = open.length === 0 ? 0 : rnd(6);
      if (action === 0) {
        const id = await openChannel(f, { deposit: BigInt(1 + rnd(50)) * 10n ** 16n, salt: ethers.id(String(n++)), from: rnd(2) ? payer : stranger });
        open.push(id);
        owed.set(id, 0n);
      } else {
        const i = rnd(open.length);
        const id = open[i];
        const ch = await channels.getChannel(id);
        if (action === 1) {
          await channels.connect(stranger).topUp(id, BigInt(1 + rnd(20)) * 10n ** 16n);
        } else if (action === 2 || action === 3) {
          const next = owed.get(id) + BigInt(rnd(30)) * 10n ** 16n;
          owed.set(id, next);
          const target = next < ch.deposit ? next : ch.deposit;
          const call = channels.connect(rnd(2) ? payee : stranger).settle(id, next, await voucher(channels, identity, id, next));
          if (target > ch.settled) await call; else await expect(call).to.be.revertedWithCustomError(channels, "NothingToSettle");
        } else if (action === 4) {
          await channels.connect(payee).close(id, owed.get(id), owed.get(id) > ch.settled ? await voucher(channels, identity, id, owed.get(id)) : "0x");
          open.splice(i, 1);
        } else {
          if (ch.closeRequestedAt === 0n) await channels.connect(identity).requestClose(id);
          else {
            await time.increase(GRACE);
            await channels.connect(payer).withdraw(id);
            open.splice(i, 1);
          }
        }
      }
      await check();
    }
  });
});
