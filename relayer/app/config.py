"""Environment configuration. Everything operational is an env var; the fee
POLICY alone lives in a hot-reloadable JSON file (FEE_FILE) so repricing never
needs a restart, let alone a deploy — see fees.py."""

import os
from dataclasses import dataclass, field
from decimal import Decimal


def _addr(name: str, default: str = "") -> str:
    v = os.environ.get(name, default).strip()
    if v and (not v.startswith("0x") or len(v) != 42):
        raise ValueError(f"{name} is not a 0x-prefixed 20-byte address: {v!r}")
    return v


@dataclass
class Settings:
    rpc_url: str = field(default_factory=lambda: os.environ.get("RPC_URL", "http://127.0.0.1:8545"))
    chain_id: int = field(default_factory=lambda: int(os.environ.get("CHAIN_ID", "84532")))
    hub_address: str = field(default_factory=lambda: _addr("HUB_ADDRESS"))
    token_address: str = field(default_factory=lambda: _addr("TOKEN_ADDRESS"))
    relayer_private_key: str = field(default_factory=lambda: os.environ.get("RELAYER_PRIVATE_KEY", ""))

    quote_ttl_seconds: int = field(default_factory=lambda: int(os.environ.get("QUOTE_TTL_SECONDS", "300")))
    # Below this ETH balance /health degrades and new quotes/submissions refuse.
    min_relayer_eth: Decimal = field(default_factory=lambda: Decimal(os.environ.get("MIN_RELAYER_ETH", "0.001")))

    fee_file: str = field(default_factory=lambda: os.environ.get("FEE_FILE", "fees.json"))
    # Fallback flat fee (SATORI) when FEE_FILE is absent or unreadable.
    flat_fee_satori: Decimal = field(default_factory=lambda: Decimal(os.environ.get("FLAT_FEE_SATORI", "0.25")))

    # Per-IP sliding-window rate limit for the public endpoints.
    rate_limit_per_minute: int = field(default_factory=lambda: int(os.environ.get("RATE_LIMIT_PER_MINUTE", "30")))

    # Browser CORS origins. Comma-separated, or "*" (the default) for any — the
    # API carries no per-origin secret, so this is not a security boundary; set
    # it to the dapp's origins if you'd rather narrow it.
    cors_origins: list = field(default_factory=lambda: [
        o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()])

    # Refuse to broadcast anything estimated above this (a griefing bound —
    # predict batches legitimately reach ~1M with adapter pulls).
    max_gas_limit: int = field(default_factory=lambda: int(os.environ.get("MAX_GAS_LIMIT", "3000000")))

    def validate_live(self) -> None:
        """Required only to serve traffic, not to import (keeps tests light)."""
        missing = [n for n, v in [("HUB_ADDRESS", self.hub_address),
                                  ("TOKEN_ADDRESS", self.token_address),
                                  ("RELAYER_PRIVATE_KEY", self.relayer_private_key)] if not v]
        if missing:
            raise RuntimeError(f"missing required env: {', '.join(missing)}")


settings = Settings()
