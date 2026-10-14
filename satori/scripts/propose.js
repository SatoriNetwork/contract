// Create a holder-voting proposal and hand its words to the proof pipeline.
//
//   DESCRIPTION_FILE=prop.md npx hardhat run scripts/propose.js --network baseSepolia
//
// Env:
//   DESCRIPTION_FILE     file whose exact bytes are the proposal text (or
//   DESCRIPTION          the text inline; FILE wins if both are set)
//   MIN_TURNOUT_BPS      default 0    — no turnout floor
//   APPROVAL_BPS         default 5000 — strict majority of for+against
//   PROOFS_URL           pipeline base URL (default http://127.0.0.1:8788);
//                        set empty to skip posting the text
//
// The chain stores keccak256 of the words; the pipeline stores the words and
// accepts them from anyone BECAUSE only the right ones fit the commitment.
// Everything after this script — activation, every voter's ballot — is the
// pipeline's job, on purpose: nothing here depends on a human being fast.
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const text = process.env.DESCRIPTION_FILE
    ? fs.readFileSync(process.env.DESCRIPTION_FILE, "utf8")
    : process.env.DESCRIPTION;
  if (!text) throw new Error("set DESCRIPTION_FILE or DESCRIPTION");

  const book = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
  const govAddr = book.addresses.holderGovernor;
  if (!govAddr) throw new Error(`no holderGovernor for ${network.name} — run deploy-governor.js`);

  const minTurnout = Number(process.env.MIN_TURNOUT_BPS || 0);
  const approval = Number(process.env.APPROVAL_BPS || 5000);
  const gov = await ethers.getContractAt("HistoricalBalanceGovernor", govAddr);

  const actionsHash = ethers.keccak256(ethers.toUtf8Bytes(""));   // sentiment: no actions
  const descriptionHash = ethers.keccak256(ethers.toUtf8Bytes(text));

  console.log(`propose() on ${govAddr} (${network.name})`);
  console.log(`  bar: turnout >= ${minTurnout / 100}%, approval > ${approval / 100}%`);
  const rc = await (await gov.propose(actionsHash, descriptionHash, minTurnout, approval)).wait();
  const ev = rc.logs.map((l) => { try { return gov.interface.parseLog(l); } catch { return null; } })
                    .find((e) => e && e.name === "ProposalCreated");
  const id = ev.args.proposalId;
  console.log(`  proposalId=${id}`);
  console.log(`  snapshotBlock=${ev.args.snapshotBlock} hash=${ev.args.snapshotBlockHash}`);
  console.log(`  activation deadline: block ${await gov.activationDeadline(id)}`);

  const base = process.env.PROOFS_URL ?? "http://127.0.0.1:8788";
  if (!base) { console.log("  PROOFS_URL empty — post the text yourself"); return; }

  // The pipeline learns of the proposal from the chain; give it a moment.
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${base}/proposals/${id}/description`, { method: "POST", body: text });
      if (r.status === 200) { console.log(`  words stored at ${base}/proposals/${id}`); return; }
      if (r.status === 400) throw new Error(await r.text());   // wrong words: never retry
    } catch (e) { if (String(e.message).includes("commitment")) throw e; }
    await sleep(2000);
  }
  console.log(`  WARNING: pipeline at ${base} never accepted the text — is it running?`);
}

main().catch((e) => { console.error(e); process.exit(1); });
