#!/usr/bin/env bash
# Full browser e2e for the pay-in-SATORI flow. Stages a private stack on
# isolated ports (RPC 3071, UI 3070, relayer 8020 — NEVER the 3032/3033/8545
# range other things use), drives the dapp through both prompt branches, and
# tears everything down. Temporarily patches the dapp's (stale) dev token
# address to the freshly deployed one and restores it via git on exit.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"     # .../contract
UI_DIR="$ROOT/satori-ui"
ADDR="$UI_DIR/src/contracts/addresses.ts"
RPC=3071; UI=3070; RELAY=8020
LOG=/tmp/satori-ui-e2e; mkdir -p "$LOG"
TARGET="$ROOT/relayer/tests/ui-e2e-target.json"
FEES="$LOG/fees.json"; echo '{"default":"0.25","per_action":{"Claim":"0"}}' > "$FEES"

NODE_PID=""; RELAY_PID=""; UI_PID=""
cleanup() {
  [ -n "$UI_PID" ] && kill "$UI_PID" 2>/dev/null
  [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null
  [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null
  # npx forks children; guarantee teardown by port. These three ports are unique
  # to this test — nothing else in the workspace uses them.
  command -v fuser >/dev/null && for p in $UI $RPC $RELAY; do fuser -k "$p/tcp" 2>/dev/null; done
  git -C "$ROOT" checkout -- "$ADDR" 2>/dev/null
  rm -f "$TARGET"
}
trap cleanup EXIT

echo "==> hardhat node :$RPC"
( cd "$ROOT/satori" && exec npx hardhat node --port $RPC ) > "$LOG/node.log" 2>&1 &
NODE_PID=$!
for _ in $(seq 1 30); do
  curl -sf -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","id":1}' "http://127.0.0.1:$RPC" >/dev/null && break
  sleep 1
done

echo "==> deploy + stage dry account"
( cd "$ROOT/satori" && HARDHAT_URL="http://127.0.0.1:$RPC" \
  npx hardhat run scripts/deploy-relay-ui-e2e.js --network localhost ) 2>&1 | tail -2 || { echo "deploy failed"; exit 1; }

TOKEN=$(python3 -c "import json;print(json.load(open('$TARGET'))['token'])")
echo "==> patching dapp dev token -> $TOKEN"
python3 - "$ADDR" "$TOKEN" <<'PY'
import re, sys
path, token = sys.argv[1], sys.argv[2]
s = open(path).read()
# Replace the FIRST token: "0x..." (the dev/31337 block, which is first in CHAINS).
s2 = re.sub(r'(token:\s*")0x[0-9a-fA-F]{40}(")', rf'\g<1>{token}\g<2>', s, count=1)
open(path, 'w').write(s2)
PY

echo "==> relayer :$RELAY"
( cd "$ROOT/relayer" && RPC_URL="http://127.0.0.1:$RPC" CHAIN_ID=31337 \
  HUB_ADDRESS=$(python3 -c "import json;print(json.load(open('$TARGET'))['hub'])") \
  TOKEN_ADDRESS=$TOKEN \
  RELAYER_PRIVATE_KEY=$(python3 -c "import json;print(json.load(open('$TARGET'))['relayerKey'])") \
  FEE_FILE="$FEES" MIN_RELAYER_ETH=0.001 \
  exec uvicorn app.main:app --host 127.0.0.1 --port $RELAY ) > "$LOG/relayer.log" 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 20); do curl -sf "http://127.0.0.1:$RELAY/health" >/dev/null && break; sleep 1; done

echo "==> dapp :$UI (derives its RPC as UI+1 = $((UI+1)), our node)"
( cd "$UI_DIR" && BROWSER=none PORT=$UI REACT_APP_RELAYER_PORT=$RELAY \
  exec npx react-scripts start ) > "$LOG/ui.log" 2>&1 &
UI_PID=$!
echo "    waiting for CRA compile..."
for _ in $(seq 1 90); do curl -sf "http://127.0.0.1:$UI" >/dev/null 2>&1 && break; sleep 2; done
sleep 3

echo "==> playwright"
UI_URL="http://127.0.0.1:$UI" node "$ROOT/relayer/tests/e2e_ui.mjs"
RESULT=$?
echo "==> exit $RESULT"
exit $RESULT
