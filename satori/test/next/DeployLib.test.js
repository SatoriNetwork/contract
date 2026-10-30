// The pure decisions behind deploy.js, handoff.js and deploy-remote-token.js
// (M02, M06). The scripts themselves are rehearsed on a local chain.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  BASE_MAINNET, SAFE, predictSafe, rootPolicy, adoption, delegationCalls, delegated,
  encodeMultiSend, txBuilderBatch, txBuilderChecksum, validateInputs, checkFeeTree,
} = require("../../scripts/deploy-lib");

const Z = ethers.ZeroAddress;
const DEPLOYER = "0x9d3109b8A045D63056Aa5C1d2c883F3F9fA18817";
const SAFE_ADDR = "0x61a9E0Fe02068C4BCCea665D21e93ebE81d62f18";
const OWNERS = ["0x954A9e51Fe4fFeFAeE55f461ed2c745B570b3217", "0x36E39A7ebbb774268a179C192D79450b6627907F", "0x6Ea8DBd3C16Bc81b82Fb977FA33719C4C08a3142", "0x624bde5971976FEB27e049bE6911249114DB7B2a", "0xD188dFe3517a4A5358685f3e2544771EE2d398E4"];
// SafeProxyFactory 1.4.1's proxyCreationCode(), read from Base Sepolia.
const PROXY_CREATION_CODE = "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564";
const goodSafe = { owners: OWNERS, threshold: 3, reproducible: true, modules: [], singleton: SAFE.singleton };

describe("deploy-lib", function () {
  describe("predictSafe", function () {
    it("reproduces the Base Sepolia rehearsal Safe from its owners, threshold and salt nonce 0", function () {
      expect(predictSafe({ owners: OWNERS, threshold: 3, saltNonce: 0, proxyCreationCode: PROXY_CREATION_CODE }))
        .to.equal(SAFE_ADDR);
    });
    it("moves with the owner set, the threshold and the nonce", function () {
      const args = { owners: OWNERS, threshold: 3, saltNonce: 0, proxyCreationCode: PROXY_CREATION_CODE };
      expect(predictSafe({ ...args, threshold: 2 })).to.not.equal(SAFE_ADDR);
      expect(predictSafe({ ...args, saltNonce: 1 })).to.not.equal(SAFE_ADDR);
      expect(predictSafe({ ...args, owners: OWNERS.slice(1) })).to.not.equal(SAFE_ADDR);
    });
  });

  describe("rootPolicy (M02)", function () {
    const base = (governor, safe) => rootPolicy({ chainId: BASE_MAINNET, governor, deployer: DEPLOYER, safe, local: false });
    it("on Base, refuses the deployer as root", function () {
      expect(base(DEPLOYER, null).errors[0]).to.match(/GOVERNOR is the deployer/);
    });
    it("on Base, refuses a root that is not a Safe", function () {
      expect(base(SAFE_ADDR, null).errors[0]).to.match(/is not a Safe/);
    });
    it("on Base, warns on a 1-of-n Safe without refusing it", function () {
      const r = base(SAFE_ADDR, { ...goodSafe, threshold: 1 });
      expect(r.errors).to.deep.equal([]);
      expect(r.warnings[0]).to.match(/any one owner alone is root/);
    });
    it("on Base, refuses a Safe the deployer owns, and a Safe other chains cannot reproduce", function () {
      expect(base(SAFE_ADDR, { ...goodSafe, owners: [...OWNERS, DEPLOYER] }).errors[0]).to.match(/deployer is an owner/);
      expect(base(SAFE_ADDR, { ...goodSafe, reproducible: false }).errors[0]).to.match(/same address on other chains/);
    });
    it("on Base, refuses a Safe with a module, or one running another singleton", function () {
      expect(base(SAFE_ADDR, { ...goodSafe, modules: [DEPLOYER] }).errors[0]).to.match(/module acts as the Safe/);
      expect(base(SAFE_ADDR, { ...goodSafe, singleton: DEPLOYER }).errors[0]).to.match(/not SafeL2 1.4.1/);
    });
    it("on Base, accepts a reproducible multi-signature Safe", function () {
      expect(base(SAFE_ADDR, goodSafe)).to.deep.equal({ errors: [], warnings: [] });
    });
    it("off Base, turns every refusal into a warning, and says nothing on a local chain", function () {
      const sep = rootPolicy({ chainId: 84532, governor: DEPLOYER, deployer: DEPLOYER, safe: null, local: false });
      expect(sep.errors).to.deep.equal([]);
      expect(sep.warnings[0]).to.match(/root of every copy/);
      const oneOfN = rootPolicy({ chainId: 84532, governor: SAFE_ADDR, deployer: DEPLOYER, safe: { ...goodSafe, threshold: 1 }, local: false });
      expect(oneOfN.errors).to.deep.equal([]);
      expect(oneOfN.warnings[0]).to.match(/any one owner alone is root/);
      expect(rootPolicy({ chainId: 31337, governor: DEPLOYER, deployer: DEPLOYER, safe: null, local: true }))
        .to.deep.equal({ errors: [], warnings: [] });
    });
  });

  describe("adoption (M06)", function () {
    it("adopts a token no stack has finished with", function () {
      expect(adoption({ controller: Z, controllerFinished: false, frozen: [] })).to.deep.equal({ adopt: true });
      expect(adoption({ controller: SAFE_ADDR, controllerFinished: false, frozen: [] })).to.deep.equal({ adopt: true });
    });
    it("refuses a finished stack and a token with a frozen lever", function () {
      expect(adoption({ controller: SAFE_ADDR, controllerFinished: true, frozen: [] }).error).to.match(/finished stack/);
      expect(adoption({ controller: Z, controllerFinished: false, frozen: ["airdrop"] }).error).to.match(/frozen levers \(airdrop\)/);
    });
  });

  describe("the Safe's delegation transaction (M02)", function () {
    const iface = new ethers.Interface([
      "function setWiringAuthority(address)", "function setAppointAuthority(address)", "function transfer(address,uint256)",
    ]);
    const TOKEN = "0x035b1Dc570f7e7460FC4Bd84EA13BAd211467861";
    const FEE = ethers.parseEther("0.001");

    it("lends the deployer wiring, appoint and the fee, all on the token", function () {
      const calls = delegationCalls(iface, TOKEN, DEPLOYER, FEE);
      expect(calls.map((c) => iface.parseTransaction({ data: c.data }).name))
        .to.deep.equal(["setWiringAuthority", "setAppointAuthority", "transfer"]);
      expect(calls.every((c) => c.to === TOKEN)).to.equal(true);
      expect(calls.map((c) => iface.parseTransaction({ data: c.data }).args.toArray()))
        .to.deep.equal([[DEPLOYER], [DEPLOYER], [DEPLOYER, FEE]]);
    });

    it("counts as done only with both slots and the fee", function () {
      const s = { wiring: DEPLOYER, appoint: DEPLOYER, balance: FEE };
      expect(delegated(s, DEPLOYER, FEE)).to.equal(true);
      expect(delegated({ ...s, wiring: SAFE_ADDR }, DEPLOYER, FEE)).to.equal(false);
      expect(delegated({ ...s, appoint: SAFE_ADDR }, DEPLOYER, FEE)).to.equal(false);
      expect(delegated({ ...s, balance: FEE - 1n }, DEPLOYER, FEE)).to.equal(false);
    });

    it("writes a Transaction Builder file the Safe UI accepts: string values, and its checksum", function () {
      const calls = delegationCalls(iface, TOKEN, DEPLOYER, FEE);
      const b = txBuilderBatch({ chainId: 8453n, safe: SAFE_ADDR, name: "n", calls, createdAt: 1 });
      expect(b.version).to.equal("1.0");
      expect(b.chainId).to.equal("8453");
      expect(b.meta.createdFromSafeAddress).to.equal(SAFE_ADDR);
      expect(b.transactions).to.deep.equal(calls.map((c) => ({ to: c.to, value: "0", data: c.data, contractMethod: null, contractInputsValues: null })));
      // The UI checks it with meta.checksum removed and meta.name nulled.
      const { checksum, ...meta } = b.meta;
      expect(checksum).to.equal(txBuilderChecksum({ ...b, meta }));
      expect(txBuilderChecksum({ ...b, meta: { ...meta, name: "renamed" } })).to.equal(checksum);
      expect(txBuilderChecksum({ ...b, meta, transactions: b.transactions.slice(1) })).to.not.equal(checksum);
    });

    it("packs MultiSendCallOnly's format: operation, to, value, length, data per call", function () {
      const calls = delegationCalls(iface, TOKEN, DEPLOYER, FEE);
      const data = encodeMultiSend(calls);
      const [packed] = new ethers.Interface(["function multiSend(bytes)"]).decodeFunctionData("multiSend", data);
      let at = 2; // past "0x"
      for (const c of calls) {
        expect(packed.slice(at, at + 2)).to.equal("00");
        expect(ethers.getAddress("0x" + packed.slice(at + 2, at + 42))).to.equal(TOKEN);
        expect(BigInt("0x" + packed.slice(at + 42, at + 106))).to.equal(0n);
        const len = Number(BigInt("0x" + packed.slice(at + 106, at + 170)));
        expect("0x" + packed.slice(at + 170, at + 170 + len * 2)).to.equal(c.data);
        at += 170 + len * 2;
      }
      expect(at).to.equal(packed.length);
    });
  });

  describe("validateInputs (M06)", function () {
    it("takes the defaults", function () {
      expect(validateInputs({})).to.deep.equal({ holderWindow: 256, holderPeriod: 604800, rootPublisher: null });
    });
    it("refuses what the governors would refuse after the token exists", function () {
      expect(() => validateInputs({ ACTIVATION_WINDOW_BLOCKS: "257" })).to.throw(/1\.\.256/);
      expect(() => validateInputs({ ACTIVATION_WINDOW_BLOCKS: "0" })).to.throw(/1\.\.256/);
      expect(() => validateInputs({ VOTING_PERIOD_SECONDS: "0" })).to.throw(/VOTING_PERIOD_SECONDS/);
      for (const bad of ["abc", "1.5", "1e30", "-3"]) {
        expect(() => validateInputs({ ACTIVATION_WINDOW_BLOCKS: bad })).to.throw(/ACTIVATION_WINDOW_BLOCKS/);
        expect(() => validateInputs({ VOTING_PERIOD_SECONDS: bad })).to.throw(/VOTING_PERIOD_SECONDS/);
      }
      expect(() => validateInputs({ VOTING_PERIOD_SECONDS: String(2n ** 40n + 1n) })).to.throw(/uint48/);
      expect(validateInputs({ VOTING_PERIOD_SECONDS: String(2n ** 40n) }).holderPeriod).to.equal(2 ** 40);
    });
    it("refuses a ROOT_PUBLISHER that is not a nonzero address, instead of quietly using the deployer", function () {
      expect(() => validateInputs({ ROOT_PUBLISHER: "0xnope" })).to.throw(/ROOT_PUBLISHER/);
      expect(() => validateInputs({ ROOT_PUBLISHER: Z })).to.throw(/ROOT_PUBLISHER/);
      expect(validateInputs({ ROOT_PUBLISHER: SAFE_ADDR.toLowerCase() }).rootPublisher).to.equal(SAFE_ADDR);
    });
  });
  describe("checkFeeTree (M05)", function () {
    let F, p, authC, authB, eoa;
    beforeEach(async function () {
      F = await ethers.getContractFactory("SatoriSplitterImmutable");
      const s = await ethers.getSigners();
      p = s.slice(1, 5).map((x) => x.address);
      [authC, authB, eoa] = [s[5].address, s[6].address, s[7].address];
    });
    async function split(auth, payees, shares, threshold = 0) {
      const c = await F.deploy(auth, payees, shares.map(BigInt), threshold);
      await c.waitForDeployment();
      return c.getAddress();
    }
    async function tree({ bThreshold = 6000, cAuth = authC } = {}) {
      const c = await split(cAuth, [p[0], p[1]], [5000, 5000]);
      const b = await split(authB, [p[2], p[3]], [5000, 5000], bThreshold);
      const a = await split(Z, [c, b], [6000, 4000]);
      const file = { chainId: 31337, verified: true, platformFeeRecipient: a, a, c, b,
        payees: { PAYEE_1: p[0], PAYEE_2: p[1], PAYEE_3: p[2], PAYEE_4: p[3] },
        authorities: { C: authC, B: authB } };
      return { a, b, c, file };
    }
    // The runtime code SatoriSplitterImmutable deploys with a given threshold
    // (its only immutable besides totalShares), by simulating a deployment.
    const runtimeFor = async (threshold) => ethers.provider.call({
      data: (await F.getDeployTransaction(authC, [p[0], p[1]], [5000n, 5000n], threshold)).data });

    it("passes the tree deploy-splitters.js builds, with and without its file", async function () {
      const t = await tree();
      expect((await checkFeeTree(ethers.provider, t.a, t.file, 31337)).problems).to.deep.equal([]);
      expect((await checkFeeTree(ethers.provider, t.a, null, 31337)).problems).to.deep.equal([]);
    });

    it("refuses an address with no code, a contract that is not a splitter, and a top whose slots are not splitters", async function () {
      expect((await checkFeeTree(ethers.provider, eoa, null, 31337)).problems[0]).to.match(/no code/);
      const mock = await (await (await ethers.getContractFactory("MockCoined")).deploy()).getAddress();
      expect((await checkFeeTree(ethers.provider, mock, null, 31337)).problems).to.have.length(1);
      expect((await checkFeeTree(ethers.provider, mock, null, 31337)).problems[0]).to.match(/did not answer like a splitter/);
      const a = await split(Z, [p[0], p[1]], [6000, 4000]);
      expect((await checkFeeTree(ethers.provider, a, null, 31337)).problems.join(" ")).to.match(/not a splitter/);
    });

    it("refuses a top with an authority, other shares, or another slot count", async function () {
      const t = await tree();
      const withAuth = await split(authC, [t.c, t.b], [6000, 4000]);
      expect((await checkFeeTree(ethers.provider, withAuth, null, 31337)).problems.join(" ")).to.match(/authority/);
      const even = await split(Z, [t.c, t.b], [5000, 5000]);
      expect((await checkFeeTree(ethers.provider, even, null, 31337)).problems.join(" ")).to.match(/6000.*4000/);
      const three = await split(Z, [t.c, t.b, eoa], [6000, 3000, 1000]);
      expect((await checkFeeTree(ethers.provider, three, null, 31337)).problems.join(" ")).to.match(/2 slots/);
    });

    it("refuses a branch that does not split 50/50", async function () {
      const c = await split(authC, [p[0], p[1]], [7000, 3000]);
      const b = await split(authB, [p[2], p[3]], [5000, 5000], 1000);
      const a = await split(Z, [c, b], [6000, 4000]);
      expect((await checkFeeTree(ethers.provider, a, null, 31337)).problems.join(" ")).to.match(/5000.*5000/);
    });

    it("refuses a file from another chain, or one naming other branches or payees", async function () {
      const t = await tree();
      const probe = (file) => checkFeeTree(ethers.provider, t.a, file, 31337).then((r) => r.problems.join(" "));
      expect(await probe({ ...t.file, chainId: 84532 })).to.match(/chain 84532/);
      expect(await probe({ ...t.file, c: t.b, b: t.c })).to.match(/file/);
      expect(await probe({ ...t.file, payees: { ...t.file.payees, PAYEE_4: eoa } })).to.match(/PAYEE_4/);
    });

    it("refuses a branch under another authority, or with another rotation threshold", async function () {
      const t = await tree({ cAuth: eoa });
      expect((await checkFeeTree(ethers.provider, t.a, t.file, 31337)).problems.join(" ")).to.match(/C's authority/);
      const u = await tree({ bThreshold: 9000 });
      expect((await checkFeeTree(ethers.provider, u.a, null, 31337)).problems.join(" ")).to.match(/B's rotation threshold is 9000, not 6000/);
    });

    it("holds the tree to the operator's own PAYEE and SPLITTER_AUTHORITY inputs when there is no file", async function () {
      const t = await tree();
      const expectIn = { payees: p, authorities: { C: authC, B: authB } };
      expect((await checkFeeTree(ethers.provider, t.a, null, 31337, { expect: expectIn })).problems).to.deep.equal([]);
      const wrong = { ...expectIn, payees: [p[0], p[1], p[2], eoa] };
      expect((await checkFeeTree(ethers.provider, t.a, null, 31337, { expect: wrong })).problems.join(" ")).to.match(/PAYEE_4/);
      const wrongAuth = { ...expectIn, authorities: { C: authC, B: eoa } };
      expect((await checkFeeTree(ethers.provider, t.a, null, 31337, { expect: wrongAuth })).problems.join(" ")).to.match(/B's authority/);
    });

    it("refuses a node whose code is not SatoriSplitterImmutable, even if it answers the same", async function () {
      const t = await tree();
      expect((await checkFeeTree(ethers.provider, t.a, t.file, 31337, { runtimeFor })).problems).to.deep.equal([]);
      const lie = async (threshold) => (await runtimeFor(threshold)).slice(0, -2) + "00";
      expect((await checkFeeTree(ethers.provider, t.a, t.file, 31337, { runtimeFor: lie })).problems.join(" "))
        .to.match(/A's code is not SatoriSplitterImmutable/);
    });

    it("describes the effective split it checked", async function () {
      const t = await tree();
      const { split: eff } = await checkFeeTree(ethers.provider, t.a, null, 31337);
      expect(eff).to.deep.equal({ [p[0]]: 3000n, [p[1]]: 3000n, [p[2]]: 2000n, [p[3]]: 2000n });
    });
  });
});
