/// Human period labels for a stream's cadence, recorded in MINUTES
/// (`streamMinCadenceMinutes`; the contract floor is 60 — InvalidCadence below
/// that — so Hourly is the shortest legal cadence).
///
/// Labels are derived from the ACTUAL elapsed period (minutes → days), never
/// from magic cadence values, so any legal cadence gets a sensible label:
/// 1440 reads "Daily", 10080 "Weekly", 43200 "Monthly", and a period that
/// doesn't land on a clean calendar term falls back to a concrete duration.

const MINUTES_PER_DAY = 1440;

/// Exact update period for a cadence in minutes (1440 minutes = 1 day).
/// Sub-day cadences read in hours — "0.04 days" helps nobody.
export function formatCadenceDays(minCadenceMinutes: number | undefined): string {
  const minutes = minCadenceMinutes && minCadenceMinutes > 0 ? minCadenceMinutes : 60;
  if (minutes < MINUTES_PER_DAY) {
    const hours = minutes / 60;
    const h = Number.isInteger(hours) ? `${hours}` : hours.toFixed(1);
    return `${h} hour${hours === 1 ? '' : 's'}`;
  }
  const days = minutes / MINUTES_PER_DAY;
  const d = Number.isInteger(days) ? `${days}` : days.toFixed(1);
  return `${d} day${days === 1 ? '' : 's'}`;
}

/// Natural calendar label for a cadence, computed from its real period.
export function formatCadenceLabel(minCadenceMinutes: number | undefined): string {
  const minutes = minCadenceMinutes && minCadenceMinutes > 0 ? minCadenceMinutes : 60;
  if (minutes <= 60) return 'Hourly';
  const days = minutes / MINUTES_PER_DAY;
  const near = (target: number) => Math.abs(days - target) <= target * 0.12;
  if (near(1))     return 'Daily';
  if (near(7))     return 'Weekly';
  if (near(14))    return 'Fortnightly';
  if (near(30.4))  return 'Monthly';
  if (near(60.8))  return 'Bi-monthly';
  if (near(91.3))  return 'Quarterly';
  if (near(182.6)) return 'Semi-annual';
  if (near(365))   return 'Yearly';
  if (days >= 550) {
    const years = days / 365;
    return `${Number.isInteger(years) ? years : years.toFixed(1)} years`;
  }
  if (days < 1) {
    // Between Hourly and Daily without hitting either band: name the hours.
    const hours = minutes / 60;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}-hour`;
  }
  const d = Number.isInteger(days) ? `${days}` : days.toFixed(1);
  return `${d} days`;
}
