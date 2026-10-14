# Core contract efficiency audit — round 2

Second pass after the A-F fixes. Lower-hanging fruit than round 1 but
some are still meaningful for a one-shot immutable deploy.

## 1. DEAD STORAGE — `upPredictions` / `downPredictions`

**Location:** `Satori.sol` line 142-145, 914-916.

```solidity
mapping(uint32 => mapping(uint256 => uint256)) public upPredictions;
mapping(uint32 => mapping(uint256 => uint256)) public downPredictions;
```

Written on every prediction:
```solidity
if (direction == 1) upPredictions[streamId][round]++;
else                downPredictions[streamId][round]++;
```

Used by: **only the public `getPredictionCounts` view function**.
The values are not read by any contract logic. They're purely for dapp
display.

Every prediction pays for an SSTORE that serves only display purposes.
The `PredictionMade` event already carries `direction`, `streamId`,
`round` — a dapp indexer (TheGraph or in-house) can compute up/down
counts from events.

**Gas saved:**
- Cold SSTORE (first prediction of stream-round-direction): ~22K
- Warm SSTORE (subsequent): ~3K (it's `+= 1` so subsequent increments)

For a typical predict on a fresh stream-round: 22K gas saved.
For a busy stream getting 100 predictions in a round: maybe 22K + 99×3K = 319K saved.

**Risk:** breaking change to the public ABI — dapp must move to events.
For a fresh deploy with no live dapp, free win.

**Recommendation:** drop both mappings and `getPredictionCounts`. Dapp
indexes from events.

## 2. DEAD STORAGE — `userWeightPerStreamRound` / `totalWeightPerStreamRound`

**Location:** `Satori.sol` line 148-151, 1026-1027.

```solidity
mapping(uint32 => mapping(uint256 => uint256)) public totalWeightPerStreamRound;
mapping(address => mapping(uint32 => mapping(uint256 => uint256))) public userWeightPerStreamRound;
```

Written in `_applyScore` on every correctly-scored prediction:
```solidity
userWeightPerStreamRound[user][streamId][dateA] = scaledWeight;
totalWeightPerStreamRound[streamId][dateA] += scaledWeight;
```

Used by: **no contract logic in production.** A grep across the
codebase shows only test files and docs read them. The corresponding
direction-split variants live in `SatoriRewards.sol`:
- `userWeightByDirection[user][streamId][round][direction]` — used by claim path
- `totalWeightByDirection[streamId][round][direction]` — used by claim path

The Satori.sol versions just merge UP+DOWN into a single number; the
direction breakdown in SatoriRewards is the actual source of truth used
by every reward computation.

So these are **duplicate writes serving no live purpose**.

**Gas saved:** 2 SSTOREs per scored correct prediction (~6K warm, more cold).
For a busy stream with 50 daily winners over 365 days: ~50 × 365 × 6K = ~110M gas across stream lifetime. Hot path.

**Risk:** breaking change to the public ABI for these two views. Tests
that read them (`RewardDistributionAccuracy.test.js` and a few
`test_backup/` files) will need to use the SatoriRewards-side
equivalents instead.

**Recommendation:** drop both mappings.

## 3. UNUSED FUNCTION PARAMETERS — `scorePrediction`

**Location:** `SatoriRewards.sol` line 433-453.

```solidity
function scorePrediction(
    address user,
    uint32 streamId,
    uint256 round,
    uint8 direction,         // ← UNUSED
    uint256 predictionPower  // ← UNUSED (compiler warns)
) external override onlyCore { ... }
```

Neither parameter is referenced in the body. The compiler warns
about `predictionPower`. `direction` is also dead.

**Gas saved:** ~64 bytes of calldata × ~16 gas/byte = ~1K gas per call.
Called from `Satori._makePrediction` (once per stream in a predict
batch). For 25-stream `predictMultiple`: ~25K wasted on calldata.

**Risk:** interface change. `ISatoriRewards`, the impl, the foundry
test mock, and the one caller in Satori.sol all need updating in
lockstep.

**Recommendation:** drop both params. Trivial change.

## 4. CROSS-CONTRACT CALL OVERHEAD — vault claim's per-round reads

**Location:** `BountyVault.sol` `claim()` (line 187-216), and the same
pattern in `claimAsDelegator`.

Per round, the vault makes up to 5 external calls into SatoriRewards:
```solidity
rewards.totalWeightByDirection(streamId, r, 1);   // ext call 1
rewards.totalWeightByDirection(streamId, r, 2);   // ext call 2
rewards.userWeightByDirection(msg.sender, streamId, r, 1);  // ext call 3
rewards.userWeightByDirection(msg.sender, streamId, r, 2);  // ext call 4
rewards.predictionDelegationInfo(msg.sender, streamId, r);   // ext call 5
```

Each external call has ~700 gas base overhead plus SLOAD cost. After
the first call to SatoriRewards in the tx the storage is "warm" so
SLOADs are ~100. Per call: ~800 gas overhead × 5 = ~4K per round.
Over 32 rounds: ~128K just in inter-contract dispatch.

**Fix:** add a batch view to `SatoriRewards`:
```solidity
function getRoundWeights(address user, uint32 streamId, uint256 round)
    external view returns (
        uint256 totalW1, uint256 totalW2,
        uint256 userW1, uint256 userW2,
        SatoriTypes.PredictionDelegationInfo memory delInfo
    );
```

Single external call. Saves ~4 of the 5 calls per round. **~100K gas
saved on a 32-round claim.**

**Risk:** Interface addition. Pure additive — doesn't change anything else.

**Recommendation:** add the batch view; refactor vault's loops to use it.

## 5. STORAGE PACKING — Registry's per-stream metadata

**Location:** `SatoriRegistry.sol` line 48-58.

```solidity
mapping(uint32 => HistoryEntry[32]) private historyData;
mapping(uint32 => uint8) private historyHead;
mapping(uint32 => uint8) private historyCount;
mapping(uint32 => uint64) private lastUpdateTimestamps;
```

Three separate mappings for metadata that's written together on every
`setValue`. Each setValue does:
- `historyHead[streamId] = ...`       // 1 SSTORE
- `historyCount[streamId] = ...`      // 1 SSTORE (until full)
- `lastUpdateTimestamps[streamId] = ...` // 1 SSTORE

Pack into a single mapping:
```solidity
struct StreamMeta {
    uint8 head;
    uint8 count;
    uint64 lastUpdateTimestamp;
    // 22 bytes unused — room for future fields
}
mapping(uint32 => StreamMeta) private streamMeta;
```

Now `setValue` does:
- `streamMeta[streamId] = ...` // 1 SSTORE total

**Gas saved:** ~2 SSTOREs per setValue × 365 setValues/year per stream = ~12K × 365 = **4.4M gas/year/stream**. Streams call setValue daily.

**Risk:** moderate. Touches a hot data structure. Need to update reads
in `_newestSlot`, `setValue`, `setValueForRound`, `updateValue`,
`getValue`, `getValueState`, `getValueAtRound`, `getFirstTwoValuesAfter`,
`getDataStreamInfo`, `getRecentHistory`, `getHistory`,
`wasStreamActiveInRound`. About 12 reader sites. Each is a 1-line edit
(replace `historyHead[streamId]` with `streamMeta[streamId].head`).

**Recommendation:** worth it. The setValue hot path is fundamental.

## 6. RETURN BLOAT — `getValueState` returns 8 fields, callers use 3

**Location:** `SatoriRegistry.getValueState` (line 452).

Returns the full `ValueState` struct (3 values + 3 rounds + currentIdx + count + lastUpdateTimestamp = 8 fields, ~256 bytes ABI-encoded).

Callers (`Satori.predict`, `Satori.predictMultiple`,
`BountyVault.recoverInactiveBounty`) use only:
- `vst.count`
- `vst.rounds[vst.currentIdx]`
- `vst.lastUpdateTimestamp`

The values array (3 int128) is never read.

**Fix:** add a slim view for the hot-path callers:
```solidity
function getLatestUpdateInfo(uint32 streamId) external view returns (
    uint8 count, uint64 latestRound, uint64 lastUpdateTimestamp
);
```

Saves ~3K gas/call (return data encoding) plus ~600 gas of internal
loop work to populate the values array.

**Per call savings:** ~4K gas.
**For 25-stream `predictMultiple` validation loop:** 25 × 4K = ~100K gas saved.

**Risk:** interface addition. Doesn't affect existing `getValueState`
(could keep both, or migrate callers and remove old).

**Recommendation:** add the slim view; migrate the predict path.

## Summary of round 2

| # | Item | Type | Impact | Risk |
|---|---|---|---|---|
| 1 | Drop `upPredictions`/`downPredictions` | Storage removal | ~22K gas/predict | Public ABI break |
| 2 | Drop `userWeightPerStreamRound`/`totalWeightPerStreamRound` | Storage removal | ~6K gas/scored prediction | Public ABI break |
| 3 | Drop unused `scorePrediction` params | Interface | ~1K gas/call | Coordinated interface change |
| 4 | Batch vault's per-round weight reads | New view | ~100K gas/vault claim | Pure addition |
| 5 | Pack registry's per-stream metadata | Storage refactor | ~6K gas/setValue | Many call sites updated |
| 6 | Slim `getLatestUpdateInfo` view | New view | ~100K gas/25-stream predict | Pure addition |

**Combined "all done" gas savings on the hot paths:**
- Every predict: ~28K saved (drop dead storage + slim view per stream)
- Every setValue: ~6K saved (pack metadata)
- Every vault claim: ~100K saved (batch reads)
- Every correct-prediction scoring: ~6K saved (drop dead storage)

These compound into thousands of dollars over the contract's lifetime
at scale, even on Base.

## Recommended sequencing

If you ship them, do it in order:

1. **#1 + #2** together — pure removals, no interface additions, easiest review.
2. **#3** — drop unused params (catches the compiler warning).
3. **#5** — registry metadata packing. Independent of the others.
4. **#4 + #6** together — both add new batch views to existing
   contracts; both refactor callers to use them. Same pattern, same risk
   profile.

Anything else I find later would be marginal compared to these.
