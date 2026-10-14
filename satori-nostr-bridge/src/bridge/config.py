"""Configuration, all from the environment (12-factor, docker-friendly).

  INDEXER_URL     required. Base URL of satori-indexer, e.g. https://api.satorinet.io
                  The bridge is an ORDINARY HTTP CLIENT of the indexer. It holds no
                  database in common with it and needs no change on its side.
  NOSTR_KEY       required. nsec (bech32) or hex private key. THIS IS THE TRUST
                  ANCHOR: subscribers believe these streams because this key signs
                  them. Treat it like a deploy key.
  RELAY_URLS      required. Comma-separated ws:// or wss:// relay URLs.
  RPC_URL         optional. Enables tick-to-price conversion for Uniswap-backed
                  streams. Without it those streams publish the raw tick, labelled
                  as a tick rather than mislabelled as a price.
  STATE_PATH      sqlite cursor file (default /data/bridge.db — put /data on a volume)
  POLL_SECONDS    how often to ask the indexer for new observations (default 30)
  CHAIN_ID        optional override for the stream-name prefix. Normally read from
                  the indexer's /status so the name cannot disagree with the data.
  DRY_RUN         set to 1 to log what WOULD be published and publish nothing.
                  Records nothing either, so the real run after it still has the
                  full backfill to publish.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Raised for a missing or malformed setting, at startup and never later."""


@dataclass(frozen=True)
class Config:
    indexer_url: str
    nostr_key: str
    relay_urls: tuple[str, ...]
    rpc_url: str | None
    state_path: str
    poll_seconds: int
    chain_id_override: int | None
    dry_run: bool


def _require(name: str) -> str:
    v = os.environ.get(name, "").strip()
    if not v:
        raise ConfigError(f"{name} is required")
    return v


def load_config() -> Config:
    relays = tuple(
        u.strip() for u in _require("RELAY_URLS").split(",") if u.strip()
    )
    if not relays:
        raise ConfigError("RELAY_URLS contained no usable URL")
    for u in relays:
        if not u.startswith(("ws://", "wss://")):
            raise ConfigError(f"relay URL must be ws:// or wss://, got {u!r}")

    chain_id = os.environ.get("CHAIN_ID", "").strip()

    return Config(
        indexer_url=_require("INDEXER_URL").rstrip("/"),
        nostr_key=_require("NOSTR_KEY"),
        relay_urls=relays,
        rpc_url=(os.environ.get("RPC_URL", "").strip() or None),
        state_path=os.environ.get("STATE_PATH", "/data/bridge.db"),
        poll_seconds=int(os.environ.get("POLL_SECONDS", "30")),
        chain_id_override=int(chain_id) if chain_id else None,
        dry_run=os.environ.get("DRY_RUN", "").strip() in ("1", "true", "yes"),
    )
