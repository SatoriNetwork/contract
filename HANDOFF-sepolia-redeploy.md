# HANDOFF — D4, the rolling-scoring stack on Base Sepolia

Written 2026-09-09, covering the D4 deploy of 2026-09-08 and replacing the
D3-era handoff of 2026-09-01. That document described a deploy that had not
happened yet and was blocked on two questions; both turned out to be answered by
the code, and the deploy is now done. Nothing below is remembered — every figure
was read back off the chain or off a test run.

Branch `restructure/immutable-core`, pushed through `a900739f`.

---

## 1. What is live

**The contract stack is deployed, verified, and handed over to the Safe.** The
dapp, indexer and bridge on Satori Central all point at it.

| | |
|---|---|
| book | `satori/deployments/baseSepolia.json` (D3's kept as `baseSepolia-PRE-rolling-20260908.json`) |
| token | `0xc9166f739dE68e5E611bAF47364f641D671b6D5a` |
| engine | `0x050Afb925DA81387C7bF000fCD7cdeC983C595C5` |
| hub | `0xBdb2201B0c36419CCF2607a64e421ff37898EbFd` |
| registry | `0xD774fFeB8C3619802770e6F558C520C805Bcaa90` |
| voting | `0x69994cD2a11EfbBE85435ae6d4c948bCf17577A8` |
| rewards | `0xA9528eE52c4B0A18406BD7cbaA03cA9A000a9Dc7` |
| games | `0x4F71B857578076BF90469Bb16Ee9468944AD00b3` |
| bounties | `0xad312F9D095bf1139E3D65990Fb0B50c7BF45739` |
| merkle | `0xbA81c904b533C1B0e006c35A46bee74F75239AFA` |
| deploymentBlock | 46534513 |
| deploymentRound | **20704** |

`deploymentRound` roughly HALVED against D3's 41395. Rounds are 24 hours now, so
the count of elapsed rounds since epoch halves. If it looks wrong, that is why.

The deploy was 44 transactions and cost **0.0034 ETH** (deployer balance
0.048764 -> 0.045405). Rehearsing the same script against a local node first
measured ~33.8M gas, which at Base Sepolia's fee is fractions of a cent — so if
you are budgeting a redeploy, budget in thousandths of an ETH, not the tens of
thousandths the D3 note implied.

### Governance — fully on the Safe

```
token.governor              0x61a9E0Fe02068C4BCCea665D21e93ebE81d62f18  (3-of-5 Safe)
token.pendingGovernor       0x0
rewards.admin               same Safe
merkle.rootPublisher        same Safe
deployer SATORI             0.0        (1148.67 moved to the Safe)
capabilities bitmap         32         (delegatePrediction only; voting is bit 7 and OFF)
```

Delegated roles, restored after the deploy and before the handoff, so each cost
one signature instead of three:

```
engine.offchainReporter     0xc0c06055f4Ddc55C81aeA0f86e7620f5a4C87594
engine.curveOperator        same key   (0.0101 ETH — the D3 note that it needs
                                        topping up is out of date)
```

### Services

`app.satorinet.io` (Satori Central, **ssh port 2222**) — see
`deploy/central/DEPLOY-central.md`, which is the runbook. Follow it, not this file.

| | state |
|---|---|
| UI | bundle `main.8c66976c.js`, new addresses baked in |
| indexer | wiped and resynced itself on the fingerprint change; synced to head |
| relay | untouched |
| bridge | rebuilt, cursor reset, publishing |

---

## 2. Do not repeat these — four things that bit, in order

**1. `deploy.js` CANNOT be run with GOVERNOR preset to the Safe.** The D3
handoff called this an open question for the owner. It is not a preference:
`setHub`/`setController` are `onlyGovernor` and signed by the deployer, adapter
registration needs the deployer to be `rewards.admin()`, and it burns SATORI
which only the governor holds at genesis. The deployer owns the stack *during*
the deploy and `scripts/handoff.js` moves it after. `handoff.js`'s own header
says all this — read it before re-litigating.

**2. The public RPC lies about state it has just accepted.** After setting the
reporter and curve operator, the read-back in the same script returned zero for
both. Receipts were status 1 and a re-read at head was correct. `deploy.js`
already polls around this. Do not "fix" a write that did not fail.

**3. A Safe receipt of status 1 proves the SAFE ran, not that the inner call
worked** — `execTransaction` emits `ExecutionSuccess` over a reverted inner
call. `safe-exec.js` prints this warning itself. Always re-read the effect.

**4. `handoff.js` said COMPLETE while a role was still on the hot key.** Its
completion check tested governor, admin and treasury and returned *before* the
section covering `merkle.rootPublisher`, which was still the throwaway deploy
key with the Safe merely nominated. Fixed in `83a6a3b0`; it now checks all four
and prints the `acceptRootPublisher` calldata when one is outstanding. Worth
knowing the shape: a "done" that does not enumerate what it checked is a guess.

---

## 3. The bridge had a real bug, found by not trusting its log

`satori-nostr-bridge` holds no contract addresses — it reads the indexer. But
its Nostr stream identity is `satori-{chainId}-{streamId}`, identical across
old and new stacks, so **its cursor carried straight over a redeploy**: it sat
at block 46,548,629 while D4's data starts at ~46,534,5xx, silently skipping
everything and logging `published: 0` forever. Resetting `/data/bridge.db` (old
one preserved in the volume under `bak-D3/`) fixed it.

Then, with it publishing again, querying the relay **as a subscriber** — which
`DEPLOY-central.md` tells you to do, because "announced" means sent, not stored
— showed the payload dated **1998**. `naming.py` carried its own
`TIME_UNIT_SECONDS = 43_200` under a comment asserting a round was "12 hours,
fixed forever in the immutable token". Phase 5 made rounds 24h; the constant
never moved, so every published timestamp was halved. Fixed in `4f70eecd`.

**Three phantom streams remain on the relays.** D3 had streams 2, 3 and 4; D4
has only the default. Their old kind-34600/34601 events are still out there
advertising `round 41395`, and the bridge will never touch them again because
those streams no longer exist. Clearing them needs NIP-09 deletion events,
which the bridge cannot emit. Left deliberately — decide whether it is worth
building.

---

## 4. The default stream is participation now, not a count

Since the adversary work, `flushDefaultStream` writes the fraction of
circulating supply committed to predicting, scaled 1e18 — not a prediction
count. The dapp had never been moved with it, and shipped three defects that
were invisible only because the value is still 0 on a fresh stack: copy that
described a headcount, raw 1e18 integers on screen, and a chart gap-fill that
mixed counts into a ratio series. All fixed in `a900739f`.

**The on-chain name is stuck at "Satori Predictions" and cannot be changed.**
`setDataStreamName` is provider-gated, stream 1's provider is the hub
*contract*, and the hub exposes no passthrough — no key can rename it, deployer
or Safe. The dapp relabels it **"Satori Participation"** at the data source
(`useStreamList`). Changing it for real needs a hub upgrade or a redeploy.

---

## 5. Known gaps, deliberately left

- **Vote indexing is OFF.** `VOTING_ADDRESS` is unset in Central's
  `.env.deploy`, so `/votes/:gameId` 503s and `vote_moved` / `game_approved` go
  unindexed. Pre-existing, and the dapp never calls `/votes`. One env line plus
  a restart if wanted. Note voting is capability bit 7 and ships OFF, so only
  the admin can vote at all right now.
- **Quiet rounds are gaps on the default-stream chart.** Honest, not broken —
  no value was ever published for them. Filling them needs a `deployedBalance`
  getter on the engine, which is a contract change.
- **Three phantom Nostr streams** (§3).
- **`test_bridge.py` cannot collect here** — it imports `tests.mini_relay` from
  satorilib, which is not vendored. Pre-existing. `test_values.py` runs.

---

## 6. Test status, verified at `a900739f`

| suite | result | how to run |
|---|---|---|
| Hardhat | **2161 passing, 3 pending, 0 failing** (30m) | `cd satori && npx hardhat test` |
| Foundry (fuzz + invariants) | **20 passing, 0 failing** | `PATH="$HOME/.foundry/bin:$PATH" forge test` |
| Dapp | **33 suites, 357 passing** | `cd satori-ui && CI=true npx react-scripts test --watchAll=false` |
| Bridge `test_values.py` | 11 passing | see §5 — `test_bridge.py` cannot collect here |

`forge` is NOT on PATH by default; it lives in `~/.foundry/bin`. The dapp count
moved 359 -> 357 deliberately: 12 tests covering the removed chart gap-fill were
replaced by 10 covering the shift, the labelling and the percentage rendering.

Two gates that are NOT part of `npm test`, by design, because they cost real
time or money: `satori/test-fork/` (fork tests) and the intelligent-adversary
harness in `satori/adversary/`. Run the adversary before any change to scoring
or the default game — it is what found both exploits that shaped the current
metric.

---

## 7. Keys and access

- `.env` `PRIVATE_KEY` → `0x9d31…8817`, the deployer. Holds no SATORI and no
  roles any more; still the relayer. 0.0454 ETH.
- `.wallets.env` holds all five Safe owner keys as **`WALLET_nn_PRIVATE_KEY`**
  (not `_PRIVATE` — that cost a wasted run). Owners are WALLET_01..05.
- Safe: `SAFE=… TO=… DATA=… SIGNER_KEYS=k1,k2,k3 RELAYER_KEY=… EXECUTE=1 node
  satori/scripts/safe-exec.js`
- ssh: `ssh -i ~/.ssh/id_ed25519 -p 2222 root@157.180.104.175`, and pass
  `-o UserKnownHostsFile=<writable path>` — this sandbox cannot write `~/.ssh`.
- Docker bind mounts do NOT work from this sandbox (the daemon has a different
  filesystem view). Build context is sent over the API, so building from a temp
  directory works; `-v "$PWD":/w` silently does not.

---

## 8. Where to read next

- `docs/2026-09-08-review.md` — how the protocol works now, at `9cf7ea74`.
- `docs/issues/rolling-24h-scoring.md` — the design doc and its rulings.
- `deploy/central/DEPLOY-central.md` — the deployment runbook. Authoritative.
