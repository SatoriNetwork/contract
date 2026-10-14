import React from 'react';

// Stream-primary progress bar for the prediction flow. The UI walks the user
// through STREAMS (each backed by exactly one binary game), so the counts here
// are genuinely stream counts, not game counts — the "Stream X / Y" label is
// correct under the 1:1 stream<->game model and is intentionally left as-is.
interface StreamProgressProps {
  currentIndex: number;
  totalStreams: number;
  predictionsCount: number;
  atMaxPredictions: boolean;
  maxPredictions: number;
  // Step through the list from the bar itself (in addition to the skip button
  // below). Previous = back one in the list; next = skip forward one. Each arrow
  // is hidden (kept in layout) at the corresponding end of the list.
  onPrevious?: () => void;
  onNext?: () => void;
}

export function StreamProgress({
  currentIndex,
  totalStreams,
  predictionsCount,
  atMaxPredictions,
  maxPredictions,
  onPrevious,
  onNext,
}: StreamProgressProps) {
  const progress = totalStreams > 0 ? ((currentIndex) / totalStreams) * 100 : 0;
  const canBack = currentIndex > 0;
  const canForward = currentIndex < totalStreams - 1;
  const arrowCls =
    'text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-base leading-none px-0.5 select-none transition-colors';

  return (
    <div className="flex items-center gap-2 text-sm" data-testid="stream-progress">
      <span className="text-gray-500 whitespace-nowrap">
        Stream{' '}
        <span className="font-medium text-gray-900 dark:text-white">{Math.min(currentIndex + 1, totalStreams)}</span>
        {' / '}
        <span className="font-medium text-gray-900 dark:text-white">{totalStreams}</span>
      </span>

      {/* Arrows hug the bar (previous on its left, next on its right) rather than
          the outer edges, so there is no leading/trailing indent. Kept invisible
          (not removed) at each end so the bar width does not jump. */}
      <button
        type="button"
        onClick={onPrevious}
        disabled={!canBack}
        aria-label="Previous stream"
        data-testid="stream-prev"
        className={`${arrowCls} ${canBack ? '' : 'invisible'}`}
      >
        &#8249;
      </button>

      <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-500 rounded-full transition-all duration-300"
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={!canForward}
        aria-label="Next stream"
        data-testid="stream-next"
        className={`${arrowCls} ${canForward ? '' : 'invisible'}`}
      >
        &#8250;
      </button>

      <span className={`font-medium ${atMaxPredictions ? 'text-yellow-400' : 'text-gray-500'}`}>
        {predictionsCount}/{maxPredictions}
      </span>

      {atMaxPredictions && (
        <span className="text-yellow-400 text-xs">Max reached</span>
      )}
    </div>
  );
}
