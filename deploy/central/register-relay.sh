#!/bin/sh
# Register a relay with Satori Central's `discovered_relays` table.
#
# Run ON Central (it execs into central-lite, which holds the DB session and
# the relay_watcher package):
#
#   sh register-relay.sh [wss://nostr.satorinet.io]
#
# WHY THIS IS A MANUAL STEP AT ALL
# --------------------------------
# Relays are normally DISCOVERED, not registered. relay_watcher/nip65.py loads
# every neuron Nostr pubkey from `peers`, subscribes to their NIP-65 (kind
# 10002) relay lists, and upserts whatever URLs it finds. A relay therefore
# appears once neurons actually list it — that is how satorian.satorinet.io got
# there with neuron_count 15.
#
# A relay Satori has just stood up has no neurons listing it yet, so discovery
# will never see it. The tempting shortcut — insert a row into `peers` so the
# watcher queries our own pubkey — is WRONG: `peers` is the root of the whole
# distribution system (src/scripts/score.py builds its dataframe from it, and
# the skill-metrics tables foreign-key to peers.id). A synthetic peer would
# inject a fake participant into reward distribution.
#
# So we call the watcher's own insertion point directly instead. It touches
# `discovered_relays` and nothing else.
#
# THIS HAS FINANCIAL EFFECT — READ BEFORE RUNNING
# -----------------------------------------------
# Registered relays are paid. `src/scripts/daily_run.py` pays relay rewards to
# the relay's Base `address`, derived from its Nostr key (relays have no
# peer_id). Registering a relay makes it eligible; it is not a bookkeeping entry.
# This needs central's base-upgrade code (src/utils/eth_address.py); on a
# central without it the import fails before anything is written.
#
# In particular: the address is derived from the relay's NIP-11 `pubkey`. If two
# relays serve the SAME pubkey they resolve to the SAME address and both
# accrue to it. That is the current state — the Central relay reuses
# satorian.satorinet.io's identity. Give Central's relay its own keypair if the
# two should be accounted separately.
#
# neuron_count is set to 0 deliberately: no neuron lists this relay yet, and
# claiming otherwise would be a lie the watcher will happily overwrite once
# real neurons do list it.
set -eu

RELAY_URL="${1:-wss://nostr.satorinet.io}"

# NIP-11 is fetched over the INTERNAL docker network, not the public name.
# Central cannot reach its own public hostname — the box hairpins and the
# connection is refused. This bites the watcher too: its NIP-11 probe of
# nostr.satorinet.io will fail for the same reason. That is survivable because
# upsert_discovered_relay COALESCEs, so a failed probe preserves the identity
# fields written here rather than clobbering them.
NIP11_URL="${NIP11_URL:-http://satori-relay-nginx/}"

docker exec -e RELAY_URL="$RELAY_URL" -e NIP11_URL="$NIP11_URL" central-lite python3 -c '
import os, httpx
from relay_watcher.db import upsert_discovered_relay
from src.utils.eth_address import relay_base_address

doc = httpx.get(os.environ["NIP11_URL"],
                headers={"Accept": "application/nostr+json"}, timeout=10).json()
pk   = doc["pubkey"]
addr = relay_base_address(pk)
print("relay      :", os.environ["RELAY_URL"])
print("nip11 name :", doc["name"])
print("pubkey     :", pk)
print("base address:", addr)
print("id         :", upsert_discovered_relay(os.environ["RELAY_URL"], pk, addr, 0))
'

echo
echo "Verify:"
echo "  docker exec satori-db psql -U satori -d satori -c \\"
echo "    \"SELECT id, relay_url, address, neuron_count FROM discovered_relays ORDER BY id;\""
