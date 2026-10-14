"""What the bridge remembers between ticks and across restarts.

Two things, and both exist to stop the bridge re-publishing history it has
already published:

- a per-stream cursor: the last block whose observations were published
- what each stream was announced AS, so an announcement is re-sent only when the
  metadata actually changed rather than every tick

Kind 34600 and 34601 are parameterised-replaceable, so a duplicate is harmless
to correctness. It is not harmless to a relay operator, or to a subscriber
watching for changes. This file is why the steady state is quiet.
"""
from __future__ import annotations

import os
import sqlite3


class State:
    def __init__(self, path: str):
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode = WAL")
        self.db.executescript(
            """
            CREATE TABLE IF NOT EXISTS cursor (
              stream_name TEXT PRIMARY KEY,
              last_block  INTEGER NOT NULL,
              seq         INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS announced (
              stream_name TEXT PRIMARY KEY,
              fingerprint TEXT NOT NULL,
              -- The moment WE first saw this stream. The indexer records the
              -- block a stream was created in, not its timestamp, so this is
              -- the closest honest answer to "created_at" available without
              -- fetching every creation block. Persisted so it stays stable
              -- across restarts rather than resetting the stream's apparent age.
              first_seen  INTEGER NOT NULL
            );
            """
        )
        self.db.commit()

    # ---- cursor -----------------------------------------------------------

    def last_block(self, stream_name: str) -> int | None:
        row = self.db.execute(
            "SELECT last_block FROM cursor WHERE stream_name = ?", (stream_name,)
        ).fetchone()
        return row[0] if row else None

    def next_seq(self, stream_name: str) -> int:
        row = self.db.execute(
            "SELECT seq FROM cursor WHERE stream_name = ?", (stream_name,)
        ).fetchone()
        return (row[0] if row else 0) + 1

    def advance(self, stream_name: str, last_block: int, seq: int) -> None:
        self.db.execute(
            "INSERT INTO cursor (stream_name, last_block, seq) VALUES (?,?,?) "
            "ON CONFLICT(stream_name) DO UPDATE SET last_block = excluded.last_block, "
            "seq = excluded.seq",
            (stream_name, last_block, seq),
        )
        self.db.commit()

    # ---- announcements ----------------------------------------------------

    def announced_fingerprint(self, stream_name: str) -> str | None:
        row = self.db.execute(
            "SELECT fingerprint FROM announced WHERE stream_name = ?", (stream_name,)
        ).fetchone()
        return row[0] if row else None

    def first_seen(self, stream_name: str, now: int) -> int:
        row = self.db.execute(
            "SELECT first_seen FROM announced WHERE stream_name = ?", (stream_name,)
        ).fetchone()
        return row[0] if row else now

    def record_announcement(self, stream_name: str, fingerprint: str, first_seen: int) -> None:
        self.db.execute(
            "INSERT INTO announced (stream_name, fingerprint, first_seen) VALUES (?,?,?) "
            "ON CONFLICT(stream_name) DO UPDATE SET fingerprint = excluded.fingerprint",
            (stream_name, fingerprint, first_seen),
        )
        self.db.commit()

    def close(self) -> None:
        self.db.close()
