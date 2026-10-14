# Core contract efficiency audit

Pre-mainnet review of `SatoriRewards.sol` + `Satori.sol` for unnecessary
loops, redundant storage operations, and view/distribution
inconsistencies. Ordered by impact.

## A. BUG — view path overstates predictor's claimable when fees < 10%

**Location:** `SatoriRewards._getUserNetRewardForRound` (line 866).

The view computes `predictorBonus` as a *residual*:
```solidity
uint256 delegatorsShare = (delegatedReward * 8000) / 10000;  // hardcoded 80%
uint256 predictorBonus = delegatedReward - delegatorsShare - fee1 - fee2;
```

But the distribution path (`_distributeDelegatedReward`, line 538) treats
the bonus as *fixed*:
```solidity
uint256 predictorBonus = (delegatedReward * 1000) / 10000;  // FIXED 10%
uint256 delegatorsShare = delegatedReward - predictorBonus - totalPlatformFee;
```

When platform fees are at default 5% + 5% = 10%, the two formulas agree
(80% delegators, 10% bonus, 10% fees). But the owner (or fee addresses)
can REDUCE platform fees below 10%. Once they do, the view diverges:

| platformFee1+2 | View shows predictor | Actual claim gives | Delegators actually get |
|---|---|---|---|
| 10% (default) | 10% bonus | 10% bonus | 80% (matches view) |
| 6% | **14% bonus** | 10% bonus | 84% (more than view says) |
| 0% | **20% bonus** | 10% bonus | 90% (more than view says) |

The predictor sees a number in the dapp and gets less than that on
claim. Confusing UX. The distribution path is the source of truth.

**Fix:**
```solidity
// In _getUserNetRewardForRound:
uint256 predictorBonus = (delegatedReward * 1000) / 10000;
// (drop delegatorsShare / fee1 / fee2 variables — not needed for the
// predictor's net, only for the delegator's share which is computed
// elsewhere via _delegatorRewardRatePerRound.)
return (totalReward - delegatedReward) + predictorBonus;
```

Lines saved: ~5. Bug fixed.

## B. BUG — `getTotalClaimableRewards` double-counts partially-settled rounds

**Location:** `SatoriRewards.getTotalClaimableRewards` (line 956).

The view walks `_predictorWinRounds[user]` starting at the OUTER cursor
`_nextSettleRoundIndex[user]`. For each round, it loops over all
wins from `k = 0`:

```solidity
for (uint32 i = startIdx; i < rlen; i++) {
    uint32 r = rounds[i];
    StreamDirection[] storage wins = _predictorWinsInRound[user][r];
    uint256 wlen = wins.length;
    for (uint256 k = 0; k < wlen; k++) {   // ← starts at 0
        ...
        total += _getUserNetRewardForRound(user, w.streamId, r, w.direction);
    }
}
```

But `_settleRewards` (the mutating path) uses an INNER cursor too:
```solidity
uint256 startK = _settledWinsInRound[user][r];
for (uint256 k = startK; k < wlen; k++) {
```

The inner cursor matters when a round is *partially* settled — the
outer cursor halts on a round whose `_unsettledPredictionCount > 0`, but
the inner has already settled the wins observed so far and credited
them into `unclaimedRewards`.

**Scenario:** Alice predicted on 5 streams at round R via
`predictMultiple`. 2 streams' B/C have been resolved → 2 wins
scored + credited to `unclaimedRewards`. 3 streams' B/C are still
pending. `_settleRewards` halts at round R after settling those 2 wins;
`_settledWinsInRound[alice][R] = 2`; `_unsettledPredictionCount[alice][R] = 3`.

Alice calls `getTotalClaimableRewards`:
- Adds `unclaimedRewards[alice]` (contains 2 wins).
- Loops at i = R (startIdx), k = 0 → counts all 3 wins (including the 2 already in unclaimedRewards).
- Returns: 2 + 3 = **5 wins worth**, but Alice can only claim 2.

**Fix:**
```solidity
for (uint32 i = startIdx; i < rlen; i++) {
    uint32 r = rounds[i];
    StreamDirection[] storage wins = _predictorWinsInRound[user][r];
    uint256 wlen = wins.length;
    uint256 startK = (i == startIdx) ? _settledWinsInRound[user][r] : 0;
    for (uint256 k = startK; k < wlen; k++) {
        ...
    }
}
```

For rounds strictly after the cursor, `_settledWinsInRound` is naturally
0 (never touched). For the cursor round, use the inner cursor.

Lines changed: 1. Bug fixed.

## C. OPT — unnecessary `_lookupBalanceAt` call on non-winning rounds

**Location:** `SatoriRewards._accrueDelegatorRewards` (line 745) AND
`_pendingDelegatorRewardsView` (line 810).

Both have:
```solidity
uint256 rate = _delegatorRewardRatePerRound[p.delegate][r];
uint256 bal = _lookupBalanceAt(p, r);    // ← always called
if (rate > 0 && bal > 0) {
    sumAccrued += (bal * rate) / RATE_SCALE;
}
```

`_lookupBalanceAt` walks the delegator's `Checkpoint[]` array — O(C)
iterations per call. For most rounds, `rate == 0` (predictor didn't win
that round) and the result of `_lookupBalanceAt` is thrown away.

**Real impact:** For a delegator whose delegate wins ~30% of rounds, the
remaining 70% of iterations pay for an unused checkpoint walk. With
C=3 checkpoints, that's 0.7 × N × 3 wasted SLOAD-and-compare per claim.
For a user claiming 32 rounds at a time: ~67 wasted SLOADs ≈ 6.7K gas.

**Fix:**
```solidity
uint256 rate = _delegatorRewardRatePerRound[p.delegate][r];
if (rate > 0) {
    uint256 bal = _lookupBalanceAt(p, r);
    if (bal > 0) sumAccrued += (bal * rate) / RATE_SCALE;
}
```

Lines changed: ~4 in two functions. Saves up to ~7K gas per claim. Trivial fix.

## D. OPT — `_distributeReward` does 3 separate `_addUnclaimed` calls per win

**Location:** `SatoriRewards._distributeDelegatedReward` (line 538), called
from `_settleRewards` in a loop.

Each delegated win triggers:
```solidity
_addUnclaimed(user, ...);              // SSTORE user bucket + SSTORE global counter
_addUnclaimed(platformFeeAddress1, fee1);  // SSTORE fee1 bucket + SSTORE global
_addUnclaimed(platformFeeAddress2, fee2);  // SSTORE fee2 bucket + SSTORE global
```

That's **6 SSTOREs per win**. The `totalUnclaimedRewards` global counter
is updated 3 times per win — each write is hot but still ~3K gas.

For a user with N delegated wins in their settle queue: 6N SSTOREs. With
N = 30: **180 SSTOREs ≈ 540K gas**.

**Fix:** accumulate locally across the loop in `_settleRewards`, write
each bucket ONCE at end:
```solidity
// In _settleRewards, add local accumulators:
uint256 userCredit = 0;
uint256 fee1Credit = 0;
uint256 fee2Credit = 0;

// _distributeReward becomes _accumulateRewardSplit(...), no SSTOREs:
//   userCredit += userPortion;
//   fee1Credit += fee1Portion;
//   fee2Credit += fee2Portion;
//   _delegatorRewardRatePerRound[user][round] += ... // (per-round, can't hoist)

// At end of _settleRewards:
if (userCredit > 0) unclaimedRewards[user] += userCredit;
if (fee1Credit > 0) unclaimedRewards[platformFeeAddress1] += fee1Credit;
if (fee2Credit > 0) unclaimedRewards[platformFeeAddress2] += fee2Credit;
totalUnclaimedRewards += userCredit + fee1Credit + fee2Credit;
```

Saves (3N − 3) SSTOREs. For N=30 wins: 87 SSTOREs × ~3K = **~260K gas**
per heavy claim. Major win.

Code change: refactor `_distributeDelegatedReward` to return values
instead of writing. ~30 lines of restructuring across `_settleRewards`
and `_distributeReward` / `_distributeDelegatedReward`. Worth it.

## E. OPT — `PredictionDelegationInfo` struct uses 2 storage slots, fits in 1

**Location:** `SatoriTypes.PredictionDelegationInfo`.

```solidity
struct PredictionDelegationInfo {
    uint224 ownPower;       // slot 0 (4 bytes unused)
    uint224 delegatedPower; // slot 1 (4 bytes unused)
}
```

Two slots. With SATORI total supply bounded by 1440 × elapsed_rounds at
≤ ~5.3e25 wei after a century, `uint128` is wildly sufficient (max
3.4e38 wei).

**Fix:**
```solidity
struct PredictionDelegationInfo {
    uint128 ownPower;
    uint128 delegatedPower;  // 32 bytes total — 1 slot
}
```

`scorePrediction` writes this struct on every prediction. Saves
1 SSTORE per scored prediction (~20K cold, ~3K warm). On a busy network
this is the most-hit storage path in the contract.

Note: `Checkpoint` struct in `SatoriRewards.sol` is similar — `uint32 round
+ uint256 value` uses 2 slots, could fit in 1 with `uint128 value`. But
Checkpoint writes are rare (only on receive-while-delegated), so this
matters less. Worth doing for consistency.

## F. OPT (MINOR) — `_distributeDelegatedReward` reads fees from storage per call

**Location:** `_distributeDelegatedReward` (line 538), reads
`platformFeePercent1` and `platformFeePercent2` from state on every call.

If hoisted into `_settleRewards` once and passed as parameters, saves
~2 SLOADs × N wins. Warm SLOAD is 100 gas, so N=30: **6K gas**. Marginal
but free if we're already refactoring (D) — pass them along.

## G. OBSERVATION — `_lookupBalanceAt` reverse-scan is fine

**Location:** `SatoriRewards._lookupBalanceAt` (line 827).

Reverse-iterates `Checkpoint[]` from latest to oldest. Most queries
target recent rounds (the latest accrual catchup), so the first iteration
finds the answer.

Could be replaced with binary search for O(log C) — but C is typically
1-3 (one initial + checkpoints from received transfers while delegated).
Binary search wouldn't help and adds code complexity. **Leave as-is.**

After fix C (rate-check hoist), this function is called far less often.
The remaining overhead is bounded.

## H. OBSERVATION — `predictMultiple` O(N²) duplicate check

**Location:** `Satori.predictMultiple` (line 846).

```solidity
for (uint256 j = 0; j < i; j++) {
    require(requests[j].streamId != streamId, "Dup");
}
```

For N=25 max requests: 25 × 24 / 2 = 300 comparisons worst case. Each is
a calldata read + compare, very cheap. Total ~6K gas worst case.

A bitmap or hash-set approach would have setup overhead higher than the
O(N²) loop for N ≤ 25. **Leave as-is.**

## I. OBSERVATION — Per-stream external calls in `predictMultiple` validation

**Location:** `Satori.predictMultiple` (line 813-849).

The validation loop calls `satoriRegistry.getValueState(streamId)` for
each of N streams. That's N external calls + N struct returns.

For N=25, this is ~25 × 2600 gas overhead = 65K gas just for the
inter-contract jumps. Could be optimized by:
- Adding `getValueStates(uint32[])` returning array — single external call
- Or inlining the `streamExists` / `valueState` lookups

Real savings: ~50K gas on a 25-stream `predictMultiple`. But it requires
restructuring the registry's external interface. **Probably not worth it
for v1**; the gas cost is real but bounded and Base L2 makes it
inconsequential.

## J. OBSERVATION — `_predictorWinRounds[user]` grows monotonically

**Location:** `SatoriRewards.scoreCorrectPrediction` (line 502).

Every winning round appends to the user's `_predictorWinRounds` array.
For a user winning daily for 5 years: 1825 entries.

The `_nextSettleRoundIndex[user]` cursor skips already-processed entries.
So per-claim work is bounded by NEW wins since last claim. Storage grows
unbounded but cleanup isn't free either.

**Leave as-is.** Storage rent isn't a thing on Ethereum/Base, so growing
storage is fine. The cursor handles the gas concern.

---

## Summary

| Item | Type | Effort | Impact |
|---|---|---|---|
| A | Bug | trivial | Fixes UX desync when fees change |
| B | Bug | trivial | Fixes view double-counting |
| C | Optimization | trivial | ~7K gas / claim |
| D | Optimization | medium (~30 LOC) | ~260K gas / heavy claim |
| E | Optimization | trivial | ~20K gas / scored prediction |
| F | Optimization | trivial (alongside D) | ~6K gas / claim |
| G-J | Already-fine / not-worth-it | — | — |

**Recommended action:** ship A + B + C + D + E + F in a single PR. Two
real bugs corrected; 4 optimizations totalling ~300K gas savings on hot
paths. All low-risk for a fresh deployment (no live-state migration
concerns since you said backwards compat isn't a concern).
