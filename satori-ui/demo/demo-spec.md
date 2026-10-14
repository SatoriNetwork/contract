# Satori Hype Reel — Demo Spec

The exact storyboard the recorder (`record-demo.js` / `tests/demo-hype.spec.ts`)
plays. ~2 min, 1280x720, captioned. Captions are injected as a fixed-position
styled banner via `page.evaluate` (bold white on a semi-transparent dark card).

| # | Beat | Caption (title / sub) | On screen | Hold |
|---|------|-----------------------|-----------|------|
| 1 | Title | **SATORI** / a prediction market that mints every round | centered title over the app | ~7s |
| 2 | Concept | **Streams → Games → Predict → Earn** | centered | ~6s |
| 3 | Streams | **Browse prediction streams.** / Vote one eligible. | Streams tab; slow scroll down the populated stream list (BTC/ETH/SOL/Satori Daily…) | ~17s |
| 4 | Predict | **Predict the direction.** / Stack them. Submit. | switch dev account → **Bob** (fresh, hasn't predicted); top prediction flow (chart + UP/DOWN); click UP to stack a prediction | ~18s |
| 5 | Earn | **Win → streaks, rewards,** / claim anytime. | switch dev account → **Alice** (already predicted → live Claimable); Dashboard balance/claimable/power/lock + Streaks + Recent Predictions | ~15s |
| 6 | Extensible (flex) | **Add a price feed or a whole new game type —** / the UI adapts automatically. | Adapters tab (stream-adapter list: Chainlink/Uniswap/Custom; game-adapter list: community Yes/No), then expand stream #1's **Games** panel showing the built-in **Binary UP/DOWN** and the descriptor-driven **Yes/No (Above/Below)** game | ~24s |
| 7 | Close | **SATORI** / predict everything. | centered title | ~7s |

## Robustness contract

Every interactive sub-action (vote click, UP click, account switch, row expand)
is best-effort and wrapped so a missing element NEVER aborts the recording — the
caption + the relevant tab/static shot always plays. The reel degrades
gracefully, it does not fail.

## Seeded state the reel relies on

Produced by `satori/scripts/deploy.js` + `seed-e2e-ui.js` + `seed-demo.js`
(see `README.md`). On the recorded take:

- **Streams** (6): `Satori Predictions` (#1, default flagship), `Custom feed (e2e)`
  (#2, official Custom adapter), `BTC / USD` (#3, value 64000 → renders 64.0K),
  `ETH / USD` (#4, 3400), `SOL / USD` (#5, 145), `Satori Daily` (#6, 1440).
- **Eligibility**: BTC (#3) is eligible (it carries "your vote" for the default
  account); ETH (#4) also surfaces eligible; the rest are ranked/ineligible.
  Votes were cast game-keyed from dev accounts 1–6; predictions were submitted on
  the eligible game so the Dashboard shows live claimable rewards.
- **Adapters**: official stream adapters Chainlink V3 (#1), Uniswap V3 (#2),
  Custom (#3); one **community game adapter "Yes/No"**.
- **Games on stream #1**: the built-in Binary (Up/Down) game **and** a
  descriptor-driven YesNo game named "Above/Below" — this is the flex shot.

Dev accounts available in the switcher: **Owner**, **Alice**, **Bob**.
