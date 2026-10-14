// The default stream ("Satori Participation", id 1) reports the PREVIOUS round's
// PARTICIPATION RATIO.
//
// WHAT THE VALUE IS. Until 2026-09-07 this stream carried the raw prediction
// COUNT, and an adversary run showed why that was unsafe: a batch's size drives
// the count directly, for free, in either direction, so the mint-paying default
// game could be won risk-free. `SatoriEngine.flushDefaultStream` now writes:
//
//     deployed = _roundState[today - 1].deployedBalance;   // sum of predictors' balances
//     ratio    = deployed * 1e18 / token.totalSupply();
//     satoriRegistry.setValueForRound(DEFAULT_STREAM_ID, ratio, today);
//
// So the value is the fraction of circulating supply that was committed to
// predicting, scaled by 1e18 — capital-bounded and costly to move, rather than a
// free lever. It is NOT a count, and nothing here may treat it as one.
//
// UNITS. The registry ring is HOUR-keyed: `getHistory` stamps are absolute hours
// (timestamp / 3600). Stream 1 is written once per round through
// `setValueForRound`, which lands its entry at `hour = round * 24` EXACTLY
// (SatoriRegistry.setValueForRound: "this round-denominated write lands at the
// round's FIRST hour"). This module converts hour -> round (/ 24) at entry and
// works in ROUNDS throughout.
//
// THE SHIFT. The value STAMPED round N describes round N-1, by construction.
// Plotting it at N is a mislabel, not a presentation choice: it reports every
// round's activity one round late, and the round a user actually predicted in
// reads as zero forever.
//
// Owner hit this on 2026-08-22: predicted once in round 2, saw 0 for rounds 1
// and 2, and correctly guessed the number would surface under round 3. So:
// move each stamped value back one round, onto the round it actually describes.
// The genesis seed (stamped at the deployment round) would land before the
// protocol existed and is dropped.
//
// THERE IS NO LONGER A TAIL FILL. There used to be one: the flush is lazy, so a
// round nobody predicted in never gets stamped, and the gap was filled by
// reading `roundPredictionCount(round)` — the same number the flush would have
// published. That stopped being true when the metric became a ratio. The count
// is a headcount (3) and the series is a 1e18-scaled fraction (4.2e17), so the
// fill was injecting values ~18 orders of magnitude too small into the same
// line — every filled round plotting as a flat zero.
//
// It cannot be repaired, only removed: the ratio needs `deployedBalance`, and
// the engine exposes no getter for it (only `roundPredictionCount` is public).
// A round with no stamp now renders as a genuine gap, which is what it is — no
// value was ever published for it. See the D4 review, 2026-09-08.
//
// SCOPE. This applies to stream 1 ONLY. Every other stream publishes a value
// that IS the value at the moment it was stamped — a Chainlink price stamped
// at hour H is the price at hour H. Shifting those would be the bug this fixes.

import type { StreamValueDisplay } from './streamAdapterUI';

/// `SatoriHub.DEFAULT_STREAM_ID`. Pinned to 1 on-chain.
export const DEFAULT_STREAM_ID = 1;

/// What the dapp CALLS stream 1, which is not what the chain calls it.
///
/// On-chain its name is still the literal "Satori Predictions" that
/// `SatoriHub._bootstrapDefaultStream` wrote, and that name is immutable in
/// practice: `SatoriRegistry.setDataStreamName` is provider-gated, stream 1's
/// provider is the hub CONTRACT, and the hub exposes no passthrough — so no
/// key can rename it, not the deployer and not the governor Safe. Changing it
/// would take a hub upgrade or a redeploy.
///
/// "Predictions" described the old count faithfully and describes a
/// participation ratio not at all, so the dapp corrects the label at the edge.
/// Deliberate divergence from chain state, owner-directed 2026-09-08.
export const DEFAULT_STREAM_DISPLAY_NAME = 'Satori Participation';

/// How to render stream 1's value.
///
/// The stored value is a fraction of supply scaled by 1e18, so dividing by 1e16
/// yields the PERCENTAGE directly — no new formatting mechanism, just the
/// existing decimals/unit pair pointed one place further left.
export const DEFAULT_STREAM_VALUE_DISPLAY: StreamValueDisplay = {
  decimals: 16,
  unit: '%',
  label: 'share of supply predicting',
};

/// The value display to render `streamId` with, given whatever the adapter
/// probe resolved (null for Simple streams, which stream 1 is).
///
/// Stream 1 is a Simple stream, so `resolveStreamAdapterUI` returns null for it
/// and every render site would fall back to the RAW value — 42% participation
/// printed as "420000000000000000". Every site that formats a stream value must
/// go through here.
export function streamValueDisplayFor(
  streamId: number,
  resolved: StreamValueDisplay | null,
): StreamValueDisplay | null {
  return streamId === DEFAULT_STREAM_ID ? DEFAULT_STREAM_VALUE_DISPLAY : resolved;
}

/// On INPUT to `shiftToDescribedRound`, `round` holds getHistory's stamp — an
/// absolute HOUR. On output, and everywhere else in this module, it is a round.
export interface SeriesPoint { value: number; round: number }

/// Move hour-stamped values onto the ROUND they describe, dropping anything
/// that lands before the protocol's first round (the genesis seed).
///
/// Stream 1's stamps sit at exact round boundaries (hour = round * 24), so the
/// division is exact; the floor is belt-and-braces against a malformed stamp.
export function shiftToDescribedRound<T extends SeriesPoint>(
  points: T[],
  deploymentRound: number,
): T[] {
  return points
    .map((p) => ({ ...p, round: Math.floor(p.round / 24) - 1 }))
    .filter((p) => p.round >= deploymentRound);
}
