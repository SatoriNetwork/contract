import React from 'react';
import { InfoTip } from './InfoTip';

// The colour answers ONE question: is this prediction going to earn real weight?
//
//   grey   no streak at all
//   blue   you have a streak, but it is still BELOW the bar
//   green  you are AT or ABOVE the bar — this prediction earns the real band
//
// It used to be a six-step heat ramp keyed to the streak's magnitude (grey/blue/green/
// yellow/orange/red at 0/2/5/9/19+). That looked exciting and told the player nothing
// actionable: green at streak 3 while the bar sat at 4 said "hot" to someone who was
// about to earn a rounding error. Progression is still legible — the BAR FILL grows with
// the streak on the same curve as before — so the two channels now carry two different
// facts instead of competing: length = how far you have come, colour = whether it counts.
const GREY = '#6b7280';   // gray-500  — no streak
const BLUE = '#3b82f6';   // blue-500  — has a streak, but still below the bar
const GREEN = '#22c55e';  // green-500 — at/above the bar, earning

function streakColor(streak: number, bar: number | undefined): string {
  if (streak <= 0) return GREY;
  // With no bar loaded we cannot claim "earning", and colouring it green would be a
  // promise the chain has not made. Fall back to the have-a-streak colour.
  if (bar === undefined) return BLUE;
  return streak >= bar ? GREEN : BLUE;
}

// Fixed streak → fill-% curve: a "barely moved" start, an exciting fast middle,
// then a long slow crawl to a full bar (so a huge streak still has somewhere to
// go). A dot shows at 0.
//   0→dot  1→5  2→10  3→20  4→40  5→50  6→60  7→70  8→75  9→80
//   then +1% per streak (10→81, 11→82, …) capped at 100% (reached at streak 29).
const FILL_TABLE = [0, 5, 10, 20, 40, 50, 60, 70, 75, 80]; // index = streak, 0..9
function streakFillPct(streak: number): number {
  if (streak <= 0) return 0;
  if (streak <= 9) return FILL_TABLE[streak];
  return Math.min(100, 80 + (streak - 9));
}

interface StreakMeterProps {
  /** The user's current streak on the displayed stream's game. */
  streak: number;
  /**
   * The bar for this stream's game — `max(dustFloor, adaptive threshold)`, the streak at
   * or above which a prediction earns real weight. Undefined while it is still loading,
   * which the colour treats as "unknown", never as "earning".
   */
  bar?: number;
  dark?: boolean;
}

/**
 * Compact, full-width streak meter shown just above the predict buttons for the
 * stream about to be predicted — so the player sees exactly what's on the line.
 *
 * Two independent readings: the FILL shows how long the streak is, the COLOUR shows
 * whether it clears the bar. A tick on the track marks where that bar sits, so "how much
 * further" is answerable at a glance rather than only "am I there yet".
 *
 * Wordless AT REST — no copy beyond "Streak" and the two numbers. The colour and the tick
 * carry the message on sight.
 *
 * The bar's actual VALUE is one tap (or hover) away on the track itself, because the tick
 * can say where the bar is but not what it is, and the number is what a player needs to
 * decide whether this prediction is worth making. The tip gives that number and nothing
 * else: where the streak stands relative to it is already on screen twice, as the tick's
 * distance from the fill and as the two numbers either side of the track. That used to be refused on the grounds
 * that "a hover explanation is invisible on touch, which is where most of this is played" —
 * a fair objection, and the reason this uses InfoTip: it opens on TAP as well as hover, the
 * same affordance as the "?" icons everywhere else in the dapp.
 */
export function StreakMeter({ streak, bar, dark = true }: StreakMeterProps) {
  const color = streakColor(streak, bar);
  const pct = streakFillPct(streak);
  const above = bar !== undefined && streak >= bar;
  // Place the tick on the SAME curve as the fill, so its position is honest rather
  // than merely decorative.
  const barPct = bar !== undefined ? streakFillPct(bar) : null;

  const track = (
    <div
      className={`relative w-full h-2 rounded-full ${dark ? 'bg-gray-700/60' : 'bg-gray-200'}`}
      data-testid={barPct !== null ? 'streak-bar-trigger' : undefined}
    >
      {/* Fill: a dot at 0 (minWidth), following the fixed curve toward full. */}
      <div
        className="h-2 rounded-full transition-all duration-300 ease-out"
        style={{ width: `${pct}%`, minWidth: '0.5rem', backgroundColor: color }}
      />
      {/* Bar marker — always shown once the bar is known.
          It used to disappear on clearing the bar, on the theory that a cleared bar is an
          answered question. It is not: the bar is ADAPTIVE and moves with the field, so
          the gap between it and the streak is live information about how much slack there
          is before a loss drops you back under. Behind the fill it needs its own contrast,
          or it disappears into the green it is sitting on. */}
      {barPct !== null && (
        <span
          className="absolute top-[-2px] h-3 w-[2px] rounded-full"
          style={{
            left: `${barPct}%`,
            backgroundColor: above ? 'rgba(17,24,39,0.75)' : (dark ? '#e5e7eb' : '#374151'),
            opacity: above ? 1 : 0.7,
          }}
          data-testid="streak-bar-marker"
        />
      )}
    </div>
  );

  return (
    <div className="flex items-center gap-3 px-1 py-1.5" data-testid="streak-meter">
      <span
        className="text-[11px] font-bold uppercase tracking-wider select-none"
        style={{ color }}
        data-testid="streak-label"
        data-earning={above ? 'true' : 'false'}
      >
        Streak
      </span>
      {barPct !== null ? (
        <InfoTip
          label="What the streak bar is"
          triggerClassName="flex-1 bg-transparent border-0 p-0 m-0 cursor-help"
          trigger={track}
        >
          <div className="font-semibold text-gray-800 dark:text-gray-100 mb-1">
            Bar: <span data-testid="streak-bar-value">{bar}</span>
          </div>
          <p>
            Predictors who have longer streaks earn more. The bar for higher rewards adapts
            to the game&apos;s difficulty.
          </p>
        </InfoTip>
      ) : track}
      <span className="text-lg font-bold tabular-nums w-8 text-right leading-none" style={{ color }}>
        {streak}
      </span>
    </div>
  );
}
