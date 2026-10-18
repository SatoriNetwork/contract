"""Fee policy — deliberately NOT on-chain (docs/design/gasless-relay.md):
the contract only enforces "the user signed this exact fee"; whether that fee
is enough to relay is decided here, per request.

Policy lives in FEE_FILE (JSON, SATORI units as strings):

    { "default": "0.0001", "per_action": { "Predict": "0.0002" } }

The file is re-read on every quote/submit (mtime-cached), so repricing is an
edit to that file — no restart, no deploy, no transaction."""

import json
import os
from decimal import Decimal

from .config import settings
from .signing import RelayAction

WEI = Decimal(10) ** 18

_cache: tuple[float, dict] | None = None


def _load_policy() -> dict:
    global _cache
    path = settings.fee_file
    try:
        mtime = os.stat(path).st_mtime
    except OSError:
        return {"default": settings.flat_fee_satori, "per_action": {}}
    if _cache and _cache[0] == mtime:
        return _cache[1]
    try:
        with open(path) as f:
            raw = json.load(f)
        policy = {
            "default": Decimal(str(raw.get("default", settings.flat_fee_satori))),
            "per_action": {k: Decimal(str(v)) for k, v in raw.get("per_action", {}).items()},
        }
    except (ValueError, OSError, KeyError):
        # A malformed edit must not take the service down; fall back and let
        # /health surface it.
        policy = {"default": settings.flat_fee_satori, "per_action": {}}
    _cache = (mtime, policy)
    return policy


def fee_wei(action: RelayAction) -> int:
    policy = _load_policy()
    satori = policy["per_action"].get(action.name, policy["default"])
    return int(satori * WEI)


def policy_ok() -> bool:
    """False when FEE_FILE exists but could not be parsed on last load."""
    path = settings.fee_file
    if not os.path.exists(path):
        return True
    try:
        with open(path) as f:
            json.load(f)
        return True
    except (ValueError, OSError):
        return False
