#!/usr/bin/env bash
# Redeploy the dapp (satori-ui) to games.satorinet.io. See DEPLOY-central.md.
#
#   deploy/central/deploy-dapp.sh                  build, ship, verify
#   deploy/central/deploy-dapp.sh --check          everything up to shipping; Central untouched
#   deploy/central/deploy-dapp.sh --new-contracts  the chain now runs contracts whose ABIs
#                                                  differ from the live dapp's (a contract deploy)
#   deploy/central/deploy-dapp.sh --ref TAG        build a pushed tag, not this checkout: a dapp
#                                                  fix while the branch waits on a contract deploy
set -euo pipefail

CHECK=0 NEW_CONTRACTS=0 REF=
while [ $# -gt 0 ]; do
  case $1 in
    --check) CHECK=1 ;;
    --new-contracts) NEW_CONTRACTS=1 ;;
    --ref) REF=${2:?--ref needs a tag}; shift ;;
    *) sed -n '2,9p' "$0"; exit 2 ;;
  esac
  shift
done

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$ROOT"
SITE=https://games.satorinet.io
REMOTE=/root/satori-dapp
SSH=(ssh -i "$HOME/.ssh/id_ed25519" -p 2222 -o BatchMode=yes -o ConnectTimeout=15
     -o UserKnownHostsFile="$ROOT/deploy/central/central.known_hosts" -o StrictHostKeyChecking=yes
     root@157.180.104.175)
TMP=$(mktemp -d)
trap 'git -C "$ROOT" worktree remove --force "$TMP/tree" 2>/dev/null; rm -rf "$TMP"' EXIT

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nSTOP: %s\n' "$*" >&2; exit 1; }
env_val() { sed -n "s/^$1=//p" .env.deploy | tail -1; }
lower() { tr '[:upper:]' '[:lower:]'; }

# Every function, event and error the dapp can call or decode. Central keeps the
# live dapp's copy in $REMOTE/ui-abi.txt; a dapp whose list differs only works
# against contracts deployed to match it.
abi_signatures() {
  node -e '
    const fs = require("fs"), dir = "satori-ui/src/contracts";
    const t = (p) => p.type.startsWith("tuple")
      ? `(${p.components.map(t).join(",")})${p.type.slice(5)}` : p.type;
    const out = new Set();
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const j = JSON.parse(fs.readFileSync(`${dir}/${f}`));
      for (const e of (Array.isArray(j) ? j : j.abi) || []) {
        if (!["function", "event", "error"].includes(e.type)) continue;
        const ins = (e.inputs || []).map((i) => t(i) + (i.indexed ? " indexed" : "")).join(",");
        const outs = e.outputs ? ` -> (${e.outputs.map(t).join(",")})` : "";
        out.add(`${f} ${e.type} ${e.name}(${ins})${outs}`);
      }
    }
    console.log([...out].sort().join("\n"));'
}

say "checkout"
[ -f .env.deploy ] || die "no .env.deploy in $ROOT"
git fetch -q --tags origin
if [ -n "$REF" ]; then
  BRANCH=$REF
  COMMIT=$(git rev-parse --verify -q "$REF^{commit}") || die "no tag $REF"
  git ls-remote --tags origin | grep -q "^$COMMIT	refs/tags/$REF" \
    || die "$REF is not a tag on origin. The deploy ships pushed code only."
  git worktree add -q --detach "$TMP/tree" "$COMMIT"
  cp .env.deploy "$TMP/tree/"
  cd "$TMP/tree"
else
  BRANCH=$(git branch --show-current)
  COMMIT=$(git rev-parse HEAD)
  [ -z "$(git status --porcelain -- satori-ui)" ] \
    || die "uncommitted changes in satori-ui/. The deploy ships committed code only."
  [ "$COMMIT" = "$(git rev-parse '@{u}' 2>/dev/null)" ] \
    || die "$BRANCH is not in sync with its remote. Push or pull first."
fi
echo "$(basename "$ROOT") $BRANCH @ $(git log -1 --format='%h %s')"

say "live site"
docker version >/dev/null 2>&1 || die "Docker is not reachable (DOCKER_HOST=${DOCKER_HOST:-unset})."
STATUS=$(curl -fsS "$SITE/api/status") || die "$SITE/api/status did not answer."
live_addr() { grep -oE "\"$1\":\"0x[0-9a-fA-F]{40}\"" <<<"$STATUS" | grep -oE '0x[0-9a-fA-F]{40}' | lower; }
for c in token engine registry; do
  [ -n "$(live_addr $c)" ] || die "$SITE/api/status has no $c address."
done
LIVE_CHAIN=$(grep -oE '"chainId":[0-9]+' <<<"$STATUS" | grep -oE '[0-9]+$')
[ "$(env_val CHAIN_ID)" = "$LIVE_CHAIN" ] \
  || die ".env.deploy has CHAIN_ID=$(env_val CHAIN_ID) but the live indexer runs chain $LIVE_CHAIN."
[ "$(env_val TOKEN_ADDRESS | lower)" = "$(live_addr token)" ] \
  || die ".env.deploy's TOKEN_ADDRESS is not the live indexer's token. This checkout's .env.deploy is not the live config."
LIVE_BUNDLE=$(curl -fsS "$SITE/" | grep -oE 'main\.[a-z0-9]+\.js' | sed -n 1p)
echo "chain $LIVE_CHAIN, serving $LIVE_BUNDLE"

say "contract ABIs vs the live dapp"
abi_signatures >"$TMP/abi.txt"
"${SSH[@]}" "cat $REMOTE/ui-abi.txt 2>/dev/null || true" >"$TMP/live-abi.txt" || die "cannot reach Central over SSH."
if [ ! -s "$TMP/live-abi.txt" ]; then
  [ $NEW_CONTRACTS = 1 ] || die "Central has no $REMOTE/ui-abi.txt, so compatibility can't be checked. Use --new-contracts only if you know these ABIs match the chain."
  echo "no record on Central; proceeding on --new-contracts"
elif ! diff "$TMP/live-abi.txt" "$TMP/abi.txt" >"$TMP/abi.diff"; then
  sed -n 's/^</  live only: /p; s/^>/  this dapp: /p' "$TMP/abi.diff"
  [ $NEW_CONTRACTS = 1 ] || die "this dapp's contract ABIs differ from the live dapp's (above). It only works against contracts deployed to match. Rerun with --new-contracts only once the chain runs those contracts."
  echo "ABIs differ; proceeding on --new-contracts"
else
  echo "identical to the live dapp"
fi

say "build"
docker compose --env-file .env.deploy build ui
docker run --rm --entrypoint sh satori-ui:latest -c 'cat /usr/share/nginx/html/static/js/main.*.js' >"$TMP/main.js"
BUNDLE=$(docker run --rm --entrypoint sh satori-ui:latest -c 'ls /usr/share/nginx/html/static/js/' | grep -E '^main\.[a-z0-9]+\.js$')
grep -qF "$(env_val INDEXER_URL)" "$TMP/main.js" || die "the bundle does not contain INDEXER_URL from .env.deploy."
for c in token engine registry; do
  grep -qiF "$(live_addr $c)" "$TMP/main.js" \
    || die "the bundle does not contain the live $c address $(live_addr $c). Its address book (satori-ui/src/contracts/addresses.ts) points elsewhere."
done
echo "$BUNDLE: live indexer URL and contract addresses present"

if [ $CHECK = 1 ]; then
  say "check passed: $BUNDLE is ready. Nothing was shipped."
  exit 0
fi

say "ship"
ROLLBACK=satori-ui:pre-$(date -u +%Y%m%d-%H%M%S)
"${SSH[@]}" "docker tag satori-ui:latest $ROLLBACK"
docker save satori-ui:latest | gzip -1 | "${SSH[@]}" 'gunzip | docker load'
LOADED=$("${SSH[@]}" "docker run --rm --entrypoint sh satori-ui:latest -c 'ls /usr/share/nginx/html/static/js/'" | grep -E '^main\.[a-z0-9]+\.js$')
[ "$LOADED" = "$BUNDLE" ] || die "Central loaded $LOADED, expected $BUNDLE. Nothing was recreated; the live site is unchanged."
"${SSH[@]}" "cd $REMOTE && docker compose --env-file .env.deploy up -d --no-deps satori-ui"
for _ in $(seq 30); do
  HEALTH=$("${SSH[@]}" "docker inspect -f '{{.State.Health.Status}}' satori-ui" || true)
  [ "$HEALTH" = healthy ] && break
  sleep 2
done
ROLLBACK_CMD="cd $REMOTE && docker tag $ROLLBACK satori-ui:latest && docker compose --env-file .env.deploy up -d --no-deps satori-ui"
[ "$HEALTH" = healthy ] || die "satori-ui is '$HEALTH' after 60s. Roll back on Central: $ROLLBACK_CMD"
"${SSH[@]}" "cat > $REMOTE/ui-abi.txt" <"$TMP/abi.txt"
printf '%s %s %s %s %s\n' "$(date -u +%FT%TZ)" "$(basename "$ROOT")" "$BRANCH" "$COMMIT" "$BUNDLE" \
  | "${SSH[@]}" "cat >> $REMOTE/ui-deploys.log"

say "verify $SITE"
PUBLIC=$(curl -fsS "$SITE/" | grep -oE 'main\.[a-z0-9]+\.js' | sed -n 1p)
[ "$PUBLIC" = "$BUNDLE" ] || die "$SITE serves $PUBLIC, expected $BUNDLE. Roll back on Central: $ROLLBACK_CMD"
curl -fsS "$SITE/api/status" | grep -q '"lastError":null' || echo "warning: the indexer reports an error (this deploy did not touch it)"
echo "live: $BUNDLE (was $LIVE_BUNDLE)"
echo "rollback, on Central: $ROLLBACK_CMD"
