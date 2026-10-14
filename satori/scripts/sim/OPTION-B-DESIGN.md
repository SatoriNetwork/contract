# Option B — Delegation-aware BountyVault

**Status:** design proposal, not yet implemented.
**Goal:** make vault bounty payouts symmetric with the protocol's 80/10/5/5
split when the predictor used delegated power. Today, the predictor takes
100% of the bounty regardless of delegation.

## Behavior

When predictor Bob calls `vault.claim(bountyId)` and his prediction at
round R used delegated power:

| Component | Today | After Option B |
|---|---|---|
| Bob's own portion of snapshot | 100% to Bob | 100% to Bob |
| Delegated portion of snapshot | 100% to Bob | 80% reserved for delegators<br>10% to Bob (delegate bonus)<br>5% to platformFee1<br>5% to platformFee2 |

A delegator (Alice) then calls `vault.claimAsDelegator(bountyId, delegate)`
to pull her pro-rata share of the reserved pool.

## Storage additions in `BountyVault.sol`

```solidity
// Per-bounty per-delegate per-round: 80% portion reserved for the
// delegate's delegators on the rounds where they predicted with
// delegated power. Set when the delegate calls vault.claim() and
// the round had delegated_power > 0.
mapping(uint256 => mapping(address => mapping(uint256 => uint256)))
    private _delegatorPool;

// Per-(delegator, bounty, delegate): cursor for next round to claim.
// Same CLAIM_WINDOW semantics as the predictor's lastClaimedRound.
mapping(address => mapping(uint256 => mapping(address => uint256)))
    public delegatorClaimedTo;
```

## API additions on `BountyVault.sol`

```solidity
function claimAsDelegator(uint256 bountyId, address delegate)
    external nonReentrant returns (uint256 amount);

// Optional helper:
function getDelegatorClaimable(uint256 bountyId, address delegator,
                                address delegate) external view returns (uint256);
```

## Modified `claim` flow

```solidity
function claim(uint256 bountyId) external nonReentrant {
    // ... [unchanged setup, cursor, snapshot loop] ...

    for (uint256 r = from; r <= to; r++) {
        uint256 totalW1 = rewards.totalWeightByDirection(b.streamId, r, 1);
        uint256 totalW2 = rewards.totalWeightByDirection(b.streamId, r, 2);
        if (totalW1 == 0 && totalW2 == 0) continue;

        // ... [snapshot logic unchanged] ...
        uint256 snapshot = _snapshots[bountyId][r];
        if (snapshot == 0) continue;

        uint256 share = 0;
        if (totalW1 > 0) {
            uint256 userW = rewards.userWeightByDirection(msg.sender, b.streamId, r, 1);
            if (userW > 0) share += (snapshot * userW) / totalW1;
        }
        if (totalW2 > 0) {
            uint256 userW = rewards.userWeightByDirection(msg.sender, b.streamId, r, 2);
            if (userW > 0) share += (snapshot * userW) / totalW2;
        }

        // NEW: detect delegated portion and reserve the delegator pool.
        SatoriTypes.PredictionDelegationInfo memory delInfo =
            rewards.predictionDelegationInfo(msg.sender, b.streamId, r);
        if (delInfo.delegatedPower > 0 && share > 0) {
            uint256 totalPower = uint256(delInfo.ownPower) + uint256(delInfo.delegatedPower);
            uint256 delegatedShare = (share * uint256(delInfo.delegatedPower)) / totalPower;

            uint256 fee1 = (delegatedShare * rewards.platformFeePercent1()) / 10000;
            uint256 fee2 = (delegatedShare * rewards.platformFeePercent2()) / 10000;
            uint256 delegatorsCut = (delegatedShare * 8000) / 10000;
            uint256 predictorBonus = delegatedShare - delegatorsCut - fee1 - fee2;

            // Reserve for later delegator claims
            _delegatorPool[bountyId][msg.sender][r] = delegatorsCut;

            // Pay fees immediately
            address p1 = rewards.platformFeeAddress1();
            address p2 = rewards.platformFeeAddress2();
            if (fee1 > 0 && p1 != address(0))
                IERC20(b.token).safeTransfer(p1, fee1);
            if (fee2 > 0 && p2 != address(0))
                IERC20(b.token).safeTransfer(p2, fee2);

            // Predictor gets only the own + delegate-bonus portion
            uint256 predictorPart = share - delegatedShare + predictorBonus;
            totalPayout += predictorPart;
        } else {
            totalPayout += share;
        }
    }

    // ... [pay predictor + fees, emit event] ...
}
```

## New `claimAsDelegator` flow

```solidity
function claimAsDelegator(uint256 bountyId, address delegate)
    external nonReentrant returns (uint256 amount)
{
    require(bountyId < bounties.length, "!bounty");
    Bounty storage b = bounties[bountyId];

    uint256 currentRound = satori.getCurrentRound();
    if (currentRound == 0) return 0;

    uint256 from = delegatorClaimedTo[msg.sender][bountyId][delegate];
    if (from == 0) from = 1;
    if (currentRound > CLAIM_WINDOW && from < currentRound - CLAIM_WINDOW) {
        from = currentRound - CLAIM_WINDOW;
    }
    uint256 to = currentRound - 1;
    if (from > to) {
        delegatorClaimedTo[msg.sender][bountyId][delegate] = to + 1;
        return 0;
    }

    uint256 total = 0;
    for (uint256 r = from; r <= to; r++) {
        uint256 pool = _delegatorPool[bountyId][delegate][r];
        if (pool == 0) continue;

        SatoriTypes.PredictionDelegationInfo memory delInfo =
            rewards.predictionDelegationInfo(delegate, b.streamId, r);
        if (delInfo.delegatedPower == 0) continue;

        uint256 senderPower = rewards.getDelegatorPowerAt(msg.sender, delegate, uint32(r));
        if (senderPower == 0) continue;

        total += (pool * senderPower) / uint256(delInfo.delegatedPower);
    }

    delegatorClaimedTo[msg.sender][bountyId][delegate] = to + 1;

    if (total > 0) {
        IERC20(b.token).safeTransfer(msg.sender, total);
        emit DelegatorBountyClaimed(bountyId, msg.sender, delegate, total, from, to);
    }
    return total;
}
```

## Required change in `SatoriRewards.sol`

Add one public view:

```solidity
function getDelegatorPowerAt(address delegator, address delegate, uint32 round)
    external view returns (uint256)
{
    DelegationPeriod[] storage periods = _delegationPeriods[delegator];
    uint256 len = periods.length;
    for (uint256 i = 0; i < len; i++) {
        DelegationPeriod storage p = periods[i];
        if (p.delegate != delegate) continue;
        if (round < p.startRound) continue;
        if (p.endRound != 0 && round >= p.endRound) continue;
        return _lookupBalanceAt(p, round);
    }
    return 0;
}
```

The internal `_lookupBalanceAt(p, round)` already exists and walks the
period's `Checkpoint[]` (typically 1-3 entries) to find the balance value
at `round`.

## Total change

- `SatoriRewards.sol`: +15 lines (one new public view)
- `BountyVault.sol`: ~+120 lines (new storage + new function + modified claim)
- Test additions: ~80 lines
- Total: ~215 lines

## Untouched

- Recovery (`recoverInactiveBounty`) — pool reservations are already
  deducted from `b.pool`, so they don't affect the un-snapshotted
  remainder the funder recovers. Delegators can still claim their
  reserved pool even after the funder recovers.
- `emergencyWithdraw` — owner can still drain everything for migration.
- Protocol-side reward logic — untouched. Same 80/10/5/5 split via
  `_getUserNetRewardForRound`.
