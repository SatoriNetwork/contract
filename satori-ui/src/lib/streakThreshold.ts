// The streak-growing threshold, as users are told about it.
//
// NAMING. The contract calls this `farmingThreshold()` and the design doc is
// `docs/design/farming-threshold.md`. Both keep that name — it describes what
// the rule DEFENDS against (streak farming across a fleet of empty wallets).
// But it is a terrible thing to show a player: it names the attack, not the
// effect, and someone seeing it for the first time has no idea what "farming"
// has to do with their balance. **In the UI it is the "streak growing
// threshold" — the amount you need to grow a streak.** Keep the two apart.
//
// ONE COPY, TWO PLACES. The header badge and the dashboard balance both explain
// this, and before 2026-08-21 they said different things: the header never
// mentioned the actual number, so the answer to "how much do I need?" was
// simply absent from the place people tap first. Both now build their text
// here.
//
// WHAT IS ACTUALLY COMPARED. Not the balance on screen. `useFarmingThreshold`
// tests prediction POWER — balance plus unclaimed rewards plus delegated-in — so
// somebody with an empty wallet and a pile of unclaimed winnings is above the
// line and must not be told they are under it. The copy below therefore states
// what they HAVE from `power`, never from the displayed balance.

/// The threshold sits well under 1 SATORI for the first year, so the ordinary
/// one-decimal balance format renders it "0.0" and tells the reader nothing.
export function formatThresholdAmount(wei: bigint): string {
  const n = Number(wei) / 1e18;
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(2);
}

/// Short label for the badge / tooltip trigger. Plain, and not an accusation.
export const STREAK_THRESHOLD_LABEL = "Below the streak growing threshold";

/// The numbers line: what you need, and what you have. Returns null while
/// either read is still loading, so the caller can omit it rather than print
/// a half-sentence.
export function streakThresholdFigures(
  threshold: bigint | null,
  power: bigint | null,
): { need: string; have: string } | null {
  if (threshold == null || power == null) return null;
  return { need: formatThresholdAmount(threshold), have: formatThresholdAmount(power) };
}
