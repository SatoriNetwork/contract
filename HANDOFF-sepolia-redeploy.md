# D6 — redeploy, 2026-10-14 (supersedes the live addresses below)

The stack was redeployed from this tree (the issuance-indexed emission schedule).
Everything in this section was read back off Base Sepolia. The D4 text below is kept
as history; its addresses are no longer live.

- Book: `satori/deployments/baseSepolia.json`. The D5 book is kept as `baseSepolia-PRE-humble-20261014.json`.
- deploymentBlock **48094944**, deploymentRound **20740**. deploy.js passed all 60 post-conditions and verify-deployment.js reported 79/79 invariants.
- Coined `0xE6110E71b748b799AE7Ac7a24E8098AcbBD71B1b` was deployed from the coined repo, master `70d934b` (tx `0x9627c14b…0175`). It is the named-stream adapter's immutable Coined.
- Governance stays on the deployer `0x9d31…8817`, following the D5 precedent: governor, rewards admin, airdrop loader, root publisher and lockVote proposer. handoff.js was NOT run.
- Fee recipients: platform = splitter A `0xcfB3…4464`; marketing = `0x9f50…8762`.
- After the deploy, as deployer:
  - capabilities set to 163 (createStream, authorGame, delegatePrediction, vote). Tx `0x6834d241aa2b9ffb199201b72bbee02915606a56eef01cd2cdf13e518ca1ad3a`.
  - offchainBudget set to 359814308518774397927, which is (emissionRateNow − devRateNow)/2, a 50/50 split that applies from the next round. Tx `0x4178c7ac4b6f5631b6d81ef406a5d33c87628eaddb6dd9990496802e28640a16`.
  - 50 SATORI each sent to `0x03AbFED741a344C578304040D6CACAc86960e97d` (tx `0xc73346d7abbebe179e7af21f65d2a029e5cc9fc77bd68a0b9b885e882766b190`) and `0xc0c06055f4Ddc55C81aeA0f86e7620f5a4C87594` (tx `0xcc68b6f3233803c5d581c42ad09e43f943e00ffdd9adac4e8c9dc57683fe4bd8`).
  - engine.offchainReporter and curveOperator are left at 0x0, as on D5.
- Base's public RPC now caps eth_getLogs at 200 blocks, so the indexer runs with CHUNK_SIZE=190.
- The Central indexer compose now passes `GAMES_ADDRESS` and `VOTING_ADDRESS`. Without them, /games and the vote tables answer 503.

| | |
|---|---|
| token | `0x4dee947383d5C9c8E421F55Fe3518a29324aE469` |
| airdrop | `0xF15CEAec0e29A0B6551180F8617850bc5356938C` |
| engine | `0xE8fA688ea29850305216121C0bddfFb9096A1093` |
| engineImpl | `0x9c35423653Faa3A4109830d80f04fc50902d6d96` |
| hub | `0x1eec7E1443C1065ab78180A14326e5Ac8284f143` |
| voting | `0x5A56279215684A8088234799FfD56f806AcFBb6e` |
| rewards | `0xde5d2B4b92c1231EC19cd3877D7C3eb6b44982Ac` |
| registry | `0x1ED75AB0a66Ba7d23C3E5c84798e90205E76743a` |
| games | `0xB06e419D24cCbA967c6193e9e374117171B400C3` |
| bounties | `0x7FEaA67a4d4D8c9462A0d8d643984227C7710dCF` |
| votingImpl | `0x9dDB945Fa72f5b000ea115C9Bf9CF78C99518DB1` |
| rewardsImpl | `0xBCe8302275abba675f8877FC0509e2AaAf9a75d2` |
| registryImpl | `0x0841826Af5bBf61d5E351Cb8EcC6316B725Ce34d` |
| gamesImpl | `0x587D6A1d2f6D2Dc239F5F3a4F80b71669FCd72bd` |
| bountiesImpl | `0x236A1876fb39FF492C5EA148f31345db28459eBb` |
| hubImpl | `0x8e8bE6Db184e4DfF25EdFFB8EAcf7959bfFa1Db1` |
| coined | `0xE6110E71b748b799AE7Ac7a24E8098AcbBD71B1b` |
| chainlinkAdapter | `0xc8C451A4c2DcE92696b596B1982a025c48E23609` |
| uniswapAdapter | `0xda8Ab39C292339cA0d57fDf490cD29169b4d27cA` |
| customAdapter | `0xE5044addC72E1D541beA8C16bb6883EE4b66F019` |
| coinedAdapter | `0xd675567b3E023c745FcD843C29AD57D3697a1e28` |
| namedAdapter | `0x862A4279B4594C2DF02C3af1463C48e206e943f9` |
| lens | `0x9BF5266F60092F1bFbd5F16d21d0bE9673c0F91F` |
| merkle | `0x78C83AE275e9659Bc8490fa33943e22ec7c5A7e7` |
| merkleImpl | `0x76890a567561dD580dBdB2347875992EE1a0c1a7` |
| holderGovernor | `0x931105bFe293d46298F5bC91A8D863a3d816e408` |
| lockVoteGovernor | `0xb528f163f0F23c0BEdB0173103268596163de183` |

---

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
