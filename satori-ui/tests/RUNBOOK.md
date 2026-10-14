# E2E Runbook — C2 UI-surface specs (adapters / games / descriptors)

This runbook stands up the full local stack and runs the Playwright specs that
cover the descriptor-aware UI surfaces:

| Spec file | Covers |
|---|---|
| `adapters.spec.ts` | Adapter surfaces (Advanced tab create area): stream-adapter list + community register form; game-adapter section (list + community register form). |
| `games-list.spec.ts` | A stream's Games panel: built-in binary game (UP/DOWN) + a descriptor-driven YesNo game (Yes/No). |
| `create-game.spec.ts` | Create-game form: type `<select>` + descriptor-driven threshold field for a YesNo adapter type. |
| `stream-value.spec.ts` | Stream value cell + descriptor-driven label/unit via `formatStreamValue` (Custom/Chainlink/Uniswap adapter). |

Two of these depend on extra on-chain seed beyond the canonical deploy (a
registered YesNo game adapter + a created YesNo game, and a descriptor-backed
adapter stream). Without the seed those specs **skip** (they never fail for
missing state) — see step 4. The presence/form assertions in every spec run
against the bare deploy.

## Topology (important port wiring)

- The dapp runs in **development** mode (`npm start`), so it auto-connects a
  Hardhat dev signer and reads contracts from `addresses.ts[31337]`.
- The dapp's RPC auto-discovery (`addresses.ts` → `devRpcUrl()`) points at
  **`window.location.port + 1`**. So if the dapp is served on `PORT`, the
  Hardhat node must be reachable at **`PORT + 1`**. `playwright.config.ts`
  encodes the same convention (`baseURL` = `localhost:${PORT}`, node at `PORT+1`).
- `hardhat.config.js` boots the node with **chainId 1337**, while the dapp's
  `DEV_CHAIN_ID` is **31337**. This mismatch is harmless in dev: the dapp's dev
  signer is a raw `ethers.Wallet` over the read provider and does not enforce the
  chainId, and the deterministic contract addresses depend only on
  deployer+nonce (identical on either chain).

This runbook uses **`PORT=8544`** so the node sits on the hardhat-default
**`8545`** and `deploy.js --network localhost` (URL `http://127.0.0.1:8545`)
works with no config edits. Any `PORT` works as long as the node is on `PORT+1`.

All paths below are relative to the repo root `Satori/contract`. The contracts
toolchain (hardhat) lives at `Satori/contract/node_modules/.bin/hardhat`; the
dapp lives in `Satori/contract/satori-ui`.

## 1. Start a Hardhat node on PORT+1 (= 8545)

```bash
cd Satori/contract/satori
../node_modules/.bin/hardhat node --port 8545 --hostname 127.0.0.1 > /tmp/hh-node.log 2>&1 &
# wait until it answers:
curl -s -X POST http://127.0.0.1:8545 -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

## 2. Deploy the protocol (fills the deterministic addresses in addresses.ts[31337])

```bash
cd Satori/contract/satori
../node_modules/.bin/hardhat run scripts/deploy.js --network localhost
```

`deploy.js` deploys the split stack (immutable token + UUPS engine + hub +
children), registers the 3 official **stream** adapters (Chainlink=1,
Uniswap=2, Custom=3), bootstraps the default stream, and writes the address
book to `deployments/localhost.json`. The printed hub address must equal
`addresses.ts[31337].hub` (`0x9A676e781A523b5d0C0e43731313A708CB607508` on the
fixed deploy order).

## 2b. Enable the delegatePrediction capability (needed by `game-wallet.spec.ts`)

Every capability ships OFF by design (the deploy's post-conditions assert it),
and the Game Wallet's delegate step runs as a NON-admin dev account, so it
needs `CAP_DELEGATE_PREDICTION` switched on. The capability tool defaults to
Base Sepolia — point it at the local node and sign as the local admin
(hardhat account 0):

```bash
cd Satori/contract/satori
RPC_URL=http://127.0.0.1:8545 NETWORK=localhost SET=1 \
  SIGNER_KEYS=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  node scripts/set-capabilities.js +delegatePrediction
```

Without this, `game-wallet.spec.ts` fails at the delegate step with a message
pointing back at this exact command.

## 3. (Optional) Seed baseline dev activity — stream + votes + predictions

```bash
cd Satori/contract/satori
../node_modules/.bin/hardhat run scripts/dev-activity.js --network localhost
```

`dev-activity.js` generates a fresh stream + game, votes, two rounds of
predictions by two users, settles, and funds a token bounty — useful when the
dapp/indexer should show real activity. The C2 specs don't need it: stream 1
(the default stream) exists straight from `deploy.js`, which is all the
baseline assertions require.

## 4. Seed the C2 UI state (lights up the descriptor-driven specs)

```bash
cd Satori/contract/satori
../node_modules/.bin/hardhat run scripts/seed-e2e-ui.js --network localhost
```

(The script reads the hub/engine addresses from `deployments/localhost.json`,
written by `deploy.js`; `HUB_ADDRESS`/`ENGINE_ADDRESS` env vars override.)

`scripts/seed-e2e-ui.js` (added with this task) seeds exactly what the
otherwise-skipping specs need:

1. Deploys a `YesNoGame` and registers it as a **community game adapter** named
   `"Yes/No"` → the create-game `<select>` now offers a YesNo type and its
   `IGameUIDescriptor` `configSchema()` resolves the `threshold` field
   (`create-game.spec.ts`).
2. `createGame(stream 1, <yesno type>, abi.encode(int128 threshold), "Above/Below")`
   → stream 1's Games panel now shows a YesNo game with Yes/No option buttons
   (`games-list.spec.ts`).
3. Creates a **Custom adapter stream** (adapterId 3). The Custom adapter
   validates only `target != 0` (no on-chain probe) and its descriptor's
   `valueDisplay()` returns `(0, "", "Custom value")` regardless of target, so
   the stream row renders a descriptor label without needing a real feed/pool
   (`stream-value.spec.ts`). A Uniswap/Chainlink stream would instead need a
   real pool/aggregator at the target — their `validate()` probes it.
4. Creates a second **YesNo game on the Custom stream**. The deployer PROVIDES
   that stream, so it shows on the Advanced tab's "Your Streams" (manage)
   list — and with 2 games its "games" pill opens the games sub-view, where
   the create-game form lives (`create-game.spec.ts`).

## 5. Run the dapp (development mode) on PORT

`playwright.config.ts` will auto-start the dev server via its `webServer`
(`PORT=$PORT HOST=0.0.0.0 BROWSER=none npm start`, `reuseExistingServer: true`).
You can also start it yourself first:

```bash
cd Satori/contract/satori-ui
PORT=8544 HOST=127.0.0.1 BROWSER=none npm start
```

## 6. Run the specs

```bash
cd Satori/contract/satori-ui
# Just the C2 UI-surface specs:
PORT=8544 npx playwright test adapters games-list create-game stream-value

# Single worker (less flaky on a busy machine; one CRA server + one node):
PORT=8544 npx playwright test adapters games-list create-game stream-value --workers=1
```

If Playwright reports a missing browser
(`Executable doesn't exist at .../chromium_headless_shell-XXXX/...`), install it:

```bash
cd Satori/contract/satori-ui
npx playwright install chromium
```

## Expected result (with steps 1–4 seeded)

All 12 C2 assertions pass:

```
12 passed
```

Without step 4, the two descriptor-state specs **skip** instead of failing:
`games-list.spec.ts` (YesNo case) and `stream-value.spec.ts` (descriptor-label
case); the remaining 10 still pass against the bare deploy.

## Notes / caveats

- The **pre-existing** `phase0-connection.spec.ts` and `referral.spec.ts` are
  out of C2 scope and currently have stale expectations against the evolved app
  (e.g. the `<h1>` now reads "Satori daily", and the `current-round` /
  `stream-count` testids were removed). They are unrelated to these specs and
  were not modified.
- The C2 specs are presence/resolution checks — they do not submit predictions
  or pay spam fees, so they don't depend on the connected dev account holding a
  SATORI balance.
