"use strict";
const { ethers } = require("ethers");
const loadConfig = require("./config");
const { Ledger } = require("./ledger");
const { Pipeline } = require("./proposals");
const server = require("./server");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two independent loops share one provider and one ledger:
//
//   watch loop   — every POLL_MS: new proposals, activation, holder proofs.
//   ledger loop  — every POLL_MS: keep the Transfer scan warm.
//
// They are separate for one reason: a long ledger backfill (first boot on a
// mainnet RPC) must NEVER delay an activation, whose window on Base is about
// two minutes. The watch loop touches the ledger only through advanceTo(S),
// which is mutex-serialized inside the ledger itself.
async function main() {
  const cfg = loadConfig();
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const net = await provider.getNetwork();               // fail fast if unreachable

  const signer = cfg.activatorKey ? new ethers.Wallet(cfg.activatorKey, provider) : null;
  const ledger = new Ledger(provider, "", cfg);          // token addr set after init
  const pipeline = new Pipeline(provider, signer, cfg, ledger);
  await pipeline.init();
  ledger.token = pipeline.token;                         // governor is the authority on the token

  const status = {
    chainId: Number(net.chainId),
    governor: cfg.governor,
    token: pipeline.token,
    activator: signer ? signer.address : null,
    activationWindow: pipeline.window,
    startedAt: Math.floor(Date.now() / 1000),
    head: 0,
    watchError: null,
    ledgerError: null,
  };
  server.start(cfg, { status, ledger, pipeline });
  console.log(`proof-pipeline up: chain=${status.chainId} governor=${cfg.governor} ` +
              `token=${pipeline.token} activator=${status.activator ?? "NONE (watch-only)"} ` +
              `port=${cfg.port}`);

  (async () => {                                         // watch loop
    for (;;) {
      try {
        status.head = await provider.getBlockNumber();
        await pipeline.tick(status.head);
        status.watchError = null;
      } catch (e) {
        status.watchError = String((e && e.message) || e);
      }
      await sleep(cfg.pollMs);
    }
  })();

  (async () => {                                         // ledger keep-warm loop
    for (;;) {
      try {
        if (status.head > 0) await ledger.advanceTo(status.head);
        status.ledgerError = null;
      } catch (e) {
        status.ledgerError = String((e && e.message) || e);
      }
      await sleep(cfg.pollMs);
    }
  })();
}

main().catch((e) => { console.error(e); process.exit(1); });
