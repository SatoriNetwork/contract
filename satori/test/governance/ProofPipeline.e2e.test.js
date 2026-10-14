const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// END TO END against the running satori-proof-pipeline daemon: the piece that
// makes holder voting operable by humans. A proposal's activation window is
// ~2 minutes on Base and the public RPC's eth_getProof retention is minutes
// (holder-voting-review.md §9) — nobody is going to run a script by hand in
// that window, so a daemon watches, activates, and precomputes every holder's
// ballot. This test proves the WHOLE loop with no hand off-stage:
//
//   propose  ->  daemon sees it, reconstructs the header, ACTIVATES it
//            ->  daemon enumerates holders from Transfer logs
//            ->  daemon serves each holder's balance proof over HTTP
//            ->  a voter casts with the served proof, weight == snapshot balance
//
// including the drained-holder case: carol empties her account right after the
// snapshot and still votes with her snapshot balance, because the ledger
// nominates recently-touched accounts, and the proof — not the ledger — is
// what the chain believes.
//
// Needs anvil (eth_getProof) AND the pipeline's node_modules:
//
//     cd ../satori-proof-pipeline && npm ci && cd ../satori
//     anvil --port 8549 --silent &
//     HARDHAT_URL=http://127.0.0.1:8549 npx hardhat test \
//         test/governance/ProofPipeline.e2e.test.js --network localhost

const PIPELINE = path.join(__dirname, "..", "..", "..", "satori-proof-pipeline");
const PORT = 8791;
const DAY = 24 * 60 * 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

describe("proof pipeline e2e — the daemon activates and serves ballots", function () {
  this.timeout(180000);

  let token, gov, tokenAddr, govAddr, dep, alice, bob, carol, nobody;
  let child, childLog, dataDir;

  before(async function () {
    [dep, alice, bob, carol, , , , , , nobody] = await ethers.getSigners();
    try {
      await network.provider.send("eth_getProof", [ethers.ZeroAddress, [], "latest"]);
    } catch {
      console.log("      (skipped: no eth_getProof — run against anvil)");
      this.skip();
    }
    if (!fs.existsSync(path.join(PIPELINE, "node_modules"))) {
      console.log("      (skipped: run npm ci in satori-proof-pipeline first)");
      this.skip();
    }

    const chainId = (await ethers.provider.getNetwork()).chainId;
    token = await (await ethers.getContractFactory("SatoriToken"))
      .deploy(dep.address, dep.address, chainId);
    await token.waitForDeployment();
    tokenAddr = await token.getAddress();

    gov = await (await ethers.getContractFactory("HistoricalBalanceGovernor"))
      .deploy(tokenAddr, 64, DAY);
    await gov.waitForDeployment();
    govAddr = await gov.getAddress();

    await (await token.transfer(alice.address, ethers.parseEther("100"))).wait();
    await (await token.transfer(bob.address, ethers.parseEther("40"))).wait();
    await (await token.transfer(carol.address, ethers.parseEther("10"))).wait();

    // The daemon's activator: a fresh key with dust ETH. Deliberately NOT one
    // of the node's unlocked accounts — the daemon signs for itself.
    const activator = ethers.Wallet.createRandom();
    await (await dep.sendTransaction({
      to: activator.address, value: ethers.parseEther("1"),
    })).wait();

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "proof-pipeline-e2e-"));
    childLog = "";
    child = spawn(process.execPath, [path.join(PIPELINE, "src", "index.js")], {
      env: {
        ...process.env,
        RPC_URL: network.config.url,
        GOVERNOR_ADDRESS: govAddr,
        ACTIVATOR_PRIVATE_KEY: activator.privateKey,
        DATA_DIR: dataDir,
        PORT: String(PORT),
        POLL_MS: "400",
        LOG_CHUNK: "2000",
        START_BLOCK: "0",
        PROOF_CONCURRENCY: "4",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => { childLog += d; });
    child.stderr.on("data", (d) => { childLog += d; });

    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      return r.ok;
    }, 20000, "pipeline /health").catch((e) => {
      console.log(childLog);
      throw e;
    });
  });

  after(function () {
    if (child) child.kill("SIGKILL");
    if (this.currentTest && this.test.parent.tests.some(t => t.state === "failed") && childLog) {
      console.log("---- pipeline log ----\n" + childLog);
    }
  });

  it("activates a proposal by itself and serves every holder's ballot", async function () {
    const rc = await (await gov.propose(
      ethers.id("actions"), ethers.id("desc"), 0, 5000)).wait();
    const ev = rc.logs.map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
                      .find(e => e && e.name === "ProposalCreated");
    const id = ev.args.proposalId;

    // Drain carol IMMEDIATELY — after the snapshot, before the daemon can
    // possibly have enumerated. Her snapshot balance must survive anyway.
    await (await token.connect(carol).transfer(bob.address, ethers.parseEther("10"))).wait();

    // The daemon — nobody else — must activate.
    await waitFor(async () => (await gov.proposal(id)).activated, 30000, "auto-activation");
    const p = await gov.proposal(id);
    expect(p.snapshotTotalSupply).to.be.gt(0n);

    // And finish precomputing every ballot.
    const meta = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/proposals/${id}`);
      if (!r.ok) return null;
      const m = await r.json();
      return m.proofsComplete ? m : null;
    }, 60000, "proofs complete");
    expect(meta.activationTx, "activation was the daemon's own tx").to.be.a("string");

    // alice votes with the served ballot — weight is her snapshot balance.
    const ra = await fetch(`http://127.0.0.1:${PORT}/proposals/${id}/proof/${alice.address}`);
    expect(ra.ok).to.equal(true);
    const ballotA = await ra.json();
    expect(BigInt(ballotA.balance)).to.equal(ethers.parseEther("100"));
    const rcA = await (await gov.connect(alice).castVote(id, 1, ballotA.proof)).wait();
    const cast = rcA.logs.map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
                         .find(e => e && e.name === "VoteCast");
    expect(cast.args.weight).to.equal(ethers.parseEther("100"));

    // carol — empty NOW — still votes with her snapshot 10.
    const rf = await fetch(`http://127.0.0.1:${PORT}/proposals/${id}/proof/${carol.address}`);
    expect(rf.ok, "drained holder still gets her snapshot ballot").to.equal(true);
    const ballotC = await rf.json();
    expect(BigInt(ballotC.balance)).to.equal(ethers.parseEther("10"));
    expect(await token.balanceOf(carol.address)).to.equal(0n);
    await (await gov.connect(carol).castVote(id, 0, ballotC.proof)).wait();
    expect((await gov.proposal(id)).againstVotes).to.equal(ethers.parseEther("10"));

    // a never-holder has no ballot, and the daemon says so plainly.
    const rn = await fetch(`http://127.0.0.1:${PORT}/proposals/${id}/proof/${nobody.address}`);
    expect(rn.status).to.equal(404);
  });

  it("stores a proposal's words only if they fit the on-chain commitment", async function () {
    const text = "Reduce the dev fee to 10%.\n\nSentiment only; no on-chain action.";
    const rc = await (await gov.propose(
      ethers.keccak256(ethers.toUtf8Bytes("")),        // no actions: sentiment
      ethers.keccak256(ethers.toUtf8Bytes(text)),
      0, 5000)).wait();
    const ev = rc.logs.map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
                      .find(e => e && e.name === "ProposalCreated");
    const id = ev.args.proposalId;
    await waitFor(async () =>
      (await fetch(`http://127.0.0.1:${PORT}/proposals/${id}`)).ok, 15000, "proposal seen");

    // The wrong words do not fit, from anyone.
    const bad = await fetch(`http://127.0.0.1:${PORT}/proposals/${id}/description`,
      { method: "POST", body: "Raise the dev fee to 25%." });
    expect(bad.status).to.equal(400);

    // The right words fit, from anyone.
    const good = await fetch(`http://127.0.0.1:${PORT}/proposals/${id}/description`,
      { method: "POST", body: text });
    expect(good.status).to.equal(200);

    const m = await (await fetch(`http://127.0.0.1:${PORT}/proposals/${id}`)).json();
    expect(m.description).to.equal(text);
  });

  it("reports its own state honestly over /status", async function () {
    const r = await fetch(`http://127.0.0.1:${PORT}/status`);
    const s = await r.json();
    expect(s.governor.toLowerCase()).to.equal(govAddr.toLowerCase());
    expect(s.token).to.equal(tokenAddr.toLowerCase());
    expect(s.activator).to.be.a("string");
    expect(s.holders).to.be.greaterThan(0);
    expect(s.proposals.length).to.equal(2);
    expect(s.proposals[0].proofsComplete).to.equal(true);
    expect(s.watchError).to.equal(null);
  });
});
