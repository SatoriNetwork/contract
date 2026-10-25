// The operator-side upgrade gate and chain guard (sweep M08, G12).
//
//   - check-upgrade-safety.js reads the implementation the proxy RUNS NOW off the
//     ERC-1967 slot and diffs current source against the layout recorded for that
//     implementation address; it refuses when none was recorded (M08).
//   - deploy-impl.js records the layout of every implementation it prepares, so the
//     next upgrade has something to compare with (M08).
//   - chain-guard.js refuses an address book for another chain (G12).
//
// The gate runs as the operator runs it: a child process against a node. The node
// is a throwaway `hardhat node` on a free port, reached through the `localhost`
// network (HARDHAT_URL), so nothing here touches another session's chain.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { layoutOf, TRACKED } = require("../scripts/storage-layout-lib");
const { requireChain } = require("../scripts/chain-guard");

const ROOT = path.join(__dirname, "..");
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PROXY = "0x000000000000000000000000000000000000c0DE";
const BOOK_NAME = "zz-opsgate-test";
const BOOK = path.join(ROOT, "deployments", `${BOOK_NAME}.json`);
const LOCAL_BOOK = path.join(ROOT, "deployments", "localhost.json");

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  srv.on("error", reject);
});

describe("Ops scripts — chain guard", function () {
  const provider = (chainId) => ({ getNetwork: async () => ({ chainId: BigInt(chainId) }) });

  it("passes when the book names the chain the node answers", async function () {
    expect(await requireChain(provider(84532), { chainId: 84532 })).to.equal(84532);
  });

  it("refuses an address book for another chain, naming both", async function () {
    let err;
    try { await requireChain(provider(8453), { chainId: 84532 }); } catch (e) { err = e; }
    expect(err, "must refuse").to.not.equal(undefined);
    expect(err.message).to.contain("84532").and.to.contain("8453");
  });

  it("does not refuse when the book carries no chain id, or there is no book", async function () {
    expect(await requireChain(provider(8453), {})).to.equal(8453);
    expect(await requireChain(provider(8453), null)).to.equal(8453);
  });

  it("the scripts that send transactions call it", function () {
    for (const f of ["set-capabilities.js", "load-airdrop.js", "publish-root.js", "sweep-airdrop.js"]) {
      expect(fs.readFileSync(path.join(ROOT, "scripts", f), "utf8"), f).to.contain("chain-guard");
    }
  });
});

describe("Ops scripts — the upgrade gate reads the LIVE implementation (M08)", function () {
  this.timeout(300000);
  let node, url, provider, signer, implA, layout;
  let hadLocalBook = false, localBookBackup;

  before(async function () {
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    node = spawn(process.execPath, [path.join(ROOT, "..", "node_modules", "hardhat", "internal", "cli", "bootstrap.js"),
      "node", "--port", String(port)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("hardhat node did not start")), 120000);
      node.stdout.on("data", (d) => { if (String(d).includes("Started HTTP")) { clearTimeout(t); resolve(); } });
      node.on("exit", (c) => { clearTimeout(t); reject(new Error(`hardhat node exited ${c}`)); });
    });
    provider = new ethers.JsonRpcProvider(url);
    signer = await provider.getSigner(0);
    const F = (await ethers.getContractFactory("SatoriRegistry")).connect(signer);
    const impl = await F.deploy();
    await impl.waitForDeployment();
    implA = (await impl.getAddress()).toLowerCase();
    await provider.send("hardhat_setStorageAt", [PROXY, IMPL_SLOT, ethers.zeroPadValue(implA, 32)]);
    layout = await layoutOf(TRACKED.find((t) => t.endsWith(":SatoriRegistry")));

    hadLocalBook = fs.existsSync(LOCAL_BOOK);
    if (hadLocalBook) localBookBackup = fs.readFileSync(LOCAL_BOOK);
  });

  after(function () {
    if (node) node.kill();
    fs.rmSync(BOOK, { force: true });
    if (hadLocalBook) fs.writeFileSync(LOCAL_BOOK, localBookBackup); else fs.rmSync(LOCAL_BOOK, { force: true });
  });

  const writeBook = (book, file = BOOK) => fs.writeFileSync(file, JSON.stringify(book, null, 2));
  const check = (env) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "check-upgrade-safety.js")], {
    cwd: ROOT, encoding: "utf8", timeout: 120000,
    env: { ...process.env, CONTRACT: "SatoriRegistry", NETWORK: BOOK_NAME, HARDHAT_NETWORK: "localhost", HARDHAT_URL: url, ...env },
  });
  const out = (r) => `${r.stdout}\n${r.stderr}`;

  it("passes against the layout recorded for the implementation the proxy runs", function () {
    writeBook({ layouts: {}, implLayouts: { [implA]: layout } });
    const r = check({ PROXY });
    expect(r.status, out(r)).to.equal(0);
    expect(out(r)).to.contain("live implementation").and.to.contain("SAFE");
  });

  it("uses the live implementation's layout, not the deploy-time one", function () {
    // The deploy-time layout is drifted, the live implementation's is right. A
    // check that used the deploy-time one would refuse here.
    const drifted = layout.map((e, i) => i === 0 ? { ...e, slot: String(Number(e.slot) + 1) } : e);
    writeBook({ layouts: { SatoriRegistry: drifted }, implLayouts: { [implA]: layout } });
    expect(check({ PROXY }).status).to.equal(0);
  });

  it("refuses when no layout was recorded for the live implementation, even if a deploy-time one exists", function () {
    writeBook({ layouts: { SatoriRegistry: layout }, implLayouts: {} });
    const r = check({ PROXY });
    expect(r.status, out(r)).to.equal(1);
    expect(out(r)).to.contain("REFUSING").and.to.contain("no layout for the implementation");
  });

  it("refuses when the recorded layout for the live implementation has drifted from source", function () {
    const drifted = layout.map((e, i) => i === 0 ? { ...e, slot: String(Number(e.slot) + 1) } : e);
    writeBook({ layouts: { SatoriRegistry: layout }, implLayouts: { [implA]: drifted } });
    const r = check({ PROXY });
    expect(r.status, out(r)).to.equal(1);
    expect(out(r)).to.contain("UNSAFE TO UPGRADE");
  });

  it("refuses when a struct inside a stored variable changed shape since the recorded layout", function () {
    const withStruct = layout.findIndex((e) => /struct/.test(e.shape || ""));
    expect(withStruct, "SatoriRegistry holds a struct in storage").to.be.greaterThan(-1);
    const changed = layout.map((e, i) => i === withStruct ? { ...e, shape: e.shape.replace("uint", "int") } : e);
    writeBook({ layouts: {}, implLayouts: { [implA]: changed } });
    const r = check({ PROXY });
    expect(r.status, out(r)).to.equal(1);
    expect(out(r)).to.contain("UNSAFE TO UPGRADE");
  });

  it("without PROXY it falls back to the deploy-time layout, and refuses when there is none", function () {
    writeBook({ layouts: { SatoriRegistry: layout } });
    expect(check({}).status).to.equal(0);
    writeBook({ layouts: {} });
    const r = check({});
    expect(r.status, out(r)).to.equal(1);
    expect(out(r)).to.contain("REFUSING");
  });

  it("deploy-impl.js records the new implementation's layout under its address", function () {
    writeBook({ layouts: {}, implLayouts: { [implA]: layout } }, LOCAL_BOOK);
    const r = spawnSync(process.execPath,
      [path.join(ROOT, "..", "node_modules", "hardhat", "internal", "cli", "bootstrap.js"),
        "run", "scripts/deploy-impl.js", "--network", "localhost"], {
        cwd: ROOT, encoding: "utf8", timeout: 240000,
        env: { ...process.env, CONTRACT: "SatoriRegistry", PROXY, NETWORK: "localhost", HARDHAT_URL: url },
      });
    expect(r.status, out(r)).to.equal(0);
    const m = /impl NEW\s+(0x[0-9a-fA-F]{40})/.exec(r.stdout);
    expect(m, out(r)).to.not.equal(null);
    const book = JSON.parse(fs.readFileSync(LOCAL_BOOK, "utf8"));
    const added = m[1].toLowerCase();
    expect(Object.keys(book.implLayouts).sort()).to.deep.equal([implA, added].sort());
    expect(book.implLayouts[added]).to.deep.equal(layout);
    expect(book.implLayouts[implA], "the earlier entry is kept").to.deep.equal(layout);
  });

  it("deploy-impl.js refuses before deploying when the live implementation has no recorded layout", function () {
    writeBook({ layouts: { SatoriRegistry: layout }, implLayouts: {} }, LOCAL_BOOK);
    const r = spawnSync(process.execPath,
      [path.join(ROOT, "..", "node_modules", "hardhat", "internal", "cli", "bootstrap.js"),
        "run", "scripts/deploy-impl.js", "--network", "localhost"], {
        cwd: ROOT, encoding: "utf8", timeout: 240000,
        env: { ...process.env, CONTRACT: "SatoriRegistry", PROXY, NETWORK: "localhost", HARDHAT_URL: url },
      });
    expect(r.status, out(r)).to.not.equal(0);
    expect(out(r)).to.contain("REFUSING");
    expect(r.stdout).to.not.contain("impl NEW");
  });
});
