# satori-proof-pipeline

The daemon that makes holder voting operable by humans. Two clocks make a
manual process impossible (docs/design/holder-voting-review.md §9):

- **activation** must land within `ACTIVATION_WINDOW` blocks of `propose()` —
  256 blocks is ~8.5 minutes on Base, and the prototype ships with 64 (~2 min);
- **proof retention** on the public Base RPC is ~512–1000 blocks, so every
  voter's `eth_getProof` must be fetched within minutes of the snapshot, after
  which no ballot for that proposal can ever be constructed again.

Nobody runs a script inside those windows on purpose. So this watches the
chain and reacts:

```
Base ──▶ satori-proof-pipeline ──▶ activateProposal(...) tx (optional key)
                     │
                     └──HTTP──▶ vote page / voters: GET .../proof/:address
```

On every `ProposalCreated` it, in order, resumable at each step across
restarts:

1. reconstructs the snapshot block's RLP header and refuses anything that
   does not hash to the snapshot hash the proposal committed to;
2. fetches the token account proof and the totalSupply storage proof;
3. sends `activateProposal` if `ACTIVATOR_PRIVATE_KEY` is set — the call is
   permissionless and verify-only, so the key needs dust ETH and can do
   nothing except submit data that verifies (without a key it waits, serving
   the payload at `/proposals/:id` so anyone can activate by hand);
4. enumerates candidate holders from its own Transfer-log ledger (one cursor,
   same discipline as the Nostr bridge) — including accounts drained AFTER
   the snapshot, which are exactly the ones a lazy enumeration loses;
5. fetches every candidate's balance proof at the snapshot and serves each as
   a ready ballot: `GET /proposals/:id/proof/:address` → `{ balance, proof }`,
   the literal second argument of `castVote`.

The ledger only nominates who to fetch for; every balance that counts is
proved against the snapshot's own storage root on chain. A ledger bug can
cost completeness, never correctness.

## Not watching the indexer, deliberately

The Nostr bridge reads the indexer's HTTP API, and that loose coupling is the
house style — but the indexer knows nothing of the governor, and stacking its
poll latency under ours would spend a real fraction of a two-minute activation
window. This daemon watches the chain directly and keeps everything else about
the bridge's shape: separate container, one process, one cursor, no shared
database, read over HTTP.

## Environment

| var | | |
|---|---|---|
| `RPC_URL` | required | must serve `eth_getProof` for recent blocks |
| `GOVERNOR_ADDRESS` | required | token + activation window are read from it |
| `ACTIVATOR_PRIVATE_KEY` | optional | dust-funded; without it, watch-only |
| `START_BLOCK` | 0 | token deploy block; trims the first backfill |
| `PORT` | 8788 | |
| `POLL_MS` | 3000 | |
| `LOG_CHUNK` | 1900 | Base's public RPC caps ranges at 2000; adapts downward on errors |
| `PROOF_CONCURRENCY` | 8 | parallel `eth_getProof` fetches per proposal |
| `DATA_DIR` | /data | ledger + per-proposal proofs |

## API

```
GET /health
GET /status                      cursors, counts, per-loop last errors
GET /proposals
GET /proposals/:id               full meta incl. rawHeader + account proofs
GET /proposals/:id/proof/:addr   { balance, proof } — castVote's argument
```

## Test

The end-to-end test spawns this daemon for real — propose, watch it activate
on its own, drain a holder, vote with the served ballots:

```
npm ci
cd ../satori && anvil --port 8549 --silent &
HARDHAT_URL=http://127.0.0.1:8549 npx hardhat test \
    test/governance/ProofPipeline.e2e.test.js --network localhost
```
