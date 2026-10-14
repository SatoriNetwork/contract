# Intelligent-adversary harness

A red-team **Claude Code** instance holding ~half the token supply attacks a
live local deployment seeded with honest activity, trying to extract MORE than
its capital's fair share of emissions (or trip a protocol cap). Unlike the
fuzzers and the hand-written PoCs, this adversary forms *intent*: it reads the
actual contract source (read-only) and writes informed attacks.

It runs through the **Claude Code CLI under your plan — no API key, no
per-token API billing.** It is NOT part of `npm test` (a run consumes plan
usage). Run it before a deploy or after a material change.

## How it runs
The adversary is a **coding agent the assistant launches as a subagent** — it
runs under your Claude plan, in-process, no API key and no separate login. You
just ask the assistant to "run the adversary"; it spawns a subagent with the
briefing below, then judges the result with `node adversary/run.js` (the
deterministic scorer/scaffolder — the attacker is never judge of its own win).

**Subagent briefing (what the assistant hands the adversary):**
> You are a red-team economist attacking the Satori protocol on a live LOCAL
> testnet, holding ~half the supply against honest players already active for
> many rounds. Beat your capital's FAIR SHARE of emissions, or trip a protocol
> cap. Study `contracts/` read-only (Read/Grep). Read `adversary/tools.js` for
> your verbs. Write your attack as the async function in `adversary/attack.js`
> (edit ONLY that file — never contracts or tests). Run it with
> `npx hardhat run adversary/execute.js`; read the SCORE (beatsFairShare,
> tripwires, gainOverFairPct); revise and repeat for up to ~12 iterations.
> Finish by writing every strategy you tried and its result to
> `adversary/agent-notes.md`, and report your best score.

## The loop, by hand
Anyone (or the agent) can drive it directly:
1. Edit `adversary/attack.js` — one async `({ world, tools, ethers, log }) =>`
   function. `tools.*` are the attacker's verbs (see `tools.js`).
2. `npx hardhat run adversary/execute.js` — builds a fresh world (honest
   history + half-supply attacker), runs your attack AS the attacker, prints a
   **SCORE**: `beatsFairShare`, `tripwires`, `gainOverFairPct`.

## Scoring
Fair share = the attacker's capital fraction × emissions minted during the
attack window. Extraction = growth of (balance + unclaimed). The attacker
"wins" if extraction beats fair share by >5%, OR an independent **tripwire**
fires on the protocol's own ceilings (`rewardCeiling`, `devFeeCeiling`).

## Findings become permanent tests
On a win, `run.js` freezes the exact winning `attack.js` and writes a
category-1 regression PoC to
`test/adversarial/exploit-adversary-<id>.poc.test.js`. It replays the attack
and asserts it now **fails** — RED against the vulnerable contract, GREEN once
the hole is closed in the CONTRACT (never by weakening the assertion), and a
permanent guard thereafter so the exploit can never silently reopen. The run
exits non-zero, like a red test.

## Pieces
- `world.js` — deploys the real test fixture, seeds honest rounds, funds the
  attacker to ~half supply.
- `tools.js` — attacker verbs (public entry points only) + sandboxed read-only
  `contracts/` source access.
- `execute.js` — runs `attack.js`, scores, records `last-score.json`.
- `scorer.js` — fair-share math + cap tripwires.
- `scaffoldFinding.js` — finding → frozen attack + regression PoC.
- `run.js` — the CLI orchestrator.

The rig itself is covered, model-free, by
`test-fork/AdversaryHarness.selftest.js` (run by name; outside `npm test`).

## Known & accepted residual (2026-09-07)

A holder of >50% of supply can rig the default game's up/down by choosing which
rounds they play (their own balance dominates the participation metric). This is
the oracle problem and cannot be fully closed for a self-referential value. It is
ACCEPTED because the default game's emission share is capped at 1%, so rigging it
nets a sliver — the attacker earns *less* than by playing honestly. The scorer
reports `controlsOutcome: true` for it but `isFinding: false` (theft requires
control AND profit beyond fair share). Do not treat a `controlsOutcome` flag on
the default game as a new bug.
