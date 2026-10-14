# Deploying the dapp, indexer and relay to Satori Central

**This is the current destination.** `docs/DEPLOY.md` describes the inklets.art
rehearsal, and its Caddy and subpath sections do not apply here. `inklets.art`
is still live and still serves nothing — it is the rollback, not the target.

Everything below was executed on 2026-09-02, not sketched.

---

## The shape

One host, one certificate, one origin:

```
                       app.satorinet.io  (157.180.104.175)
                                │
                        nginx-proxy  :80 :443          ← already existed, serves
                                │                        network.satorinet.io too
        ┌───────────────────────┼────────────────────────┐
        │  /                    │  /api                  │  /relay
   satori-ui              satori-indexer         satori-relay-nginx
   (static bundle)        (:8787, sqlite vol)     → strfry :7777 (ws)
                                 ▲                       ▲
                                 └───── satori-nostr-bridge ─────┘
                                        (own compose, signing key,
                                         no port — talks OUT only)
```

Four services, three of them behind the proxy. The bridge is the odd one out: it
reads the indexer over HTTP and publishes to the relay over WebSocket, and
nothing ever connects *to* it.

Three services on one name rather than `app` / `api` / `relay` subdomains.
`docs/issues/hosting-and-domains.md` argued for splitting them, and the argument
still holds in the abstract — separate names let either move without touching the
other. What one origin buys is concrete: one certificate, no CORS, no
mixed-content, and the dapp calling the indexer same-origin.

**The cost, stated plainly:** the indexer URL is baked into the bundle at build
time (`satori-ui/src/contracts/addresses.ts`), so splitting them later is a new
name, a new cert, *and* a dapp rebuild. Keeping three separate names in DNS from
the start would have preserved that freedom for free. This was a deliberate call
by the owner, not an oversight.

---

## Access

Documented in `Satori/central/CLAUDE.md`. **Port 2222, not 22** — the key is
already authorized from the dev sandbox:

```bash
ssh -i ~/.ssh/id_ed25519 -p 2222 root@157.180.104.175
```

Do not go looking for the deploy key `central/deploy-all.sh` wants
(`/root/.ssh/id_ed25519_deploy`); that is for Server 1 → Server 2 rolling
deploys of central-lite and is not reachable from the sandbox. It has nothing to
do with this stack.

---

## Build locally, ship the images

Central runs central-lite, the scheduler, the relay watcher and the Satori
database. It has headroom (≈133 G disk, ≈19 Gi RAM free) but a CRA build is
still the wrong thing to run next to a production database.

```bash
cd /code/Satori/contract
docker compose --env-file .env.deploy build ui indexer gasless-relayer
(cd ../satori-relay && docker compose build)          # strfry + its nginx

docker save satori-ui:latest satori-indexer:latest satori-gasless-relayer:latest \
            satori-relay-strfry:latest satori-relay-nginx:latest \
  | gzip -1 | ssh -i ~/.ssh/id_ed25519 -p 2222 root@157.180.104.175 'gunzip | docker load'
```

`satori-gasless-relayer` is the pay-gas-in-SATORI service (§Gasless relayer
below); it has no baked secret, so building it here is safe. Its build needs
`HUB_ADDRESS` and `RELAYER_PRIVATE_KEY` present in `.env.deploy` (compose
interpolates them even though only the container uses the key) — a throwaway
value is fine for the local build; the real key lands only on the server.

**Verify the image before shipping it.** CRA treats lint warnings as errors, so a
failed build leaves the *previous* image in place and the deploy ships it
happily. Grep for a string only the new build can contain:

```bash
docker run --rm --entrypoint sh satori-ui:latest \
  -c 'grep -l 0x89eFc713C5325d034CfFCd6cB8dB2C858A3398D6 /usr/share/nginx/html/static/js/*.js'
```

---

## Deploy

`deploy/central/docker-compose.yml` → `/root/satori-dapp/docker-compose.yml`,
alongside `.env.deploy`. Nothing publishes a port; everything joins the external
`central-lite_default` network so nginx-proxy reaches it by container name.

```bash
scp -i ~/.ssh/id_ed25519 -P 2222 deploy/central/docker-compose.yml \
    root@157.180.104.175:/root/satori-dapp/
ssh -i ~/.ssh/id_ed25519 -p 2222 root@157.180.104.175 \
  'cd /root/satori-dapp && docker compose --env-file .env.deploy up -d'
```

The indexer resets itself when it is pointed at a new deployment — it
fingerprints `(chainId, token, engine, rewards, bounties, registry)` and wipes
its dataset on any change (`satori-indexer/src/index.ts:33`). **Do not wipe the
volume by hand**; just update `.env.deploy` and recreate.

---

## nginx

`nginx-proxy` mounts a **single file**, `/root/nginx/nginx.conf` — there is no
`conf.d` to drop into. The server block lives in
`deploy/central/app.satorinet.io.nginx.conf` and is inserted before the closing
brace of the `http` block:

```bash
cd /root/nginx && cp nginx.conf nginx.conf.bak-$(date +%Y%m%d-%H%M%S)
python3 - <<'EOF'
blk = open("/root/nginx/app.satorinet.io.conf").read()
s   = open("/root/nginx/nginx.conf").read()
i = s.rstrip().rfind("}")          # closing brace of the http block
open("/root/nginx/nginx.conf","w").write(s[:i] + blk + "\n" + s[i:])
EOF
docker exec nginx-proxy nginx -t && docker exec nginx-proxy nginx -s reload
```

**Always `nginx -t` before reloading.** This file also serves
`network.satorinet.io`; a broken reload takes the Satori network's central API
down with it. A failed `-t` is harmless because the running config stays loaded.

### Two traps that actually bit

- **Insert *before* the `http` closing brace.** A first attempt appended after
  it and nginx refused with `"server" directive is not allowed here`. Caught by
  `nginx -t`, never reloaded.
- **A variable in `proxy_pass` disables prefix substitution.** nginx only
  rewrites the matched location prefix when `proxy_pass` ends in a literal URI.
  With `proxy_pass http://$var:8787/` it passes the request URI through
  verbatim, so every `/api/...` call reached the indexer as `/` and came back
  `Cannot GET /`. The prefix must be stripped explicitly:

  ```nginx
  rewrite ^/api/(.*)$ /$1 break;
  proxy_pass http://$satori_indexer:8787;
  ```

  The variables are not optional — the `http` block sets
  `resolver 127.0.0.11` precisely so upstreams re-resolve after a container
  restart. A literal upstream name is cached at startup and 502s forever after.

### One trap that only *looked* like a bug

Testing the relay handshake with plain `curl` returns **200, not 101**, which
reads as a dead relay. It is not. The block sets `http2 on`, curl negotiates
HTTP/2, and `Connection`/`Upgrade` are not valid HTTP/2 headers — so the request
degrades to an ordinary GET. Use `curl --http1.1` and it returns 101 and then
hangs, which is curl correctly holding an upgraded socket open. Browsers open
`wss://` over HTTP/1.1, so this never affected real clients.

---

## TLS, and how to migrate a live name without downtime

Central only had the `webroot` authenticator, and webroot cannot issue a cert
until the name already points at the box — which would mean flipping DNS first
and serving the dapp over plain HTTP until certbot caught up. Wallets need a
secure context, so that window is a real outage.

Instead the cert was issued by **DNS-01 while the name still pointed at
inklets**, using certbot's manual hooks driven by curl against the Cloudflare
API (`/root/cf-acme-hook.sh`). No new packages — Central's Python is PEP 668
externally-managed and installing `certbot-dns-cloudflare` there was not worth
it.

```bash
CF_TOKEN=<token> certbot certonly --manual --preferred-challenges dns \
  --manual-auth-hook '/root/cf-acme-hook.sh auth' \
  --manual-cleanup-hook '/root/cf-acme-hook.sh clean' \
  -d app.satorinet.io --non-interactive --agree-tos
```

Order matters, and it is the whole point: **cert first, verify against Central
with `--resolve`, flip DNS last.**

```bash
curl --resolve app.satorinet.io:443:157.180.104.175 https://app.satorinet.io/api/status
```

### Renewal — read this before the cert expires

The issuing run wrote a renewal config that calls the manual hooks, and those
hooks need `CF_TOKEN` in the environment. **The systemd renewal timer has no
such variable, so an unattended renewal would fail.** Now that the A record
points at Central, renewal should go through webroot like
`network.satorinet.io` does:

```bash
certbot certonly --webroot -w /var/www/certbot -d app.satorinet.io \
  --cert-name app.satorinet.io --force-renewal
```

That rewrites the renewal config to webroot and drops the token dependency.

---

## DNS

Zone `satorinet.io` is at Cloudflare, id `1f8f61391856662de790a653b5b8ed68`. A
working account token is in `contract/.env` — `hosting-and-domains.md` used to
call missing credentials "the single hardest blocker on the whole path", and
that is simply out of date. The token sits in **plaintext in a comment** and is
worth rotating into a real secret.

Note `/user/tokens/verify` returns `Invalid API Token` for it. That endpoint
only handles user tokens; the token is an account token and works fine against
`/zones`. Do not conclude it is dead.

The cutover is one record:

```
app.satorinet.io  A  167.71.11.203  →  157.180.104.175
```

---

## Verify the public URL, never the container

A container answering correctly proves nothing about what the internet sees.

```bash
curl -s https://app.satorinet.io/ | grep -oE 'main\.[a-z0-9]+\.js'   # note the hash
curl -s https://app.satorinet.io/static/js/main.<hash>.js | grep -c <new token address>
curl -s https://app.satorinet.io/api/status
curl -s -H 'Accept: application/nostr+json' https://app.satorinet.io/relay
curl -s https://app.satorinet.io/relayer/health           # gasless relayer: {"ok":true,...}
```

---

## Gasless relayer — `satori-gasless-relayer`

The pay-gas-in-SATORI service (`../../relayer/`, docs/design/gasless-relay.md).
A user out of ETH signs a `RelayRequest` + a SATORI fee; this service pays the
Base gas, calls `SatoriHub.relay()`, and is reimbursed in SATORI. Served at
`app.satorinet.io/relayer` — the nginx block strips the `/relayer/` prefix, so
the container keeps its own `/gasless/quote|submit|tx` and `/health` routes. The
dapp reaches it via `relayerUrl` in `addresses.ts` (already
`https://app.satorinet.io/relayer` for 84532), so no rebuild is needed to point
at it, only to change the value.

**It is NOT the Nostr relay.** `satori-relay-*` is strfry; this is
`satori-gasless-relayer`. Different service, different purpose, adjacent name.

**Its wallet.** A dedicated Base key, funded with ETH, SEPARATE from the
deployer (it is a hot key on an internet-facing box; the deployer is not). Set
in `.env.deploy` as `RELAYER_PRIVATE_KEY`, alongside `HUB_ADDRESS`,
`TOKEN_ADDRESS`, `RPC_URL`, `CHAIN_ID` (the indexer already sets the last three).
`/health` reports `ok:false` and the service refuses work below `MIN_RELAYER_ETH`
(default 0.002), so watch the balance and top it up.

**Repricing needs no deploy.** The SATORI fee is server-side policy in
`/root/satori-dapp/fees.json` (bind-mounted into the container, re-read per
request):

```json
{ "default": "0.25", "per_action": { "Claim": "0" } }
```

Ship it once alongside the compose, then edit it in place to reprice — daily,
hourly, whatever. No restart, no rebuild, no transaction. Editing the contract
is never involved; the fee lives only here.

```bash
scp -i ~/.ssh/id_ed25519 -P 2222 relayer/fees.json root@157.180.104.175:/root/satori-dapp/
```

**Verify:**
```bash
curl -s https://app.satorinet.io/relayer/health
# {"ok":true,"chainId":84532,"relayer":"0x…","relayerEth":"…","feePolicyOk":true}
```
Then, in the dapp, an out-of-ETH wallet predicting should meet the "Pay your
transaction gas in SATORI?" prompt.

---

## The relay

`satori-relay` is strfry behind a small nginx that answers NIP-11. It normally
runs **public mode**: a `pubkey` for contact, and deliberately **no `self`**
field. `self` is the reward-eligibility binding that ties a relay to an
operator's neuron — right for an operator, wrong for Satori's own
infrastructure. `satorian.satorinet.io:7777` serves exactly this shape, and the
Central relay copies it, including its pubkey.

The relay system is federated: operators run their own and register them, and
`central-lite-relay-watcher` tracks them in `discovered_relays`. This deployment
adds one more relay; it does not centralise anything.

### Registering it with Central — part of deploying it

**If you deploy a relay, register it.** A relay nobody knows about serves
nothing. Run on Central, after the relay is up and answering NIP-11:

```bash
sh register-relay.sh wss://app.satorinet.io/relay
```

Relays are normally **discovered**, not registered: `relay_watcher/nip65.py`
loads every neuron pubkey from `peers`, subscribes to their NIP-65 (kind 10002)
relay lists, and upserts what it finds. That is how `satorian.satorinet.io` has
`neuron_count` 15. A relay Satori has just stood up has no neurons listing it,
so discovery will never see it on its own — hence the manual call to the
watcher's own insertion point.

**Do not shortcut this by inserting into `peers`.** It is the root of the
distribution system (`src/scripts/score.py` builds from it; the skill-metrics
tables foreign-key to `peers.id`), so a synthetic peer row would inject a fake
participant into reward distribution. The script writes to `discovered_relays`
and nothing else.

**Registering has financial effect.** `daily_run.py` accrues relay rewards keyed
on the Nostr-derived `evr_address`, sub-threshold amounts accumulating until
they cross. This is not a bookkeeping entry.

> ⚠️ **Open question for the owner.** The Central relay currently serves
> `satorian.satorinet.io`'s NIP-11 pubkey, so both resolve to the same
> `evr_address` (`EMzrrXwSFdy8njqn8GD8MFQdkqNJAMCdoj`) and both accrue to it.
> Coherent if the intent is "Satori runs two relays and is paid for both";
> wrong if they should be accounted separately. To separate them, give the
> Central relay its own keypair via `RELAY_PUBKEY` in
> `/root/satori-dapp/.env.deploy` and re-run the script.

`neuron_count` is set to 0 on purpose — no neuron lists this relay yet, and the
watcher will overwrite it with the true count once they do.

### Picking it up without waiting a day

`relay_watcher` reloads its relay list on `RELOAD_INTERVAL`, which is **86400s**.
Until it reloads, a newly registered relay is in the table but unwatched, gets no
`relay_daily_scores`, and so does not appear in `GET /api/v1/peer/relays` (that
endpoint joins on scores). Restarting `central-lite-relay-watcher` forces the
reload; at most 5 minutes of score deltas are lost (`SAVE_INTERVAL`).

**That restart used to be a trap; it is fixed now.** Recorded because the shape
recurs: nothing about central-lite's *code* lives in its image (compose
bind-mounts `.:/app` and `../satorilib:/app/satorilib`) but its *dependencies*
do, so host code and image deps drift apart silently and the bill arrives at the
next restart — possibly weeks later, to whoever happens to trigger it.

On 2026-09-02 the watcher would not come back: `relay_watcher/nip65.py` imports
`ReqTarget` (**nostr-sdk 0.45**) while the deployed image still had 0.44, and
the shared `/root/satorilib` was one commit behind its own 0.45 migration
(`ce6c8ba`) and still imported `HandleNotification`, which 0.45 removed. Both
bind-mounted trees have to agree on the sdk version.

Resolved properly: `/root/satorilib` pulled to `ce6c8ba`, `central-lite:latest`
rebuilt (`requirements.txt` already floored at `>=0.45.0` — only the image was
stale), and all four services on it — `central-lite`, `central-lite-scheduler`,
`central-lite-relay-watcher`, `pool-watchdog`. The temporary
`docker-compose.override.yml` and `/root/satorilib-nostr045` are gone.

**If you change host code that imports a new dependency symbol, rebuild the
image in the same pass.** A green `docker ps` proves nothing here; the running
process is holding code from whenever it last started.

Side effect worth knowing: on the migrated satorilib the watcher reports
`satorian.satorinet.io: 100 free streams (of 100 total)` where the old code
reported `0 of 0` for every relay. Stream detection had been quietly broken.

### Not paying for our own relay

Satori's own relays are Association-sponsored: they should be discoverable,
watched and scored like any other, but should not draw from the reward pool they
help fund. `discovered_relays.reward_ineligible` does exactly that and nothing
else — see `migrations/add_reward_ineligible_to_discovered_relays.sql` in the
central-lite repo.

```sql
UPDATE discovered_relays SET reward_ineligible = TRUE
 WHERE relay_url = 'wss://app.satorinet.io/relay';
```

`daily_run.py` filters the flag in its *qualifying query*, not by paying the
relay zero afterwards. The pool is split evenly (`daily_relay / num_relays`), so
leaving an ineligible relay in the list would shrink every other relay's share
and burn the difference; excluding it up front redistributes that share to the
relays that earned it.

A flag rather than clearing `evr_address` — which would also have excluded it —
because `evr_address` is re-derived from NIP-11 on every discovery pass, so that
exclusion would silently undo itself. `relay_watcher`'s upsert does not write
this column.

> **Still eligible, and worth a decision:** `ws://satorian.satorinet.io:7777`
> is also Satori-run infrastructure and resolves to the *same* `evr_address`
> (`EMzrrXwSFdy8njqn8GD8MFQdkqNJAMCdoj`), but is **not** flagged — it has
> `neuron_count` 15 and has been drawing rewards for months. Flagging it is a
> live change to distribution, so it was left alone.

---

## The bridge — `satori-nostr-bridge`

This is the service that mirrors Satori data streams **onto** Nostr relays, and
it is the thing usually meant by "the relay" in conversation. The strfry relay
above is where messages land; the bridge is what puts them there.

```
Base ──▶ satori-indexer ──HTTP──▶ satori-nostr-bridge ──▶ Nostr relays ──▶ neuron
```

It runs from its **own** compose file at `/root/satori-bridge/`
(`deploy/central/docker-compose.bridge.yml`), deliberately not folded into the
dapp stack: it holds a signing key and its lifecycle is independent of a dapp
release. It listens for nothing, so no port, no name, no certificate.

```bash
docker build -t satori-nostr-bridge:latest satori-nostr-bridge/
docker save satori-nostr-bridge:latest | gzip -1 \
  | ssh -i ~/.ssh/id_ed25519 -p 2222 root@157.180.104.175 'gunzip | docker load'
```

### The signing key

`NOSTR_KEY` is the **trust anchor** — subscribers believe these streams because
this key signs them. No Satori key existed anywhere (not in the repos, not on
Central, not on inklets), so one was generated on Central on 2026-09-02 with
`nostr_sdk` inside the bridge image. The secret was written straight into
`/root/satori-bridge/.env` (mode 600) and **has never left that machine**.

```
public key  cb45de2a76a5df79ea8aff0c867e96e527f803eb389420419e441a4946129838
```

Rotating it re-anchors trust: existing subscribers keep following the old key
until they are told otherwise. It is not a routine config change.

Note this is a *different* key from the relay's NIP-11 `pubkey`. The relay's
identifies the relay; this one signs the stream events.

### Publishing to

```
ws://satori-relay-nginx          the relay on this box, internal, no TLS hop
ws://satorian.satorinet.io:7777  the established Satori relay, so existing
                                 subscribers see the streams too
```

### Run DRY_RUN first

`DRY_RUN=1` logs what would be published, publishes nothing, and leaves the
cursor untouched so the real run still does the full backfill. Worth it on any
first run against a live relay. Clear the variable and recreate to go live.

The cursor lives on the `bridge-data` volume at `STATE_PATH=/data/bridge.db`.
On a fresh volume the bridge republishes all history — that is expected, not a
bug, and is why the cursor must not live in the container filesystem.

### Verifying — do not trust the log

The bridge logging `announced` means it sent, not that anything stored it.
`docker exec satori-relay-strfry strfry scan` does **not** work — strfry is not
on that container's PATH, and the error text on stdout counts as a line, so a
naive `wc -l` reports a plausible-looking number that is pure noise. Two things
that do work: strfry's own `Inserted event` writer log, and querying the relay
as an actual subscriber:

```python
# wss://app.satorinet.io/relay
["REQ", "s1", {"authors": ["<bridge pubkey>"], "limit": 50}]
```

A healthy first run returns kind **34600** (stream announcements) and **34601**
(observations), one of each per stream. These are parameterised replaceable
events, so the count stays at one per stream per kind however many ticks run —
seeing it stay flat is correct, not a stalled bridge.

---

## Rollback

**There is no longer a warm standby.** The inklets.art stack was brought down on
2026-09-02 at the owner's instruction: `satori-ui` and `satori-indexer` are
stopped and removed, and the `satori_default` network with them. Repointing the
A record now reaches nothing.

To fall back you would redeploy there from `docs/DEPLOY.md` — the compose files
and `.env.deploy` are still in `/satori`, and `.env.deploy.bak-D1-20260901` holds
the pre-migration D1 addresses.

Still running on that box and **deliberately untouched** — none of it is the
dapp, and none of it should be stopped when decommissioning:

| Container | What |
|---|---|
| `satori-1`, `namaste-diskwatch` | Satori network nodes (`satori-lite`) |
| `namaste_club-pool` | the Namaste Club pool |
| `inklets-*` | a different site entirely, on a shared droplet |
| `evrx` | Electrum server |
