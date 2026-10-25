import React, { useState, useCallback } from 'react';

// Direction encoding matches the on-chain prediction payload byte:
//   1 = UP / YES, 2 = DOWN / NO.
// The flow stays stream-keyed (stream<->game is 1:1); App.tsx resolves the
// streamId to its gameId and packs `direction` into the 1-byte payload at
// submit time via predictMultipleWithPayloads.
/// The game's advertised question horizon, phrased for a human. 1440 is the
/// default game — "higher or lower 24 hours from your moment?" — so it reads
/// "24 hours", not "1 day"; longer horizons read in days.
export function formatTargetDuration(targetMinutes: number | undefined): string {
  const m = targetMinutes && targetMinutes > 0 ? targetMinutes : 1440;
  if (m === 1440) return '24 hours';
  if (m % 1440 === 0) return `${m / 1440} days`;
  if (m % 60 === 0) {
    const h = m / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }
  return `${m} minutes`;
}

interface PredictionButtonsProps {
  streamId: number;
  onPredict: (streamId: number, direction: number) => void;
  onSkip: () => void;
  onSubmitNow?: () => void;
  disabled?: boolean;
  existingPrediction?: { direction: number };
  canGoBack?: boolean;
  onBack?: () => void;
  predictionsCount?: number;
  dark?: boolean;
  /// The game's advertised duration in MINUTES (GameMeta.targetMinutes). The
  /// prediction's target is a KNOWN duration from a KNOWN anchor — the moment
  /// you predict — so the sub-label asks the game's actual question: "Higher in
  /// 24 hours?" (the 1440 default), "Higher in 7 days?", and so on. Defaults to
  /// the 24-hour game when not loaded yet.
  targetMinutes?: number;
}

export function PredictionButtons({
  streamId,
  onPredict,
  onSkip,
  onSubmitNow,
  disabled,
  existingPrediction,
  canGoBack,
  onBack,
  predictionsCount,
  dark = true,
  targetMinutes,
}: PredictionButtonsProps) {
  const predicted = existingPrediction?.direction;
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);

  // The sub-label keeps the button's own green/red — there is no shaded region
  // on the chart to point at any more, so no other colour belongs in here.
  const noteClass = (pressed: boolean, side: 'up' | 'down') => {
    if (side === 'up') return pressed ? 'text-green-100' : dark ? 'text-green-500' : 'text-green-600';
    return pressed ? 'text-red-100' : dark ? 'text-red-500' : 'text-red-600';
  };

  /// The sub-label is the game's ADVERTISED question. The scored move runs from
  /// the value at the moment you predict to the first sample at least
  /// `targetMinutes` later — except on a stream posting at least daily with a
  /// target under 24 cadences, which resolves on the next two samples (about
  /// 1-2 cadences), whatever duration is advertised.
  const note = (side: 'up' | 'down') =>
    `${side === 'up' ? 'Higher' : 'Lower'} in ${formatTargetDuration(targetMinutes)}?`;

  const handlePredict = useCallback((direction: number) => {
    setFlash(direction === 1 ? 'up' : 'down');
    setTimeout(() => {
      onPredict(streamId, direction);
      setFlash(null);
    }, 150);
  }, [streamId, onPredict]);

  return (
    <div data-testid="prediction-buttons">
      {/* Layout: back/skip on left, UP/DOWN stacked on right */}
      <div className="flex items-center gap-3">
        {/* Left: Back + Skip */}
        <div className="flex flex-col gap-2 min-w-[80px]">
          {canGoBack ? (
            <button
              onClick={onBack}
              className="text-sm text-gray-400 hover:text-gray-300 transition-colors text-left"
              data-testid="btn-back"
            >
              &larr; Back
            </button>
          ) : <span />}
          <button
            onClick={onSkip}
            disabled={disabled}
            className="text-sm text-gray-400 hover:text-gray-300 transition-colors text-left
              disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid="btn-skip"
          >
            Skip &rarr;
          </button>
        </div>

        {/* Right: UP above DOWN */}
        <div className="flex-1 flex flex-col gap-2">
          {/* UP */}
          <button
            onClick={() => handlePredict(1)}
            disabled={disabled}
            className={`flex items-center justify-center px-4 py-4 border-2 rounded-lg transition-all active:scale-95 group
              ${flash === 'up'
                ? 'bg-green-600 border-green-600 text-white scale-95'
                : predicted === 1
                  ? 'bg-green-600 border-green-600 text-white'
                  : dark
                    ? 'bg-green-600/20 hover:bg-green-600/30 border-green-600/40 hover:border-green-500'
                    : 'bg-green-50 hover:bg-green-100 border-green-200 hover:border-green-300'
              }
              disabled:opacity-40 disabled:cursor-not-allowed`}
            data-testid="btn-up"
          >
            <svg className={`h-6 w-6 mr-2 transition-transform group-hover:scale-110
              ${flash === 'up' || predicted === 1 ? 'text-white' : 'text-green-500'}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
            <div className="text-left">
              <div className={`font-semibold ${flash === 'up' || predicted === 1 ? 'text-white' : dark ? 'text-green-400' : 'text-green-800'}`}>UP</div>
              <div className={`text-xs ${noteClass(flash === 'up' || predicted === 1, 'up')}`} data-testid="btn-up-note">{note('up')}</div>
            </div>
          </button>

          {/* DOWN */}
          <button
            onClick={() => handlePredict(2)}
            disabled={disabled}
            className={`flex items-center justify-center px-4 py-4 border-2 rounded-lg transition-all active:scale-95 group
              ${flash === 'down'
                ? 'bg-red-600 border-red-600 text-white scale-95'
                : predicted === 2
                  ? 'bg-red-600 border-red-600 text-white'
                  : dark
                    ? 'bg-red-600/20 hover:bg-red-600/30 border-red-600/40 hover:border-red-500'
                    : 'bg-red-50 hover:bg-red-100 border-red-200 hover:border-red-300'
              }
              disabled:opacity-40 disabled:cursor-not-allowed`}
            data-testid="btn-down"
          >
            <svg className={`h-6 w-6 mr-2 transition-transform group-hover:scale-110
              ${flash === 'down' || predicted === 2 ? 'text-white' : 'text-red-500'}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
            <div className="text-left">
              <div className={`font-semibold ${flash === 'down' || predicted === 2 ? 'text-white' : dark ? 'text-red-400' : 'text-red-800'}`}>DOWN</div>
              <div className={`text-xs ${noteClass(flash === 'down' || predicted === 2, 'down')}`} data-testid="btn-down-note">{note('down')}</div>
            </div>
          </button>
        </div>
      </div>

      {/* Submit below — space opens smoothly, then button fades in */}
      {onSubmitNow && (
        <div
          style={{
            maxHeight: predictionsCount && predictionsCount > 0 ? 60 : 0,
            marginTop: predictionsCount && predictionsCount > 0 ? 12 : 0,
            overflow: 'hidden',
            transition: 'max-height 0.25s ease-out, margin-top 0.25s ease-out',
          }}
        >
          <button
            onClick={onSubmitNow}
            className="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg transition-colors"
            data-testid="btn-submit-early"
            style={{
              opacity: predictionsCount && predictionsCount > 0 ? 1 : 0,
              transition: 'opacity 0.2s ease-out 0.15s',
            }}
          >
            Submit {predictionsCount} Prediction{predictionsCount !== 1 ? 's' : ''}
          </button>
        </div>
      )}
    </div>
  );
}
