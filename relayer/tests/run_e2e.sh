#!/usr/bin/env bash
# Full e2e in one shot: private hardhat node on :8547 (NEVER :8545 — other
# services live there), stack deploy, pytest, teardown.
set -euo pipefail
cd "$(dirname "$0")/../../satori"

npx hardhat node --port 8547 > /tmp/relay-e2e-node.log 2>&1 &
NODE_PID=$!
trap 'kill $NODE_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl -sf -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' \
    http://127.0.0.1:8547 > /dev/null && break
  sleep 1
done

HARDHAT_URL=http://127.0.0.1:8547 npx hardhat run scripts/deploy-relay-e2e.js --network localhost

cd ../relayer
python3 -m pytest tests/ -q
