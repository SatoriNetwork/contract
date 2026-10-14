// Labels for the chart's hour axis.
//
// The registry ring is HOUR-keyed now: getHistory stamps (and StreamValueUpdated's
// last argument) are absolute hours, `timestamp / 3600`. The chart's X axis is
// categorical and its categories ARE these strings, so every producer of a
// category — real history rows, reserved future slots, band anchors — has to
// label by the identical rule or a point lands in its own category and anchors
// to nothing. This is the one shared copy, for exactly that reason; it replaces
// the round-keyed `roundLabel` that lived in predictionHorizon.ts.

/// Relative index label: the stream's first known hour is "1", each later hour
/// counts up from there. Falls back to the absolute hour if the first hour is
/// somehow unknown at a call site — same rule roundLabel had.
export function hourLabel(absHour: number, firstHour: number): string {
  return firstHour != null ? `${absHour - firstHour + 1}` : `${absHour}`;
}
