import fs from 'fs';

// All configuration comes from the environment (12-factor; docker-friendly).
//
//   RPC_URL          required. The chain RPC the indexer follows.
//   ADDRESS_BOOK     path to a deploy address book JSON (scripts/deploy.js
//                    output: { chainId, addresses: { token, engine, rewards,
//                    bounties, ... } }). Mount it into the container, OR:
//   TOKEN_ADDRESS / ENGINE_ADDRESS / REWARDS_ADDRESS / BOUNTIES_ADDRESS
//                    individual overrides (each wins over the book).
//   REGISTRY_ADDRESS / VOTING_ADDRESS
//                    optional overrides for the two late-added contracts (see
//                    the Addresses interface below for why they are optional).
//   START_BLOCK      optional. Defaults to token.deploymentBlock() read
//                    on-chain at boot (the same lower bound the dapp uses).
//   DB_PATH          sqlite file (default /data/indexer.db — put /data on a
//                    docker volume).
//   PORT             HTTP port (default 8787).
//   POLL_MS          follow-loop cadence (default 6000ms; Base blocks are 2s).
//   CHUNK_SIZE       blocks per eth_getLogs request (default 1900). Both Base
//                    networks reject eth_getLogs spanning more than 2000 blocks
//                    (-32602 "query exceeds max block range 2000"), and Base is
//                    what this project deploys to, so the default sits just
//                    under that cap. Raise it on an archive node with no range
//                    limit; other providers cap differently, so check theirs
//                    before raising it.
//   REORG_DEPTH      overlap window re-scanned every tick so reorged-out logs
//                    can never persist (default 128 — mirrors the dapp).

export interface Addresses {
  token: string;
  engine: string;
  rewards: string;
  bounties: string;
  /// OPTIONAL, unlike the other four. Empty string means "not configured", and
  /// the stream tables simply stay empty.
  ///
  /// It is optional because making it required would hard-fail every existing
  /// deployment on its next restart, for a feature it was not asked to provide.
  /// The cost of optional is a silent-empty failure mode, so it is NOT silent:
  /// boot logs a warning, `/status` reports `streamsIndexed: false`, and the
  /// stream endpoints answer 503 rather than an empty array. An empty array
  /// would be indistinguishable from "this chain has no streams", which is the
  /// exact ambiguity that let the void-outcome bug hide for a release.
  registry: string;
  /// OPTIONAL, same deal as `registry`: added after deployments existed, so
  /// requiring it would hard-fail them on restart. Empty means the vote tables
  /// simply stay empty — and, per the registry precedent, NOT silently: boot
  /// warns, `/status` reports `votesIndexed: false`, and `/votes/:gameId`
  /// answers 503 rather than an empty ledger.
  ///
  voting: string;
  /// OPTIONAL, same deal: the game registry (`/games`). Empty means the game
  /// tables stay empty, boot warns, `/status` reports `gamesIndexed: false`
  /// and `/games` answers 503.
  games: string;
}

export interface Config {
  rpcUrl: string;
  addresses: Addresses;
  startBlock: number | null; // null => read token.deploymentBlock() at boot
  dbPath: string;
  port: number;
  pollMs: number;
  chunkSize: number;
  reorgDepth: number;
}

function fromBook(path: string): Partial<Addresses> {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  const a = raw.addresses ?? raw; // accept the deploy book or a flat map
  return {
    token: a.token, engine: a.engine, rewards: a.rewards, bounties: a.bounties,
    registry: a.registry, voting: a.voting, games: a.games,
  };
}

export function loadConfig(): Config {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL is required');

  let book: Partial<Addresses> = {};
  if (process.env.ADDRESS_BOOK) book = fromBook(process.env.ADDRESS_BOOK);

  const addresses: Addresses = {
    token: (process.env.TOKEN_ADDRESS ?? book.token ?? '').toLowerCase(),
    engine: (process.env.ENGINE_ADDRESS ?? book.engine ?? '').toLowerCase(),
    rewards: (process.env.REWARDS_ADDRESS ?? book.rewards ?? '').toLowerCase(),
    bounties: (process.env.BOUNTIES_ADDRESS ?? book.bounties ?? '').toLowerCase(),
    registry: (process.env.REGISTRY_ADDRESS ?? book.registry ?? '').toLowerCase(),
    voting: (process.env.VOTING_ADDRESS ?? book.voting ?? '').toLowerCase(),
    games: (process.env.GAMES_ADDRESS ?? book.games ?? '').toLowerCase(),
  };
  for (const [k, v] of Object.entries(addresses)) {
    if (k === 'registry' || k === 'voting' || k === 'games') continue; // optional — checked separately below
    if (!/^0x[0-9a-f]{40}$/.test(v)) {
      throw new Error(`Missing/invalid address for "${k}" — set ADDRESS_BOOK or ${k.toUpperCase()}_ADDRESS`);
    }
  }
  // Present but malformed is a typo, not a choice. Fail on it; only ABSENT is
  // the supported "I don't want stream indexing" signal.
  if (addresses.registry !== '' && !/^0x[0-9a-f]{40}$/.test(addresses.registry)) {
    throw new Error('REGISTRY_ADDRESS is set but is not a valid address');
  }
  if (addresses.voting !== '' && !/^0x[0-9a-f]{40}$/.test(addresses.voting)) {
    throw new Error('VOTING_ADDRESS is set but is not a valid address');
  }
  if (addresses.games !== '' && !/^0x[0-9a-f]{40}$/.test(addresses.games)) {
    throw new Error('GAMES_ADDRESS is set but is not a valid address');
  }
  if (addresses.games === '') {
    console.warn(
      '[config] GAMES_ADDRESS not set — game indexing is OFF. /games will answer\n' +
      '         503 and the game tables stay empty. Set it to enable.',
    );
  }
  if (addresses.voting === '') {
    console.warn(
      '[config] VOTING_ADDRESS not set — vote indexing is OFF. /votes/:gameId will\n' +
      '         answer 503 and the vote tables stay empty. Set it to enable.',
    );
  }
  if (addresses.registry === '') {
    console.warn(
      '[config] REGISTRY_ADDRESS not set — stream indexing is OFF. /streams and\n' +
      '         /streams/:id/values will answer 503, and the Nostr bridge and the\n' +
      "         dapp's \"my streams\" view have nothing to read. Set it to enable.",
    );
  }

  return {
    rpcUrl,
    addresses,
    startBlock: process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null,
    dbPath: process.env.DB_PATH ?? '/data/indexer.db',
    port: Number(process.env.PORT ?? 8787),
    pollMs: Number(process.env.POLL_MS ?? 6000),
    chunkSize: Number(process.env.CHUNK_SIZE ?? 1_900),
    reorgDepth: Number(process.env.REORG_DEPTH ?? 128),
  };
}
