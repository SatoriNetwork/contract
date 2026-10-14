# Satori Simulation Battery — Findings

**Date**: 2026-05-11
**Scope**: Combinatorial behavior validation across bounties, delegation,
stream lifecycle, voting, claims, governance, edge cases. ~3 hours of
adversarial + happy-path simulation under varying user populations,
stream counts, and round budgets.

## TL;DR

- **14 focused scenario sims + 3 long-running sims** (mega + endurance + high-density).
- **2 full battery runs**, both pass clean: 14/14 each, plus 980/980 unit tests, plus 500-round endurance, plus 30-user × 15-stream high-density, plus 25-user 100-round mega integration.
- **All invariants held** across every run: cumulative budget cap, voting power conservation, eligibility cap, bounty-token conservation, snapshot survival on recover.
- **Two UX observations** worth documenting (CLAIM_WINDOW semantics + bounty-vs-delegation asymmetry — see "Notable Observations").
- **No contract bugs found.**

## Sim Inventory

All sims live in `/code/Satori/contract/satori/scripts/sim/`. Each is
self-contained — uses `harness.js` to deploy a fresh chain and exercises
a focused scenario. The shared harness eliminates ~80% of boilerplate
across scenarios.

| Sim | Purpose |
|---|---|
| `harness.js` | Shared deploy / airdrop / asserts |
| `bounty-basic-sim.js` | 5 predictors, single bounty, drip drains correctly |
| `bounty-multi-sim.js` | Multi-funder + multi-token (SATORI + mock-USD) on same stream |
| `bounty-recovery-sim.js` | Stream goes dark → funder recovers, prior snapshots survive |
| `many-bounty-sim.js` | 5 bounties on 3 streams; per-stream payout isolation |
| `delegation-dynamic-sim.js` | Delegate / undelegate / change-delegate mid-run; delegation-lock |
| `claim-delegation-sim.js` | `delegateClaimAbility` + `claimFor` access control |
| `multi-delegator-sim.js` | 5 delegators → 1 delegate; pro-rata stake-weighted shares |
| `stream-lifecycle-sim.js` | Create / vote / eligibility-cap / delete dynamics |
| `referral-sim.js` | 1% cut on claim; one-shot; self-pointer opt-out |
| `adversarial-sim.js` | Expected-revert sweep (Empty, Dup, Locked, !funder, etc.) |
| `voting-churn-sim.js` | 50 rounds of high vote-change rate; conservation per round |
| `downvote-sim.js` | Downvote (-balance/2) weights; negative-weight streams ineligible |
| `mixed-reward-sim.js` | Same predictor earns BOTH protocol + vault on bountied eligible stream |
| `governance-churn-sim.js` | Owner adjusts fee/cap/protocol-fee mid-run; renounces propagate |
| `bounty-delegation-sim.js` | Documents bounty-vs-protocol-reward asymmetry under delegation |
| `high-density-sim.js` | 30 users × 15 streams × 40 rounds; predictMultiple stress |
| `mega-sim.js` | 25 users, 100 rounds, all features combined with recovery |
| `endurance-sim.js` | 500 rounds, 15 users, 2 streams; long-term drift check |

Orchestrator: `battery.sh` runs the whole set against in-memory hardhat
(no long-lived node needed). Output: `/tmp/satori-sim-battery/<ts>/`.

## Invariants Verified

Across all sims:

1. **Cumulative budget cap**: `totalSupply + totalUnclaimedRewards <= 1440 × elapsed_rounds` held under every workload, including 500 rounds of activity. Highest utilization observed: 31% over 500 rounds.

2. **Voting power conservation**: `Σ getVotingPower(every_token_holder) == totalSupply` held at every checkpoint (every round in voting-churn, every 50 rounds in endurance, post-run in mega/high-density).

3. **Eligibility cap respected**: `getEligibleStreams().length <= maxEligibleStreams` held under high churn (voting-churn-sim, 40% vote-change rate over 50 rounds) and high density (15 streams competing for 10 slots).

4. **Bounty token conservation per token**: Vault drained = predictor payouts + platform fees + recovered, with sub-1000-wei dust from integer-division pro-rata splits. Per-token isolation: predictors who don't predict on a stream earn 0 from its bounties.

5. **Snapshot survival on recover**: Pre-recovery claims are never clawed back; only the un-snapshotted pool returns to the funder. Re-claim attempts post-recovery are silent no-ops.

6. **Stream protection**: Default stream (id=1) cannot be deleted. Non-authority cannot delete others' streams. Deleted streams reject `predict`.

7. **Permissioned paths**: `claimFor` requires delegation. `recoverInactiveBounty` requires funder. `setReferral` is one-shot. Setting referral to zero is rejected. Predicting while delegated is blocked. Setting predict on Empty/deleted stream reverts.

8. **Two-step ownership**: `transferOwnership` sets `pendingOwner`. Only `pendingOwner` can `acceptOwnership`. Old owner loses privileges atomically on accept.

9. **Governance value-vs-control**: Renouncing a control flag (e.g., `canSetStreamCreationFee`) is one-way and does NOT reset the parameter's value — the last-set value persists forever. Renounced control still allows reads.

10. **Pro-rata correctness**: 5 delegators with stakes 10/20/30/40/50 SATORI received pro-rata reward shares matching their stake ratios EXACTLY (20.5714... SATORI per stake-unit, no rounding variance because stakes were clean multiples). Platform fee accruals were proportional to delegated portion.

## Notable Observations

### CLAIM_WINDOW = 32 rounds is strict
The `BountyVault.CLAIM_WINDOW = 32` constant caps how far back a claimer
can scan when calling `vault.claim(bountyId)`. If a claimer lets their
cursor go stale past 32 rounds (no claims), they **forfeit access to
on-chain snapshots that already exist**. This is by design (gas-DoS
guard) and matches the registry's `HISTORY_SIZE`, but it has UX
implications:

- A bountied predictor who scores correctly at round R must claim by
  round R+32, or those rewards become un-claimable from their cursor.
- The bounty funder *can* still recover the un-snapshotted remainder via
  `recoverInactiveBounty` after stream inactivity — but rewards that
  were snapshotted before recovery and never claimed remain held in the
  vault until someone claims past them or `emergencyWithdraw` is called.

**Recommendation**: UI should encourage claiming every ~30 rounds for
bountied streams. The cooldown matches the registry's history window
naturally — past it, predictions can't be scored anyway, so the
constraint is well-aligned with the protocol's other lifecycle bounds.

### Delegated user is transfer-locked
Once a user has delegated prediction power via
`delegatePredictionPower(delegate)`, their SATORI balance is frozen —
`transfer` reverts with `"Locked"` until they undelegate. This is
documented behavior preserving the delegated-balance bookkeeping
invariant. The user must undelegate
(`delegatePredictionPower(address(0))`) before moving tokens.

### View-side delegator reward visibility
`getTotalClaimableRewards(delegator)` shows the delegator's pending
delegator-share only AFTER `_settleRewards` has been triggered for
their delegate. Triggers: delegate's own `claim()`, or the delegator's
own `claim()` (which calls `_settleRewards` for the delegate via
`_accrueDelegatorRewards`). In sims this manifests as: `aliceClaimable
== 0` until Bob (Alice's delegate) calls `claim()` himself or Alice
calls `claim()`.

**Recommendation**: Dapp display logic should know that triggering a
claim on the delegator triggers settlement; the pure view alone may
understate pending rewards.

### Integer-division dust in pro-rata splits
Per-round splits in `BountyVault.claim` use floor division (`snapshot *
userW / totalW`). With N equal-weight predictors splitting, each loses
up to N-1 wei to flooring; rounds × users compound this. Observed dust
in the 3-predictor 3-round case: 3 wei. The dust stays in the vault as
a permanent residual. Funders can sweep dust via
`recoverInactiveBounty` after inactivity, or via `emergencyWithdraw`,
if they care about sub-microSATORI cleanup.

### Bounty payouts are asymmetric vs protocol rewards under delegation
This is a **structural finding worth surfacing to users in the dapp**.

When Alice delegates prediction power to Bob, and Bob predicts correctly
on a bountied stream:

- **Protocol reward** (from the 1440/round budget): splits 80/10/5/5 —
  80% to Alice (delegator), 10% to Bob (delegate), 5% to each platform
  fee address.
- **Vault bounty** (from the externally-funded pool): **100% to Bob,
  0% to Alice**. The vault reads `userWeightByDirection(msg.sender, ...)`
  and Alice has 0 userWeight because she never called `predict`. Bob's
  userWeight includes his own + Alice's delegated power, so he claims
  the full pro-rata share.

This is consistent with the contract design — the vault is a separate
system that pays whoever actually predicted — but it has UX
implications:

- A delegator should understand that they're giving up bounty rewards
  entirely when they delegate; only the protocol-reward delegator-share
  remains theirs.
- If a delegator wants to participate in bountied streams, they should
  either un-delegate (and predict directly) or have a side agreement
  with their delegate to share bounty proceeds off-chain.

Verified in `bounty-delegation-sim.js`: Alice's `vault.claim` returns
0; Bob's `vault.claim` returns the full predictor share (45 SATORI in
the test, out of a 50-SATORI snapshot total over 5 scored rounds at
10/round, minus 10% platform fees).

### Long-run sim: supply-growth flattens
In the 500-round endurance sim, `totalSupply` stops growing after round
~250 even though `totalUnclaimedRewards` keeps growing. Root cause is
**not** a contract bug — it's RNG-driven sim behavior: the predictor
cohort's win rate eventually drops as value patterns lead to many
"void" (B==C) rounds where neither direction scores. Per-round claims
net to ~0 minted at that point. The cumulative budget cap is never
threatened (utilization caps at 31% over 500 rounds in this profile).

## Anomalies — None

No invariant violations observed in any sim. No unexpected reverts
beyond documented categories. The single owner-only path (`emergencyWithdraw`
on `BountyVault`) remains a known trust dependency — the recommended
mitigation (transfer ownership to a multisig + optional timelock,
optionally followed by renunciation) is documented in the contract
codebase and tested via the `Ownable2Step` test suite.

## Files

- Per-battery output: `/tmp/satori-sim-battery/<timestamp>/summary.md`
- Per-sim logs: `/tmp/satori-sim-battery/<timestamp>/<label>.log`
- Re-run: `cd /code/Satori/contract && ./satori/scripts/sim/battery.sh all`
