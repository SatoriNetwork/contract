# satori-indexer

Companion event indexer for the Satori dapp. It follows one chain, mirrors the
five Satori event streams the dapp reads from history into SQLite, and serves
the exact reductions the dapp computes client-side today as a tiny read-only
JSON API. One docker image, one volume — nothing else.

Why it exists: the dapp's history views (leaderboard, sentiment, referral
earnings, bounty discovery) scan event logs from the browser. On a local chain
or young testnet that is instant; on Base (~43,200 blocks/day) it stops being
viable. See `../docs/issues/closed/dapp-event-indexer-before-base-mainnet.md` for the
full consumer matrix. The dapp side is already wired: set `indexerUrl` for the
chain in `satori-ui/src/contracts/addresses.ts` (or `REACT_APP_INDEXER_URL` at
build time) and the five consumers use it, falling back to the browser scan on
any failure — the indexer is an accelerator, not a dependency.

## What it indexes

| Event | Contract | Feeds |
|---|---|---|
| `PredictionScored` | engine | leaderboard |
| `PredictionMade` | engine | sentiment chart |
| `StreakThresholdSet` / `CurveConfigSet` | engine | each game's dust bar on `/games`, the curve on `/status` |
| `BountyFunded` / `BountyDripped` / `StrandedPotReclaimed` / `BountyTokenCleaned` | bounties | bounty discovery and pool state |
| `ReferralPaid` / `ReferralSet` | rewards | referral earnings, who you referred |
| `RewardSplit` / `DelegatorRewardsAccrued` / `ReferralPaid` / `RewardsClaimed` | rewards | `/rewards/:address` (each credit carries the balance it left; a claim zeroes it) |
| `RoundBudgetFrozen` | rewards | `/rounds/:round/budget` |
| `PredictionDelegated` / `PredictionUndelegated` / `DelegatePowerSynced` | rewards | `/delegation/:address` |
| `DataStreamCreated` / `NamedAdapterSet` / `NamedStreamCreated` / `StreamValueUpdated` / `NameUpdated` / `ProviderChanged` | registry | `/streams`, `/streams/:id/values` |
| `GameCreated` / `GameNameUpdated` / `GameAuthorityTransferred` | games | `/games` |
| `Voted` / `GameApprovedSet` / `VotesMoved` | voting | `/votes/:gameId` |

Every signature above comes from `src/events.json`, a copy of
`satori/test/fixtures/event-topics.json`, which `EventTopics.test.js` pins to the
compiled contracts. After a contract change to a consumed event, regenerate both
with `node satori/scripts/gen-event-topics.js` and review the diff.

Everything is a fold over logs. The indexer makes no contract call after boot
(`token.deploymentBlock()` for the start block, and only when `START_BLOCK` is
unset): `DataStreamCreated` carries the whole creation record, and `named` is
`adapterId == NamedAdapterSet.adapterId`. So any node that serves `eth_getLogs`
is enough, and two indexers over the same logs hold the same rows.

## API

All endpoints are GET, public, CORS `*`, `Cache-Control: max-age=5`.

| Route | Returns |
|---|---|
| `/health` | `{ok}` — 503 if the follow loop is persistently failing |
| `/status` | chainId, startBlock, lastScannedBlock, head, syncing, per-table row counts, the engine's `curveConfig` |
| `/leaderboard?limit=100&gameId=4` | latest streak per (user, game); streak > 0; sorted desc |
| `/sentiment/:gameId` | per-round UP/DOWN prediction power + counts |
| `/bounties/pairs` | every (gameId, token) ever funded, whether cleaned since, and its current `poolWei`, `rateScaled` and `live`, folded from the latest fund, drip or reclaim |
| `/bounties/pairs/:token` | same, filtered to one bounty token |
| `/referrals/:address` | referral payouts to that address + exact wei total |
| `/rewards/:address` | `unclaimedWei`, the on-chain unclaimed balance (latest credit's post-state, 0 after a claim), and the credits behind it. A delegator's share not yet accrued is not in it |
| `/rounds/:round/budget` | the payable budget the round froze on its first touch, or `null` before anything touched it |
| `/delegation/:address` | who it delegates prediction power to (or `null`), from which round, and the inbound power it holds as a delegate |
| `/streams` | every stream ever created, at its current name and provider. `?creator=0x…` filters to who created it |
| `/streams/:id/values` | that stream's observations, oldest first. `?fromBlock=N` returns only the tail |
| `/games` | every game ever created, at its current name and authority, with its resolved target and config, and its `dustThreshold` and `dustBar` (`max(dustFloor, threshold)`, the streak at which a prediction stops being dust). `?stream=N` is one stream's ladder, `?authority=0x…` one author's games. 503 unless `GAMES_ADDRESS` is set |

The two `/streams` routes answer **503** unless `REGISTRY_ADDRESS` is set, rather
than an empty array: `[]` is a valid answer to "which streams exist", so returning
one would quietly tell a caller the chain has no streams. `/status.streamsIndexed`
says which mode this indexer is in.

Stream values are `int256` and are returned as **strings, exactly as stored**. For a
Uniswap adapter stream the number is a raw tick, not a price; converting needs the
pool's token decimals and is the caller's job (the dapp does it in
`satori-ui/src/lib/streamOrientation.ts`).

## Configuration (environment)

| Var | Default | Meaning |
|---|---|---|
| `RPC_URL` | **required** | chain RPC to follow |
| `TOKEN_ADDRESS` `ENGINE_ADDRESS` `REWARDS_ADDRESS` `BOUNTIES_ADDRESS` | — | contract addresses (each overrides the book) |
| `REGISTRY_ADDRESS` | — | **optional.** Enables stream indexing (`/streams`, `/streams/:id/values`). Unset means the stream tables stay empty and those routes answer 503. Optional rather than required so an existing deployment does not hard-fail on restart for a feature it was not asked to provide |
| `ADDRESS_BOOK` | — | alternative: path to a mounted `deployments/<net>.json` from `satori/scripts/deploy.js` |
| `START_BLOCK` | `token.deploymentBlock()` | scan lower bound |
| `DB_PATH` | `/data/indexer.db` | sqlite file (keep on the volume) |
| `PORT` | `8787` | HTTP port |
| `POLL_MS` | `6000` | follow-loop cadence |
| `CHUNK_SIZE` | `1900` | blocks per `eth_getLogs`. Both Base networks cap the range at 2000; raise only on a provider you have checked |
| `REORG_DEPTH` | `128` | trailing window re-scanned every tick |

## Run on a VPS

```sh
docker build -t satori-indexer .
docker run -d --name satori-indexer --restart unless-stopped \
  -p 8787:8787 -v satori-indexer-data:/data \
  -e RPC_URL=https://mainnet.base.org \
  -e TOKEN_ADDRESS=0x... -e ENGINE_ADDRESS=0x... \
  -e REWARDS_ADDRESS=0x... -e BOUNTIES_ADDRESS=0x... \
  satori-indexer
curl localhost:8787/status
```

Or with compose: copy the vars above into a `.env` file and `docker compose up -d`.

The named volume holds the entire dataset. Restarts resume from the last
scanned block; deleting the volume just triggers a full (cheap) re-scan. If
you point an existing volume at a *different* deployment or chain, the indexer
notices (fingerprint mismatch) and resets the dataset itself.

Note on bind mounts: the container runs as the unprivileged `node` user. Named
volumes inherit writable permissions automatically; if you bind-mount a host
directory instead, `chown 1000:1000` it first.

## Local development

```sh
# 1. chain + contracts + activity (from ../satori)
npx hardhat node --port 3033
npx hardhat run scripts/deploy.js      --network localhost
npx hardhat run scripts/dev-streams.js --network localhost   # streams + observations
npx hardhat run scripts/dev-activity.js --network localhost  # predictions, bounty, referrals

# 2. indexer (from here)
npm install
RPC_URL=http://127.0.0.1:3033 \
ADDRESS_BOOK=../satori/deployments/localhost.json \
DB_PATH=./dev.db PORT=8787 POLL_MS=1500 npm run dev
```

**The port is 3033, not 8545.** This file said 8545 until 2026-08-18, which is
`hardhat node`'s default but not this project's: `hardhat.config.js` points the
`localhost` network at **3033**, because the dapp derives its RPC URL as its own
port plus one and `run-local.sh` puts the UI on 3032. Following the old
instructions gets you an indexer that connects to whatever else is on 8545,
reports a different chainId, scans happily, and finds **zero logs** — a clean
sync against the wrong chain, which looks exactly like a quiet one.

`dev-activity.js` needs the voting capability enabled and will revert
`CapabilityDisabled` on a bare deploy. `dev-streams.js` deliberately does not, so
stream indexing stays testable against a deploy and nothing else.

## Design notes

- **Scan algorithm** is a server-side port of the dapp's proven
  `eventCache.ts`: walk forward in `CHUNK_SIZE` chunks, one `eth_getLogs` per
  contract per chunk (topic0 OR-lists — 3 requests per steady-state tick).
- **Reorg safety**: every tick deletes-then-refills the trailing
  `REORG_DEPTH` blocks inside one transaction, so a reorged-out log can never
  persist. If the head moves *backward* (dev-chain reset, provider rollback)
  the dataset is trimmed, not nuked.
- **Correctness over cleverness**: views mirror the dapp's client-side
  reductions exactly (same ordering, same tie-breaks, same ether-precision
  sentiment sums) so swapping a scan for an HTTP call cannot change what
  users see.
