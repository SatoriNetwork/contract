# Satori gasless relayer

The off-chain half of `docs/design/gasless-relay.md`. Users sign an EIP-712
`RelayRequest` (action + SATORI fee, one signature); this service pays the Base
ETH gas, calls `SatoriHub.relay()`, and receives the signed fee atomically.

## Flow

```
POST /gasless/quote   {user, action, data}         -> fee, nonce, deadline, typedData
      (wallet signs typedData; first use also signs a standing-allowance permit)
POST /gasless/submit  {…fields, signature, permit?} -> {transactionHash}
GET  /gasless/tx/{hash}                             -> pending | success | reverted
GET  /health
```

`action` is `SatoriHub.RelayAction`: 0 Predict, 1 Claim, 2 Transfer,
3 DelegatePrediction, 4 SetAllowedDelegator, 5 SetPredictorFee, 6 Vote.
`data` is the abi-encoded action arguments (for Predict:
`(address referrer, (uint32 gameId, bytes payload)[])`).

The server rebuilds and verifies everything from the raw fields — client
typedData is never trusted — then simulates before broadcasting, so a doomed
transaction costs nothing.

## Fees

`fees.json` (mounted into the container) is the whole pricing policy, in SATORI:

```json
{ "default": "0.25", "per_action": { "Claim": "0" } }
```

It is re-read on every request (mtime-cached). Editing it reprices the service
immediately — no restart, no deploy, no transaction. The contract stores no fee.

Users whose wallets are lane-A locked (a live prediction delegation) cannot pay
a SATORI fee at all; quote such users `"0"` fees or let submissions fail
simulation — policy, not code.

## Run

```
cp .env.example .env   # fill RPC_URL, HUB_ADDRESS, TOKEN_ADDRESS, RELAYER_PRIVATE_KEY
docker compose up -d
```

The key is env-injected at run time and never baked into the image. Keep
separate keys per network (Base Sepolia 84532 / Base 8453) and keep the wallet
topped with ETH — `/health` reports `ok: false` below `MIN_RELAYER_ETH` and the
service refuses new work.

## Tests

```
python3 -m pytest tests/ -q      # unit tests always; e2e auto-skips
tests/run_e2e.sh                 # full e2e: private hardhat node + deployed stack
```

`tests/test_signing.py` pins the EIP-712 hashing to a vector produced by
ethers' `signTypedData` — the same library `satori/test/GaslessRelay.test.js`
proves against the contract — so Python, the dapp and the hub cannot drift
apart silently.
