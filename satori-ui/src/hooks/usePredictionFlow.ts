import { useState, useCallback, useMemo, useEffect } from 'react';
import { StreamBasic } from './useStreamList';

// The selection queue stays stream-keyed (stream<->game is 1:1). At submit
// time App.tsx resolves each `streamId` to its gameId via the useGames bridge
// and packs `direction` into a 1-byte payload for
// satori.predictMultipleWithPayloads([{ gameId, payload }, ...]).
export interface PredictionEntry {
  streamId: number;
  direction: number; // 1 = UP/YES, 2 = DOWN/NO (the on-chain payload byte)
  // What the user actually PRESSED, when that differs from `direction`.
  //
  // For a Uniswap stream whose readable price runs opposite the tick, pressing UP
  // has to record DOWN on chain (see lib/streamOrientation). The flip happens once,
  // at the press, because that is the only moment the resolved pool display is
  // guaranteed to be in hand — re-deriving it at submit time would risk sending an
  // unflipped direction if a probe were slow or failed.
  //
  // Keeping both means every screen that lists the queue shows the press without
  // needing to know a thing about orientation. Absent = the two agree.
  displayDirection?: number;
}

/// Most games one batch may carry. A GAS ceiling, not a protocol rule — the
/// contract imposes no cap at all (BatchPrediction.test.js: "No batch-size cap:
/// large batches succeed as long as the user has enough power and gas"), so the
/// only thing standing between a user and an unsendable transaction is this.
///
/// SIZED FOR THE WORST REALISTIC CASE, which is the DEFAULT case: a predictor
/// who has been delegated to, and who is the first to predict each game this
/// round. Delegation is what instant signing does, and at launch there is
/// rarely anyone else to have recorded the game first — `_recordVotes` charges
/// only the round's first predictor of a game, so "someone else went first" is
/// a discount you cannot rely on.
///
/// Measured steady state (predict + settle last round) on that path:
///    8 games → 2,298,305   (77% of a 3M limit)
///   10 games → 2,763,608   (92%)  ← the last size that fits
///   12 games → 3,208,158   (107% — over)
///   16 games → 4,101,181   (137% — over by a third)
///
/// The same batch costs ~2.6M at 16 games when the user is NOT delegated and
/// others already recorded the games — which is exactly the measurement that
/// made 16 look safe. It is not, for the path most users will be on.
///
/// Delegator COUNT is irrelevant: 1, 4 and 8 delegators all cost the same, so
/// this holds for a popular predictor as much as a fresh one.
///
/// Remaining headroom eater: a game the user holds a bounty stake on costs
/// ~126k more. The wallet enforces the real ceiling; the hard cap below just
/// stops the obvious overrun. See test/BatchPredictionGasScaling.test.js.
///
/// HARD cap — the most a single round's batch may queue. Base's ~30M block gas
/// / ~334k per delegated predict+settle (~190k per-stream + ~142k delegation
/// premium) ≈ 89, so 85 leaves headroom for the bounty-stake eater without a
/// gas revert. At the hard cap the user must submit; they cannot add more.
const HARD_MAX_PREDICTIONS = 85;
/// SOFT limit — how many the flow surfaces before the submit/continue screen.
/// A human wants a quick game, not dozens of graphs, so the primary list is the
/// user's eligible FAVORITES if they have at least this many, else their
/// favorites topped up to this many with the most-rewarding streams. "Continue
/// Predicting" opens the rest, up to the hard cap.
const SOFT_LIMIT = 5;

// Favorites stored in localStorage keyed by wallet address
function getFavorites(address: string): number[] {
  try {
    const raw = localStorage.getItem(`satori-favorites-${address}`);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setFavorites(address: string, ids: number[]) {
  localStorage.setItem(`satori-favorites-${address}`, JSON.stringify(ids));
}

export function usePredictionFlow(
  streams: StreamBasic[],
  isEligible: (streamId: number) => boolean,
  address: string | null,
) {
  const [predictions, setPredictions] = useState<PredictionEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showKeepGoing, setShowKeepGoing] = useState(false);

  // Reset flow when address changes
  useEffect(() => {
    setPredictions([]);
    setCurrentIndex(0);
    setShowKeepGoing(false);
    setIsSubmitting(false);
  }, [address]);

  // Load favorites for this wallet (state so toggleFavorite triggers re-render)
  const [favorites, setFavoritesState] = useState<number[]>(
    () => (address ? getFavorites(address) : []),
  );
  useEffect(() => {
    setFavoritesState(address ? getFavorites(address) : []);
  }, [address]);

  // Order streams per design doc:
  //   1. Favorited + eligible      (user's custom order)
  //   2. Non-favorited + eligible  (by weight desc)
  //   3. SUBMIT screen — Submit + "Continue Predicting" buttons
  //   4. Favorited + ineligible    (user's custom order; via keep-going)
  //   5. Non-favorited + ineligible (by weight desc; via keep-going)
  // The Submit button stays visible during steps 4–5 so the user can stop at
  // any time. Reaching the end of step 5 returns to the submit screen.
  const orderedStreams = useMemo(() => {
    const favSet = new Set(favorites);
    // Only include streams that have values (the contract requires a recent
    // value to predict). The default stream (id 1, bound 1:1 to the default
    // binary game, gameId 1) is exempt: the contract auto-flushes its value
    // via flushDefaultStream() so it's always predictable when eligible — even
    // on a fresh deploy where its valueHour is still 0. We gate on the stream
    // id here because the flow is stream-keyed (1:1 stream<->game) and
    // DEFAULT_STREAM_ID == 1 — always predictable when eligible (its value is
    // written lazily by flushDefaultStream at predict time). The eligibility
    // grouping below decides whether it's shown. A named stream is exempt too:
    // predict's own pull writes it once the clock hour has advanced
    // (SatoriRegistry.updateValues).
    const predictable = streams.filter((s) => s.valueHour > 0 || s.id === 1 || s.isNamed);

    const favEligible = favorites
      .filter((id) => {
        const s = predictable.find((s) => s.id === id);
        return s && isEligible(s.id);
      })
      .map((id) => predictable.find((s) => s.id === id)!);

    const favIneligible = favorites
      .filter((id) => {
        const s = predictable.find((s) => s.id === id);
        return s && !isEligible(s.id);
      })
      .map((id) => predictable.find((s) => s.id === id)!);

    const nonFavEligible = predictable
      .filter((s) => isEligible(s.id) && !favSet.has(s.id))
      .sort((a, b) => b.weight - a.weight);

    const nonFavIneligible = predictable
      .filter((s) => !isEligible(s.id) && !favSet.has(s.id))
      .sort((a, b) => b.weight - a.weight);

    // SOFT list (primary): eligible favorites if the user has >= SOFT_LIMIT of
    // them; otherwise favorites topped up to SOFT_LIMIT with the most-rewarding
    // (highest-weight) eligible streams. Bounded by what actually exists, so a
    // chain with only two eligible streams shows two. The submit/continue screen
    // follows it.
    const fillCount = favEligible.length >= SOFT_LIMIT ? 0 : SOFT_LIMIT - favEligible.length;
    const primary = [...favEligible, ...nonFavEligible.slice(0, fillCount)];
    // EXTENDED list ("Continue Predicting"): the soft list, then the remaining
    // eligible streams, then the ineligible ones — the whole predictable set,
    // capped at the hard limit.
    const extended = [
      ...primary,
      ...nonFavEligible.slice(fillCount),
      ...favIneligible,
      ...nonFavIneligible,
    ].slice(0, HARD_MAX_PREDICTIONS);

    return { primary, extended };
  }, [streams, favorites, isEligible]);

  const activeList = showKeepGoing
    ? orderedStreams.extended
    : orderedStreams.primary;

  const currentStream = activeList[currentIndex] ?? null;
  const totalStreams = activeList.length;
  // The soft limit is the primary list's length (favorites, or topped up to
  // SOFT_LIMIT) — what the top counter counts toward before the user continues.
  const softLimit = orderedStreams.primary.length;

  // We're at the submit screen if we've cycled past the active list. In
  // keep-going mode, that means the end of the extended list.
  const atSubmitScreen = showKeepGoing
    ? currentIndex >= orderedStreams.extended.length
    : currentIndex >= orderedStreams.primary.length;
  const canSubmit = atSubmitScreen && predictions.length > 0;
  // Anything past the soft list to continue to — more eligible streams beyond
  // the soft cap, or ineligible ones. Drives the "Continue Predicting" button.
  const hasIneligibleRemaining =
    orderedStreams.extended.length > orderedStreams.primary.length;
  // Counter denominator: the soft limit until the user chooses to continue,
  // then the hard cap.
  const displayMax = showKeepGoing ? HARD_MAX_PREDICTIONS : softLimit;

  const addPrediction = useCallback(
    (streamId: number, direction: number, displayDirection?: number) => {
      setPredictions((prev) => {
        if (prev.length >= HARD_MAX_PREDICTIONS) return prev;
        // Replace if already predicted for this stream
        const filtered = prev.filter((p) => p.streamId !== streamId);
        return [...filtered, { streamId, direction, displayDirection }];
      });
      // Auto-advance to next stream
      setCurrentIndex((i) => i + 1);
    },
    [],
  );

  const skip = useCallback(() => {
    setCurrentIndex((i) => i + 1);
  }, []);

  const previous = useCallback(() => {
    setCurrentIndex((i) => Math.max(0, i - 1));
  }, []);

  const goToStream = useCallback((index: number) => {
    setCurrentIndex(index);
  }, []);

  const keepGoing = useCallback(() => {
    setShowKeepGoing(true);
    // currentIndex is already at orderedStreams.primary.length, which is the
    // first index of the nonFavIneligible entries in the extended list.
  }, []);

  /// Navigate directly to a stream by id, eligible or not. If it isn't in the
  /// primary (eligible) list we switch to the extended list (keep-going) and
  /// jump to it there — both state updates batch, so one call lands it. Returns
  /// whether the stream was found.
  const goToStreamId = useCallback((id: number) => {
    const primaryIdx = orderedStreams.primary.findIndex((s) => s.id === id);
    if (primaryIdx >= 0) {
      setCurrentIndex(primaryIdx);
      return true;
    }
    const extIdx = orderedStreams.extended.findIndex((s) => s.id === id);
    if (extIdx >= 0) {
      setShowKeepGoing(true);
      setCurrentIndex(extIdx);
      return true;
    }
    return false;
  }, [orderedStreams]);

  const reset = useCallback(() => {
    setPredictions([]);
    setCurrentIndex(0);
    setShowKeepGoing(false);
    setIsSubmitting(false);
  }, []);

  const getPredictionForStream = useCallback(
    (streamId: number) => predictions.find((p) => p.streamId === streamId),
    [predictions],
  );

  const toggleFavorite = useCallback(
    (streamId: number) => {
      if (!address) return;
      const current = getFavorites(address);
      const idx = current.indexOf(streamId);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        current.push(streamId);
      }
      setFavorites(address, current);
      setFavoritesState([...current]);
    },
    [address],
  );

  const isFavorite = useCallback(
    (streamId: number) => favorites.includes(streamId),
    [favorites],
  );

  return {
    // State
    predictions,
    currentIndex,
    currentStream,
    totalStreams,
    isSubmitting,
    canSubmit,
    atSubmitScreen,
    hasIneligibleRemaining,
    showKeepGoing,
    activeList,

    // Actions
    addPrediction,
    skip,
    previous,
    goToStream,
    goToStreamId,
    keepGoing,
    reset,
    setIsSubmitting,
    getPredictionForStream,
    toggleFavorite,
    isFavorite,

    // Limits
    MAX_PREDICTIONS: HARD_MAX_PREDICTIONS,
    softLimit,
    displayMax,
    predictionsCount: predictions.length,
    atMaxPredictions: predictions.length >= HARD_MAX_PREDICTIONS,
  };
}
