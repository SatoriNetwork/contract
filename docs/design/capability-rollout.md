# Capability flags — progressive rollout

## Intent

Satori launches **minimal**: at genesis the only things a member of the public can
do are **predict** and **claim** their own rewards (plus the always-open
plumbing: settle, dev-fee mint, keeper value-updates, and referrals). Every other
user-facing capability is gated behind an admin toggle and ships **OFF**. Features
are then opened **one at a time** on a public roadmap, so the community learns each
new capability as it arrives and the protocol limits its live attack surface during
the riskiest early period.

This is progressive decentralization: the permissionless-marketplace vision is
delayed, not abandoned. Nothing here is a bug fix — it is a launch posture.

## The capabilities

**Eight** live flags at bits 0..7, densely numbered, so "all on" is `0xff`. Ids are fixed
in `SatoriHub` (`CAP_*`) and read at the matching bit by
`SatoriRewards.capabilityAllowed`.

| Bit | Capability | Gated entry point(s) |
|-----|-----------|----------------------|
| 0 | Create streams | `createSimpleDataStream` (+ derived / adapter variants) via `_chargeStream` |
| 1 | **Author** a game (custom type/config on an existing stream) | `createGame` |
| 2 | Community stream adapters | `registerCommunityAdapter` |
| 3 | Community game adapters | `registerCommunityGameAdapter` |
| 4 | Bounties | `SatoriBounties.fundBounty`, `SatoriBounties.stakeBountyToken` |
| 5 | Prediction-power delegation | `delegatePredictionPower` to a delegate (leaving is never gated) |
| 6 | Claim delegation | `delegateClaimAbility` to a delegate (revoking is never gated) |
| 7 | Voting | `vote` |
| 8+ | *unused* | — |

A flag gates joining a feature, never leaving it. Switching bit 5 or 6 off
stops new delegations, but undelegating and revoking a claim delegate always
work: delegation locks the delegator's balance, and a claim delegate blocks the
owner's own claim, so a gate on leaving would strand them behind a toggle.

Vote bounties and vote delegation used to hold ids here. Both features were
removed with burn voting and their ids were **reclaimed**, not retired — see
below.

#### What bit 1 does and does not cover

It governs **authoring** a game: choosing a game's type, config and name on a
stream that already exists. It does NOT govern the plain built-in binary game
that every stream is born with — that one is created internally as part of the
stream and is covered by bit 0.

So turning bit 1 off stops custom and community game types appearing. It does
not stop new games appearing altogether: each new stream still brings its own
default game (and, on the with-derived path, one per derived child). Worth
knowing before reaching for this switch during an incident — it blocks the
dangerous class, not every game.

## Launch note: voting must be switched on

Voting is bit 7 and, like every other capability, ships **OFF**. Until the admin
enables it, only the admin can vote — so no game but the protocol's own accrues
any weight, and the whole emission split degenerates.

That is a real launch-ordering dependency, not a nicety: `scripts/deploy.js` does
not call `setCapabilities` at all, so a fresh deployment starts with the entire
bitmap at zero. Enabling voting is a deliberate post-deploy step.

## Ids are dense, and renumbering is fine pre-launch

The ids run 0..7 with no gaps. When a capability is removed, everything above it
renumbers down.

That is safe *here* for one specific reason: the policy is a single stored word,
`setCapabilities` overwrites it wholesale, and every deployment starts it at
zero. There is no surviving bitmap for a renumber to silently re-map.

It stops being safe the moment a live deployment's bitmap has to outlast a code
change. At that point the ids have to freeze, and a removed capability's bit has
to be abandoned rather than reclaimed — because a stored word written under the
old numbering would quietly grant the wrong capability. Until then, holes in the
numbering buy nothing and cost readability.

## How it works

- **Storage + setter live on `SatoriRewards`.** Rewards owns the `admin` role and is
  already called by both the hub and bounties, so it is the natural shared home. The
  hub gates all its user entry points by reading `rewards.capabilityAllowed(cap,
  msg.sender)`; `SatoriBounties` does the same for funding/staking.
- **`setCapabilities(uint256 bitmap)` — admin only.** The admin sets the whole policy
  atomically: bit `i` enables capability `i`. To open one more feature, read the
  current mask (off-chain, or from the `CapabilitiesSet` event) and OR in the next
  bit — e.g. `0x000` → `0x001` (streams) → `0x005` (streams + games) → … The setter
  is an **operational admin** power (`rewards.admin()`), not a governance
  authority; see [authority-map.md](./authority-map.md).
- **The admin always bypasses every flag.** `capabilityAllowed(cap, caller)` is
  `enabled(cap) || caller == admin`. This lets the admin seed the initial streams and
  games (so there is something to predict on at launch) while the public is still
  gated. For adapter registration the admin also retains its own free, always-open
  paths (`registerAdapter`, `registerGameAdapter`).
- **Fixed storage slot.** The bitmap lives at
  `keccak256("satori.hub.capabilities") - 1`, *outside* the sequential storage layout
  (the same pattern `SatoriUUPS` uses), so introducing it required no storage-layout
  re-baseline on any upgradeable contract.
- **Deploy default is 0** (all OFF). `scripts/deploy.js` does not enable anything; the
  admin opens features post-launch per the roadmap.

### Why the flags moved off the hub

`SatoriHub` is a facade already close to the EIP-170 24,576-byte limit (~23.2 KB).
Adding the storage word, `setCapabilities`, and the public view on the hub pushed it
~270 bytes over the limit — undeployable. Moving the storage + setter + view to
`SatoriRewards` (which had head-room) leaves the hub only the cheap per-function gate
(`rewards.capabilityAllowed(...)` call sites), keeping it under the limit. The setter
is a whole-bitmap store (one `SSTORE`, no read-modify-write) rather than a per-bit
`setCapability(id,bool)` partly for the same size reason and partly because setting
the entire rollout policy atomically is the safer operation.

## What adapter games can and cannot earn (bit 3)

No adapter game of any kind earns from the mint, and that is **permanent and
intended**. `SatoriVoting.vote` reverts `GameNotMintEligible` for any game with
`gameTypeId != 0`, and `gameWeight` is written in exactly one place: inside that
function, after that check. With no weight, `_gameRoundAllocation` yields zero.

Bit 3 still gates **real money**, though. An on-chain adapter game earns no
emission but does pay **bounties** — `scoreAdapterPrediction` calls
`creditAdapterBounty` deliberately, "so a no-payout SATORI round still pays
bounties". Bounties are funded by whoever wants the game to exist, not by the
protocol. Treat bit 3 as the flag that opens externally-funded games.

### Removed: off-chain root-settled games (held bit 7 until 2026-08-20)

There used to be a ninth capability for `registerCommunityOffchainGameAdapter`,
whose games were scored entirely off-chain against a posted Merkle root. Those
games could pay through **neither** route — not the mint, and not bounties either,
since they took no on-chain predictions — so `settleOffchainGame` could only ever
settle zero. The whole machinery was removed and the ids **compacted**, moving
voting from bit 8 down to bit 7.

See `docs/issues/adapter-games-cannot-earn.md` for the decision and what it freed.
`docs/design/offchain-vote-handicap.md` describes a mechanism removed even earlier
and is superseded.

## Testing

`test/next/Capabilities.test.js` covers: the setter is admin-only; unset bits read
disabled (default OFF) while the admin is always allowed; every one of the eight live
gated entry points reverts `CapabilityDisabled` for a non-admin when its flag is off;
the admin bypasses an off flag; and enabling exactly one bit opens exactly that
feature. A second block checks that clearing bits 5 and 6 never blocks leaving:
delegators undelegate (directly, to themselves, by relay) and can move their
tokens again, a delegator still votes and keeps its delegate, and an owner
revokes its claim delegate and claims for itself. Joining, switching and the
same-round return stay refused. The shared fixture (`deploySplitFixture`) sets `0xff` after wiring — bits
0..7, every one of which gates something, which is harmless to
set — so the rest of the suite exercises a full-featured environment; production
launches gated.
