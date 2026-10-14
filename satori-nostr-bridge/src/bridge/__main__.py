"""Entry point: `python -m bridge`."""
from __future__ import annotations

import asyncio
import logging
import sys

from .bridge import Bridge
from .config import ConfigError, load_config


async def _main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        cfg = load_config()
    except ConfigError as e:
        # Configuration is wrong at startup or not at all. Exiting non-zero lets
        # docker's restart policy back off instead of looping a broken process.
        print(f"[config] {e}", file=sys.stderr)
        return 2

    bridge = Bridge(cfg)
    await bridge.start()
    try:
        await bridge.run_forever()
    finally:
        await bridge.stop()
    return 0


def main() -> None:
    try:
        raise SystemExit(asyncio.run(_main()))
    except KeyboardInterrupt:
        raise SystemExit(0)


if __name__ == "__main__":
    main()
