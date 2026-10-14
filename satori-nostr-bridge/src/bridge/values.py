"""Turning a stored integer into something a subscriber can use.

Satori stores a Uniswap stream's value as the RAW TICK, deliberately. Publishing
that number to Nostr under a name like "WETH/USDC" would be actively misleading:
tick 213397 is not a price, it is a logarithm of one. So the bridge does what the
dapp does, and where it cannot, it says so instead of guessing.

Detection is DUCK-TYPED rather than driven by the stream type, for the same
reason the dapp's is (`satori-ui/src/lib/streamAdapterUI.ts`): an adapter
stream's `provider` IS its data source contract, so a Uniswap-backed stream's
provider is the pool. Ask that address for `token0()`/`token1()`. If it answers,
the value is a tick and the decimals needed to convert it are one call away. If
it does not, this is not a pool and the value stands as stored.

The conversion itself mirrors `satori-ui/src/lib/streamOrientation.ts`:

    native = 1.0001^tick × 10^(decimals0 − decimals1)
    shown  = 1/native if the pool reads inverted, else native

with the orientation decided at tick 0 rather than at the live tick. That is not
an optimisation: choosing per-observation would let a stream's units flip
mid-series as the price crosses parity, which is worse than an awkward unit.
"""
from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass

# Function selectors, so this needs no ABI library and no web3 dependency.
SEL_TOKEN0 = "0x0dfe1681"
SEL_TOKEN1 = "0xd21220a7"
SEL_DECIMALS = "0x313ce567"
SEL_SYMBOL = "0x95d89b41"

UNIT_TICK = "tick"
UNIT_RAW = "raw"
# A named stream's counter: net prediction flow in SATORI wei (A_named_streams).
UNIT_FLOW = "flow"


class RpcError(RuntimeError):
    """The CALL failed: no such function, reverted, empty return.

    Means "this address is not what we hoped". Safe to treat as a negative
    answer, which is what `probe_pool` does.
    """


class RpcUnreachable(RuntimeError):
    """The ENDPOINT failed: HTTP error, timeout, refused connection.

    A different thing entirely, and conflating the two is how a tick stream ends
    up silently publishing a raw tick forever.

    Found the hard way on 2026-08-20: `sepolia.base.org` answers **HTTP 403** to
    urllib's default `Python-urllib/3.x` User-Agent. Every `token0()` probe
    failed, `probe_pool` read that as "not a pool", and the WETH/USDC stream
    would have published tick 213397 unconverted — correct-looking output, with
    the conversion silently disabled by a header.
    """


@dataclass(frozen=True)
class TokenPair:
    decimals0: int
    decimals1: int
    symbol0: str
    symbol1: str


class Rpc:
    """The smallest JSON-RPC client that can do `eth_call`."""

    def __init__(self, url: str, timeout: float = 10.0):
        self.url = url
        self.timeout = timeout
        self._id = 0

    def call(self, to: str, data: str) -> str:
        self._id += 1
        body = json.dumps({
            "jsonrpc": "2.0", "id": self._id, "method": "eth_call",
            "params": [{"to": to, "data": data}, "latest"],
        }).encode()
        req = urllib.request.Request(self.url, data=body, headers={
            "Content-Type": "application/json",
            # REQUIRED, not politeness. Cloudflare-fronted public RPCs —
            # sepolia.base.org among them — return 403 to urllib's default
            # `Python-urllib/3.x`. Without this every call fails and, before the
            # error split below, failed *silently*.
            "User-Agent": "satori-nostr-bridge/1.0",
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                d = json.loads(r.read().decode())
        except Exception as e:  # noqa: BLE001
            # Transport failure. NOT an answer about the address.
            raise RpcUnreachable(f"{type(e).__name__}: {e}") from e
        if "error" in d:
            # JSON-RPC error — the node answered, the call did not work.
            raise RpcError(str(d["error"]))
        result = d.get("result", "0x")
        if result in ("0x", ""):
            # A call to an address with no such function returns empty. That IS
            # an answer ("not a pool"), not a failure.
            raise RpcError("empty result")
        return result


def _decode_address(word: str) -> str:
    return "0x" + word[-40:]


def _decode_uint(word: str) -> int:
    return int(word, 16)


def _decode_string(hexdata: str) -> str:
    """Decode an ABI-encoded dynamic string.

    Some well-known tokens return a bytes32 instead of a string (MakerDAO-era
    ERC-20s predate the standard settling), so fall back to trimming a fixed
    word rather than raising on them.
    """
    raw = bytes.fromhex(hexdata[2:])
    if len(raw) >= 64:
        try:
            offset = int.from_bytes(raw[0:32], "big")
            length = int.from_bytes(raw[offset:offset + 32], "big")
            if 0 < length <= len(raw) - offset - 32:
                return raw[offset + 32: offset + 32 + length].decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            pass
    return raw.rstrip(b"\x00").decode("utf-8", "replace")


def probe_pool(rpc: Rpc, address: str) -> TokenPair | None:
    """Return the token pair if `address` is a Uniswap-shaped pool, else None.

    None is the ordinary case: most streams are not pools. It is not an error
    and is not logged as one.

    `RpcUnreachable` is deliberately NOT caught. If the endpoint is refusing us,
    "not a pool" is a lie, and swallowing it turns a broken RPC config into
    permanently unconverted ticks that look like a deliberate choice. Let it
    propagate so the caller can decide loudly.
    """
    try:
        t0 = _decode_address(rpc.call(address, SEL_TOKEN0))
        t1 = _decode_address(rpc.call(address, SEL_TOKEN1))
    except RpcError:
        return None
    try:
        return TokenPair(
            decimals0=_decode_uint(rpc.call(t0, SEL_DECIMALS)),
            decimals1=_decode_uint(rpc.call(t1, SEL_DECIMALS)),
            symbol0=_decode_string(rpc.call(t0, SEL_SYMBOL)),
            symbol1=_decode_string(rpc.call(t1, SEL_SYMBOL)),
        )
    except RpcError:
        # It IS a pool (both token calls answered) but a token is unreadable, so
        # the tick cannot be scaled. Treat it as unconvertible rather than
        # inventing decimals, which would silently publish a wrong price.
        return None


def is_inverted(pair: TokenPair) -> bool:
    """Which way round the pair reads, decided at tick 0 and never re-decided."""
    return (10 ** (pair.decimals0 - pair.decimals1)) < 1


def unit_label(pair: TokenPair) -> str:
    return (f"{pair.symbol0} per {pair.symbol1}" if is_inverted(pair)
            else f"{pair.symbol1} per {pair.symbol0}")


def tick_to_price(tick: int, pair: TokenPair) -> float | None:
    """`1.0001^tick` scaled by the decimal gap, inverted if the pair reads that way.

    Returns None rather than inf/0 outside Uniswap's legal tick range
    (±887272), where the exponential overflows a float and any number produced
    would be noise.
    """
    if not -887272 <= tick <= 887272:
        return None
    try:
        native = (1.0001 ** tick) * (10 ** (pair.decimals0 - pair.decimals1))
    except OverflowError:
        return None
    if native <= 0 or native != native or native in (float("inf"), float("-inf")):
        return None
    shown = (1 / native) if is_inverted(pair) else native
    if shown in (float("inf"), float("-inf")) or shown != shown:
        return None
    return shown


class ValueRenderer:
    """Decides, once per stream and then from cache, how to present its values."""

    def __init__(self, rpc_url: str | None):
        self._rpc = Rpc(rpc_url) if rpc_url else None
        self._pairs: dict[str, TokenPair | None] = {}

    @property
    def conversion_available(self) -> bool:
        return self._rpc is not None

    def _pair_for(self, provider: str) -> TokenPair | None:
        if self._rpc is None:
            return None
        if provider not in self._pairs:
            self._pairs[provider] = probe_pool(self._rpc, provider)
        return self._pairs[provider]

    def render(self, provider: str, raw_value: str, named: bool = False,
               ) -> tuple[str, float | None, str | None]:
        """-> (unit, display_value, display_unit)

        `unit` describes the RAW number and is always accurate. When the raw
        number is a tick and we could not convert it, display_value is None and
        `unit` still says `tick`, so nothing downstream can mistake it for a
        price.

        A named stream's provider is the engine, not a pool, so it is never
        probed: the counter is SATORI wei and is scaled, not converted.
        """
        if named:
            return UNIT_FLOW, int(raw_value) / 10**18, "SATORI"
        pair = self._pair_for(provider)
        if pair is None:
            # Either not a pool, or no RPC to ask. Either way the stored integer
            # is the value, and we do not claim to know its units.
            return UNIT_RAW, None, None
        try:
            tick = int(raw_value)
        except ValueError:
            return UNIT_TICK, None, None
        return UNIT_TICK, tick_to_price(tick, pair), unit_label(pair)
