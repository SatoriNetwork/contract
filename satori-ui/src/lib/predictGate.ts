import type { StreamBasic } from '../hooks/useStreamList';
import type { PredictionResult } from '../hooks/useDashboard';

export interface PredictGate {
  active: boolean;
  /// Inactive stream: the clock hour it takes this address's next call.
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
///     as stale). Not applied to a Sentiment stream, the default stream included
///     (predict's own pull writes it once the hour advances).
///   - DuplicatePrediction: once per round.
///   - The once-per-target-period wait of targetMinutes > 1440 games is not
///     mirrored.
export function predictGate(
  streamId: number,
  stream: Pick<StreamBasic, 'valueHour' | 'isNamed'> | undefined,
  last: Pick<PredictionResult, 'roundMade'> | undefined,
  currentRound: number | null,
): PredictGate {
  if (!stream) return { active: true };
  if (!stream.isNamed && stream.valueHour <= 0) return { active: false };
  if (!last) return { active: true };
  if (currentRound != null && last.roundMade === currentRound) return { active: false, reopenHour: (currentRound + 1) * 24 };
  if (stream.isNamed) return { active: true };
  return { active: Math.floor(stream.valueHour / 24) > last.roundMade };
}

/// "14:00 UTC", with the UTC date when it is not `nowHour`'s day.
export function reopenTime(reopenHour: number, nowHour: number): string {
  const hh = `${String(reopenHour % 24).padStart(2, '0')}:00 UTC`;
  if (Math.floor(reopenHour / 24) === Math.floor(nowHour / 24)) return hh;
  const date = new Date(reopenHour * 3_600_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${hh} on ${date}`;
}
