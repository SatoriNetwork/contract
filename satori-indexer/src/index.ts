import { Contract, JsonRpcProvider } from 'ethers';
import { loadConfig } from './config';
import { openDb, getMeta, setMeta, deleteFromBlock } from './db';
import { tokenIface } from './abi';
import { Indexer } from './indexer';
import { makeServer } from './server';

async function main() {
  const cfg = loadConfig();
  const provider = new JsonRpcProvider(cfg.rpcUrl);
  // Static polling provider: the indexer drives its own loop; no subscriptions.
  provider.pollingInterval = 60_000;

  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);

  // Start block: explicit env wins; else the token's deploymentBlock — the
  // same lower bound the dapp's own scans use.
  let startBlock = cfg.startBlock;
  if (startBlock == null) {
    const token = new Contract(cfg.addresses.token, tokenIface, provider);
    startBlock = Number(await token.deploymentBlock());
  }

  const db = openDb(cfg.dbPath);

  // A dataset is scoped to (chainId, address set). If either changed since
  // this DB file was written, the history inside is for a DIFFERENT
  // deployment — start clean rather than serve mixed data.
  // The optional addresses are in here too: pointing an existing dataset at a
  // DIFFERENT registry, voting or games contract would otherwise silently mix
  // two deployments' rows, since nothing else in the fingerprint would change.
  const a = cfg.addresses;
  // Bump when a new event is indexed: rows for it exist only from a rescan.
  const SCHEMA = 2;
  const fingerprint = `s${SCHEMA}:${chainId}:${a.token}:${a.engine}:${a.rewards}:${a.bounties}:${a.registry}:${a.voting}:${a.games}`;
  const prev = getMeta(db, 'fingerprint');
  if (prev !== null && prev !== fingerprint) {
    console.warn('[indexer] deployment fingerprint changed — resetting dataset');
    deleteFromBlock(db, 0);
    setMeta(db, 'lastScannedBlock', String(startBlock - 1));
  }
  setMeta(db, 'fingerprint', fingerprint);

  const indexer = new Indexer(db, provider, cfg, startBlock);
  const app = makeServer(db, indexer, chainId, cfg.addresses.registry !== '');
  app.listen(cfg.port, () => {
    console.log(`[indexer] chain ${chainId} · start block ${startBlock} · serving :${cfg.port}`);
  });

  // Follow loop runs for the container's lifetime; docker restarts on crash.
  await indexer.start();
}

main().catch((e) => {
  console.error('[indexer] fatal:', e);
  process.exit(1);
});
