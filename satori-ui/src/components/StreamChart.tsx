import React, { useMemo, useState } from 'react';
import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { formatCompact } from '../utils/format';
import { formatCadenceLabel, formatCadenceDays } from '../utils/cadence';
import { InfoTip } from './InfoTip';
import { formatStreamValue, type StreamValueDisplay } from '../lib/streamAdapterUI';
import { orientationOf, displayValueOf, formatOrientedPrice } from '../lib/streamOrientation';
import { valueTicks } from '../lib/axisTicks';
import { hourLabel } from '../lib/hourAxis';
import { leanAt } from '../lib/leanFormat';
import { formatTargetDuration } from './PredictionButtons';

// PLOT-AREA INSETS, in px: the price axis on the left, the chart margin on the
// right. Recharts is handed both.
const Y_AXIS_WIDTH = 45;
const PLOT_MARGIN_RIGHT = 20;

/// Milliseconds per registry hour — the ring is HOUR-keyed (timestamp / 3600),
/// so every date on this chart is plain 3600000-ms arithmetic off an absolute
/// hour number.
const HOUR_MS = 3_600_000;

/// Shape consumed by the chart. Rows are HOUR-keyed: `hour` is the absolute
/// hour (timestamp / 3600) the value was stamped, straight from the registry's
/// 768-slot ring via useStreamDetail. The optional `up`/`down` values (total
/// prediction POWER backing each direction, not a headcount) are filled in by
/// `useStreamDetail`'s PredictionMade event scan when a single stream is in
/// focus; that scan is GAME-keyed (it filters PredictionMade on the stream's
/// 1:1 binary gameId), but the resulting sentiment is attached to this
/// stream-primary shape. When the counts are absent (or zero), the chart's
/// `hasCounts` check short-circuits the sentiment overlay and only the price
/// line renders.
export interface ChartStream {
  id: number;        // streamId (display id) — the chart is stream-primary
  name: string;
  isEligible: boolean; // derived from the stream's binary game eligibility
  minCadenceMinutes?: number; // update cadence in MINUTES; drives the cadence badge
  // The value is the network's own signed prediction flow (useStreamList
  // stamps it from registry.namedAdapterId). Plotted for its shape; never
  // printed as a number anywhere — header, axis or tooltip. See lib/leanFormat.
  isNamed?: boolean;
  // Ring entry before history[0], if any (useStreamDetail loads one extra), so
  // the window's first point is read against its real predecessor.
  prevOfFirst?: number;
  history: { value: number; hour: number; up?: number; down?: number; upCount?: number; downCount?: number }[];
}

interface StreamChartProps {
  stream: ChartStream;
  height?: number;
  isFavorite?: boolean;
  onToggleFavorite?: () => void;
  dark?: boolean;
  // Optional descriptor-resolved value display (decimals/unit/label) for this
  // stream's adapter. When present, axis ticks / tooltip / header value render
  // through formatStreamValue; when null (Simple stream or no descriptor) the
  // chart keeps its existing raw formatCompact rendering — no regression.
  valueDisplay?: StreamValueDisplay | null;
  /// The game's advertised duration in MINUTES (GameMeta.targetMinutes; 1440 =
  /// the default "higher or lower 24 hours from your moment?" game). The
  /// tooltip uses it to say what a prediction is actually scored against: the
  /// first sample at least this long after the moment predicted. Defaults to
  /// the 24-hour game when not loaded yet.
  targetMinutes?: number;
  // What this stream's number MEANS, when that is not self-evident. The default
  // stream is the case in point: its value at round N is the previous round's
  // deployed-capital share, so it necessarily trails by a round, and without
  // saying so the chart looks like it is lagging or mislabelled. Shown as a hover
  // note on the reading.
  valueNote?: string;
  // Plain-language "what is this stream?" line, shown by tapping the name. See
  // lib/streamDescription.ts. Optional — no description, no affordance.
  description?: string;
}

export function StreamChart({ stream, height = 320, isFavorite, onToggleFavorite, dark = true, valueDisplay = null, targetMinutes, valueNote, description }: StreamChartProps) {
  // Render a raw numeric value through the resolved display when available,
  // otherwise fall back to the existing compact formatting.
  const formatValue = (v: number) =>
    valueDisplay ? formatStreamValue(v, valueDisplay) : formatCompact(v);

  // ORIENTATION. For a Uniswap tick stream whose readable quote runs opposite the
  // tick, everything the reader sees has to flip together: the plotted line, the
  // axis, the header number, the sentiment bars, and the buttons (flipped where a
  // press is submitted). They all read this one flag.
  const orient = useMemo(() => orientationOf(valueDisplay), [valueDisplay]);

  // Numbers that have ALREADY been through displayValueOf — the plotted line, the
  // axis ticks, the header. formatValue must not touch these: it would convert a
  // tick a second time and produce nonsense.
  const formatPlotted = (v: number) =>
    orient.isTick ? formatOrientedPrice(v) : formatValue(v);

  // A point-over-point delta in display units. Same formatting as a reading now
  // that the price formatter emits a bare number.
  const formatDelta = (v: number) =>
    orient.isTick ? formatOrientedPrice(v) : formatValue(v);

  // The sentiment bars show ONE metric at a time, switched by the toggle:
  // 'power' = total prediction power backing each side, 'count' = headcount of
  // predictors. Same bar style for both; flipping the toggle changes the bar
  // values, and recharts' own (efficient) bar animation tweens each bar from its
  // old height to the new one.
  const [metric, setMetric] = useState<'power' | 'count'>('power');

  // Diverging bars are built as an all-positive 3-segment stack: a transparent
  // spacer up to the centre line, then the red (down) bar hanging below centre,
  // then the green (up) bar sitting above it. All values are positive, so we
  // dodge recharts' broken mixed-sign stacking (which rendered red over green),
  // while still getting recharts' native, glitch-free tween animation.
  // The (hidden) counts axis is [0, 2.5*max]; the centre sits at 1.25*max, so the
  // tallest bar reaches ~40% of the chart height on its side (matching the old look).

  // The stream's own first known hour anchors the relative axis labels ("1",
  // "2", ...) — see lib/hourAxis.ts, the one shared copy of that rule.
  const firstHour = stream.history.length > 0 ? stream.history[0].hour : undefined;

  // The stream's cadence in whole hours, for calling out gaps: a stored point
  // further than one cadence period from its predecessor means the stream
  // skipped updates, and on a point-indexed axis those hours are collapsed.
  const cadenceHours = Math.max(1, Math.round((stream.minCadenceMinutes ?? 1440) / 60));

  const { chartData, countDomain, lastRow, prevRow } = useMemo(() => {
    const rows = stream.history.map((h, i) => {
      // Plot the DISPLAYED number, not the raw tick. A line drawn from ticks
      // under axis labels showing an inverted price would climb as the numbers
      // fell.
      const plotted = displayValueOf(h.value, valueDisplay) ?? h.value;
      // Swap the sides when inverted: power that backed a rising TICK backed a
      // FALLING displayed price, so it belongs on the other side of the centre
      // line to match what the reader sees.
      const rawUp = h.up ?? 0, rawDown = h.down ?? 0;
      const rawUpC = h.upCount ?? 0, rawDownC = h.downCount ?? 0;
      const up = orient.inverted ? rawDown : rawUp;
      const down = orient.inverted ? rawUp : rawDown;
      const upCount = orient.inverted ? rawDownC : rawUpC;
      const downCount = orient.inverted ? rawUpC : rawDownC;
      const hasPred = upCount > 0 || downCount > 0;
      return {
        index: i,
        value: plotted,
        up, down,             // total prediction power per side
        upCount, downCount,   // number of predictions per side
        // Active metric per side — these drive the bar heights.
        barUp: metric === 'power' ? up : upCount,
        barDown: metric === 'power' ? down : downCount,
        hasPred,
        hour: h.hour, // absolute registry hour (kept for the tooltip date math)
        // Hours between this point and the previous stored one. The X axis is
        // indexed by POINT, not by hour, so a quiet stretch is collapsed and
        // two bars can look adjacent while being days apart. Surfaced in the
        // tooltip (when the gap exceeds the cadence) rather than by re-spacing
        // the axis, which would mean rebuilding the diverging-bar stack.
        gapHours: i > 0 ? h.hour - stream.history[i - 1].hour : 0,
        // Relative hour label (1, 2, 3, ...) via the shared hour-axis rule.
        label: hourLabel(h.hour, firstHour as number),
      };
    });
    const max = rows.reduce((m, r) => Math.max(m, r.barUp, r.barDown), 0) || 1;
    const mid = 1.25 * max;
    // Sub-pixel floor: every coloured segment gets a tiny nonzero value instead of
    // exactly 0, so it always has real geometry — recharts then tweens each in
    // place rather than sliding a segment that was exactly 0. eps is ~0.1% of max,
    // invisible at any real scale.
    const eps = max * 1e-3;
    const data = rows.map((r) => {
      // One stack per point: matched (both sides agree) is the faint full-total
      // backdrop at the tips; margin (winner's net excess) is the stronger bar
      // hugging the centre. Each side's matched + margin = its full total.
      const matched = r.hasPred ? Math.max(eps, Math.min(r.barUp, r.barDown)) : 0;
      const marginUp = r.hasPred ? Math.max(eps, r.barUp - r.barDown) : 0;
      const marginDown = r.hasPred ? Math.max(eps, r.barDown - r.barUp) : 0;
      return {
        ...r,
        // Transparent spacer lifts the stack so the down side's top lands on centre.
        // Skip it for points with no predictions (avoids an invisible hover target).
        padDown: r.hasPred ? mid - r.barDown : 0,
        matchedDown: matched,
        matchedUp: matched,
        marginUp,
        marginDown,
      };
    });

    return {
      chartData: data,
      countDomain: [0, 2.5 * max] as [number, number],
      lastRow: data[data.length - 1],
      prevRow: data[data.length - 2],
    };
  }, [stream.history, metric, firstHour, valueDisplay, orient]);

  // Everything below reads chartData, NOT stream.history, so the header number,
  // the percentage change, the axis domain and the sentiment summary are all in
  // the same orientation as the line. Taken from the raw history instead, an
  // inverted stream would show the axis of one price and the change of its
  // reciprocal — a green +2% beside a falling line.
  const lastValue = lastRow?.value;
  const prevValue = prevRow?.value;
  const change = lastValue != null && prevValue != null ? lastValue - prevValue : 0;
  const changePct = prevValue ? ((change / Math.abs(prevValue)) * 100).toFixed(2) : '0.00';
  const named = !!stream.isNamed;

  const values = chartData
    .map((r) => r.value)
    .filter((v): v is number => v != null);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const padding = (maxVal - minVal) * 0.1 || 1;
  // Label the DATA, not the padded frame. The 10% domain padding stays — it
  // keeps the line off the edge — but ticks at its endpoints named values the
  // series never took (an axis reading -0.1 and 1.1 for a 0/1 prediction
  // count). See lib/axisTicks.ts.
  const yTicks = valueTicks(values as number[], lastValue as number | undefined);

  // Check if any prediction counts exist
  const hasCounts = stream.history.some((h) => (h.up ?? 0) > 0 || (h.down ?? 0) > 0);

  // Newest-point sentiment — from the last chart row, so the sides are already
  // swapped for an inverted stream and agree with the bar above them.
  const currentUp = (lastRow?.up ?? 0);
  const currentDown = (lastRow?.down ?? 0);
  const currentUpCount = (lastRow?.upCount ?? 0);
  const currentDownCount = (lastRow?.downCount ?? 0);

  const hasHistory = stream.history.length > 0;

  // Shift each bar right by half its own width so a point's predictions sit just
  // AFTER the value they were made on — they call a FUTURE sample, so they line
  // up toward the future rather than centred on the current value. Uses recharts'
  // (animated) x/width, so the native tween is preserved.
  const shiftHalf = (props: any) => {
    const { x, y, width, height, fill, fillOpacity } = props;
    return <rect x={x + width / 2} y={y} width={width} height={height} fill={fill} fillOpacity={fillOpacity} />;
  };

  /// Absolute registry hour -> Date, anchored on "the current hour is now".
  const hourToDate = (absHour: number): Date => {
    const now = Date.now();
    const currentHour = Math.floor(now / HOUR_MS);
    return new Date(now + (absHour - currentHour) * HOUR_MS);
  };

  // X-axis tick -> date string. The tick value is the relative hour label;
  // rebuild the absolute hour, then map it to a date with 3600000-ms math. A
  // sub-day cadence gets the hour too — several of its points share a date.
  const hourDateLabel = (label: any) => {
    const elapsed = Number(label);
    if (!Number.isFinite(elapsed)) return label;
    const absHour = firstHour != null ? elapsed + firstHour - 1 : elapsed;
    const d = hourToDate(absHour);
    return (stream.minCadenceMinutes ?? 1440) < 1440
      ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const colors = dark
    ? { grid: '#2E2E2E', axis: '#6E6E6E', tick: '#9A9A9A', tooltipBg: '#1C1C1C', tooltipBorder: '#2E2E2E', tooltipText: '#F1F1F1', activeDotStroke: '#1C1C1C' }
    : { grid: '#E5E7EB', axis: '#9A9A9A', tick: '#6E6E6E', tooltipBg: '#ffffff', tooltipBorder: '#E5E7EB', tooltipText: '#121212', activeDotStroke: '#ffffff' };

  return (
    <div
      className={`p-4 ${dark ? 'bg-gray-800 border border-gray-700 rounded-lg' : 'bg-white border border-gray-100 rounded-xl shadow-lg'}`}
      data-testid="stream-chart"
    >
      {/* Chart header */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex flex-col gap-1 min-w-0 sm:flex-row sm:items-center sm:gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {onToggleFavorite && (
              <button
                onClick={onToggleFavorite}
                className="text-xl leading-none"
                data-testid="btn-favorite"
                aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
              >
                {isFavorite ? (
                  <span className="text-yellow-500">&#9733;</span>
                ) : (
                  <span className={`${dark ? 'text-gray-500' : 'text-gray-300'} hover:text-yellow-500`}>&#9734;</span>
                )}
              </button>
            )}
            {description ? (
              <InfoTip
                label="What this stream is"
                triggerClassName={`inline-flex items-center align-middle p-0 m-0 bg-transparent border-0 cursor-help font-medium underline decoration-dotted decoration-1 underline-offset-4 ${dark ? 'text-white decoration-gray-500' : 'text-gray-900 decoration-gray-400'}`}
                trigger={<span data-testid="stream-name">{stream.name}</span>}
              >
                {description}
              </InfoTip>
            ) : (
              <h3 className={`font-medium ${dark ? 'text-white' : 'text-gray-900'}`} data-testid="stream-name">
                {stream.name}
              </h3>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xs px-1.5 py-0.5 rounded ${dark ? 'text-gray-400 bg-gray-700' : 'text-gray-400 bg-gray-100'}`}>#{stream.id}</span>
            {stream.minCadenceMinutes != null && (
              <InfoTip
                trigger={
                  <span
                    className={`text-xs px-1.5 py-0.5 rounded ${dark ? 'text-purple-300 bg-purple-900/30' : 'text-purple-700 bg-purple-100'}`}
                  >
                    {formatCadenceLabel(stream.minCadenceMinutes)}
                  </span>
                }
              >
                Updates every {formatCadenceDays(stream.minCadenceMinutes)}
              </InfoTip>
            )}
            {named && (
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${dark ? 'text-pink-300 bg-pink-900/30' : 'text-pink-700 bg-pink-100'}`}
                title="A stream that is just a name: its value is the network's own prediction flow, shown as a shape, never a number."
                data-testid="stream-named-badge"
              >
                named
              </span>
            )}
            {stream.isEligible ? (
              <span className={`text-xs px-1.5 py-0.5 rounded ${dark ? 'text-green-400 bg-green-900/30' : 'text-green-700 bg-green-100'}`} title="This data stream rewards predictors because it's been voted up high enough.">rewarding</span>
            ) : (
              <span className={`text-xs px-1.5 py-0.5 rounded ${dark ? 'text-gray-500 bg-gray-700' : 'text-gray-500 bg-gray-100'}`} title="This data stream doesn't reward predictors yet because it hasn't been voted up high enough.">not rewarding</span>
            )}
            {/* What the reading MEANS — with the id and the badges, which is where
                a reader already looks to find out what this stream IS. Only
                streams with a note carry it, which today is the default
                predictions stream alone. */}
            {valueNote && (
              <InfoTip label="What this counts">{valueNote}</InfoTip>
            )}
          </div>
        </div>
        <div className="flex flex-col items-end sm:flex-row sm:items-center sm:gap-2">
          <span className={`text-2xl font-bold ${dark ? 'text-white' : 'text-gray-900'}`} data-testid="stream-value">
            {lastValue == null ? '—' : named ? leanAt(chartData, chartData.length - 1, stream.prevOfFirst) : formatPlotted(lastValue)}
          </span>
          {/* The unit sits BESIDE the reading, not inside it — a value is a number.
              Only tick streams have one to show; everything else already carries
              its unit in the descriptor's own label. */}
          {orient.unitLabel && (
            <span
              className={`text-xs ${dark ? 'text-gray-400' : 'text-gray-500'}`}
              data-testid="stream-value-unit"
            >
              {orient.unitLabel}
            </span>
          )}
          {prevValue != null && (
            <span
              className={`text-sm font-medium ${change >= 0 ? 'text-green-600' : 'text-red-600'}`}
              data-testid="stream-change"
            >
              {named ? 'vs last hour' : <>{change >= 0 ? '+' : ''}{formatDelta(change)} ({changePct}%)</>}
            </span>
          )}
        </div>
      </div>

      {/* Newest-point sentiment (selected metric) + the Power/Count toggle. */}
      {hasCounts && (
        <div className="flex items-center justify-between gap-2 mb-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-green-500 font-medium">
              {metric === 'power' ? formatCompact(currentUp) : currentUpCount} UP
            </span>
            <span className={dark ? 'text-gray-600' : 'text-gray-300'}>|</span>
            <span className="text-red-500 font-medium">
              {metric === 'power' ? formatCompact(currentDown) : currentDownCount} DOWN
            </span>
          </div>
          <div
            className={`flex items-center rounded-md overflow-hidden border text-[11px] font-medium ${dark ? 'border-gray-600' : 'border-gray-300'}`}
            data-testid="chart-metric-toggle"
            role="group"
            aria-label="Bars show prediction power or predictor count"
          >
            <button
              onClick={() => setMetric('power')}
              className={`px-2 py-0.5 transition-colors ${metric === 'power' ? 'bg-blue-600 text-white' : dark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'}`}
              data-testid="metric-power"
            >
              Power
            </button>
            <button
              onClick={() => setMetric('count')}
              className={`px-2 py-0.5 transition-colors ${metric === 'count' ? 'bg-blue-600 text-white' : dark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'}`}
              data-testid="metric-count"
            >
              Count
            </button>
          </div>
        </div>
      )}

      {/* Chart. No shaded horizon band and no reserved future slots any more:
          a prediction's target is a KNOWN duration (the game's targetMinutes)
          from a KNOWN anchor (the moment predicted), so there is no region of
          the chart to point at — the tooltip and the buttons carry the rule in
          words instead. */}
      {hasHistory ? (
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={chartData} margin={{ top: 5, right: PLOT_MARGIN_RIGHT, bottom: 5, left: 0 }} barCategoryGap="4%">
            <XAxis
              dataKey="label"
              stroke={colors.axis}
              fontSize={11}
              tick={{ fill: colors.tick }}
              tickFormatter={hourDateLabel}
              interval="preserveStartEnd"
            />
            {/* Left Y axis: price */}
            <YAxis
              yAxisId="price"
              domain={[minVal - padding, maxVal + padding]}
              ticks={yTicks.length ? yTicks : undefined}
              stroke={colors.axis}
              fontSize={11}
              tick={named ? false : { fill: colors.tick }}
              tickFormatter={formatPlotted}
              label={named ? { value: 'network lean', angle: -90, position: 'insideLeft', fill: colors.tick, fontSize: 11 } : undefined}
              width={Y_AXIS_WIDTH}
            />
            {/* Right Y axis: prediction sentiment bars (hidden, centre at 1.25*max) */}
            {hasCounts && (
              <YAxis
                yAxisId="counts"
                orientation="right"
                domain={countDomain}
                hide
              />
            )}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const data = payload[0]?.payload;
                if (!data) return null;

                // data.hour is the absolute registry hour; the date is plain
                // 3600000-ms arithmetic off it.
                const date = hourToDate(data.hour ?? 0);
                const dateStr = (stream.minCadenceMinutes ?? 1440) < 1440
                  ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
                  : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

                const upVal = data.up || 0;
                const downVal = data.down || 0;
                const upCnt = data.upCount || 0;
                const downCnt = data.downCount || 0;
                const total = upVal + downVal;
                const hasVotes = total > 0;
                const sentimentPct = hasVotes ? Math.round(((upVal - downVal) / total) * 100) : 0;

                return (
                  <div style={{
                    backgroundColor: colors.tooltipBg,
                    border: `1px solid ${colors.tooltipBorder}`,
                    borderRadius: '8px',
                    color: colors.tooltipText,
                    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                    padding: '8px 12px',
                    fontSize: '13px',
                    maxWidth: 260,
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{dateStr}</div>
                    {data.value != null && (
                      <div>
                        {named
                          ? <>Lean: {leanAt(chartData, data.index, stream.prevOfFirst)}</>
                          : <>Value: {formatPlotted(data.value)}</>}
                      </div>
                    )}
                    {data.gapHours > cadenceHours && (
                      <div style={{ opacity: 0.75, marginTop: 2 }}>
                        no update for {data.gapHours >= 48
                          ? `${Math.round(data.gapHours / 24)} days`
                          : `${data.gapHours} hours`} before this
                      </div>
                    )}
                    {hasVotes && (
                      <>
                        <div style={{ marginTop: 4 }}>
                          <span style={{ color: '#22c55e', fontWeight: 700, fontSize: '18px' }}>&#9650;</span>
                          <span style={{ color: '#22c55e', fontWeight: 600, marginLeft: 4 }}>{formatCompact(upVal)}</span>
                          <span style={{ color: '#22c55e', opacity: 0.7, marginLeft: 6 }}>{upCnt} {upCnt === 1 ? 'predictor' : 'predictors'}</span>
                        </div>
                        <div>
                          <span style={{ color: '#ef4444', fontWeight: 700, fontSize: '18px' }}>&#9660;</span>
                          <span style={{ color: '#ef4444', fontWeight: 600, marginLeft: 4 }}>{formatCompact(downVal)}</span>
                          <span style={{ color: '#ef4444', opacity: 0.7, marginLeft: 6 }}>{downCnt} {downCnt === 1 ? 'predictor' : 'predictors'}</span>
                        </div>
                        <div style={{
                          color: sentimentPct >= 0 ? '#22c55e' : '#ef4444',
                          fontWeight: 600,
                        }}>
                          Sentiment: {sentimentPct >= 0 ? '+' : ''}{sentimentPct}% by power
                        </div>
                      </>
                    )}
                    {/* The game's target framing: what a prediction from this
                        moment is actually measured against. A known duration
                        from a known anchor — no shaded region to point at. */}
                    <div style={{ opacity: 0.7, marginTop: 4 }}>
                      A prediction here is scored against the first sample
                      &ge; {formatTargetDuration(targetMinutes)} from here.
                    </div>
                  </div>
                );
              }}
            />
            {/* One stack per point (bottom -> top): spacer, matched-down (faint
                tip), margin-down (centre), margin-up (centre), matched-up (faint
                tip). A single stack means perfect alignment AND the bars auto-size
                to fill their band at any screen width (no fixed barSize). Every
                coloured segment is eps-floored so it always has geometry and tweens
                in place on a toggle. Margin (net difference) is the stronger centre
                bar; the faint matched is the full power/count backdrop. */}
            {hasCounts && (
              <Bar yAxisId="counts" dataKey="padDown" stackId="sentiment" fill="transparent" stroke="none" shape={shiftHalf} isAnimationActive animationDuration={400} animationEasing="ease-out" />
            )}
            {hasCounts && (
              <Bar yAxisId="counts" dataKey="matchedDown" stackId="sentiment" fill={dark ? '#dc2626' : '#fca5a5'} fillOpacity={dark ? 0.14 : 0.28} shape={shiftHalf} isAnimationActive animationDuration={400} animationEasing="ease-out" />
            )}
            {hasCounts && (
              <Bar yAxisId="counts" dataKey="marginDown" stackId="sentiment" fill="#dc2626" fillOpacity={dark ? 0.35 : 0.6} shape={shiftHalf} isAnimationActive animationDuration={400} animationEasing="ease-out" />
            )}
            {hasCounts && (
              <Bar yAxisId="counts" dataKey="marginUp" stackId="sentiment" fill="#16a34a" fillOpacity={dark ? 0.35 : 0.6} shape={shiftHalf} isAnimationActive animationDuration={400} animationEasing="ease-out" />
            )}
            {hasCounts && (
              <Bar yAxisId="counts" dataKey="matchedUp" stackId="sentiment" fill={dark ? '#16a34a' : '#86efac'} fillOpacity={dark ? 0.14 : 0.28} shape={shiftHalf} isAnimationActive animationDuration={400} animationEasing="ease-out" />
            )}
            {/* Price line on top */}
            <Line
              yAxisId="price"
              type="monotone"
              dataKey="value"
              stroke={dark ? '#6AAFE6' : '#4A90E2'}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: dark ? '#6AAFE6' : '#4A90E2', stroke: colors.activeDotStroke, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      ) : (
        <div className="flex items-center justify-center text-gray-400" style={{ height }}>
          No history data yet
        </div>
      )}

    </div>
  );
}
