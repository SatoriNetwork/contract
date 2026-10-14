"""Read-only HTTP client for satori-indexer.

This is the whole of the coupling between the two services: a URL and three GETs.
No shared database, no shared process.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


class IndexerUnavailable(RuntimeError):
    """The indexer could not be reached, or answered something unusable.

    Always transient from the bridge's point of view: the next tick retries. It
    is never a reason to publish anything, which is the point of raising rather
    than returning a default.
    """


@dataclass(frozen=True)
class Stream:
    stream_id: int
    name: str
    stream_type: int
    creator: str
    provider: str
    created_block: int
    value_count: int
    # Defaults so an indexer older than the named-stream change still parses.
    adapter_id: int = 0
    named: bool = False

    @classmethod
    def from_json(cls, d: dict) -> "Stream":
        return cls(
            stream_id=int(d["streamId"]),
            name=str(d.get("name") or ""),
            stream_type=int(d.get("streamType") or 0),
            creator=str(d.get("creator") or "").lower(),
            # For an ADAPTER stream this is the data-source contract, not a
            # person: a Uniswap stream's provider is the pool itself. That is
            # what makes tick detection a single duck-typed call.
            provider=str(d.get("provider") or "").lower(),
            created_block=int(d.get("createdBlock") or 0),
            value_count=int(d.get("valueCount") or 0),
            adapter_id=int(d.get("adapterId") or 0),
            named=bool(d.get("named")),
        )


@dataclass(frozen=True)
class Observation:
    block: int
    log_index: int
    tx: str
    old_value: str
    new_value: str
    round_number: int
    # Absent from an indexer older than the hour-keyed shape.
    hour: int | None = None

    @classmethod
    def from_json(cls, d: dict) -> "Observation":
        return cls(
            block=int(d["block"]),
            log_index=int(d["logIndex"]),
            tx=str(d["tx"]),
            # Strings, never coerced: int256, signed, wider than a float.
            old_value=str(d["oldValue"]),
            new_value=str(d["newValue"]),
            round_number=int(d["round"]),
            hour=None if d.get("hour") is None else int(d["hour"]),
        )


class IndexerClient:
    def __init__(self, base_url: str, timeout: float = 15.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def _get(self, path: str, params: dict | None = None):
        url = f"{self.base_url}{path}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        try:
            with urllib.request.urlopen(url, timeout=self.timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # 503 is the indexer telling us stream indexing is off. That is a
            # configuration answer, not a network blip, so it is worth the
            # clearer message.
            if e.code == 503:
                raise IndexerUnavailable(
                    f"{path} answered 503 — the indexer has no REGISTRY_ADDRESS set, "
                    "so it is not indexing streams"
                ) from e
            raise IndexerUnavailable(f"{path} answered HTTP {e.code}") from e
        except Exception as e:  # noqa: BLE001 - any failure is the same to us
            raise IndexerUnavailable(f"{path} failed: {e}") from e

    def status(self) -> dict:
        d = self._get("/status")
        if not isinstance(d, dict) or "chainId" not in d:
            raise IndexerUnavailable("/status did not look like a status document")
        return d

    def streams(self) -> list[Stream]:
        d = self._get("/streams")
        if not isinstance(d, list):
            raise IndexerUnavailable("/streams did not return a list")
        return [Stream.from_json(s) for s in d]

    def values(self, stream_id: int, from_block: int | None = None) -> list[Observation]:
        params: dict = {}
        if from_block is not None:
            params["fromBlock"] = from_block
        d = self._get(f"/streams/{stream_id}/values", params or None)
        if not isinstance(d, list):
            raise IndexerUnavailable("/streams/:id/values did not return a list")
        return [Observation.from_json(o) for o in d]

    def ready(self) -> tuple[bool, str]:
        """Is the indexer safe to read from right now?

        Two gates, both of which produce silently-wrong output if skipped:

        - `streamsIndexed` false means the stream tables are empty by
          configuration. Publishing from that state would announce nothing and
          look like a chain with no streams.
        - `syncing` true means a backfill is in progress, so `/streams` is a
          PARTIAL history. Announcing a partial set is not merely incomplete, it
          teaches subscribers a wrong picture that only a later correction fixes.
        """
        s = self.status()
        if not s.get("streamsIndexed"):
            return False, "indexer is not indexing streams (no REGISTRY_ADDRESS)"
        if s.get("syncing"):
            return False, "indexer is still syncing; refusing to publish a partial history"
        return True, ""
