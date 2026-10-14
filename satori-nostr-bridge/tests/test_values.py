"""Value rendering: the part that can silently publish a wrong number."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from bridge.naming import (  # noqa: E402
    observation_payload, observation_timestamp, round_to_timestamp, stream_name,
)
from bridge.values import (  # noqa: E402
    TokenPair, ValueRenderer, is_inverted, tick_to_price, unit_label,
)

WETH_USDC = TokenPair(decimals0=6, decimals1=18, symbol0="USDC", symbol1="WETH")
USDC_WETH = TokenPair(decimals0=18, decimals1=6, symbol0="WETH", symbol1="USDC")


def test_stream_name_carries_the_chain():
    # Two chains must never produce the same Nostr identity for the same id.
    assert stream_name(8453, 7) == "satori-8453-7"
    assert stream_name(84532, 7) != stream_name(8453, 7)


def test_round_converts_to_the_round_start_exactly():
    assert round_to_timestamp(0) == 0
    assert round_to_timestamp(1) == 86_400
    assert round_to_timestamp(41511) == 41511 * 86_400


def test_observation_timestamp_is_the_hour_and_falls_back_to_the_round():
    # Hour-keyed when the indexer serves it; an older indexer serves none and
    # the round start is the (coarse) fallback.
    assert observation_timestamp(497689, 20737) == 497689 * 3_600
    assert observation_timestamp(None, 20737) == 20737 * 86_400


def test_orientation_is_decided_by_the_decimal_gap():
    assert is_inverted(WETH_USDC) is True
    assert is_inverted(USDC_WETH) is False
    assert unit_label(WETH_USDC) == "USDC per WETH"
    assert unit_label(USDC_WETH) == "USDC per WETH"


def test_tick_converts_to_a_plausible_price():
    # Real reading from the Sepolia rehearsal: tick 213397 on a WETH/USDC pool
    # was about 540 USDC per WETH (LAUNCH_CHECKLIST H1).
    price = tick_to_price(213397, WETH_USDC)
    assert price is not None
    assert 500 < price < 600


def test_tick_outside_uniswaps_range_yields_nothing_rather_than_infinity():
    # 1.0001**900000 overflows a float. Publishing `inf` as a price would be
    # worse than publishing nothing, which is the whole point of this branch.
    assert tick_to_price(900_000, WETH_USDC) is None
    assert tick_to_price(-900_000, WETH_USDC) is None


def test_a_stream_with_no_rpc_is_never_labelled_as_a_price():
    r = ValueRenderer(rpc_url=None)
    unit, display, display_unit = r.render("0xpool", "213397")
    assert unit == "raw"
    assert display is None and display_unit is None


def test_payload_omits_value_entirely_when_it_could_not_be_derived():
    # A consumer must not be able to read a tick as a price by accident, so the
    # key is absent rather than present-and-equal-to-the-raw-number.
    p = observation_payload(
        stream_id=7, chain_id=8453, block=100, round_number=41511,
        raw_value="213397", unit="tick", display_value=None, display_unit=None,
    )
    assert "value" not in p
    assert p["raw"] == "213397" and p["unit"] == "tick"


def test_payload_keeps_the_raw_integer_as_a_string():
    # int256 does not survive a float, and it can be negative.
    p = observation_payload(
        stream_id=1, chain_id=31337, block=1, round_number=2,
        raw_value="-42", unit="raw", display_value=None, display_unit=None,
    )
    assert p["raw"] == "-42" and isinstance(p["raw"], str)

    big = str(2**200)
    p2 = observation_payload(
        stream_id=1, chain_id=31337, block=1, round_number=2,
        raw_value=big, unit="raw", display_value=None, display_unit=None,
    )
    assert p2["raw"] == big


def test_pool_probe_is_cached_so_one_stream_costs_one_probe():
    calls = []

    class FakeRpc:
        def call(self, to, data):
            calls.append((to, data))
            raise RuntimeError("nope")

    r = ValueRenderer(rpc_url="http://x")
    r._rpc = FakeRpc()  # type: ignore[assignment]
    # probe_pool swallows RpcError only; make the fake raise the right type
    from bridge.values import RpcError

    class FailingRpc:
        def call(self, to, data):
            calls.append((to, data))
            raise RpcError("not a pool")

    r._rpc = FailingRpc()  # type: ignore[assignment]
    for _ in range(5):
        r.render("0xnotapool", "1")
    assert len(calls) == 1, "a non-pool must be probed once, not once per observation"


def test_a_refusing_endpoint_is_not_reported_as_absence_of_pools():
    """The 2026-08-20 bug, pinned.

    `sepolia.base.org` returns HTTP 403 to urllib's default User-Agent. Before
    the fix, probe_pool caught that and returned None, so a Uniswap stream
    published its raw tick with the conversion silently disabled by a header.

    A transport failure must PROPAGATE. "Not a pool" is a claim about an
    address, and the endpoint refusing us is not evidence for it.
    """
    import pytest
    from bridge.values import RpcUnreachable, probe_pool

    class RefusingRpc:
        def call(self, to, data):
            raise RpcUnreachable("HTTP Error 403: Forbidden")

    with pytest.raises(RpcUnreachable):
        probe_pool(RefusingRpc(), "0xpool")


def test_the_rpc_client_sends_a_user_agent():
    """Cloudflare-fronted public RPCs 403 without one. Not politeness."""
    import inspect
    from bridge.values import Rpc
    assert "User-Agent" in inspect.getsource(Rpc.call)
