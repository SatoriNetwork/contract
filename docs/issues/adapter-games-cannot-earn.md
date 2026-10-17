# Adapter games do not earn from the mint — intended and permanent

**Found:** 2026-08-20, chasing an owner challenge to an overstated risk claim.
**Status:** **DECIDED 2026-08-20 — intended and permanent.** Owner's ruling. Not a
defect; the code was right and four documents were wrong.

## The decision

**Adapter games never draw from the mint. The emission belongs to the protocol's
own binary game, permanently.**

The mechanism: `SatoriVoting.vote` reverts `GameNotMintEligible` for any game with
`gameTypeId != 0`, and `gameWeight` is written in exactly one place — inside that
function, after that check. There is no other path to weight, so no adapter game
can hold any, and `_gameRoundAllocation` yields zero for all of them.

The reasoning is in the code and is the whole argument:

> The old off-chain 2x handicap is gone: it was a discount priced against outcomes
> the chain cannot verify, and those games are now simply not mint-eligible at all
> — a cleaner line than any multiplier.

Pricing a discount for unverifiable outcomes was always going to be a guess. Not
paying for them at all is a line that needs no calibration and cannot be gamed.

## ⚠️ Correction: "economically inert" was wrong for on-chain adapter games

The first version of this document said adapter games "cannot pay anyone". That is
**false for on-chain adapter games**, and the distinction matters for the rollout
order:

| | mint | bounties |
|---|---|---|
| built-in binary (type 0) | ✅ the only game that earns emission | ✅ |
| **on-chain adapter (bit 3)** | ❌ never | ✅ **yes — real money, externally funded** |
| **off-chain root-settled (bit 7)** | ❌ never | ❌ no on-chain predictions, so no scoring path |

`scoreAdapterPrediction` calls `creditAdapterBounty`, and the code comment there is
explicit that this is deliberate: *"so a no-payout SATORI round still pays
bounties."* The design **anticipates** games that earn no emission and pay real
bounties. On-chain adapter games are a genuine product surface funded by whoever
wants them, rather than subsidised by the protocol.

## The one real consequence, and it is bit 7 only

Off-chain root-settled games can pay through neither route. They take no on-chain
predictions (structurally, since 2026-08-19), so `scoreAdapterPrediction` never runs
for them and no bounty is ever credited. Their only payout path is
`settleOffchainGame`, which pays from a pot sized by vote weight they can never
have.

**So `settleOffchainGame` can only ever settle zero.** The merkle verification, the
cursor, the FCFS partial-pay logic, the pot accrual machinery and its 32 tests are
all reachable and all correct, and none of them can move a token.

## ✅ REMOVED 2026-08-20 — owner's decision

The machinery is gone. Off-chain root-settled games no longer exist anywhere in the
contracts.

**What it freed, measured:**

```
SatoriRewards  23847 -> 22095   -1,752   headroom  727 -> 2,481
SatoriHub      21967 -> 19935   -2,032   headroom 2,609 -> 4,641
SatoriGames     8631 ->  8192     -439
SatoriEngine   15910 -> 15875      -35
                              ---------
                               -4,258 bytes
```

`SatoriRewards` was the tightest contract in the system and the only one carrying a
size warning. **That warning is gone** — headroom went from 727 bytes to 2,481, a
3.4x increase, in the contract where it was scarcest.

**Removed:** `SatoriRewards`'s pot state (4 mappings), its two events, the
`OffchainGameNoPredict` error, `accrueOffchainGamePot`, `_accrueOffchainGamePot`,
`creditOffchainGameSettle`, and both unreachable backstops; `SatoriHub`'s
`settleOffchainGame`, `recordOffchainGameVotes` and the two registration doors;
`SatoriGames`'s `isOffchainGameType`, `isOffchainGame` and
`registerOffchainGameAdapter`; the `offchain` bit from `gameDispatch`; the engine's
`OffchainNotPredictable` checks added the day before; `OffchainGame.sol`,
`IOffchainGame.sol`, `DualUseOffchainGameMock.sol` and 32 tests.

**Two things got structurally simpler, not just smaller:**

- `onStreamProduced` lost its per-stream games loop entirely — a `gamesByStream`
  read and a loop, off the registry's write path. Its remaining job is the
  round-budget freeze, which is not incidental: `_ensureRoundBudget` pins a round's
  gross on first touch, and a stream producing can be that first touch.
- The Conservation invariant got **stronger**. It reasoned that the first predictor
  was the sole writer of a round's numerator "except for `recordOffchainGameVotes`,
  which needs an off-chain game type, of which none is registered in this fixture."
  That exception is now gone from the contract, so the invariant holds by
  construction rather than by fixture.

**Capability ids were COMPACTED** (owner's call): voting moved from bit 8 to bit 7
and there is no hole. "All on" is now `0xff`, not `0x1ff`.

Safe to renumber only because nothing is live — every capability ships OFF and no
mainnet deployment exists. Once a bitmap has been set on a live chain this stops
being free, which is exactly the trap the stale H1 list set earlier the same day.

### ⚠️ This cannot ship as an upgrade to the current Sepolia stack

Removing four storage mappings from `SatoriRewards` shifts every slot after them by
four. The layout guard caught it — that is what it is for — and the baseline was
re-pinned deliberately (55 slots -> 51).

**So the Sepolia deployment from earlier today must be redeployed, not upgraded.**
Upgrading that proxy in place would read `satoriEngine` out of the slot that used to
hold `offchainGamePotAccrued`. This was the right trade only because no mainnet
deployment exists and a Sepolia redeploy costs about 0.0004 ETH: the alternative was
leaving four dead slots in a contract meant to run unchanged forever.

### Post-removal review — every gate re-run 2026-08-20

The owner held the deploy until this was verified end to end. Results:

| gate | result |
|---|---|
| Hardhat suite | **2140 passing, 0 failing** (down exactly 32 — the deleted off-chain tests) |
| Foundry | **43 passing, 0 failing**, 12 suites |
| Dapp suite | **249 passing**, 21 suites |
| Dapp production build | succeeds; new bundle carries no removed symbol |
| Deploy on a fresh chain | **all 37 post-conditions passed** |
| Storage layout guard | 8 contracts OK, 0 breaks (re-pinned 55 -> 51 slots) |
| EIP-170 sizes | no warnings; `SatoriRewards` headroom 727 -> 2,481 |
| Public ABI diff | **19 removed, 0 added** — every removal off-chain-only |
| Dangling references | none in source; two Foundry hits are comments explaining the removal |

**Gas got cheaper, which was not the goal.** A single `predict` fell **16,237
gas** (662,822 -> 646,585) and `predictMultiple(20)` fell 21,813.

That saving does *not* come from the `onStreamProduced` loop, which sits on the
registry's `setValue` path and never runs during a prediction. It comes from two
things the predict path itself stopped doing:

- `SatoriGames.gameDispatch` returned a third value, `offchain`, computed as
  `isOffchainGameType[typeId]` — **an SLOAD on every predict**, to answer a
  question with only one possible answer. Removing the mapping removed the read.
- `SatoriEngine` then branched on that value (`if (offchain) revert
  OffchainNotPredictable;`), a guard added 2026-08-19 and removed again here.

The `onStreamProduced` loop saving is real but lands on stream production, not
prediction: it dropped a `gamesByStream` array fetch plus one `isOffchainGame`
external call **per game on the stream**, work that scaled with a stream's game
count in order to almost always discover it had nothing to do.

Three stragglers the review caught and fixed, none of them behavioural: a comment
placed mid-expression in `seed-demo-activity.js` that commented out a `.wait()`
(caught by `node --check`); `verify-deployment.js` still probing a ninth
capability that no longer exists; and `capability-rollout.md` still carrying a
section calling bit 7 "community off-chain game adapters" when bit 7 is now voting.

## What was wrong, now fixed

Four places asserted the opposite, two of them inside the contract:

- `SatoriVoting.sol` ×3 — `VoteCast` NatSpec, `ZeroVote` NatSpec, and the `vote`
  header all described the off-chain 2x handicap as live, in the same file whose
  `vote` body says it was removed.
- `capability-rollout.md` — claimed off-chain games "draw from the normal
  vote-weighted pool" and "carry a vote handicap".
- `docs/design/offchain-vote-handicap.md` — a whole design doc for the removed
  mechanism. Marked superseded.
- `LAUNCH_CHECKLIST.md` E1 — "a community adapter decides **who** wins each round",
  framed as the largest untrusted-code surface. It does decide that, and with
  bounties there is real money in it — but not emission, which is what the framing
  implied.

## Related

- `docs/design/capability-rollout.md` — bits 3 and 7.
- `docs/design/offchain-vote-handicap.md` — superseded.
- `docs/issues/offchain-games-separated-architecture.md` — the 2026-08-19
  separation, which is *why* off-chain games have no scoring path and therefore no
  bounty path either.

---

## ✅ THE DEAD MINT LANE REMOVED 2026-08-23

The 2026-08-20 pass removed the off-chain class but left the ON-CHAIN adapter
game's SATORI payout in place — reachable code whose pool was always zero. The
owner caught it the moment it was written down as a live referral payer:

> "they don't get paid on adapter games remember? We made it so adapter games
> can't get voted so adapter games cannot pay out the central mint"

Traced end to end before cutting:

```
SatoriVoting.vote reverts GameNotMintEligible for gameTypeIdOf != 0,
and gameWeight is written nowhere else
  -> getGameVotesAtRound is always 0 for an adapter game
  -> _gameRoundAllocation returns 0 at `if (gameVotes == 0)`
  -> _streamPoolPostCut returns 0 at `if (nominalAllocation == 0)`
  -> reward = Math.mulDiv(0, effShare, roundTotal) = 0
  -> `if (reward > 0)` never opens
```

The one way round it was checked too: `_streamPoolPostCut` can size a slice from
a DIFFERENT game (the base's default, on a derived stream), but that branch needs
this game to BE its stream's default, and a default game is the built-in binary,
never an adapter.

**Removed:** the first-scorer pinned denominator, the running-paid cap, the
saturating `userScore × multiplier` product, `_adapterRoundTotal` and
`_adapterRoundPaid`, and `multiplier`/`total` from `scoreAdapterPrediction`'s
signature (interface, implementation and the engine's call).

**Kept:** the `_adapterPending` consume — the protocol owning double-pay
prevention — and the whole BOUNTY lane, which is real, separately funded, and
pays on a game type that earns no emission. `IPredictionGame.score` still returns
six values; that is an untrusted external contract's shape and not ours to change.

```
SatoriRewards  22096 -> 21700   -396   headroom 2480 -> 2876
SatoriEngine   15875 -> 15823    -52
storage           51 -> 49 slots (re-pinned deliberately)
```

**AUDIT H3 IS NOW CLOSED BY SOMETHING STRONGER.** Those rails were the fix for
the H3 over-mint (a hostile adapter handing each user a tailored singleton total
to pay everyone a full pool). There is no longer a mint path to over-mint
through. The mirrored rails on `SatoriBounties` are untouched and still bound
`Σ bounty ≤ pot`, which is where the reasoning still earns its keep.

**Tests:** 2137 passing, down exactly 5 — the removed arithmetic's own tests.
They had already been reduced to shape-checks: their titles read "credits the
FULL pool — which is zero" and "half of zero is zero", and the file header
admitted "the multiplier-scales-the-numerator semantics are no longer covered
end-to-end anywhere". What survives is the end-to-end "five self-declared winners
are paid nothing" and the double-pay guard.

**17 doc corrections across 9 canonical files.** Delicate because
`SatoriBounties` carries mirrored rails that ARE live, so each edit had to strip
the SATORI half of a sentence and leave the bounty half standing.

⚠️ **Sepolia must be redeployed again** — two mappings removed shifts every slot
after them, and the ABI changed.

