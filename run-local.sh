#!/bin/bash
# Satori — local stack: Hardhat node + full deploy + dapp.
#
# Replaces the old deploy-satori-local.sh, which had rotted: it used /app/ paths,
# copied `Satori.sol/Satori.json` (a contract that no longer exists since the split
# into SatoriToken / SatoriEngine / SatoriHub + children), grepped deploy output
# that no longer prints that line, and patched an address into the UI that the UI
# no longer reads from there.
#
# No address patching is needed now. deploy.js has a FIXED deploy order, so the
# addresses are deterministic and already hardcoded in
# satori-ui/src/contracts/addresses.ts under chain 31337. Deploy on a fresh node
# and they line up exactly.
#
# PORTS: the dapp derives its RPC URL as (its own port + 1) — see devRpcUrl() in
# addresses.ts — so the two must stay adjacent. Defaults: UI 3032 -> RPC 3033.
#   UI_PORT=3051 ./run-local.sh     # if 3032 is taken; RPC follows at 3052
set -e

# BIND controls which interface the node and the dapp listen on. Default is
# loopback (unchanged). Set BIND=0.0.0.0 to reach the stack from another machine
# — over Tailscale, say:
#   BIND=0.0.0.0 ./run-local.sh
# BOTH services must bind it, not just the dapp: the dapp derives its RPC URL
# from window.location.hostname (devRpcUrl() in addresses.ts), so a browser on
# another host asks THAT host for the RPC too. Hardhat defaults to 127.0.0.1, so
# without this the page loads and every read fails.
#
# Plain HTTP is fine here because the local dapp uses its built-in dev account
# switcher, not an injected wallet. Do NOT extrapolate that to a real deployment
# — see docs/DEPLOY.md on why a wallet needs a secure context.
BIND="${BIND:-127.0.0.1}"
UI_PORT="${UI_PORT:-3032}"
RPC_PORT=$((UI_PORT + 1))
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${LOG_DIR:-/tmp/satori-local}"
mkdir -p "$LOG_DIR"

# Hardhat's well-known deterministic accounts. [0] is the deployer, and deploy.js
# defaults GOVERNOR and REWARDS_ADMIN to it — so [0] is the account that sees the
# role-gated Governor and Admin tabs.
ACC0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ACC1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
ACC2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

echo "==> stopping anything already running"
pkill -f "hardhat node" 2>/dev/null || true
pkill -f "react-scripts start" 2>/dev/null || true
sleep 2

echo "==> hardhat node on $BIND:$RPC_PORT"
( cd "$ROOT/satori" && npx hardhat node --hostname "$BIND" --port "$RPC_PORT" > "$LOG_DIR/node.log" 2>&1 & )
for i in $(seq 1 30); do
  CHAIN=$(curl -s -X POST -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
    "http://127.0.0.1:$RPC_PORT" 2>/dev/null | grep -o '0x[0-9a-f]*' || true)
  [ -n "$CHAIN" ] && break
  sleep 1
done
if [ -z "$CHAIN" ]; then echo "node failed to start; see $LOG_DIR/node.log"; exit 1; fi
# 0x7a69 == 31337, which is what addresses.ts keys the local address book on.
echo "    chainId $CHAIN"
[ "$CHAIN" = "0x7a69" ] || { echo "    WARNING: expected 0x7a69 (31337) — the dapp will not find addresses"; }

echo "==> deploying"
# PLATFORM_FEE_RECIPIENT / MARKETING_FEE_RECIPIENT are REQUIRED (the SatoriRewards
# constructor rejects placeholders). ROOT_PUBLISHER is deliberately unset: that
# skips SatoriMerkle, matching the launch decision to defer it (LAUNCH_AUDIT LA-2).
( cd "$ROOT/satori" && \
  HARDHAT_URL="http://127.0.0.1:$RPC_PORT" \
  PLATFORM_FEE_RECIPIENT="$ACC1" \
  MARKETING_FEE_RECIPIENT="$ACC2" \
  npx hardhat run scripts/deploy.js --network localhost > "$LOG_DIR/deploy.log" 2>&1 ) \
  || { echo "deploy failed; see $LOG_DIR/deploy.log"; tail -20 "$LOG_DIR/deploy.log"; exit 1; }
echo "    address book -> satori/deployments/localhost.json"

echo "==> dapp on $BIND:$UI_PORT (first compile takes ~30-60s)"
( cd "$ROOT/satori-ui" && HOST="$BIND" PORT="$UI_PORT" BROWSER=none npm start > "$LOG_DIR/ui.log" 2>&1 & )
for i in $(seq 1 90); do
  curl -s -o /dev/null "http://127.0.0.1:$UI_PORT" && break
  sleep 2
done

cat <<EOF

  dapp   http://localhost:$UI_PORT
  rpc    http://localhost:$RPC_PORT   (chain 31337)
  logs   $LOG_DIR/{node,deploy,ui}.log

  The header has a dev account switcher. Pick "Owner" ($ACC0) —
  it is the token governor AND the rewards admin, so the role-gated
  "governor" and "admin" tabs only appear for it.

  "+1 round" in the header advances the chain a full round (12h).

  stop:  pkill -f 'hardhat node'; pkill -f 'react-scripts start'
EOF
