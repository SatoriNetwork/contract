#!/usr/bin/env bash
# Point git at the VERSIONED hooks in .githooks/.
#
# Git hooks live in .git/hooks, which is not tracked — so a hook committed to the
# repo does nothing until each clone opts in. `core.hooksPath` is that opt-in: one
# command, and the hook stays a normal reviewable file in the repo rather than a
# copy that silently drifts from it.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
chmod +x .githooks/* scripts/preflight.sh 2>/dev/null || true
git config core.hooksPath .githooks
echo "==> core.hooksPath -> .githooks"
echo ""
echo "    The pre-push hook is OFF BY DEFAULT — a plain 'git push' runs nothing."
echo ""
echo "    run the checks:     VERIFY=1 git push      (~85s)"
echo "    without pushing:    npm run preflight"
echo "    drop the slow leg:  VERIFY=1 SKIP_INVARIANTS=1 git push"
