"""The bridge loop: chain history in, Nostr events out.

One pass does exactly this, and nothing else:

  1. Refuse to do anything if the indexer is unready. (See IndexerClient.ready —
     publishing from a mid-backfill indexer teaches subscribers a wrong history.)
  2. For each stream, announce it if it is new or its metadata changed.
  3. For each stream, publish observations after the cursor, oldest first.
  4. Advance the cursor only for observations that were actually published.

Step 4 is ordered that way on purpose: a crash mid-stream re-publishes at most
the observations it did not record, and kind 34601 is replaceable, so a repeat
is harmless. The opposite order would silently drop them.
"""
from __future__ import annotations

import json
import logging
import time

from satorilib.satori_nostr import SatoriNostr, SatoriNostrConfig
from satorilib.satori_nostr.models import DatastreamMetadata, DatastreamObservation

from .config import Config
from .indexer import IndexerClient, IndexerUnavailable, Stream
from .naming import observation_payload, observation_timestamp, stream_name
from .state import State
from .values import ValueRenderer

log = logging.getLogger("bridge")


def _fingerprint(s: Stream) -> str:
    """What must change before a stream is re-announced.

    The rule is: every variable field the announcement carries appears here. A
    field in the payload but not in the fingerprint can go stale on the relay and
    never correct itself, because nothing would ever notice it had moved.

    Name and provider both change after creation and both are visible to
    subscribers. `named` moves too: an indexer that boots before a dev chain
    wires `namedAdapterId` serves false until its next poll. `adapter_id`
    cannot change on-chain, but it belongs here on that same rule — and it
    usefully means a bridge upgraded to publish it re-announces every stream
    exactly once, rather than leaving already-known streams described by the
    old shape forever.

    Value count deliberately does not: it moves every observation and would turn
    every announcement into a re-announcement.
    """
    return json.dumps(
        [s.name, s.provider, s.stream_type, s.adapter_id, s.named],
        separators=(",", ":"))


class Bridge:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.indexer = IndexerClient(cfg.indexer_url)
        self.state = State(cfg.state_path)
        self.values = ValueRenderer(cfg.rpc_url)
        self.client: SatoriNostr | None = None
        self.chain_id: int | None = None

    async def start(self) -> None:
        self.client = SatoriNostr(SatoriNostrConfig(
            keys=self.cfg.nostr_key,
            relay_urls=list(self.cfg.relay_urls),
        ))
        await self.client.start()
        log.info("publishing as %s to %s", self.client.pubkey(), ", ".join(self.cfg.relay_urls))
        if not self.values.conversion_available:
            log.warning(
                "RPC_URL is not set: Uniswap-backed streams will publish the raw "
                "tick, labelled 'tick'. No value will be presented as a price.")

    async def stop(self) -> None:
        if self.client is not None:
            await self.client.stop()
        self.state.close()

    def _metadata(self, s: Stream, name: str, now: int) -> DatastreamMetadata:
        where = f"Satori on-chain data stream {s.stream_id} on chain {self.chain_id}."
        if s.named:
            description = (
                "Named stream: its value is the net prediction flow of Satori "
                "predictors on this stream's daily game (UP adds the predictor's "
                "power, DOWN subtracts), in SATORI wei; snapshotted hourly. " + where
            )
        else:
            description = (
                f"{where} Mirrored from the Satori protocol registry. "
                f"Provider {s.provider}."
            )
        return DatastreamMetadata(
            stream_name=name,
            nostr_pubkey=self.client.pubkey(),  # type: ignore[union-attr]
            name=s.name,
            description=description,
            encrypted=False,
            # Free, so publish_observation takes its broadcast branch: one
            # plaintext event per observation rather than an encrypted DM per
            # subscriber. These are public chain facts; charging for them would
            # be charging for something anyone can already read.
            price_per_obs=0,
            created_at=self.state.first_seen(name, now),
            # Deliberately null, even where the chain knows a cadence. The
            # on-chain number is a MINIMUM between writes (and a named stream
            # snapshots only when touched), but this field's consumer reads it
            # as a schedule: satorilib's is_likely_active flags a stream stale
            # past 1.5x cadence_seconds, which would judge a healthy-but-quiet
            # stream dead and send subscribers re-hunting it. Null means "no
            # schedule claimed", which is the truth.
            cadence_seconds=None,
            tags=["satori", "onchain", f"chain-{self.chain_id}"] + (["named"] if s.named else []),
            metadata={
                "chainId": self.chain_id,
                "streamId": s.stream_id,
                "creator": s.creator,
                "provider": s.provider,
                "streamType": s.stream_type,
                "adapterId": s.adapter_id,
                "named": s.named,
                "createdBlock": s.created_block,
            },
        )

    async def _announce_if_changed(self, s: Stream, name: str, now: int) -> DatastreamMetadata:
        meta = self._metadata(s, name, now)
        fp = _fingerprint(s)
        if self.state.announced_fingerprint(name) == fp:
            return meta
        if self.cfg.dry_run:
            # Nothing is recorded on a dry run, deliberately. See the note on
            # _publish_new_values: a rehearsal that writes state consumes the
            # very backfill it exists to preview.
            log.info("[dry-run] would announce %s (%s%s)", name, s.name,
                     ", named" if s.named else "")
            return meta
        await self.client.announce_datastream(meta)  # type: ignore[union-attr]
        log.info("announced %s (%s)", name, s.name)
        self.state.record_announcement(name, fp, meta.created_at)
        return meta

    async def _publish_new_values(self, s: Stream, name: str, meta: DatastreamMetadata) -> int:
        cursor = self.state.last_block(name)
        # `fromBlock` is inclusive, so ask from the block AFTER the cursor.
        # Without the +1 every tick re-publishes the newest observation forever.
        observations = self.indexer.values(
            s.stream_id, from_block=None if cursor is None else cursor + 1)
        if not observations:
            return 0

        seq = self.state.next_seq(name)
        published = 0
        for o in observations:
            unit, display, display_unit = self.values.render(s.provider, o.new_value, named=s.named)
            obs = DatastreamObservation(
                stream_name=name,
                timestamp=observation_timestamp(o.hour, o.round_number),
                value=observation_payload(
                    stream_id=s.stream_id,
                    chain_id=self.chain_id or 0,
                    block=o.block,
                    round_number=o.round_number,
                    hour=o.hour,
                    raw_value=o.new_value,
                    unit=unit,
                    display_value=display,
                    display_unit=display_unit,
                ),
                seq_num=seq,
            )
            if self.cfg.dry_run:
                log.info("[dry-run] would publish %s seq=%d block=%d raw=%s unit=%s",
                         name, seq, o.block, o.new_value, unit)
            else:
                await self.client.publish_observation(obs, meta)  # type: ignore[union-attr]
                # Recorded per observation, so an interruption costs at most the
                # one in flight rather than the whole batch. NOT recorded on a
                # dry run: the documented go-live sequence is a dry run followed
                # by the real one over the same volume, so a cursor advanced here
                # would leave that real run with nothing to publish — silently,
                # and looking healthy while the relay stayed empty.
                self.state.advance(name, o.block, seq)
            seq += 1
            published += 1
        return published

    async def tick(self) -> dict:
        """One full pass. Returns a small summary, for logging and for tests."""
        ready, why = self.indexer.ready()
        if not ready:
            log.warning("skipping tick: %s", why)
            return {"skipped": why}

        if self.chain_id is None:
            self.chain_id = self.cfg.chain_id_override or int(self.indexer.status()["chainId"])
            log.info("bridging chain %s", self.chain_id)

        streams = self.indexer.streams()
        now = int(time.time())
        announced = 0
        published = 0
        for s in streams:
            name = stream_name(self.chain_id, s.stream_id)
            before = self.state.announced_fingerprint(name)
            meta = await self._announce_if_changed(s, name, now)
            if before != _fingerprint(s):
                announced += 1
            published += await self._publish_new_values(s, name, meta)
        return {"streams": len(streams), "announced": announced, "published": published}

    async def run_forever(self) -> None:
        import asyncio
        while True:
            try:
                summary = await self.tick()
                if summary.get("announced") or summary.get("published"):
                    log.info("tick: %s", summary)
            except IndexerUnavailable as e:
                # Expected and transient. The indexer restarts, the network
                # blips; neither is a reason to take the bridge down.
                log.warning("indexer unavailable: %s", e)
            except Exception:  # noqa: BLE001
                log.exception("tick failed")
            await asyncio.sleep(self.cfg.poll_seconds)
