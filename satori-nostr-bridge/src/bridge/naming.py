"""How an on-chain stream becomes a Nostr stream, and the observation payload.

The naming rule is the one decision here that cannot be changed later without
orphaning every subscriber, so it is written down rather than inlined.
"""
from __future__ import annotations

# A round is 24 hours. This MUST match `SatoriToken.TIME_UNIT_SECONDS`, which the
# immutable token declares as a literal. The chain has no other clock:
# `getCurrentRound` is literally `block.timestamp / TIME_UNIT_SECONDS`, so a round
# number converts back to the timestamp of that round's start exactly.
#
# It was 43_200 (12h) until the rolling-scoring redesign (2026-09-05, phase 5)
# made rounds 24h. This constant was NOT updated with it, and the comment here
# asserted the old value was "fixed forever in the immutable token" — which is
# why nobody looked. The D4 deploy published round 20704 as timestamp 894412800,
# i.e. 1998, because a 24h round was being halved. If the protocol's round length
# ever changes again, THIS LINE CHANGES WITH IT.
TIME_UNIT_SECONDS = 86_400


def stream_name(chain_id: int, stream_id: int) -> str:
    """The Nostr identity of an on-chain stream.

    `satori-<chainId>-<streamId>`. Two properties matter and both come from the
    chain id being in there:

    - A redeploy on a NEW chain cannot collide with the old one.
    - Testnet and mainnet streams can share a relay without pretending to be
      each other, which they would under a bare stream id.

    A redeploy on the SAME chain *does* collide, deliberately: stream 3 is stream
    3, and the alternative (folding in a contract address) makes the name
    unreadable and unguessable for a subscriber who only knows the chain.
    """
    return f"satori-{chain_id}-{stream_id}"


HOUR_SECONDS = 3_600


def round_to_timestamp(round_number: int) -> int:
    """The unix timestamp of a round's START, exact because a round is defined
    as `timestamp / TIME_UNIT_SECONDS`."""
    return round_number * TIME_UNIT_SECONDS


def observation_timestamp(hour: int | None, round_number: int) -> int:
    """The unix timestamp of the observation's HOUR, exact because the registry
    ring keys on `timestamp / 3600` and a stream may write every hour.

    The round's start is only the fallback for an indexer that serves no
    `hour`, and it is coarse: a day of hourly snapshots shares one timestamp,
    and neuron-lite dedupes bridge observations on it, keeping one of the day.
    Either beats the wall clock at publish time, which is wrong for every
    backfilled observation, and a backfill is the normal first run.
    """
    if hour is not None:
        return hour * HOUR_SECONDS
    return round_to_timestamp(round_number)


def observation_payload(
    *,
    stream_id: int,
    chain_id: int,
    block: int,
    round_number: int,
    raw_value: str,
    unit: str,
    display_value: float | None,
    display_unit: str | None,
    hour: int | None = None,
) -> dict:
    """What a subscriber actually receives as the observation's `value`.

    `raw` is always the exact on-chain integer AS A STRING. It is int256: it can
    be negative and it does not fit a float, so anything that round-trips it
    through a JSON number is lossy. The string is the authoritative field and a
    consumer that wants certainty should read it.

    `value` is the human-meaningful number where one could be derived (a Uniswap
    tick converted to a price; a named stream's counter scaled from wei to
    SATORI), and absent otherwise. It is NEVER a raw tick
    presented as a price: if the conversion could not be made, this key is not
    here at all and `unit` says `tick`.
    """
    payload: dict = {
        "chainId": chain_id,
        "streamId": stream_id,
        "block": block,
        "round": round_number,
        "raw": raw_value,
        "unit": unit,
    }
    if hour is not None:
        payload["hour"] = hour
    if display_value is not None:
        payload["value"] = display_value
        payload["valueUnit"] = display_unit or ""
    return payload
