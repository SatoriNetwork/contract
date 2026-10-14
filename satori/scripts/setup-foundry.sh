#!/usr/bin/env bash
# setup-foundry.sh — one-shot install of Foundry + forge-std for invariant testing.
#
# Usage:
#   npm run invariant:setup    # from /code/Satori/contract
#   or
#   bash satori/scripts/setup-foundry.sh
#
# Idempotent: skips steps that have already been done.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SATORI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FOUNDRY_BIN="$HOME/.foundry/bin"

echo "==> Foundry invariant-test setup"

# 1. Install foundryup if missing.
if [[ ! -x "$FOUNDRY_BIN/foundryup" ]]; then
    echo "[1/3] Installing foundryup..."
    curl -sSL https://foundry.paradigm.xyz | bash
else
    echo "[1/3] foundryup already installed (skip)"
fi

# 2. Install / update forge + friends.
export PATH="$FOUNDRY_BIN:$PATH"
if ! command -v forge >/dev/null 2>&1; then
    echo "[2/3] Installing forge / cast / anvil / chisel..."
    foundryup
else
    echo "[2/3] forge already installed: $(forge --version | head -1) (skip — run 'foundryup' manually to update)"
fi

# 3. Vendor forge-std into satori/lib/ if not already present.
if [[ ! -d "$SATORI_DIR/lib/forge-std" ]]; then
    echo "[3/3] Vendoring forge-std into satori/lib/..."
    mkdir -p "$SATORI_DIR/lib"
    git clone --depth 1 https://github.com/foundry-rs/forge-std.git "$SATORI_DIR/lib/forge-std"
else
    echo "[3/3] forge-std already vendored at satori/lib/forge-std (skip)"
fi

echo ""
echo "==> Setup complete. Run invariants with:"
echo "    npm run invariant         (fast: 64 runs × 25 calls)"
echo "    npm run invariant:deep    (CI: 512 runs × 50 calls)"
