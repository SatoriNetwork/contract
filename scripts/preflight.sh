#!/usr/bin/env bash
# preflight.sh — the checks that must never be optional.
#
# Every check here exists because it ALREADY failed silently once:
#
#   1. forge build            — a reserved-keyword parse error in ONE test file
#                               took the whole Foundry suite out of service for
#                               five days, because forge compiles test/foundry
#                               as a single unit and nothing ever ran it.
#                               (docs/issues/closed/foundry-suite-silently-dead-since-burn-vote-migration.md)
#   2. size + layout guards   — they measured NOTHING when hardhat ran from the
#                               repo root instead of satori/, so they were
#                               green-by-vacuum. The second config that made that
#                               possible is deleted, the guards now resolve names
#                               from the live config, and ProjectLayout.test.js
#                               fails if a second config comes back.
#                               (docs/issues/closed/hardhat-guards-silently-fail-from-repo-root.md)
# Deliberately EXCLUDES the full Hardhat suite (~8 min). That belongs in CI
# (.github/workflows/verify.yml). Everything else is here, and the whole run is
# about 75 seconds warm.
#
# A note on that timing, because it was nearly the wrong number: this looked like
# a ~19-MINUTE script at first, which would have made it useless — a hook that
# slow gets --no-verify'd habitually and then protects nothing. The cause was not
# the checks. Hardhat and Forge both defaulted to ./cache and wrote
# solidity-files-cache.json in mutually unreadable formats, so each run poisoned
# the other's cache and forced a full via_ir rebuild. `cache_path` in
# foundry.toml separates them; forge build went 19min -> 0.4s. If this script
# ever feels slow again, check that first.
#
# NOT automatic. The pre-push hook that calls this is off by default, so a plain
# `git push` runs nothing — this only happens when you ask for it.
#
# Usage:
#   npm run preflight                    # by hand
#   VERIFY=1 git push                    # as a pre-push gate
#   VERIFY=1 SKIP_INVARIANTS=1 git push  # drop the ~35s forge leg
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"

fail() { echo ""; echo "  PREFLIGHT FAILED: $1"; echo ""; exit 1; }

# ---------------------------------------------------------------------------
# 1. Foundry build. Catches the parse-error class outright.
# ---------------------------------------------------------------------------
if command -v forge >/dev/null 2>&1; then
  echo "==> forge build"
  # Warm this is ~1s. Cold (or after a contract change) it is slow — via_ir with
  # the optimizer on — which is exactly why the full suite lives in CI and only
  # the build lands here.
  ( cd "$ROOT/satori" && forge build ) >/dev/null 2>&1 \
    || fail "forge build — run 'cd satori && forge build' to see it. A parse error in ANY test/foundry file disables the ENTIRE suite."
else
  echo "==> forge not installed — SKIPPING Foundry checks"
  echo "    install with: npm run invariant:setup"
  echo "    (the Foundry suite is unverified until you do)"
fi

# ---------------------------------------------------------------------------
# 2. The two hardhat guards — FROM satori/, which is the whole point.
#    Run from the repo root they silently match zero contracts and pass.
# ---------------------------------------------------------------------------
echo "==> size + storage-layout guards"
( cd "$ROOT/satori" && npx hardhat test test/ContractSize.test.js test/StorageLayout.test.js ) >/dev/null 2>&1 \
  || fail "size / storage-layout guard — run 'cd satori && npx hardhat test test/ContractSize.test.js test/StorageLayout.test.js'. If the layout changed intentionally: npm run layout:snapshot"

# ---------------------------------------------------------------------------
# 3. The WHOLE Foundry suite (~35s), not just the invariants.
#
#    It ran invariants only until 2026-08-17, and that gap had a cost: the
#    non-invariant AdapterSanity test failed for months and nothing on any
#    developer's machine reported it. CI ran it with continue-on-error, so it was
#    green by suppression there too. A check nobody is obliged to run is not a
#    check, and a check that cannot fail is not one either.
# ---------------------------------------------------------------------------
if [[ "${SKIP_INVARIANTS:-0}" != "1" ]] && command -v forge >/dev/null 2>&1; then
  echo "==> forge suite: invariants + fuzz + sanity (~35s; SKIP_INVARIANTS=1 to skip)"
  ( cd "$ROOT/satori" && forge test --no-match-path "test/foundry/*.halmos.t.sol" ) >/dev/null 2>&1 \
    || fail "forge suite — run 'cd satori && forge test --no-match-path \"test/foundry/*.halmos.t.sol\"'"
fi

echo ""
echo "  preflight OK"
echo "  NOT run here: the full Hardhat suite (~8 min). 'npm test', or let CI do it."
echo ""
