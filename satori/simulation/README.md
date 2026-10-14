# Satori adversarial simulation

A local, deterministic, multi-agent "deployment" where **disparate simulated humans** —
different starting stakes, different prediction skill, some honest, some hostile — all act
within the sandbox and try to game / drain / break the contract. They can **read** the
code but cannot change it; they can only make transactions. A ruthless **invariant oracle**
watches after every turn and declares whether the system was hacked.

```
SIM_SEED=42 SIM_ROUNDS=30 npx hardhat run simulation/run.js
```

Every run is fully reproducible from its seed, so a discovered exploit shrinks to a repro.

## Design (why it's built this way)

The agents are not the product — **the oracle is**. Agents just drive the contract into
weird states; the invariant battery is what actually catches an exploit. A sim with clever
attackers and a weak oracle is theater. So the effort is: oracle > harness > agents.

```
 personas.js ──decide(view)──▶ actions.js ──tx──▶ world.js (real deployment + clock + feeds)
   (who/how)                  (the only         │
   honest / hostile / LLM      contract         ▼
                               boundary)     oracle.js  ── assert after every turn ──▶ verdict
                                             (conservation / solvency / strand / auth / P&L)
```

- **`world.js`** — fresh full deployment (`deploySatoriFixture` + `initializeDefaultStream`
  + a few markets), a clock the harness advances by whole rounds (12h), and the data feeds
  the harness moves. Players never control time or oracles — just like reality.
- **`personas.js`** — disparate players. `honest(skill)` predicts with a given accuracy;
  `bountyFunder` adds bounty flows; `h3Deployer` + `h3Sybil` are a coordinated attacker
  team that deploys a hostile adapter and bets on it. Each is a `decide(view, rng, shared)`
  → `[action]`. `view` is what the player can see (its wallet, the markets, its P&L);
  `shared` is the team scratchpad (real attackers use many wallets).
- **`actions.js`** — the single boundary between a DECISION and EXECUTION + accounting.
  Every contract call funnels here; it delta-measures real token flows into the ledger and
  treats reverts as data, not crashes.
- **`oracle.js`** — the P&L/token ledger + the invariant battery (below).
- **`run.js`** — seats the roster, runs N rounds, settles + checks invariants after every
  turn, and prints a leaderboard + verdict. Exits non-zero on a HARD violation.

## The invariants (grounded in the 5-bug audit)

| Invariant | Catches |
|-----------|---------|
| `totalSupply() == totalRewardsMinted` | a mint that bypassed cap accounting |
| per-(game,round) credited ≤ round budget | **H3**-style over-mint (pool paid more than once); the score/total over-mint backstop |
| bounty-token solvency: `held + paidOut + fees == fundedIn` (per token) | **H2** siphon / any token drain |
| no `NoPendingPrediction` on a believed-pending settle | **H4** strand |
| `owner()==0`, fee reduce-only | auth / governance creep |
| economic P&L leaderboard + "exploiter out-earns every honest player" flag | value redistribution the hard cap can't see (**H1**-style) |

This battery is validated to have teeth. Adapter games use a **score/total** model: the
core pays `pool × userScore / total`, PINS the first scorer's `total` per (game, round), and
CAPS the round's running paid numerators at it — so a game can mint at most ONE pool per
round. `EveryoneWinsGame` is the over-mint attacker: every user announces `total == their own
score`, trying to claim the full pool each (the score/total analogue of the old
singleton-bucket attack). The pin+cap defeat it — only the first scorer is paid, the rest get
0 — so the per-(game,round) ≤ budget invariant holds. (Note the cumulative mint cap is
*self-enforced by the contract* — over-mint txns revert rather than exceeding it — so it
can't be *observed* violated; that's why an over-mint is detected by the per-(game,round)
conservation backstop, not the cap.)

## Red-team SUB-AGENT (plan executor, no external API)

The adversary is a **Claude Code sub-agent**, not an API client. The loop is out-of-band:

1. A sub-agent READS the immutable contract (under `satori/contracts/`). `llm.js`
   `buildAdversaryBrief({source, schema, worldInfo, goal})` is the plain-text brief it
   gets — rules of engagement, the legal action schema, the plan JSON format (incl.
   `capture`/`$ref`), the world layout, and the named invariants to break.
2. The sub-agent AUTHORS an attack **plan JSON** and saves it to a file.
3. `SIM_LLM_PLAN=plan.json npx hardhat run satori/simulation/run.js` **replays** it. There
   is no network call and no API key.

When `SIM_LLM_PLAN` is set, `run.js` replaces the scripted roster with `plan.wallets`
adversary wallets (default 3), labelled `LLM-0..N`. Each is provisioned a token (so
bounty/token actions are legal) and a starting stake, and replays the steps addressed to
its wallet index. `plan.seed`/`plan.rounds` are defaults the env (`SIM_SEED`/`SIM_ROUNDS`)
still overrides. The same shared scratchpad is threaded through so `capture` refs resolve.

**Plan format** (`loadPlan`): `{ seed?, rounds?, wallets?:int (default 3), steps:[ {round:int
(relative, 0-based), wallet:int, actions:[...] } ] }`. `round` is relative to the wallet's
first turn. Any string of the form `"$name"` or `"$name.field"` is replaced at run time
(`resolveRefs`) with the scratchpad value a prior `capture:"name"` action stored — so a plan
can `deployEvilGameAdapter` (`capture:"evil"`) in one step and reference `"$evil.typeId"` in
a later `createAdapterGame` step (`capture:"evilgame"`), then `vote`/`predict`
`"$evilgame.gameId"`. Unresolved refs pass through unchanged so `validatePlan` drops them.

```
# replay a sub-agent-authored attack plan (no API, no key):
SIM_LLM_PLAN=/tmp/plan.json npx hardhat run satori/simulation/run.js
```

A worked plan is the EveryoneWinsGame over-mint expressed entirely as JSON: wallet 0 deploys
`everyoneWins` (`capture:"evil"`), creates the adapter game on stream 2 with
`adapterTypeId:"$evil.typeId"` (`capture:"evilgame"`), votes `"$evilgame.gameId"`, then
wallets 0/1/2 all `predict "$evilgame.gameId"`. It runs end to end and the oracle returns
**HELD** — the first-scorer pin + running-sum cap defeat it (only the first scorer is paid one
pool, the rest get 0), so the per-(game,round) ≤ budget invariant holds.

**Teeth proof:** the oracle catches the over-mint when the SATORI per-(game,round) cap is
reverted (seeds 3/13) — so a HELD verdict is meaningful, not vacuous.

**The validator confines the sub-agent to the legal action space.** `validatePlan` is the safety
boundary: it drops actions with an unknown type or missing required fields, coerces `dir` to
`1|2`, drops bounty/token actions when the agent holds no token, caps the plan length, and
returns `[]` on garbage — it never throws. A hallucinated or hostile plan therefore can
neither crash the run nor escape the legal action set; it is judged by exactly the same
invariant battery as every scripted agent.

Default (no `SIM_LLM_PLAN`) keeps the scripted 10-agent roster unchanged. Keep sub-agent
plans few and creative (depth); keep the scripted + fuzz agents many and in CI (breadth). For
breadth, the repo's Foundry `test/foundry/Handler.sol` is the natural home for stateful
invariant fuzzing of the same properties.

## Knobs

- `SIM_SEED` (default 42, or the plan's `seed`), `SIM_ROUNDS` (default 30, or the plan's `rounds`).
- `SIM_LLM_PLAN` — path to a sub-agent-authored attack plan JSON; replaces the scripted roster.
- The roster (persona mix + starting stakes) is the `roster()` function in `run.js`.
- This directory is **not** in the Hardhat test glob (`tests: "./test"`), so it never runs
  in the normal suite — it's an on-demand red-team tool.
