// Route A of docs/issues/closed/multi-transaction-flows-need-batching.md — permit-accepting
// entry points, so a flow that moves tokens costs ONE wallet confirmation.
//
// The design rule under test is the safety property, not the convenience:
//
//   A permit attempt is ADVISORY. The transfer is what decides.
//
// Every entry point tries the permit in try/catch, DISCARDS the outcome, and then
// performs the same transfer its non-permit twin always did. These tests exist to
// prove that rule holds in the two places it matters — a front-run permit and a
// phantom permit — because in both of those a naive implementation looks perfectly
// healthy on the happy path. See docs/design/permit-entry-points.md.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySatoriFixture } = require("./fixtures");

const NO_PERMIT_TOKEN = { value: 0n, deadline: 0n, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash };
const NO_PERMIT_SATORI = { value: 0n, deadline: 0n, signature: "0x" };
const FAR_FUTURE = 4102444800n; // 2100-01-01

/// Build an ERC-2612 signature. Works for SATORI and for any OZ ERC20Permit token.
async function signPermit(token, owner, spender, value, deadline) {
  const [chainId, name, nonce, verifyingContract] = await Promise.all([
    ethers.provider.getNetwork().then((n) => n.chainId),
    token.name(),
    token.nonces(owner.address),
    token.getAddress(),
  ]);
  const raw = await owner.signTypedData(
    { name, version: "1", chainId, verifyingContract },
    {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    { owner: owner.address, spender, value, nonce, deadline },
  );
  const { v, r, s } = ethers.Signature.from(raw);
  return { raw, v, r, s };
}

const tokenPermit = (value, deadline, sig) => ({ value, deadline, v: sig.v, r: sig.r, s: sig.s });
const satoriPermit = (value, deadline, sig) => ({ value, deadline, signature: sig.raw });

describe("Permit entry points (Route A)", function () {
  let fix, satori, token, hub, bounties, lens;
  let owner, alice, bob;

  beforeEach(async function () {
    fix = await loadFixture(deploySatoriFixture);
    ({ satori, token, hub, bounties, lens, owner } = fix);
    [, alice, bob] = fix.signers;

    await satori.transfer(alice.address, ethers.parseEther("120"));
    await satori.transfer(bob.address, ethers.parseEther("60"));

    // The fixture pre-approves the hub for MaxUint256 from every signer. Every
    // test here must start from ZERO or it would pass without the permit doing
    // any work at all — which is exactly the failure mode this suite is for.
    await token.connect(alice).approve(await hub.getAddress(), 0);
    await token.connect(bob).approve(await hub.getAddress(), 0);
  });

  // ==========================================================================
  describe("SatoriHub.voteWithPermit", function () {
    let gameId;

    beforeEach(async function () {
      const tx = await satori.createSimpleDataStream("Permit Stream", owner.address);
      const rc = await tx.wait();
      // stream N's binary game shares its id in this fixture's creation order;
      // read it back off the registry rather than assuming.
      const streamId = await fix.registry.nextStreamId();
      gameId = await fix.games.gameCount();
      expect(streamId).to.be.gt(1n);
    });

    it("votes in ONE transaction with no prior allowance", async function () {
      const amount = ethers.parseEther("10");
      const hubAddr = await hub.getAddress();
      expect(await token.allowance(alice.address, hubAddr)).to.equal(0n);

      const balBefore = await token.balanceOf(alice.address);
      const sig = await signPermit(token, alice, hubAddr, amount, FAR_FUTURE);

      await hub.connect(alice).voteWithPermit(gameId, amount, satoriPermit(amount, FAR_FUTURE, sig));

      expect(await token.balanceOf(alice.address)).to.equal(balBefore - amount);
    });

    it("still succeeds when the permit is FRONT-RUN by someone else", async function () {
      const amount = ethers.parseEther("10");
      const hubAddr = await hub.getAddress();
      const sig = await signPermit(token, alice, hubAddr, amount, FAR_FUTURE);

      // Bob lifts Alice's signature out of the mempool and lands it first. The
      // allowance it sets is exactly the one Alice asked for; what it also does
      // is CONSUME HER NONCE, so her own permit call is now doomed to revert.
      await token.connect(bob).permit(alice.address, hubAddr, amount, FAR_FUTURE, sig.v, sig.r, sig.s);
      expect(await token.allowance(alice.address, hubAddr)).to.equal(amount);

      const balBefore = await token.balanceOf(alice.address);
      await hub.connect(alice).voteWithPermit(gameId, amount, satoriPermit(amount, FAR_FUTURE, sig));
      expect(await token.balanceOf(alice.address)).to.equal(balBefore - amount);
    });

    it("reverts on an EXPIRED permit rather than voting for free", async function () {
      const amount = ethers.parseEther("10");
      const hubAddr = await hub.getAddress();
      const past = BigInt((await ethers.provider.getBlock("latest")).timestamp) - 1n;
      const sig = await signPermit(token, alice, hubAddr, amount, past);

      const balBefore = await token.balanceOf(alice.address);
      await expect(
        hub.connect(alice).voteWithPermit(gameId, amount, satoriPermit(amount, past, sig)),
      ).to.be.reverted;
      expect(await token.balanceOf(alice.address)).to.equal(balBefore);
    });

    it("reverts on a GARBAGE signature rather than voting for free", async function () {
      const amount = ethers.parseEther("10");
      const balBefore = await token.balanceOf(alice.address);
      await expect(
        hub.connect(alice).voteWithPermit(gameId, amount, {
          value: amount, deadline: FAR_FUTURE, signature: "0x" + "11".repeat(65),
        }),
      ).to.be.reverted;
      expect(await token.balanceOf(alice.address)).to.equal(balBefore);
    });

    it("falls back to an existing allowance when no permit is supplied", async function () {
      const amount = ethers.parseEther("10");
      await token.connect(alice).approve(await hub.getAddress(), amount);

      const balBefore = await token.balanceOf(alice.address);
      await hub.connect(alice).voteWithPermit(gameId, amount, NO_PERMIT_SATORI);
      expect(await token.balanceOf(alice.address)).to.equal(balBefore - amount);
    });

    it("credits exactly the same weight as the non-permit vote", async function () {
      const amount = ethers.parseEther("10");
      const hubAddr = await hub.getAddress();

      const sig = await signPermit(token, alice, hubAddr, amount, FAR_FUTURE);
      await hub.connect(alice).voteWithPermit(gameId, amount, satoriPermit(amount, FAR_FUTURE, sig));
      const viaPermit = await fix.voting.gameWeight(gameId);

      await token.connect(bob).approve(hubAddr, amount);
      await hub.connect(bob).vote(gameId, amount);
      const afterBoth = await fix.voting.gameWeight(gameId);

      expect(afterBoth - viaPermit).to.equal(viaPermit);
    });

    it("works for an ERC-1271 smart-contract wallet with a non-65-byte signature", async function () {
      // The blob is deliberately NOT 65 bytes. That is the whole reason the hub
      // takes `bytes` instead of (v, r, s): a Safe's concatenated owner
      // signatures and a passkey's authenticator payload cannot fit the ERC-2612
      // parameter shape at all, so a v/r/s-only entry point would exclude exactly
      // the accounts this is for.
      const blob = "0x" + "ab".repeat(100);
      const W = await ethers.getContractFactory("ERC1271WalletMock");
      const wallet = await W.deploy(blob);
      await wallet.waitForDeployment();
      const walletAddr = await wallet.getAddress();

      const amount = ethers.parseEther("5");
      await satori.transfer(walletAddr, ethers.parseEther("50"));
      const hubAddr = await hub.getAddress();

      // Drive the wallet so msg.sender at the hub is the wallet itself.
      const data = hub.interface.encodeFunctionData("voteWithPermit", [
        gameId, amount, { value: amount, deadline: FAR_FUTURE, signature: blob },
      ]);
      const balBefore = await token.balanceOf(walletAddr);
      await wallet.connect(alice).execute(hubAddr, data);
      expect(await token.balanceOf(walletAddr)).to.equal(balBefore - amount);
    });
  });

  // ==========================================================================
  describe("the EIP-712 domain the dapp derives", function () {
    // The dapp cannot be told the domain; it has to work it out from the token
    // (satori-ui/src/lib/permit.ts, resolvePermitDomain). If its derivation and
    // this token ever disagree, every signature it produces is well-formed,
    // costs the user a signing prompt, and is then rejected on-chain. That
    // failure arrives AFTER they signed, which is the worst place for it.
    //
    // These assertions are the link between the dapp's unit tests (which use a
    // fake token) and this suite (which uses the real one).

    it("SATORI's DOMAIN_SEPARATOR is reproducible from name() + version 1", async function () {
      const [chainId, name, verifyingContract, onChain] = await Promise.all([
        ethers.provider.getNetwork().then((n) => n.chainId),
        token.name(),
        token.getAddress(),
        token.DOMAIN_SEPARATOR(),
      ]);
      expect(
        ethers.TypedDataEncoder.hashDomain({ name, version: "1", chainId, verifyingContract }),
        "the dapp derives the domain this way; if it stops matching, permit signing breaks silently",
      ).to.equal(onChain);
    });

    it("SATORI answers ERC-5267 eip712Domain(), the dapp's preferred source", async function () {
      const d = await token.eip712Domain();
      const [chainId, verifyingContract] = await Promise.all([
        ethers.provider.getNetwork().then((n) => n.chainId),
        token.getAddress(),
      ]);
      expect(d[1]).to.equal(await token.name());
      expect(d[2]).to.equal("1");
      expect(d[3]).to.equal(chainId);
      expect(d[4]).to.equal(verifyingContract);
      // And it agrees with the separator, so the dapp's verify step accepts it.
      expect(
        ethers.TypedDataEncoder.hashDomain({ name: d[1], version: d[2], chainId, verifyingContract }),
      ).to.equal(await token.DOMAIN_SEPARATOR());
    });

    it("a signature built exactly the dapp's way is accepted on-chain", async function () {
      // End to end through the derived domain rather than a hardcoded one.
      const hubAddr = await hub.getAddress();
      const [chainId, verifyingContract] = await Promise.all([
        ethers.provider.getNetwork().then((n) => n.chainId),
        token.getAddress(),
      ]);
      const d = await token.eip712Domain();
      const domain = { name: d[1], version: d[2], chainId, verifyingContract };
      expect(ethers.TypedDataEncoder.hashDomain(domain)).to.equal(await token.DOMAIN_SEPARATOR());

      const amount = ethers.parseEther("3");
      const raw = await alice.signTypedData(
        domain,
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        {
          owner: alice.address, spender: hubAddr, value: amount,
          nonce: await token.nonces(alice.address), deadline: FAR_FUTURE,
        },
      );

      const streamTx = await satori.createSimpleDataStream("Domain Stream", owner.address);
      await streamTx.wait();
      const g = await fix.games.gameCount();

      const balBefore = await token.balanceOf(alice.address);
      await hub.connect(alice).voteWithPermit(g, amount, {
        value: amount, deadline: FAR_FUTURE, signature: raw,
      });
      expect(await token.balanceOf(alice.address)).to.equal(balBefore - amount);
    });
  });

  // ==========================================================================
  describe("SatoriHub — stream creation with permit", function () {
    it("creates a simple stream in ONE transaction", async function () {
      const hubAddr = await hub.getAddress();
      const fee = await lens.streamBurn();
      const sig = await signPermit(token, alice, hubAddr, fee, FAR_FUTURE);

      const before = await fix.registry.nextStreamId();
      await hub
        .connect(alice)
        .createSimpleDataStreamWithPermit("One Press", alice.address, 1440, satoriPermit(fee, FAR_FUTURE, sig));
      expect(await fix.registry.nextStreamId()).to.equal(before + 1n);
    });

    it("creates an ADAPTER stream in ONE transaction", async function () {
      const hubAddr = await hub.getAddress();
      const fee = await lens.streamBurn();
      const sig = await signPermit(token, alice, hubAddr, fee, FAR_FUTURE);
      const before = await fix.registry.nextStreamId();
      await hub.connect(alice).createAdapterDataStreamWithPermit(
        "Feed", 3 /* custom: any non-zero target validates */, bob.address, "0x", 1440,
        satoriPermit(fee, FAR_FUTURE, sig),
      );
      expect(await fix.registry.nextStreamId()).to.equal(before + 1n);
    });

    it("charges exactly the same fee as the non-permit twin", async function () {
      const hubAddr = await hub.getAddress();
      const fee = await lens.streamBurn();

      const sig = await signPermit(token, alice, hubAddr, fee, FAR_FUTURE);
      const aliceBefore = await token.balanceOf(alice.address);
      await hub
        .connect(alice)
        .createSimpleDataStreamWithPermit("A", alice.address, 1440, satoriPermit(fee, FAR_FUTURE, sig));
      const alicePaid = aliceBefore - (await token.balanceOf(alice.address));

      await token.connect(bob).approve(hubAddr, fee);
      const bobBefore = await token.balanceOf(bob.address);
      await hub.connect(bob)["createSimpleDataStream(string,address,uint24)"]("B", bob.address, 1440);
      const bobPaid = bobBefore - (await token.balanceOf(bob.address));

      expect(alicePaid).to.equal(bobPaid);
      expect(alicePaid).to.equal(fee);
    });
  });

  // ==========================================================================
  describe("SatoriBounties — funding and staking with permit", function () {
    let gameId, usdc, plain, phantom;

    beforeEach(async function () {
      const tx = await satori.createSimpleDataStream("Bounty Stream", owner.address);
      await tx.wait();
      gameId = await fix.games.gameCount();

      const P = await ethers.getContractFactory("MockERC20Permit");
      usdc = await P.deploy("USDCP", "USDCP", 18);
      await usdc.waitForDeployment();
      await usdc.mint(alice.address, ethers.parseEther("1000"));

      const M = await ethers.getContractFactory("MockERC20");
      plain = await M.deploy("PLAIN", "PLAIN");
      await plain.waitForDeployment();
      await plain.mint(alice.address, ethers.parseEther("1000"));

      const Ph = await ethers.getContractFactory("MockPhantomPermitERC20");
      phantom = await Ph.deploy();
      await phantom.waitForDeployment();
      await phantom.mint(alice.address, ethers.parseEther("1000"));
    });

    it("stakes a bounty token in ONE transaction", async function () {
      const amount = ethers.parseEther("100");
      const bAddr = await bounties.getAddress();
      const sig = await signPermit(usdc, alice, bAddr, amount, FAR_FUTURE);

      await bounties
        .connect(alice)
        .stakeBountyTokenWithPermit(await usdc.getAddress(), amount, tokenPermit(amount, FAR_FUTURE, sig));

      expect(await bounties.bountyStake(alice.address, await usdc.getAddress())).to.equal(amount);
    });

    it("funds a first non-SATORI bounty in ONE transaction, permitting BOTH the token and the SATORI fee", async function () {
      const amount = ethers.parseEther("100");
      const rate = ethers.parseEther("1");
      const bAddr = await bounties.getAddress();
      const hubAddr = await hub.getAddress();
      const postFee = await lens.bountyBurn();

      const tokSig = await signPermit(usdc, alice, bAddr, amount, FAR_FUTURE);
      const satSig = await signPermit(token, alice, hubAddr, postFee, FAR_FUTURE);

      const satoriBefore = await token.balanceOf(alice.address);
      await bounties
        .connect(alice)
        .fundBountyWithPermit(
          gameId,
          await usdc.getAddress(),
          amount,
          rate,
          tokenPermit(amount, FAR_FUTURE, tokSig),
          satoriPermit(postFee, FAR_FUTURE, satSig),
        );

      expect(await bounties.pool(gameId, await usdc.getAddress())).to.equal(amount);
      expect(satoriBefore - (await token.balanceOf(alice.address))).to.equal(postFee);
    });

    it("reverts a first non-SATORI post when the SATORI fee is not covered", async function () {
      const amount = ethers.parseEther("100");
      const bAddr = await bounties.getAddress();
      const tokSig = await signPermit(usdc, alice, bAddr, amount, FAR_FUTURE);

      await expect(
        bounties
          .connect(alice)
          .fundBountyWithPermit(
            gameId,
            await usdc.getAddress(),
            amount,
            ethers.parseEther("1"),
            tokenPermit(amount, FAR_FUTURE, tokSig),
            NO_PERMIT_SATORI,
          ),
      ).to.be.reverted;
      expect(await bounties.pool(gameId, await usdc.getAddress())).to.equal(0n);
    });

    it("accepts a token with NO permit at all, using its existing allowance", async function () {
      const amount = ethers.parseEther("100");
      const bAddr = await bounties.getAddress();
      await plain.connect(alice).approve(bAddr, amount);

      await bounties
        .connect(alice)
        .stakeBountyTokenWithPermit(await plain.getAddress(), amount, NO_PERMIT_TOKEN);

      expect(await bounties.bountyStake(alice.address, await plain.getAddress())).to.equal(amount);
    });

    it("REVERTS on a phantom-permit token instead of trusting the permit's success", async function () {
      // This token has no permit and a permissive fallback, so `permit(...)`
      // returns successfully having granted nothing. An implementation that read
      // that success as "allowance granted" would sail past here and fail
      // somewhere far less obvious — or, if it also skipped the transfer's
      // return check, book a stake that was never paid for.
      const amount = ethers.parseEther("100");
      const phantomAddr = await phantom.getAddress();
      expect(await phantom.allowance(alice.address, await bounties.getAddress())).to.equal(0n);

      await expect(
        bounties.connect(alice).stakeBountyTokenWithPermit(phantomAddr, amount, {
          value: amount, deadline: FAR_FUTURE, v: 27, r: ethers.ZeroHash, s: ethers.ZeroHash,
        }),
      ).to.be.reverted;
      expect(await bounties.bountyStake(alice.address, phantomAddr)).to.equal(0n);
    });

    it("postingFeeApplies tracks the fee rule the charge actually uses", async function () {
      const usdcAddr = await usdc.getAddress();
      const bAddr = await bounties.getAddress();
      const hubAddr = await hub.getAddress();

      // A pair nobody has funded, in a non-SATORI token: fee due.
      expect(await bounties.postingFeeApplies(gameId, usdcAddr)).to.equal(true);
      // SATORI itself is always free.
      expect(await bounties.postingFeeApplies(gameId, await token.getAddress())).to.equal(false);

      const amount = ethers.parseEther("100");
      const postFee = await lens.bountyBurn();
      const tokSig = await signPermit(usdc, alice, bAddr, amount, FAR_FUTURE);
      const satSig = await signPermit(token, alice, hubAddr, postFee, FAR_FUTURE);
      await bounties
        .connect(alice)
        .fundBountyWithPermit(
          gameId, usdcAddr, amount, ethers.parseEther("1"),
          tokenPermit(amount, FAR_FUTURE, tokSig),
          satoriPermit(postFee, FAR_FUTURE, satSig),
        );

      // Posted: top-ups of the same pair are free, and the view says so.
      expect(await bounties.postingFeeApplies(gameId, usdcAddr)).to.equal(false);

      const satoriBefore = await token.balanceOf(alice.address);
      const topUp = ethers.parseEther("10");
      const sig2 = await signPermit(usdc, alice, bAddr, topUp, FAR_FUTURE);
      await bounties
        .connect(alice)
        .fundBountyWithPermit(
          gameId, usdcAddr, topUp, ethers.parseEther("1"),
          tokenPermit(topUp, FAR_FUTURE, sig2),
          NO_PERMIT_SATORI, // no SATORI permit, and none needed
        );
      expect(await token.balanceOf(alice.address)).to.equal(satoriBefore);
    });

    it("still succeeds when a bounty-token permit is FRONT-RUN", async function () {
      const amount = ethers.parseEther("100");
      const bAddr = await bounties.getAddress();
      const sig = await signPermit(usdc, alice, bAddr, amount, FAR_FUTURE);

      await usdc.connect(bob).permit(alice.address, bAddr, amount, FAR_FUTURE, sig.v, sig.r, sig.s);

      await bounties
        .connect(alice)
        .stakeBountyTokenWithPermit(await usdc.getAddress(), amount, tokenPermit(amount, FAR_FUTURE, sig));
      expect(await bounties.bountyStake(alice.address, await usdc.getAddress())).to.equal(amount);
    });
  });
});
