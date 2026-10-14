"""The loop, against a REAL relay and a fake indexer.

The relay is satorilib's MiniRelay: a real NIP-01 implementation over a real
websocket, so the events asserted here went through signing, encoding and a
relay round-trip rather than a mock of one. Only the indexer is faked, because
its behaviour is already pinned on its own side and what matters here is what
the bridge does with the answers.
"""
import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(Path("/code/Satori/satorilib")))

from bridge.bridge import Bridge  # noqa: E402
from bridge.config import Config  # noqa: E402
from bridge.indexer import Observation, Stream  # noqa: E402
from bridge.values import SEL_DECIMALS, SEL_SYMBOL, SEL_TOKEN0, SEL_TOKEN1  # noqa: E402
from tests.mini_relay import MiniRelay  # noqa: E402  (satorilib's test relay)

NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5"


class FakeIndexer:
    """Stands in for satori-indexer. Every knob here is a real failure mode."""

    def __init__(self):
        self.chain_id = 8453
        self.streams_indexed = True
        self.syncing = False
        self._streams: list[Stream] = []
        self._values: dict[int, list[Observation]] = {}
        self.value_calls: list[tuple[int, int | None]] = []

    def status(self):
        return {"chainId": self.chain_id, "streamsIndexed": self.streams_indexed,
                "syncing": self.syncing}

    def ready(self):
        if not self.streams_indexed:
            return False, "indexer is not indexing streams (no REGISTRY_ADDRESS)"
        if self.syncing:
            return False, "indexer is still syncing; refusing to publish a partial history"
        return True, ""

    def streams(self):
        return list(self._streams)

    def values(self, stream_id, from_block=None):
        self.value_calls.append((stream_id, from_block))
        rows = self._values.get(stream_id, [])
        if from_block is not None:
            rows = [o for o in rows if o.block >= from_block]
        return rows


def make_stream(sid=1, name="BTC-USD", provider="0xprovider", adapter_id=0, named=False):
    # Through from_json, so these rows are the shape the indexer actually serves.
    return Stream.from_json({
        "streamId": sid, "name": name, "streamType": 1, "creator": "0xcreator",
        "provider": provider, "createdBlock": 10, "valueCount": 0,
        "adapterId": adapter_id, "named": named,
    })


def make_obs(block, round_number, value, hour=None):
    return Observation(block=block, log_index=0, tx=f"0x{block:064x}",
                       old_value="0", new_value=str(value), round_number=round_number,
                       hour=hour)


def _word(n: int) -> str:
    return "0x" + f"{n:064x}"


def _abi_string(s: str) -> str:
    b = s.encode()
    return "0x" + (32).to_bytes(32, "big").hex() + len(b).to_bytes(32, "big").hex() + b.ljust(32, b"\x00").hex()


class PoolRpc:
    """Answers like a WETH/USDC Uniswap pool and records every probe."""
    WETH = "0x" + "aa" * 20
    USDC = "0x" + "bb" * 20

    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def call(self, to, data):
        self.calls.append((to, data))
        if data == SEL_TOKEN0:
            return _word(int(self.WETH, 16))
        if data == SEL_TOKEN1:
            return _word(int(self.USDC, 16))
        if data == SEL_DECIMALS:
            return _word(18 if to == self.WETH else 6)
        if data == SEL_SYMBOL:
            return _abi_string("WETH" if to == self.WETH else "USDC")
        raise AssertionError(f"unexpected probe {data} to {to}")


async def _make_bridge(tmp_path, relay_url, fake, dry_run=False):
    cfg = Config(indexer_url="http://unused", nostr_key=NSEC,
                 relay_urls=(relay_url,), rpc_url=None,
                 state_path=str(tmp_path / "state.db"), poll_seconds=1,
                 chain_id_override=None, dry_run=dry_run)
    b = Bridge(cfg)
    b.indexer = fake  # type: ignore[assignment]
    await b.start()
    return b


def events_of_kind(relay, kind):
    return [e for e in relay.events if e.get("kind") == kind]


@pytest.mark.asyncio
async def test_announces_streams_and_publishes_observations(tmp_path):
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(1, "BTC-USD"), make_stream(2, "ETH-USD")]
    fake._values = {
        1: [make_obs(100, 41511, 100000), make_obs(104, 41513, 100250)],
        2: [make_obs(101, 41511, 3000)],
    }
    b = await _make_bridge(tmp_path, url, fake)
    try:
        summary = await b.tick()
        await asyncio.sleep(0.4)

        assert summary == {"streams": 2, "announced": 2, "published": 3}
        assert len(events_of_kind(relay, 34600)) == 2, "one announcement per stream"
        assert len(events_of_kind(relay, 34601)) == 3, "one event per observation"

        # The name must carry the chain, and the payload must keep the exact int.
        obs = [json.loads(e["content"]) for e in events_of_kind(relay, 34601)]
        assert {o["value"]["streamId"] for o in obs} == {1, 2}
        assert all(o["value"]["chainId"] == 8453 for o in obs)
        assert {o["value"]["raw"] for o in obs} == {"100000", "100250", "3000"}
        announced = [json.loads(e["content"]) for e in events_of_kind(relay, 34600)]
        assert {a["stream_name"] for a in announced} == {"satori-8453-1", "satori-8453-2"}
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_second_tick_is_silent_when_nothing_changed(tmp_path):
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(1)]
    fake._values = {1: [make_obs(100, 41511, 7)]}
    b = await _make_bridge(tmp_path, url, fake)
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        before = len(relay.events)

        second = await b.tick()
        await asyncio.sleep(0.3)

        assert second == {"streams": 1, "announced": 0, "published": 0}
        assert len(relay.events) == before, "an unchanged tick must publish nothing"
        # And the cursor must ask for the block AFTER the last one, or the newest
        # observation is republished forever.
        assert fake.value_calls[-1] == (1, 101)
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_only_new_observations_are_published(tmp_path):
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(1)]
    fake._values = {1: [make_obs(100, 41511, 1)]}
    b = await _make_bridge(tmp_path, url, fake)
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        fake._values[1].append(make_obs(108, 41515, 2))

        summary = await b.tick()
        await asyncio.sleep(0.3)

        assert summary["published"] == 1
        obs = [json.loads(e["content"]) for e in events_of_kind(relay, 34601)]
        assert [o["value"]["raw"] for o in obs] == ["1", "2"]
        # seq_num must keep counting across ticks, not restart.
        assert [o["seq_num"] for o in obs] == [1, 2]
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_a_rename_re_announces_but_does_not_republish_history(tmp_path):
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(1, "BTC-USD")]
    fake._values = {1: [make_obs(100, 41511, 1)]}
    b = await _make_bridge(tmp_path, url, fake)
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        fake._streams = [make_stream(1, "BTC-USD (renamed)")]

        summary = await b.tick()
        await asyncio.sleep(0.3)

        assert summary["announced"] == 1 and summary["published"] == 0
        announced = [json.loads(e["content"]) for e in events_of_kind(relay, 34600)]
        assert announced[-1]["name"] == "BTC-USD (renamed)"
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_a_syncing_indexer_publishes_nothing(tmp_path):
    # A mid-backfill indexer serves a PARTIAL history. Announcing from it is not
    # merely incomplete, it teaches subscribers something false.
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake.syncing = True
    fake._streams = [make_stream(1)]
    fake._values = {1: [make_obs(100, 41511, 1)]}
    b = await _make_bridge(tmp_path, url, fake)
    try:
        summary = await b.tick()
        await asyncio.sleep(0.2)
        assert "skipped" in summary
        assert relay.events == []
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_an_indexer_without_stream_indexing_publishes_nothing(tmp_path):
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake.streams_indexed = False
    b = await _make_bridge(tmp_path, url, fake)
    try:
        summary = await b.tick()
        assert "skipped" in summary
        assert relay.events == []
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_the_cursor_survives_a_restart(tmp_path):
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(1)]
    fake._values = {1: [make_obs(100, 41511, 1)]}

    b = await _make_bridge(tmp_path, url, fake)
    await b.tick()
    await asyncio.sleep(0.3)
    await b.stop()
    count_after_first_run = len(events_of_kind(relay, 34601))

    # Same state path: a restart must not replay history onto the relay.
    b2 = await _make_bridge(tmp_path, url, fake)
    try:
        summary = await b2.tick()
        await asyncio.sleep(0.3)
        assert summary["published"] == 0
        assert len(events_of_kind(relay, 34601)) == count_after_first_run
    finally:
        await b2.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_negative_values_survive_the_round_trip(tmp_path):
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(1)]
    fake._values = {1: [make_obs(100, 41511, -42)]}
    b = await _make_bridge(tmp_path, url, fake)
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        obs = [json.loads(e["content"]) for e in events_of_kind(relay, 34601)]
        assert obs[0]["value"]["raw"] == "-42"
        # And no `value` key, because with no RPC nothing can be converted.
        assert "value" not in obs[0]["value"]
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_a_dry_run_leaves_the_cursor_untouched(tmp_path):
    """The rehearsal must not consume the thing it is rehearsing.

    The documented go-live sequence is a DRY_RUN pass and then the real one, and
    compose keeps the cursor on a volume across both. A dry run that advances the
    cursor therefore eats the entire backfill: the real run publishes nothing,
    logs nothing, and looks perfectly healthy while the relay stays empty.
    """
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(1, "BTC-USD")]
    fake._values = {1: [make_obs(100, 41511, 1), make_obs(104, 41513, 2)]}

    dry = await _make_bridge(tmp_path, url, fake, dry_run=True)
    summary = await dry.tick()
    await asyncio.sleep(0.3)
    assert summary == {"streams": 1, "announced": 1, "published": 2}, \
        "a dry run still reports what it WOULD do"
    assert relay.events == [], "a dry run must publish nothing"
    await dry.stop()

    # Same state path, exactly as the volume gives you. The real run must still
    # have the whole backfill in front of it.
    real = await _make_bridge(tmp_path, url, fake)
    try:
        summary = await real.tick()
        await asyncio.sleep(0.4)
        assert summary == {"streams": 1, "announced": 1, "published": 2}
        assert len(events_of_kind(relay, 34600)) == 1
        assert len(events_of_kind(relay, 34601)) == 2
        obs = [json.loads(e["content"]) for e in events_of_kind(relay, 34601)]
        assert [o["value"]["raw"] for o in obs] == ["1", "2"]
    finally:
        await real.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_a_dry_run_repeats_itself_rather_than_draining(tmp_path):
    """Two dry ticks report the same work, because neither consumed any of it."""
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(1)]
    fake._values = {1: [make_obs(100, 41511, 1)]}
    b = await _make_bridge(tmp_path, url, fake, dry_run=True)
    try:
        first = await b.tick()
        second = await b.tick()
        await asyncio.sleep(0.3)
        assert first == second == {"streams": 1, "announced": 1, "published": 1}
        assert relay.events == []
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_a_base_stream_claims_no_cadence_it_cannot_know(tmp_path):
    """`DataStreamCreated` does not carry a cadence, so for a base stream the
    indexer genuinely has no schedule to report. Saying nothing is right;
    inventing one would be a guess presented as a fact."""
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(1)]
    b = await _make_bridge(tmp_path, url, fake)
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        meta = json.loads(events_of_kind(relay, 34600)[0]["content"])
        assert meta["cadence_seconds"] is None
    finally:
        await b.stop()
        await relay.stop()


def test_an_indexer_row_without_named_fields_still_parses():
    """An indexer older than the named-stream change serves no `adapterId` or
    `named`. The bridge must keep working against it, as a plain stream."""
    s = Stream.from_json({
        "streamId": 4, "name": "x", "streamType": 1, "creator": "0xc",
        "provider": "0xp", "createdBlock": 1, "valueCount": 0,
    })
    assert s.adapter_id == 0 and s.named is False


@pytest.mark.asyncio
async def test_a_named_stream_announces_as_named(tmp_path):
    """A subscriber must be told what a named stream's number IS.

    Its provider is the engine and its value is a prediction-flow counter in
    SATORI wei, not a price. Announced like any other stream it would read as
    "some adapter stream with a big number".
    """
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(2, "Bitcoin", provider="0xengine", adapter_id=5, named=True)]
    b = await _make_bridge(tmp_path, url, fake)
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        meta = json.loads(events_of_kind(relay, 34600)[0]["content"])
        assert meta["description"].startswith("Named stream:")
        assert meta["metadata"]["named"] is True
        assert meta["metadata"]["adapterId"] == 5
        assert "named" in meta["tags"]
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_a_named_stream_publishes_its_counter_as_flow(tmp_path):
    """The counter is SATORI wei and can go negative (net DOWN flow).

    `raw` stays the exact string; `value` is the same number in SATORI; and the
    engine is never probed as a Uniswap pool, which is what the duck-typed path
    would do with it.
    """
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(2, "Bitcoin", provider="0xengine", adapter_id=5, named=True)]
    fake._values = {2: [make_obs(100, 41511, 39999999922025791488),
                        make_obs(104, 41513, -2500000000000000000)]}
    b = await _make_bridge(tmp_path, url, fake)

    class NoRpc:
        def call(self, to, data):
            raise AssertionError(f"a named stream's provider was probed as a pool: {to}")

    b.values._rpc = NoRpc()  # type: ignore[assignment]
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        obs = [json.loads(e["content"])["value"] for e in events_of_kind(relay, 34601)]
        assert [o["raw"] for o in obs] == ["39999999922025791488", "-2500000000000000000"]
        assert [o["unit"] for o in obs] == ["flow", "flow"]
        assert obs[0]["value"] == pytest.approx(39.999999922025791488)
        assert obs[1]["value"] == -2.5
        assert {o["valueUnit"] for o in obs} == {"SATORI"}
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_a_non_named_adapter_stream_is_unchanged(tmp_path):
    """The `named` branch must not swallow the pool path: an adapter stream
    that is NOT named is still probed as a pool and still publishes a tick
    with its converted price, exactly as before named streams existed."""
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(3, "WETH/USDC", provider="0xpool", adapter_id=2, named=False)]
    fake._values = {3: [make_obs(100, 41511, 213397)]}
    b = await _make_bridge(tmp_path, url, fake)
    rpc = PoolRpc()
    b.values._rpc = rpc  # type: ignore[assignment]
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        meta = json.loads(events_of_kind(relay, 34600)[0]["content"])
        assert meta["metadata"]["named"] is False
        assert meta["metadata"]["adapterId"] == 2
        assert "named" not in meta["tags"]
        o = json.loads(events_of_kind(relay, 34601)[0]["content"])["value"]
        assert o["raw"] == "213397" and o["unit"] == "tick"
        assert o["valueUnit"] == "USDC per WETH" and o["value"] > 0
        assert ("0xpool", SEL_TOKEN0) in rpc.calls, "the provider was not probed as a pool"
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_hourly_snapshots_in_one_round_keep_distinct_timestamps(tmp_path):
    """A named stream snapshots hourly, up to 24 times a round. Timestamped by
    the round they would all collide, and neuron-lite dedupes bridge
    observations on that key, so it would keep the first of the day and drop
    the rest. The hour is the honest key and travels in the payload too."""
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(2, "Bitcoin", provider="0xengine", adapter_id=5, named=True)]
    fake._values = {2: [make_obs(73, 20737, 0, hour=497688),
                        make_obs(76, 20737, 39999999922025791488, hour=497689)]}
    b = await _make_bridge(tmp_path, url, fake)
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        evs = [json.loads(e["content"]) for e in events_of_kind(relay, 34601)]
        assert [e["timestamp"] for e in evs] == [497688 * 3600, 497689 * 3600]
        assert [e["value"]["hour"] for e in evs] == [497688, 497689]
        assert {e["value"]["round"] for e in evs} == {20737}
    finally:
        await b.stop()
        await relay.stop()


@pytest.mark.asyncio
async def test_named_is_part_of_what_an_announcement_promises(tmp_path):
    """The fingerprint must cover every variable field in the announcement.

    `named` really does move: an indexer that boots before a dev chain wires
    `namedAdapterId` serves `named: false` until its next poll. The stream was
    announced as plain; it must be re-announced as named, not left that way.
    """
    relay = MiniRelay()
    await relay.start()
    url = relay.url
    fake = FakeIndexer()
    fake._streams = [make_stream(2, "Bitcoin", adapter_id=5, named=False)]
    b = await _make_bridge(tmp_path, url, fake)
    try:
        await b.tick()
        await asyncio.sleep(0.3)
        before = len(events_of_kind(relay, 34600))

        fake._streams = [make_stream(2, "Bitcoin", adapter_id=5, named=True)]
        summary = await b.tick()
        await asyncio.sleep(0.3)

        assert summary["announced"] == 1
        assert len(events_of_kind(relay, 34600)) == before + 1
        meta = json.loads(events_of_kind(relay, 34600)[-1]["content"])
        assert meta["metadata"]["named"] is True
    finally:
        await b.stop()
        await relay.stop()
