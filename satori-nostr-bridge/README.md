# satori-nostr-bridge

Mirrors Satori's on-chain data streams onto our own Nostr relays. A stream is
created on the contract, so it is announced on Nostr; an observation lands, so it
is published. One process, one key, one sqlite cursor.

The point is **subscribability with a known publisher**. A Nostr subscriber can
follow a Satori stream without touching an RPC endpoint, and because the bridge
signs with a key we control, the source is identifiable and therefore trustable.

## Where it sits

```
Base ──▶ satori-indexer ──HTTP──▶ satori-nostr-bridge ──▶ Nostr relays ──▶ neuron
```

It reads the indexer's **public HTTP API as an ordinary client**. No shared
database, no shared process. The indexer serves `adapterId`/`named` on
`/streams` for it; an older indexer still works (both default to plain). That
is the loosest coupling that carries the requirement, and it is deliberate: see
`../docs/issues/nostr-datastream-bridge.md`.

| Reads | Writes |
|---|---|
| `GET /status` (gate) | kind **34600** stream announcements |
| `GET /streams` | kind **34601** observations |
| `GET /streams/:id/values?fromBlock=` | |
| `eth_call` for tick conversion (optional) | |

## What it publishes

**Stream identity is `satori-<chainId>-<streamId>`.** The chain id is in there so
a redeploy on a new chain cannot collide, and so testnet and mainnet streams can
share a relay without pretending to be each other.

Announcements are free streams (`price_per_obs = 0`), which takes
`publish_observation`'s broadcast branch: one plaintext event per observation
rather than an encrypted DM per subscriber. These are public chain facts, so
charging for them would be charging for something anyone can already read.

An observation's `value` looks like this:

```json
{
  "chainId": 8453, "streamId": 7, "block": 1787, "round": 41495, "hour": 995880,
  "raw": "213397", "unit": "tick",
  "value": 540.44, "valueUnit": "USDC per WETH"
}
```

- **`raw` is authoritative and is always a string.** On-chain values are `int256`:
  signed, and wider than a float. Anything that round-trips them through a JSON
  number is lossy.
- **`value` is present only when it could actually be derived.** If a tick could
  not be converted, the key is absent and `unit` still says `tick`. Nothing here
  ever presents a raw tick as a price.
- **`timestamp` is the observation's hour**, `hour × 3600`, which is exact rather
  than approximate because the registry ring keys on `block.timestamp / 3600`,
  and a stream may write every hour (a named stream snapshots hourly). Against
  an indexer too old to serve `hour`, it falls back to the round's start,
  `round × 86400`, and a day's observations then share one timestamp. Using
  the wall clock instead would be wrong for every backfilled observation, and
  the first run is always a backfill.

A **named stream** (`../docs/narratives/A_named_streams.md`) is not a price: its
value is the engine's running counter of net prediction flow on the stream's
daily game, in SATORI wei, and its provider is the engine. The indexer flags
these (`named: true`, `adapterId`), and the bridge announces them with
`metadata.named: true`, `metadata.adapterId`, a `named` tag and a description
saying what the number is. Their observations carry `unit: "flow"` and the
counter scaled to SATORI; the engine is never probed as a pool:

```json
{
  "chainId": 31337, "streamId": 2, "block": 229, "round": 20739, "hour": 497759,
  "raw": "96970597880425349120", "unit": "flow",
  "value": 96.97059788042535, "valueUnit": "SATORI"
}
```

`raw` is still the exact wei string and can be negative (net DOWN flow).

`cadence_seconds` is always null, deliberately. The chain's cadence is a minimum
between writes (and a named stream snapshots only when touched), but the field's
consumer (satorilib's `is_likely_active`) reads it as a schedule and flags a
stream stale past 1.5x it — which would judge a healthy-but-quiet stream dead.

## Ticks

Satori stores a Uniswap stream's value as the raw tick, deliberately. Tick 213397
is not a price, it is a logarithm of one, so publishing it under a name like
"WETH/USDC" would mislead.

Detection is **duck-typed**, the same way the dapp does it: an adapter stream's
`provider` *is* its data-source contract, so a Uniswap-backed stream's provider is
the pool. Ask that address for `token0()`/`token1()`; if it answers, the value is
a tick and the decimals to scale it are one call away. Probed once per stream,
then cached.

The conversion mirrors `satori-ui/src/lib/streamOrientation.ts` exactly, including
deciding orientation at tick 0 rather than at the live tick, so a stream's units
cannot flip mid-series as the price crosses parity.

Set `RPC_URL` to enable it. Without it, tick streams still publish; they carry the
raw tick, labelled, with no `value` field.

## Running it

```sh
cp .env.example .env    # fill in NOSTR_KEY and RELAY_URLS
docker build -t satori-nostr-bridge .
docker run -d --name satori-nostr-bridge --restart unless-stopped \
  --env-file .env -v satori-bridge-data:/data satori-nostr-bridge
```

`DRY_RUN=1` logs what would be published and publishes nothing, and it leaves
the cursor untouched, so the real run that follows it still has the whole
backfill in front of it. Worth one run against a live relay before the first
real one. Before that real run, check `GET /status` on the indexer reports a
non-zero `namedAdapterId`: the cursor advances past every observation it
publishes, so a named stream published while the indexer still read 0 keeps
those observations labelled `raw` on the relay (only the announcement is
corrected when the flag flips). On Base the registry sets it before any stream
exists; a dev chain can wire it after the indexer boots.

**The volume matters.** The cursor lives there, and without it every restart
republishes all history. Harmless to correctness (34601 is replaceable) but noisy,
and it makes a restart look like a data event to subscribers.

## Local development

```sh
# 1. chain, contracts, stream activity (from ../satori)
npx hardhat node --port 3033
npx hardhat run scripts/deploy.js      --network localhost
npx hardhat run scripts/dev-streams.js --network localhost

# 2. indexer (from ../satori-indexer) — REGISTRY_ADDRESS comes from the book
RPC_URL=http://127.0.0.1:3033 ADDRESS_BOOK=../satori/deployments/localhost.json \
  DB_PATH=./dev.db PORT=8787 npm run dev

# 3. bridge (from here)
pip install -r requirements.txt
INDEXER_URL=http://127.0.0.1:8787 RPC_URL=http://127.0.0.1:3033 \
  NOSTR_KEY=nsec1... RELAY_URLS=ws://127.0.0.1:7777 \
  STATE_PATH=./dev.db python -m bridge
```

`pytest` runs the suite. The bridge tests run against satorilib's `MiniRelay`, a
real NIP-01 relay over a real websocket, so what they assert genuinely went
through signing, encoding and a relay round trip.

## Two things that will bite

**`nostr-sdk` must be 0.45 or newer, and that is a floor rather than a ceiling.**
satorilib was migrated to the 0.45 API on 2026-08-18 and no longer runs on 0.44.x.
0.45 was a breaking release: the signer came off the `Client`,
`send_event_builder` and `handle_notifications` were removed, `subscribe` and
`fetch_events` take a `ReqTarget` instead of a `Filter`, and `Tag.as_vec` became
`to_vec`. satorilib now declares the floor itself, so this is belt and braces.

**The bridge refuses to publish from an unready indexer**, and both gates matter.
`streamsIndexed: false` means the stream tables are empty by configuration, so
publishing would announce nothing and look like a chain with no streams.
`syncing: true` means a backfill is in progress, so `/streams` is a partial
history, and announcing a partial set does not merely omit things, it teaches
subscribers something false that only a later correction undoes.
