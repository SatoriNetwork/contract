> # ⚠️ SUPERSEDED — the mechanism this describes was removed
>
> **Corrected 2026-08-20.** The 2x off-chain vote handicap no longer exists. Burn
> voting made adapter games non-mint-eligible outright: `SatoriVoting.vote` reverts
> `GameNotMintEligible` for any `gameTypeId != 0`, so an off-chain game cannot be
> voted at all and a handicap on buying its weight has nothing to apply to.
>
> From the code: the handicap "was a discount priced against outcomes the chain
> cannot verify, and those games are now simply not mint-eligible at all — a
> cleaner line than any multiplier."
>
> Kept because the reasoning about *why* off-chain outcomes deserve weaker economic
> standing is still sound, and would be the starting point if adapter games are ever
> made mint-eligible again. Note it also references "bit 9", which was renumbered to
> bit 7. Do not implement anything from below without re-reading `SatoriVoting.vote`.

# Off-chain game vote handicap

## Intent

Off-chain games carry a strictly weaker trust model than on-chain games — their
outcome is scored entirely off-chain and settled against a Merkle root the game
authority posts, with no on-chain verification (see
[capability-rollout.md](./capability-rollout.md), bit 9). To make them compete for
emission at a disadvantage, **it costs twice as much to buy an off-chain game
weight**: burn 100 SATORI, receive 50 weight. The handicap is **per game type**
(every off-chain-typed game, for every voter) and **intrinsic** to the type — it is
not tied to the bit-9 registration flag (the admin can create off-chain games
regardless, and the handicap must always apply).

Because the handicap is priced into the weight itself, it is felt everywhere the
weight is: the game's reward-pool numerator, the round denominator it contributes
to, and the derived weight of the default game. There is nothing to apply
separately, because there is nothing that reads a raw figure and re-derives.

## Design — charge it once, at the only point weight is created

Under burn voting there is exactly one writer of vote weight: `SatoriVoting.vote`.
So the handicap is applied there, once, and nowhere else:

```solidity
weightAdded = _isOffchainHandicapped(gameId) ? amount / 2 : amount;
if (weightAdded == 0) revert ZeroVote();
gameWeight[gameId] += weightAdded;
totalBurnedWeight  += weightAdded;
```

`gameWeight` therefore stores the **already-handicapped** figure. Every downstream
read — `weightOf`, `getGameWeights`, `gameVotesAtRound`, `roundVoteTotal`,
`defaultDerivedWeight` — sees the handicapped number without knowing the handicap
exists.

This is the simplification the burn model bought. The previous design could not
halve at the write sites: vote power entered the tally from roughly seven of them,
including a transfer hook that re-synced on every token move, so per-site halving
drifted and was easy to bypass. It therefore stored a raw weight and halved at a
shared derive point (`_updateHeapForGame`), which meant every other raw reader —
notably the pre-lock numerator writer — had to inherit the identical multiplier or
trip the lockstep invariant. Now there is one path, so there is nothing to keep in
step.

`Voted(voter, gameId, round, amountBurned, weightAdded, newGameWeight)` carries both
sides, so an indexer sees what was spent *and* what it bought without knowing which
games are off-chain.

## Truncation is a revert, not a silent loss

`amount / 2` floors. Two consequences, both handled at the same guard:

- An **odd** burn loses ≤ 1 wei of weight — negligible at 18 decimals.
- A burn of **1 wei** on an off-chain game floors to zero weight. That is rejected
  (`ZeroVote`) rather than accepted, because accepting it would destroy the caller's
  tokens and buy nothing. Every other failure mode in `vote` reverts for the same
  reason.

There is no "restore on move-away" case any more, and no residual to worry about:
weight cannot move, so the only thing that ever happens to it is more of it.

## The classification cache

A game's type is fixed at `createGame`, and an off-chain type is flagged once at
registration, so the classification is immutable. `_isOffchainHandicapped` memoises
it in `_offchainClass` (`mapping(uint32 => uint8)`: 0 unknown / 1 on-chain /
2 off-chain), populated lazily on first touch, to avoid a cross-contract
`isOffchainGame` call on every vote. The mapping is appended storage and must stay
last (append-only layout rule).

## Not changed

`SatoriRewards` and `SatoriEngine` need no edits: the pool math self-normalises,
because the numerator and the denominator both derive from the same already-halved
`gameWeight`. Off-chain games remain vote-funded from the normal pool; this is
unrelated to the admin's `offchainBudget` Merkle-reserve dial — the two systems only
share the word "off-chain".
