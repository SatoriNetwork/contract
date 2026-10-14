#!/bin/bash
# Satori — dapp + indexer against the LIVE Base Sepolia deployment (checklist D2).
#
#   ./run-testnet.sh              # UI 3032, indexer 8787 — PRODUCTION build
#   MODE=dev ./run-testnet.sh     # dev server instead: hot reload, 3x the traffic
#   UI_PORT=8080 IDX_PORT=8081 ./run-testnet.sh
#
# MODE=prod (the default) serves the same optimised bundle a real user would get.
# MODE=dev runs react-scripts with hot reload, which is the right tool for editing
# the UI and the wrong one for judging anything: React.StrictMode double-invokes
# every effect in development, so the dev server makes roughly THREE TIMES the RPC
# requests and is the only configuration that gets rate-limited by public
# endpoints. Measured: 31 requests and 8 rejections in dev, 10 requests and none
# in prod. See docs/issues/dapp-rpc-call-budget-measured.md.
#
# Both modes serve on the same port. The distinction is a setting, not a
# different address to remember.
#
# Sibling of run-local.sh, which runs everything against a throwaway hardhat node
# with deterministic addresses. This one runs nothing local but the two services:
# the chain is real, the addresses came out of a real deploy, and blocks arrive
# every couple of seconds whether or not anyone is watching. That difference is
# the entire point of D2 — it is the first time the dapp and the indexer face a
# chain that persists, reorgs, rate-limits, and lags.
#
# BINDS ON 0.0.0.0, DELIBERATELY. Both services listen on every interface so the
# machine is reachable over Tailscale. On a tailnet that is fine — the tailnet is
# the boundary. On an untrusted network it is not: there is no auth on either
# service, and the indexer will happily serve its whole database to anyone who
# asks. Do not run this on a coffee-shop wifi and wander off.
#
# The dapp reaches the indexer by DERIVING the host from whatever address the
# browser used (REACT_APP_INDEXER_PORT), rather than a baked-in localhost, so one
# build works from this machine and from a laptop across the tailnet alike.
set -e

MODE="${MODE:-prod}"
UI_PORT="${UI_PORT:-3032}"
IDX_PORT="${IDX_PORT:-8787}"
CHAIN_ID=84532

# Makes "connect wallet" work in ordinary mobile browsers, where there is no
# injected provider to find. Free from https://cloud.reown.com; put it in .env.
# Without it, mobile falls back to deep-linking MetaMask specifically, and every
# other wallet app is unreachable.
WC_ID="${WALLETCONNECT_PROJECT_ID:-}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
BOOK="$ROOT/satori/deployments/baseSepolia.json"
LOG_DIR="${LOG_DIR:-/tmp/satori-testnet}"
DB_PATH="${DB_PATH:-$LOG_DIR/indexer.db}"
RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"

# The block SatoriToken was created in. Starting earlier just wastes scanning;
# starting later would silently miss the genesis mints and every event before it.
START_BLOCK="${START_BLOCK:-44928212}"

# Base's public RPC rejects any eth_getLogs spanning more than 2000 blocks
# (-32602 "query exceeds max block range 2000"). The indexer defaults to 10000,
# which is fine against an archive node and fails EVERY tick against Base — the
# indexer then never reports healthy and never advances a single block. A local
# hardhat node has no such cap, which is why this could only ever show up here.
# See docs/issues/indexer-chunk-size-exceeds-base-rpc-limit.md.
CHUNK_SIZE="${CHUNK_SIZE:-1900}"

mkdir -p "$LOG_DIR"

[ -f "$BOOK" ] || { echo "no address book at $BOOK — has deploy.js run against baseSepolia?"; exit 1; }

echo "==> stopping anything already on those ports"
for p in "$UI_PORT" "$IDX_PORT"; do
  lsof -ti:"$p" 2>/dev/null | xargs -r kill 2>/dev/null || true
done
sleep 1

echo "==> checking the chain and the deployment"
CHAIN=$(curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' "$RPC_URL" \
  | grep -o '"result":"0x[0-9a-f]*"' | grep -o '0x[0-9a-f]*' || true)
[ "$CHAIN" = "0x14a34" ] || { echo "    expected chainId 0x14a34 (84532), got '${CHAIN:-nothing}'"; exit 1; }
TOKEN=$(grep -o '"token": *"0x[0-9a-fA-F]*"' "$BOOK" | grep -o '0x[0-9a-fA-F]*')
CODE=$(curl -s -X POST -H 'Content-Type: application/json' \
  --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$TOKEN\",\"latest\"],\"id\":1}" "$RPC_URL")
case "$CODE" in *'"0x"'*) echo "    no code at token $TOKEN — wrong book for this chain?"; exit 1;; esac
echo "    chainId $CHAIN, token $TOKEN has code"

echo "==> indexer on :$IDX_PORT  (db $DB_PATH)"
( cd "$ROOT/satori-indexer" && \
  RPC_URL="$RPC_URL" ADDRESS_BOOK="$BOOK" START_BLOCK="$START_BLOCK" \
  DB_PATH="$DB_PATH" PORT="$IDX_PORT" CHUNK_SIZE="$CHUNK_SIZE" \
  npm run dev > "$LOG_DIR/indexer.log" 2>&1 & )

for i in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$IDX_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$IDX_PORT/health" >/dev/null 2>&1 \
  || { echo "    indexer did not come up; see $LOG_DIR/indexer.log"; exit 1; }
echo "    healthy"

if [ "$MODE" = "prod" ]; then
  # The build BAKES REACT_APP_* in at compile time, so a bundle built for a
  # different indexer port or chain is silently wrong rather than broken. Stamp
  # what it was built with and rebuild only when that changes — otherwise every
  # run pays a minute of compile for nothing.
  STAMP="$ROOT/satori-ui/build/.satori-build-config"
  WANT="chain=$CHAIN_ID indexer=$IDX_PORT wc=${WC_ID:+set}"
  if [ ! -f "$ROOT/satori-ui/build/index.html" ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$WANT" ]; then
    echo "==> building the dapp ($WANT)"
    ( cd "$ROOT/satori-ui" && \
      REACT_APP_CHAIN_ID="$CHAIN_ID" REACT_APP_INDEXER_PORT="$IDX_PORT" \
      REACT_APP_WALLETCONNECT_PROJECT_ID="$WC_ID" \
      GENERATE_SOURCEMAP=false \
      npx react-scripts build > "$LOG_DIR/build.log" 2>&1 ) \
      || { echo "    build failed; see $LOG_DIR/build.log"; exit 1; }
    echo "$WANT" > "$STAMP"
    echo "    built"
  else
    echo "==> reusing the existing build ($WANT)"
  fi

  echo "==> dapp on :$UI_PORT (chain $CHAIN_ID, PRODUCTION build)"
  ( cd "$ROOT/satori-ui" && \
    node scripts/serve-build.js "$UI_PORT" > "$LOG_DIR/ui.log" 2>&1 & )
else
  echo "==> dapp on :$UI_PORT (chain $CHAIN_ID, DEV server — 3x the RPC traffic)"
  ( cd "$ROOT/satori-ui" && \
    HOST=0.0.0.0 PORT="$UI_PORT" BROWSER=none \
    REACT_APP_CHAIN_ID="$CHAIN_ID" REACT_APP_INDEXER_PORT="$IDX_PORT" \
    REACT_APP_WALLETCONNECT_PROJECT_ID="$WC_ID" \
    npm start > "$LOG_DIR/ui.log" 2>&1 & )
fi

for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$UI_PORT" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$UI_PORT" >/dev/null 2>&1 \
  || { echo "    dapp did not come up; see $LOG_DIR/ui.log"; exit 1; }

HOSTNAME_TS="$(hostname 2>/dev/null || echo localhost)"
cat <<EOF

==> up

  dapp      http://$HOSTNAME_TS:$UI_PORT      (or your tailnet name / IP)
            $([ "$MODE" = "prod" ] && echo "PRODUCTION build — what a real user gets" \
                                   || echo "DEV server — hot reload, 3x the RPC traffic")
  indexer   http://$HOSTNAME_TS:$IDX_PORT/status
  logs      $LOG_DIR/{ui,indexer,build}.log

  Chain     Base Sepolia (84532) — a REHEARSAL deployment. Its governor is a
            3-of-5 Safe whose owner keys sit in the repo's plaintext
            .wallets.env, so treat everything here as public.

  Capabilities ship OFF, so the public surface is predict / vote / claim only.
  Anything else showing as unavailable is the rollout working, not a bug.
$(if [ -z "$WC_ID" ]; then cat <<'WCNOTE'

  MOBILE: no WalletConnect project id set, so "connect" in ordinary mobile
  Chrome/Safari deep-links into MetaMask specifically and no other wallet app is
  reachable. Get a free id at https://cloud.reown.com, put
  WALLETCONNECT_PROJECT_ID=... in .env, and re-run — every wallet works then, and
  desktop gains a QR path alongside the extension.
WCNOTE
fi)

  Stop with:  lsof -ti:$UI_PORT,$IDX_PORT | xargs -r kill
EOF
