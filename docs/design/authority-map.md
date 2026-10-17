# Authority map — every privileged action in the protocol

Enumerated from the contracts on 2026-09-12, not from memory. Permissionless
actions are deliberately absent: this lists only what someone needs a ROLE to
do. If a call is not here, anybody can make it.

Written as the reference input to the DAO design (`humble.md` §4). The DAO model
under discussion is *the DAO appoints and recalls authorities, and holds only a
lever or two directly* — so the first question any of it has to answer is
"which authorities exist, and what is the worst each can do?" That is this file.

> Keep this current. It is the kind of document that is worth nothing the moment
> it lags the code, and the code is the authority over it.

---

## 1. The token's six authority slots

**`token.governor` no longer exists.** It was one address gating the fee, every
proxy upgrade, and all three token pointers — several unrelated jobs held by one
key. It was split on 2026-09-13 (`dao-governance.md` §10) into one slot per job,
so each can be a different Safe.

The **shape is frozen forever**: the token has no upgrade path, so the number and
boundaries of these slots can never change, only the addresses. Any one slot may
later point at a contract instead of a Safe, and that contract can subdivide
however it likes.

| Slot | Holds |
|---|---|
| `rootAuthority` | assigns all five below; `setRootAuthority` (two-step) / `renounceRootAuthority` |
| `feeAuthority` | `proposeDevFeeBps` / `acceptDevFeeBps` / `cancelDevFeeBps` — **freezable** |
| `upgradeAuthority` | `upgradeTo`, `renounceUpgrade` on all eight proxies |
| `wiringAuthority` | `setController`, `setHook`, `setAirdrop`, `setBridgeAuthority` (all **freezable**), `hub.setSatoriMerkle` |
| `appointAuthority` | `rewards.setAdmin`, `airdrop.setAirdropAuthority` (recall), `engine.setCurveOperator`, `setDustFloor`, `setDustTarget` |
| `freezeAuthority` | `freezeController` / `freezeHook` / `freezeAirdrop` / `freezeBridgeAuthority` / `freezeDevFeeBps` — one-way |

Every upgrade in the system resolves to `upgradeAuthority` —
`SatoriUUPS._upgradeGovernor()` returns `token.upgradeAuthority()` — so that one
slot is, in effect, the power to rewrite any contract except the token.

**`rootAuthority` is omnipotent in two steps.** It can point any slot at itself
and then act. The split separates *routine* power; the root is contained by its
own signers, not by the contract.

**`renounceRootAuthority` is not the old `renounceGovernor`.** It gives up only
the power to REASSIGN — the standing authorities keep working. Killing a lever is
now its own deliberate act: empty the slot that drives it. "Give up everything"
is no longer one call.

## 2. `token.pendingRootAuthority`

`acceptRootAuthority`, and nothing else. Nobody else can call it. Root is the
only two-step slot, because nothing can recall it — a mistyped address would take
the role and brick it. The other five are one-step and immediate, because they
are RECALL paths and in a compromise the priority is severing the bad holder now.

## 3. The rewards-level slots

`rewards.admin` was split on 2026-09-14, one level down from the token's governor
split and for the same reason. The job with real blast radius was carved out and
the rest stayed.

**`emissionSplitAuthority`** — `setOffchainBudget`, the on-chain / off-chain
dial. The largest economic lever in the protocol, and it also **bounds the Merkle
root publisher**, since a published root can only ever pay out of the reserve the
dial accrued.

**`airdropAuthority`** — `loadAirdropBatch` and `finalizeAirdropLoading` — was the
second carve-out until 2026-10-07, when the airdrop moved into its own contract
(`docs/issues/airdrop-own-contract.md`). It is now a role on `SatoriAirdrop`,
seeded at construction with `REWARDS_ADMIN`, rotated by its holder, recalled by
`appointAuthority`, with no admin fallback. Still the only operational power that
can put tokens somewhere: loading has no on-chain cap check, so an over-allocation
turns the cap into a claim race. Loading closes at the token's `freezeAirdrop`
(`loadAirdropBatch` reverts `AirdropLoadingClosed` once `airdropFrozen`), so the
table checked before the freeze is exactly what pays; freeze only after the last
batch is loaded and checked, because a freeze before loading would leave this
airdrop empty for good. What is left is `finalizeAirdropLoading`, which opens
every claim at once and reverts `AirdropNotFrozen` until the token's airdrop
door is frozen on this contract (an emptied wiring slot does not count, because
root can refill it): after that, nothing it can call changes anyone's claim
(`airdrop-claim-at-finalize.md`).

**`admin`** keeps everything else:

| Where | Action |
|---|---|
| rewards | `setCapabilities` — feature toggles; **the admin bypasses every toggle regardless** |
| rewards | `setAdmin` — rotate itself (`token.appointAuthority` can also seize it) |
| voting | `setGameApproved` — switch a game's earning on or off |
| hub | `registerAdapter`, `registerGameAdapter` — official registration, free (community registration pays a burn) |
| engine | `setOffchainReporter` |

Those are denial or noise, not theft; splitting them further would be ceremony.

**Zero means "fall back to `admin`"** for `emissionSplitAuthority`. `SatoriRewards`
is behind a proxy, so the slot is APPENDED storage and an unset slot behaves
exactly as it did before the split — no migration step, and no window in which a
job has no holder. (`airdropAuthority` has no fallback and rejects zero.)

Both are reassigned by **their own holder or `token.appointAuthority`**, the
same shape as `setAdmin`: a holder rotates its own key without asking, and recall
reaches every office.

## 3a. `hub.emissionAuthority`

Added 2026-10-12 with the issuance-indexed emission schedule
(`docs/narratives/A_emission.md`). One lever: `setEmissionRatio(ratioWad)`, the
multiplier applied each time the hub's issuance counter crosses a threshold.
0.618 is the default; 1.0 freezes the rate; above 1 grows it, clamped at 1,440 per
round; 0 reverts (owner ruling 2026-10-14), so a dust multiplier is how emission
winds down and there is no one-way stop. A change never touches the current or next round's rate.

Same shape as the rewards slots: `emissionHolder()` is the slot, or
`rewards.admin()` while it is zero; `setEmissionAuthority` is callable by the
holder or `token.appointAuthority`; one-step, no freeze.

## 4. `engine.curveOperator`

`setDustFloor`, `setDustTarget`. Optional — `address(0)` means only the governor
may tune. Appointed by the governor, and has no other power.

## 5. `merkle.rootPublisher`

`setMerkleRoot`, plus `setRootPublisher` / `acceptRootPublisher` (two-step).

**The quietest large power in the protocol.** Publishing a root decides who is
paid off-chain, up to the accrued Merkle reserve — so it is a payout key wearing
a publishing key's name. Its blast radius is bounded by the reserve, and the
reserve is bounded by `setOffchainBudget`, so whoever holds the dial bounds
whoever holds the root.

## 6. `engine.offchainReporter`

Adds off-chain prediction counts to the current round's running total, which is
what `flushDefaultStream` publishes as the default stream's value. `address(0)`
disables the feature.

## 7. `marketingFeeRecipient`

Receives the 5% referral skim from every unreferred earner. Can hand itself over
via `transferMarketingFeeRecipient` / `acceptMarketingFeeRecipient` (two-step).

## 8. Per-stream: the stream provider

Sets values on their own simple streams; `setDataStreamName`; `setProvider` to
hand over. **A user role, not a protocol authority** — see the note below.

## 9. Per-game: the game authority

`setGameName`; `setGameAuthority` to hand over. Also a user role.

## 10. Bridges

- **Tier 1** — `SUPERCHAIN_BRIDGE`, a hardcoded constant. Never the governor's.
- **Tier 2** — whatever the `bridgeAuthority` registry approves.

Both may `crosschainMint` / `crosschainBurn`, which move existing supply between
chains rather than creating it.

## 10b. Holder voting (both instruments hold authority over NOTHING)

- **`hub.voteLockGovernor`** — the one contract allowed to write lane-B vote
  locks through `hub.voteLock` (lane B only, never shortens, capped at now +
  90 rounds). Appointed and severed by the WIRING authority
  (`setVoteLockGovernor`); severing stops new locks and existing ones expire
  on their own. Worst case while appointed and hostile: wallets that vote
  stay locked up to a quarter.
- **`LockVoteGovernor.proposer`** — the association; the only address that
  can open a lock-vote proposal (a voter's lock is voluntary, but only for
  proposals worth locking on). Hands itself over with `transferProposer`; a
  mistake is repaired by redeploying and re-pointing the hub.
- The proof governor (`HistoricalBalanceGovernor`) adds NO authority
  anywhere: propose and activate are permissionless, and finalize publishes
  an event. It appears here only to record that on purpose it does not.

## 11. `controller` — a contract, not a person

The hub. `rewardMint`, `setLock`, `markParticipated`. Listed because freezing
this pointer is the point of `humble.md` §4a. Not `airdropMint`: neither the hub
nor any hub upgrade can mint airdrop.

## 11b. `airdrop` — a contract with no upgrade path

`SatoriAirdrop`, the one caller of `token.airdropMint`. Deliberately not the
controller: the hub is upgradeable, the airdrop contract is not, and the point of
the split pointer is that the airdrop can be frozen (`freezeAirdrop`) without
freezing anything else. Until the freeze, `wiringAuthority` can re-point it at a
successor contract, which is how a corrected table or new airdrop behaviour
ships, and also how a hostile wiring key could mint the unminted airdrop cap.
`freezeAirdrop` (one-way) ends that: after it no key, no hub upgrade and no
redeployed airdrop contract can mint airdrop beyond the frozen contract's table,
because the freeze also closes that table. Claims cannot open before the freeze:
finalize requires `airdropFrozen`.

## 12. `deployer` — dead after deploy

One-shot wiring on the children (`setSatoriCore`, `setSatoriEngine`,
`setSatoriBounties`, `setSatoriRewards`). Each reverts `AlreadySet` on a second
call, so the role expires at the end of the deploy script.

---

## What has NO power

`PLATFORM_FEE_RECIPIENT` receives the dev fee and can do nothing else. There is
no setter for it anywhere, by anyone, on any contract. It is a
`SatoriSplitterImmutable` deployed with no authority at all.

---

## Worst case, per authority

The question the DAO design actually turns on. "Can this role steal, or only
annoy?"

| Role | Worst it can do | Steal? |
|---|---|---|
| `rootAuthority` | point any slot at itself, then do anything below | **yes, in two steps** |
| `wiringAuthority` | re-point the controller and drain banked mint headroom; until `freezeAirdrop`, re-point the airdrop door and mint the unminted airdrop cap | **yes** |
| `upgradeAuthority` | upgrade any contract to anything | **yes** |
| `rootPublisher` | direct the whole accrued Merkle reserve to itself | **yes, within its lane** |
| `airdropAuthority` (on `SatoriAirdrop`) | over-allocate the airdrop before the freeze — no on-chain cap check, so the overage becomes a claim race; or never finalize, so nobody can claim | **yes** |
| `emissionAuthority` (hub; falls back to `admin`) | raise emission to the 1,440/round ceiling (dilution), or wind it down to dust (ratio 0 reverts) | no — it cannot mint or redirect; its reach is the size of future emission |
| `emissionSplitAuthority` | starve either scoring lane; set the ceiling the root publisher pays out of | no — denial, but it sizes someone else's theft |
| `admin` | switch every game off; toggle capabilities | no — denial |
| `offchainReporter` | inflate the default stream's count, distorting its scoring | no |
| `curveOperator` | move the streak curve within bounded dials | no |
| `marketingFeeRecipient` | redirect its own future skim | only its own |
| stream provider | publish bad values on their own streams | no |
| game authority | rename their own game | no |
| tier-2 bridge | mint on one chain against a burn on another | only via the registry the governor sets |

Two of these are the reason `humble.md` §4a exists and the reason the §4
discussion keeps returning to recall: **the two roles that can steal are the two
that most need to be replaceable quickly.**

## Where the model and the code currently disagree

For a DAO that appoints and recalls authorities, these are the gaps:

These are design inputs, not a work list. No DAO contract exists yet, so there
is nothing to point a recall at.

- **`rootPublisher` cannot be overridden by any token slot.** `setRootPublisher`
  is publisher-only, so a rogue or key-lost publisher cannot be replaced from
  outside. Under the v2 design this is **resolved without code**: the publisher
  is a Safe, so recall happens among its own signers. It only becomes a problem
  again if the role is ever given to a plain EOA.
- **`marketingFeeRecipient` likewise** — self-rotating only. Same resolution,
  lower stakes.
- **`finalizeAirdropLoading` stays loader-only** (owner, 2026-09-12, as
  admin-only; the role moved to `SatoriAirdrop` on 2026-10-07). Loading itself
  now ends at the freeze authority's `freezeAirdrop`; finalize only opens claims
  on the frozen table. It is the natural end of the loader's own one-time job
  rather than the destruction of a standing office, and it cannot steal. See
  `dao-governance.md` §2.
- **`setOffchainBudget` is `admin`-gated, not governor-gated**, so a DAO that
  wants the dial directly must either take `admin` wholesale or have the lever
  re-gated. `SatoriRewards` is upgradeable, so this is a change, not a redeploy.
- **`admin` is already recallable by the governor** (`setAdmin` accepts
  `admin || _upgradeGovernor()`), and `curveOperator` is governor-appointed. Both
  already match the model exactly.
- **Stream providers and game authorities should stay un-recallable.** They are
  user property, not protocol authority. A DAO that can seize a stream is a DAO
  that can seize a user's things.
