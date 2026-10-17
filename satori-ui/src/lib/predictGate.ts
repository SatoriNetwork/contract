import type { StreamBasic } from '../hooks/useStreamList';
import type { PredictionResult } from '../hooks/useDashboard';
import { DEFAULT_STREAM_ID } from './defaultStreamSeries';

/// A named game's wait between two predictions by one address, in clock hours.
const NAMED_WAIT_HOURS = 24;

export interface PredictGate {
  active: boolean;
  /// Inactive named stream: the clock hour it takes this address's next call.
  reopenHour?: number;
}

/// Client-side mirror of SatoriEngine's predict gate (the Pass 2 loop of
/// _predictMultipleWithPayloads), so a pick that must revert is grayed out and
/// dropped from the batch instead of reverting it. Unknown → active; the
/// preflight is the backstop.
///
///   - EmptyStream / StaleValue: the stream's newest write must postdate the
///     last prediction. Only `roundMade` is known for non-named streams, so this
///     is approximated at round granularity (a write in the SAME round counts
///     as stale). Not applied to the default stream (predict flushes it first)
///     nor to a named one (predict's own pull writes it once the hour advances).
///   - DuplicatePrediction: once per round; a named game also waits
///     NAMED_WAIT_HOURS after the last prediction's hour.
///   - The once-per-target-period wait of targetMinutes > 1440 games is not
///     mirrored.
export function predictGate(
  streamId: number,
  stream: Pick<StreamBasic, 'valueHour' | 'isNamed'> | undefined,
  last: Pick<PredictionResult, 'roundMade' | 'hour'> | undefined,
  currentRound: number | null,
  nowHour: number,
): PredictGate {
  const predictedThisRound = !!last && currentRound != null && last.roundMade === currentRound;
  if (streamId === DEFAULT_STREAM_ID) return { active: !predictedThisRound };
  if (!stream) return { active: true };
  if (stream.isNamed) {
    if (!last) return { active: true };
    // An indexer row from an older prediction than the chain's latest says nothing.
    const hour = last.hour != null && Math.floor(last.hour / 24) === last.roundMade ? last.hour : null;
    const reopenHour = hour != null ? hour + NAMED_WAIT_HOURS : undefined;
    if (predictedThisRound) return { active: false, reopenHour };
    return reopenHour != null && nowHour < reopenHour ? { active: false, reopenHour } : { active: true };
  }
  if (stream.valueHour <= 0) return { active: false };
  if (!last) return { active: true };
  if (predictedThisRound) return { active: false };
  return { active: Math.floor(stream.valueHour / 24) > last.roundMade };
}

/// "14:00 UTC", with the UTC date when it is not `nowHour`'s day.
export function reopenTime(reopenHour: number, nowHour: number): string {
  const hh = `${String(reopenHour % 24).padStart(2, '0')}:00 UTC`;
  if (Math.floor(reopenHour / 24) === Math.floor(nowHour / 24)) return hh;
  const date = new Date(reopenHour * 3_600_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${hh} on ${date}`;
}
