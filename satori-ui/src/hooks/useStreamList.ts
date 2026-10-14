import { ethers } from 'ethers';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useContracts } from './useContracts';
import { useGames } from './useGames';
import { multicallRead } from '../utils/multicall';
import { isProfane } from '../utils/profanity';
import { payoutForStream, payableBudget } from '../lib/roundPayout';
import { getCurrentRound, getNamedAdapterId } from '../lib/chainValues';
import { earningGames } from '../lib/round';
import { DEFAULT_STREAM_ID, DEFAULT_STREAM_DISPLAY_NAME } from '../lib/defaultStreamSeries';
import { indexerStreams, indexerRoundBudget, recentlyWrittenStream } from '../utils/indexerClient';

export interface StreamBasic {
  id: number;
  name: string;
  provider: string;        // value provider for the stream (getDataStreamInfo idx 1). Renamed from `authority`: the 6-field info tuple has no authority/target field.
  streamType: number;
  currentValue: number;
  valueHour: number;        // absolute HOUR the newest value was stamped (the registry ring is hour-keyed)
  weight: number;          // game-keyed: voting.gameWeight(gameId) for this stream's 1:1 binary game (0 when no game / not weighted)
  // Is this stream's game LIVE (SatoriVoting.gameLive: approved by the rewards
  // admin, or the exempt default game)? Games are BORN unapproved, so false is
  // the normal starting state, not a punishment. An unapproved game earns
  // nothing, but voters KEEP their votes — and can re-point them with
  // moveVotes — so the UI has to say so, or they are left wondering why a
  // stream they backed pays out zero.
  approved: boolean;
  minCadenceMinutes: number; // update cadence in MINUTES: 60 = hourly (the registry floor), 1440 = daily (the default). Drives predict-window and update-gap.
  adapterId: number;        // 0 for Simple streams; for Adapter streams, indexes registry.adapter[]
  isCommunityAdapter: boolean; // true if the adapter was registered via the permissionless path
  // adapterId === registry.namedAdapterId(): the value is the network's own
  // signed prediction flow. Every render site must show a lean, never the number.
  isNamed: boolean;
  config: string;           // adapter config bytes (hex); "0x" for Simple streams. From streams() tuple idx 4 (name is idx 5).
}
// NOTE: isEligible used to live on StreamBasic but baked-in flags were prone to
// closure-staleness (the loadMetadata callback's captured eligibleIds Set could
// be stale at row-construction time). Consumers now derive eligibility from
// the live `eligibleIds` Set / `isEligible(id)` accessor returned by the hook.

// Each stream's metadata = 4 reads (info + weight + struct + gameLive). With Multicall, a single
// eth_call batches PAGE_SIZE * 4 reads server-side, so the page size is purely
// a display/feel knob — no burst risk.
const PAGE_SIZE = 200;

// Page size for the contract-side getRankedGames pagination. Each entry is
// (uint32, int256) ~36 bytes, so 500 entries returns ~18KB — comfortable for
// any RPC. Iterates a few times only on chains with thousands of weighted
// games; one call handles practical sizes.
const RANKED_PAGE = 500;

// Display order: streams whose 1:1 binary game is in the eligible+rest heaps
// first (sorted by weight desc), followed by zero-weight streams in creation
// order. Ranking is now GAME-keyed: SatoriVoting.getRankedGames returns gameIds
// + weights, which we map back to owning streamIds via the useGames bridge
// (gameMeta.dataStreamId). The tail comes from SatoriRegistry.getDataStreams
// paging, filtered to dedupe with the ranked tier.

export function useStreamList() {
  const { contracts } = useContracts();
  const { resolveGameIds, getGameMetas } = useGames();
  const [streams, setStreams] = useState<StreamBasic[]>([]);
  // Frozen ("will earn this round") vs live ("in the heap right now"). See the
  // note in init() — these are different questions and the contract only pays
  // on the first one.
  const [eligibleIds, setEligibleIds] = useState<Set<number>>(new Set());
  const [liveEligibleIds, setLiveEligibleIds] = useState<Set<number>>(new Set());
  const [govVotesByStream, setGovVotesByStream] = useState<Map<number, bigint>>(new Map());
  const [govTotal, setGovTotal] = useState<bigint>(BigInt(0));
  /// The round's REAL payable budget, after the dev fee, the off-chain dial and
  /// the first-predictor bonus. Starts at 0 so a pre-load render never shows
  /// the 1440 envelope as a payout; set on first read.
  const [budget, setBudget] = useState<number>(0);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  // Display ordering — ranked tier first, then any tail of unranked streams.
  const orderedIdsRef = useRef<number[]>([]);
  const rankedSetRef = useRef<Set<number>>(new Set());
  const tailOffsetRef = useRef(0);
  const tailExhaustedRef = useRef(false);

  // Fetch metadata for a list of IDs and fold the resulting StreamBasic[] into
  // state in the order given. Returns the produced rows so callers can chain.
  const loadMetadata = useCallback(async (ids: number[], replace: boolean) => {
    if (!contracts || ids.length === 0) {
      if (replace) setStreams([]);
      return [] as StreamBasic[];
    }
    // Weight is now GAME-keyed (voting.gameWeight(gameId)), not stream-keyed.
    // Resolve each stream's 1:1 binary gameId up front (one batched eth_call via
    // the bridge) so the per-stream gameWeight read below uses the right key.
    const gameIdMap = await resolveGameIds(ids);
    // Batch every stream's metadata into a single eth_call via Multicall.
    // Per stream: info + gameWeight (lives on voting, keyed by gameId) + struct
    // (for adapterId and cadence) + gameLive. Four, not five — the
    // value-provider-cut read is gone with the feature.
    // From /streams when the indexer has the stream (name, provider, type, newest
    // value and hour, adapterId, cadence, config, named); otherwise, or for a
    // stream this client just wrote, the registry's info tuple and struct.
    const indexed = new Map((await indexerStreams() ?? []).map((st) => [st.streamId, st]));
    const fromIndex = (id: number) => !recentlyWrittenStream(id) ? indexed.get(id) : undefined;
    const reqs: { contract: any; fn: string; args: unknown[]; allowFailure?: boolean }[] = [];
    const at = new Map<number, number>();
    for (const id of ids) {
      at.set(id, reqs.length);
      const gid = gameIdMap.get(id) ?? 0;
      // Game-keyed weight (voting.gameWeight(gameId); 0 when the stream has no
      // game yet). No allowFailure: a revert here is a genuine error.
      reqs.push({ contract: contracts.voting, fn: 'gameWeight', args: [gid] });
      // Approved-or-default liveness, read per stream: an unapproved game is in
      // neither heap. A failed read shows as NOT live, the born-unapproved default.
      reqs.push({ contract: contracts.voting, fn: 'gameLive', args: [gid], allowFailure: true });
      if (!fromIndex(id)) {
        reqs.push({ contract: contracts.registry, fn: 'getDataStreamInfo', args: [id] });
        reqs.push({ contract: contracts.registry, fn: 'streams', args: [BigInt(id - 1)], allowFailure: true });
      }
    }
    const results = await multicallRead(contracts.reads.multicall, reqs);
    const rowsRaw: StreamBasic[] = ids.map((id) => {
      const base = at.get(id)!;
      const weight = results[base] ?? BigInt(0);
      const approved = Boolean(results[base + 1]);
      const st = fromIndex(id);
      let name: string, provider: string, streamType: number, value: number, valueHour: number;
      let cadence: number, adapterId: number, config: string;
      let isNamed: boolean | null = null;
      if (st) {
        ({ name, provider, streamType, adapterId, config } = st);
        value = Number(st.lastValue ?? BigInt(0));
        valueHour = st.lastHour ?? 0;
        cadence = st.minCadenceMinutes;
        isNamed = st.named;
      } else {
        const info = results[base + 2];
        const meta = results[base + 3];
        // streams() is the StreamMeta tuple (provider, streamType,
        // minCadenceMinutes, adapterId, config, name); a failed read defaults to
        // the hub's daily cadence.
        cadence = Number(meta?.minCadenceMinutes ?? BigInt(1440));
        adapterId = Number(meta?.adapterId ?? meta?.[3] ?? 0);
        config = (meta?.config ?? '0x') as string;
        // getDataStreamInfo: (name, provider, streamType, value, valueHour, exists).
        name = info[0];
        provider = info[1];
        streamType = Number(info[2]);
        value = Number(info[3]);
        valueHour = Number(info[4]);
      }
      return {
        id,
        // Stream 1 is relabelled at the edge. Its on-chain name is the literal
        // "Satori Predictions" the hub wrote at bootstrap, which describes
        // today's participation ratio not at all, and it cannot be changed on
        // chain (provider-gated setter; the provider is the hub, which has no
        // passthrough).
        name: id === DEFAULT_STREAM_ID ? DEFAULT_STREAM_DISPLAY_NAME : name,
        provider,
        streamType,
        currentValue: value,
        valueHour,
        weight: Number(weight),
        approved,
        minCadenceMinutes: cadence,
        adapterId,
        config,
        // Stamped below: the community flag is per adapter, not per stream.
        isCommunityAdapter: false,
        isNamed: isNamed ?? false,
        namedKnown: isNamed != null,
      } as StreamBasic & { namedKnown: boolean };
    });

    // Resolve isCommunityAdapter once per unique adapterId, then stamp the
    // result onto each row. Skips adapterId=0 (Simple) — never a community
    // adapter by definition.
    const uniqueAdapterIds = Array.from(
      new Set(rowsRaw.map((r) => r.adapterId).filter((aid) => aid > 0))
    );
    let adapterFlags = new Map<number, boolean>();
    let namedId = 0;
    if (uniqueAdapterIds.length > 0) {
      if (rowsRaw.some((r: any) => r.adapterId > 0 && !r.namedKnown)) namedId = await getNamedAdapterId(contracts.reads);
      const adapterReqs = uniqueAdapterIds.map((aid) => ({
        contract: contracts.registry,
        fn: 'isCommunityAdapter',
        args: [aid],
        allowFailure: true,
      }));
      const adapterResults = await multicallRead(contracts.reads.multicall, adapterReqs);
      uniqueAdapterIds.forEach((aid, idx) => {
        adapterFlags.set(aid, Boolean(adapterResults[idx]));
      });
    }
    let rows: StreamBasic[] = rowsRaw.map(({ namedKnown, ...r }: StreamBasic & { namedKnown?: boolean }) =>
      r.adapterId > 0
        ? { ...r, isCommunityAdapter: adapterFlags.get(r.adapterId) ?? false, isNamed: namedKnown ? r.isNamed : r.adapterId === namedId }
        : r
    );

    // Hide streams with profane names. Client-side only — the streams still
    // exist on-chain; this is a UX filter, not a moderation policy. The
    // default stream (id 1) is never filtered.
    rows = rows.filter((r) => r.id === DEFAULT_STREAM_ID || !isProfane(r.name));

    if (replace) setStreams(rows);
    else setStreams((prev) => [...prev, ...rows]);
    return rows;
  }, [contracts, resolveGameIds]);
  // Note: eligibleIds intentionally NOT in deps — loadMetadata no longer
  // reads it. Eligibility is derived by callers via `isEligible(id)` at
  // read time, which keeps the flag always current relative to the live Set.

  // Initial load: ranked tier in one RPC, sorted by weight desc, then page-1
  // metadata. Also fetches the eligible-id set + total count for filter pills.
  //
  // Eligibility and ranking are GAME-keyed now (voting.getGameWeights returns
  // gameIds with their weights). The stream list is stream-
  // primary, so we map every gameId back to its owning streamId via the
  // useGames bridge (gameMeta.dataStreamId) — one batched getGameMetas call
  // covers the union of eligible + ranked gameIds.
  const init = useCallback(async () => {
    if (!contracts) return;
    setLoading(true);
    try {
      // There are TWO eligible sets and they answer different questions:
      //
      //   live                         what is in the running RIGHT NOW, moving
      //                                the instant anyone votes. There is no
      //                                longer a getter for this: the heap era is
      //                                over, and eligibility is simply "carries
      //                                weight" (SatoriVoting.isEligible is
      //                                `weightOf(gameId) > 0`). It is derived
      //                                below from the getGameWeights walk, which
      //                                already filters to non-zero weight.
      //   getEligibleGamesAtRound(gov) the FROZEN snapshot the chain actually
      //                                settles rewards against.
      //
      // Rewards for the current round are paid on the GOVERNING round's
      // snapshot, which is normally the PREVIOUS round (SatoriEngine.
      // eligibilityRound: `round - 1` whenever that round locked). ISatoriVoting
      // is explicit that "games that become eligible AFTER this snapshot cannot
      // earn rewards for the round".
      //
      // So the "rewarding" flag and the payout estimate must both come from the
      // frozen set. Reading the live heap there promises earnings the contract
      // will not pay, and hides streams that will earn. The live set is still
      // worth having — it answers "did the thing I just voted for make it into
      // the heap" — so both are returned rather than one replacing the other.
      const currentRound = await getCurrentRound();
      const govRound = await contracts.cached.round.satori.eligibilityRound(currentRound);
      const [earningRaw, count, govTotalRaw] = await Promise.all([
        contracts.cached.round.voting.getEligibleGamesAtRound(govRound),
        contracts.cached.live.registry.getDataStreamCount(),
        // The round's vote DENOMINATOR — the divisor in the contract's own
        // allocation formula (SatoriRewards._gameRoundAllocation).
        //
        // `roundVoteTotal`, the public mapping, NOT the `roundDenominator`
        // accessor. That accessor reverts RoundNotFinal for any
        // `round >= currentRound`, deliberately: mid-round the total is still
        // accumulating and a share computed against a partial sum comes out too
        // large, so the contract makes "read it only once it is final" a rule
        // rather than a convention.
        //
        // This code used to call it and catch the revert to 0, on the reasoning
        // that govRound only equals the current round when the previous one
        // never locked. That reasoning died with burn voting:
        // `eligibilityRound` is now the IDENTITY (a prediction is paid against
        // its own round's weight), so govRound is ALWAYS the current round, the
        // accessor ALWAYS reverts, and the catch ALWAYS produced 0. Every round,
        // forever, the dapp believed no snapshot existed — which pinned every
        // payout to "—" and kept the "rewards are not set yet" banner
        // permanently on screen. Found 2026-08-22 when the owner asked why the
        // banner was there after they had already predicted.
        //
        // The partial-sum caveat is real and belongs in the UI as "so far", not
        // in a read that returns nothing.
        contracts.cached.round.voting.roundVoteTotal(govRound).catch(() => BigInt(0)),
      ]);
      // What the round actually has to give out: the budget it froze on its first
      // touch (RoundBudgetFrozen), which is what scoring pays from. Before
      // anything touches the round, project it from the hub's issuance-indexed
      // emission rate less the dev fee and the off-chain dial, exactly as the
      // freeze will.
      const frozenBudget = await indexerRoundBudget(Number(currentRound));
      const [emissionRateRaw, devRateRaw, offchainRaw] = frozenBudget != null ? [] : await Promise.all([
        contracts.cached.round.satori.emissionRateNow(),
        contracts.cached.round.satori.devRateNow(),
        contracts.cached.round.rewards.offchainBudget(),
      ]);
      setTotalCount(Number(count));
      const eligibleGameIds: number[] = (earningRaw ?? []).map((g: any) => Number(g));

      // Frozen per-game numerators, matching the contract's allocation formula
      // (SatoriRewards._gameRoundAllocation): budget * getGameVotesAtRound(
      // gameId, govRound) / roundTotals(govRound). Both halves come from the
      // governing round; mixing in a live weight makes the displayed payout
      // drift from the paid one on every vote cast during the round.
      const govVotesByGame = new Map<number, bigint>();
      if (eligibleGameIds.length > 0) {
        const voteReqs = eligibleGameIds.map((gid) => ({
          contract: contracts.reads.voting,
          fn: 'getGameVotesAtRound',
          args: [gid, govRound],
          allowFailure: true,
        }));
        const voteRes = await multicallRead(contracts.reads.multicall, voteReqs);
        eligibleGameIds.forEach((gid, i) => {
          govVotesByGame.set(gid, BigInt(voteRes[i] ?? 0));
        });
      }
      setGovTotal(BigInt(govTotalRaw ?? 0));
      setBudget(frozenBudget != null ? Number(ethers.formatEther(frozenBudget)) : payableBudget(
        Number(ethers.formatEther(emissionRateRaw ?? 0)),
        Number(ethers.formatEther(devRateRaw ?? 0)),
        Number(ethers.formatEther(offchainRaw ?? 0)),
      ));

      // Page through getGameWeights until exhausted. This ONE walk replaces both
      // getRankedGames and getEligibleGames, which are gone from the contract:
      //   - it returns only games with non-zero weight, and eligibility IS
      //     non-zero weight (isEligible === weightOf > 0), so the ids ARE the
      //     live eligible set;
      //   - it returns those weights, so the ranking is the same data sorted
      //     client-side. getRankedGames was never actually ranked either — it
      //     returned raw heap-array order, which a heap only guarantees at its
      //     root, so every consumer already sorted.
      //
      // Pagination note: `nextOffset` is the scan-window end, NOT a count of
      // matches, so it advances by `limit` even for a window where every game
      // had zero weight. Never break on an empty page — only on no advance,
      // which is what the contract returns once offset passes gameCount.
      const rankedGames: { gameId: number; w: number }[] = [];
      const liveGameIds: number[] = [];
      let offset = 0;
      while (true) {
        let res: any;
        try {
          res = await contracts.cached.live.voting.getGameWeights(offset, RANKED_PAGE, govRound);
        } catch {
          break;
        }
        // (ids, weights, approved, burnedInRound, nextOffset) — five returns, so
        // nextOffset is index 4. Reading it at index 2 would silently hand back
        // the `approved` array and spin this loop.
        const [rawIds, rawWeights, , , nextOff] = res;
        for (let i = 0; i < rawIds.length; i++) {
          const gameId = Number(rawIds[i]);
          rankedGames.push({ gameId, w: Number(rawWeights[i]) });
          liveGameIds.push(gameId);
        }
        const next = Number(nextOff);
        if (next <= offset) break;
        offset = next;
      }

      // Resolve the union of eligible + ranked gameIds to their owning
      // streamIds in one batched call. The map lets us re-key both the
      // eligible Set and the ranked tier into stream-id space.
      const allGameIds = Array.from(
        new Set([...eligibleGameIds, ...rankedGames.map((g) => g.gameId)].filter((g) => g > 0)),
      );
      const metas = await getGameMetas(allGameIds);
      const streamIdForGame = (gameId: number): number =>
        metas.get(gameId)?.dataStreamId ?? 0;

      // eligibleIds is a Set of STREAM ids so isEligible(streamId) works.
      // Keyed off the FROZEN set — this is the "will earn this round" flag.
      //
      // ...EXCEPT before the governing round has been snapshotted, when the frozen
      // set is empty and reading it would deadlock the protocol.
      //
      // The snapshot is written by the round's FIRST prediction
      // (SatoriEngine._ensureDailyTotalsInitialized). And eligibilityRound(r)
      // only returns r-1 when r-1 locked, so after a round in which NOBODY
      // predicted, the governing round is the CURRENT one — whose snapshot does
      // not exist yet. Gate the predictable list on that and the dapp shows "No
      // streams available", so nobody predicts, so the snapshot is never written.
      // Permanent, and it survives every refresh: one quiet round takes the dapp
      // out for good. Observed on Base Sepolia at round 41342.
      //
      // The right fallback is the LIVE heap, not the previous round's snapshot:
      // _ensureDailyTotalsInitialized copies the live heap via
      // snapshotEligibleGamesForRound, so the live heap IS what the chain will
      // freeze the moment the first prediction lands. An older snapshot would be a
      // guess that can name a stream since dropped from the heap, or hide one
      // that has entered.
      //
      // The chain never needed this: predictMultiple calls
      // _ensureDailyTotalsInitialized BEFORE it reads eligibilityRound, so the
      // first prediction of a round writes the snapshot and then validates against
      // it. Only the dapp's read-only gate was wrong.
      const govSnapshotWritten = BigInt(govTotalRaw ?? 0) > BigInt(0);
      const earningGameIds = earningGames(eligibleGameIds, liveGameIds, govSnapshotWritten);
      setEligibleIds(
        new Set(
          earningGameIds.map(streamIdForGame).filter((sid) => sid > 0),
        ),
      );
      // The live heap, stream-keyed, for "is it in the running right now".
      setLiveEligibleIds(
        new Set(
          liveGameIds.map(streamIdForGame).filter((sid) => sid > 0),
        ),
      );
      // Re-key the frozen numerators from gameId to streamId so the payout
      // estimate can be read the same way as everything else in the list.
      const votesByStream = new Map<number, bigint>();
      govVotesByGame.forEach((votes, gid) => {
        const sid = streamIdForGame(gid);
        if (sid > 0) votesByStream.set(sid, votes);
      });
      setGovVotesByStream(votesByStream);

      // Map ranked gameIds -> owning streamIds, dropping any we couldn't
      // resolve, then order by weight desc.
      const ranked: { id: number; w: number }[] = rankedGames
        .map((g) => ({ id: streamIdForGame(g.gameId), w: g.w }))
        .filter((x) => x.id > 0);
      const rankedIds = ranked.sort((a, b) => b.w - a.w).map((x) => x.id);
      rankedSetRef.current = new Set(rankedIds);
      orderedIdsRef.current = [...rankedIds];
      tailOffsetRef.current = 0;
      tailExhaustedRef.current = false;
      setHasMore(true);

      const firstSlice = rankedIds.slice(0, PAGE_SIZE);
      if (firstSlice.length < PAGE_SIZE) {
        // Ranked tier shorter than a page — pull tail to fill, in creation order.
        const filler = await fetchTail(PAGE_SIZE - firstSlice.length);
        orderedIdsRef.current = [...firstSlice, ...filler];
        await loadMetadata(orderedIdsRef.current, true);
      } else {
        await loadMetadata(firstSlice, true);
      }
      // hasMore: more in ranked tier OR tail not yet exhausted
      const moreRanked = orderedIdsRef.current.length > streams.length + firstSlice.length;
      setHasMore(moreRanked || !tailExhaustedRef.current);
    } catch (e) {
      console.error('useStreamList init failed:', e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, getGameMetas]);

  // Pull the next batch of unranked stream IDs (zero-weight) from the registry,
  // skipping any already in the ranked set. Streams are permanent post-PR-2 so
  // `getDataStreams` returns a dense list; `nextOffset` is always `offset +
  // returned-length` here. Exhaustion is detected by `nextOffset >= totalCount`.
  const fetchTail = useCallback(async (want: number): Promise<number[]> => {
    if (!contracts || tailExhaustedRef.current) return [];
    const ranked = rankedSetRef.current;
    const collected: number[] = [];
    let attempts = 0;
    while (collected.length < want && attempts < 50) {
      let res: any;
      try {
        res = await contracts.cached.live.registry.getDataStreams(tailOffsetRef.current, PAGE_SIZE);
      } catch {
        tailExhaustedRef.current = true;
        break;
      }
      const [rawIds, nextOff] = res;
      const next = Number(nextOff);
      const advanced = next > tailOffsetRef.current;
      tailOffsetRef.current = next;
      for (const raw of rawIds) {
        const id = Number(raw);
        if (id > 0 && !ranked.has(id)) collected.push(id);
        if (collected.length >= want) break;
      }
      if (!advanced || (totalCount > 0 && next >= totalCount)) {
        tailExhaustedRef.current = true;
        break;
      }
      attempts++;
    }
    return collected;
  }, [contracts, totalCount]);

  const loadMore = useCallback(async () => {
    if (!contracts || loadingMore) return;
    setLoadingMore(true);
    try {
      const have = streams.length;
      const remainingRanked = orderedIdsRef.current.slice(have, have + PAGE_SIZE);
      let toFetch = remainingRanked;
      if (toFetch.length < PAGE_SIZE) {
        const tail = await fetchTail(PAGE_SIZE - toFetch.length);
        orderedIdsRef.current = [...orderedIdsRef.current, ...tail];
        toFetch = [...toFetch, ...tail];
      }
      if (toFetch.length === 0) {
        setHasMore(false);
        return;
      }
      await loadMetadata(toFetch, false);
      const moreRanked = orderedIdsRef.current.length > have + toFetch.length;
      setHasMore(moreRanked || !tailExhaustedRef.current);
    } finally {
      setLoadingMore(false);
    }
  }, [contracts, loadingMore, streams.length, fetchTail, loadMetadata]);

  useEffect(() => { init(); }, [init]);

  const reload = useCallback(() => {
    setStreams([]);
    setHasMore(true);
    init();
  }, [init]);

  // Eligibility is intentionally NOT baked into the stream rows; consumers
  // call `isEligible(id)` (or look up `eligibleIds.has(id)` directly). This
  // ties the freshness of the flag to the live Set rather than to whatever
  // it happened to be when the row was loaded — fixes the original closure-
  // staleness bug at the source.
  const isEligible = useCallback(
    (streamId: number) => eligibleIds.has(streamId),
    [eligibleIds],
  );

  /// In the live heap right now, which is NOT the same as earning this round.
  /// Use this to answer "did my vote land"; use `isEligible` for anything about
  /// rewards.
  const isLiveEligible = useCallback(
    (streamId: number) => liveEligibleIds.has(streamId),
    [liveEligibleIds],
  );

  /// SATORI this stream is on track to pay across the round, using the same
  /// numerator and denominator the contract uses. Zero when the stream is not
  /// in the governing snapshot — which is exactly when it earns nothing.
  const payoutPerRound = useCallback(
    (streamId: number): number => {
      return payoutForStream(streamId, govVotesByStream, govTotal, budget);
    },
    [govVotesByStream, govTotal, budget],
  );

  /// Has the governing round been snapshotted yet?
  ///
  /// The frozen eligible set and roundTotals are written by the round's FIRST
  /// prediction (SatoriEngine._ensureDailyTotalsInitialized). Until that
  /// happens, `roundTotals(gov)` is 0 and the frozen set is empty — which is NOT
  /// the same as "nothing earns this round", though it reads identically if you
  /// only look at the numbers. It means "not decided yet".
  ///
  /// It bites hardest when the PREVIOUS round had no predictions either:
  /// eligibilityRound falls back to the current round, whose snapshot cannot
  /// exist yet, so every stream reads 0 and "not rewarding" while a stream
  /// plainly holds live vote weight. That is what it looked like on 2026-08-06.
  const govSnapshotTaken = govTotal > BigInt(0);

  return {
    streams,
    totalCount,
    govSnapshotTaken,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    reload,
    eligibleIds,
    isEligible,
    liveEligibleIds,
    isLiveEligible,
    payoutPerRound,
  };
}
