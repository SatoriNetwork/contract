import React, { useState, useCallback, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { StreamBasic } from '../hooks/useStreamList';
import { rememberOrientation, orientationFor, orientationOf } from '../lib/streamOrientation';
import { canTickNow, nextTickTime } from '../lib/round';
import { formatCadenceLabel, formatCadenceDays } from '../utils/cadence';
import { useContracts } from '../hooks/useContracts';
import { CreateStreamArgs, StreamKind } from '../hooks/useVoting';
import { useAdapters } from '../hooks/useAdapters';
import { useGames, GameWithId, gameDisplayName } from '../hooks/useGames';
import { useGameAdapters } from '../hooks/useGameAdapters';
import { useWallet } from '../hooks/useWallet';
import {
  gameKind,
  gameKindLabel,
  directionOptions,
  encodeGameConfig,
  encodePredictPayload,
} from '../lib/gameTypes';
import {
  resolveGameUI,
  encodeConfigFromFields,
  type ResolvedGameUI,
  type ConfigField,
} from '../lib/gameUI';
import {
  resolveStreamAdapterUI,
  formatStreamValue,
  type ResolvedStreamAdapterUI,
} from '../lib/streamAdapterUI';
import { multicallRead } from '../utils/multicall';
import { formatCompact, trimZeros, formatWeight } from '../utils/format';
import { streamValueDisplayFor, DEFAULT_STREAM_ID } from '../lib/defaultStreamSeries';
import { leanSignLabel } from '../lib/leanFormat';
import { getNamedAdapterId, NAMED_ADAPTER_ID_KEY } from '../lib/chainValues';
import NameSuggest, { submitNameOf, nameBlocker, useNamedNameTaken, type NamedNameRegistry } from './NameSuggest';
import { explainError, sendPreflighted } from '../utils/errors';
import { publishDappEvent } from '../utils/events';
import { StreamAdaptersPanel, GameAdaptersPanel } from './AdaptersTab';
import { InfoTip } from './InfoTip';
import { VotePanel } from './VotePanel';
import { afterTx } from '../lib/afterTx';
import { planBountyFunding } from '../lib/bountyAllowances';
import { makeAllowanceReaders, fundBountyOneConfirmation } from '../lib/bountyAllowanceReaders';
import { chainCache } from '../hooks/useChainRead';
import { noteStreamWrite, indexerBountyPairs } from '../utils/indexerClient';

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/// Human-readable update-allowed hint for the per-stream cadence, recorded in
/// MINUTES (floor 60 — hourly). Round-length-and-above cadences get the
/// contract's 30-minute gap slack; sub-round cadences wait their full period.
function formatCadenceUpdateHint(minCadenceMinutes: number | undefined): string {
  const minutes = minCadenceMinutes && minCadenceMinutes > 0 ? minCadenceMinutes : 60;
  if (minutes <= 60) return 'Allowed once an hour (the cadence floor).';
  const hours = minutes >= 1440 ? minutes / 60 - 0.5 : minutes / 60;
  const period = hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} hours`;
  return `Allowed once every ~${period} (${formatCadenceLabel(minutes).toLowerCase()} cadence).`;
}

// formatCadenceLabel moved to ../utils/cadence (shared with StreamChart).

/// Per-(stream, token) merged-pool bounty entry. Post-PR-5 there is a single
/// pool per token per stream (no per-funder fragmentation); `ratePerRound` is
/// the weighted-average drip rate stored in scaled units (× 1e18). The
/// `drained` flag is set when both pool and rate are zero AND the token is
/// still present in `streamBountyTokens` — those entries are candidates for
/// permissionless `cleanupDrainedBountyToken` (PR 7) and surface a Clean-up
/// button in the UI rather than a Top-up form.
type BountyEntry = {
  token: string;       // lowercase address
  symbol: string;
  decimals: number;
  pool: bigint;        // base token units
  ratePerRound: bigint; // scaled by RATE_SCALE (1e18)
  drained: boolean;
};

const RATE_SCALE = BigInt('1000000000000000000');

function fmtUnits(amount: bigint, decimals: number): string {
  try {
    return trimZeros(ethers.formatUnits(amount, decimals));
  } catch {
    return '0.0';
  }
}

/// Per-round drip in base token units = min(ratePerRound / RATE_SCALE, pool).
function dripPerRound(entry: BountyEntry): bigint {
  const unscaledRate = entry.ratePerRound / RATE_SCALE;
  return unscaledRate < entry.pool ? unscaledRate : entry.pool;
}

type Filter = 'all' | 'eligible' | 'favorites' | 'mine' | 'bounties';

interface StreamsTabProps {
  streams: StreamBasic[];
  isEligible: (streamId: number) => boolean;
  /// SATORI/round this stream is on track to pay, computed from the GOVERNING
  /// round's frozen votes — the same numerator and denominator the contract
  /// settles on. Supplied by useStreamList so it is fetched once.
  payoutPerRound: (streamId: number) => number;
  /// Has the governing round been snapshotted? Until the round's first
  /// prediction there is no frozen set and no roundTotals, so every stream reads
  /// 0 and "not rewarding" — which is indistinguishable from "earns nothing" if
  /// the UI does not say otherwise.
  govSnapshotTaken?: boolean;
  userAddress: string | null;
  isFavorite: (streamId: number) => boolean;
  onToggleFavorite: (streamId: number) => void;
  onCreateStream: (args: CreateStreamArgs) => void;
  creating: boolean;
  /// Is stream creation switched on for this address? Capabilities ship OFF and
  /// are enabled one at a time, so on a fresh deployment this is false and the
  /// create button would otherwise let people submit a transaction that can only
  /// revert.
  canCreateStream?: boolean;
  /// Tokens are transfer-locked right now, so the SATORI burn that pays for a
  /// stream cannot go through. Predicting locks you through the next round, so
  /// this is the normal state for anyone who has played today.
  tokensLocked?: boolean;
  /// The hub cannot yet take the creation fee. When true the form asks for the
  /// approval as its own press, rather than chaining it in front of the create —
  /// on mobile a signature request unloads the page, so anything queued after it
  /// simply never runs.
  needsApproval?: boolean;
  onApprove?: () => void;
  /// Creation fee, for naming the amount being approved.
  creationFee?: string;
  /// The round the lock lifts, for saying WHEN rather than just "not now".
  tokenLockedUntilRound?: number;
  /// Elapsed-round numbering for display (absolute - deployment + 1).
  toDisplayRound?: (absolute: number) => number;
  /// Vote variant only: show a "Create Stream" button that hands off to
  /// wherever the form actually lives. The form is on the advanced tab, so this
  /// cannot just toggle local state — the parent owns the tab switch.
  onRequestCreate?: () => void;
  /// Manage variant only: a bump on this number opens the create form and
  /// scrolls to it. A COUNTER rather than a boolean so a second request works
  /// too — with a flag, the second press would find it already true and do
  /// nothing, which is exactly the case someone hits when they navigate away
  /// and come back.
  openCreateSignal?: number;
  createError: string | null;
  streamCreationFee: string;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  // Voting integration. Under BURN voting there is no "your current vote" to
  // highlight and nothing to clear: a vote destroys SATORI, the weight is
  // permanent, and the contract keeps no per-voter record. `currentVoteGameId`,
  // `hasDelegatedVote` and `onClearVote` are gone with the reads that fed them
  // (getEffectiveVote / voteDelegation / clearVote — none exist on chain).
  /// Resolves TRUE only when the vote actually landed. The composer stays open on
  /// false so its inline error is visible — closing on send would hide every
  /// revert (a disabled capability, a derived stream, a missing allowance).
  onVote: (streamId: number, amount: string) => void | Promise<boolean>;
  /// Approve the hub for a vote burn. Its OWN press — see VotePanel on why the
  /// approve and the vote are never chained.
  onApproveVote: (amount: string) => void | Promise<boolean>;
  /// Spendable SATORI and the current hub allowance, both in ether units. The
  /// panel needs them to cap the input and to decide approve-vs-vote.
  voterBalance: string;
  voterHubAllowance: string;
  /// Can the wallet authorize SATORI by signature? Hides the vote approve step.
  voterCanSign?: boolean;
  voteError: string | null;
  // Game-keyed vote (W7 games-per-stream): makes a specific gameId eligible.
  // App wires this to votingHook.voteGame(gameId) + a stream-list reload.
  onVoteGame: (gameId: number, amount: string) => void | Promise<boolean>;
  voting: boolean;
  // Prediction integration: jump to this stream in the top prediction flow
  onPredictStream: (streamId: number) => void;
  // 'vote' (default) = the Vote tab: the full stream list for voting/predicting,
  // no create flow and no owner-authority controls. 'manage' = the Advanced
  // page: only your own streams, with the create flow + authority controls, and
  // no Your-Vote card.
  variant?: 'vote' | 'manage';
}

export function StreamsTab({
  streams,
  isEligible,
  payoutPerRound,
  govSnapshotTaken = true,
  userAddress,
  isFavorite,
  onToggleFavorite,
  onCreateStream,
  creating,
  canCreateStream = true,
  tokensLocked = false,
  needsApproval = false,
  onApprove,
  creationFee,
  tokenLockedUntilRound = 0,
  toDisplayRound,
  onRequestCreate,
  openCreateSignal,
  createError,
  streamCreationFee,
  hasMore,
  onLoadMore,
  loadingMore,
  onVote,
  onApproveVote,
  voterBalance,
  voterHubAllowance,
  voterCanSign = false,
  voteError,
  onVoteGame,
  voting,
  onPredictStream,
  variant = 'vote',
}: StreamsTabProps) {
  const { contracts } = useContracts();
  const { provider } = useWallet();
  const { adapters } = useAdapters();
  const { gameAdapters } = useGameAdapters();
  // Canonical IDs 1/2/3 already have friendly built-in tabs
  // (chainlink/uniswap/custom). Anything beyond is a community/official adapter
  // surfaced as an extra tab driving the generic kind='adapter' create path —
  // except the named adapter, which has its own 'named' kind: its descriptor
  // advertises a uint32 streamId field that a user must never type. Until the
  // id is known (null) no extra tab is offered at all, so the named adapter
  // can never flash up as a generic one; a failed read keeps the last answer.
  const [namedAdapterId, setNamedAdapterId] = useState<number | null>(
    () => chainCache.peekImmutable<number>(NAMED_ADAPTER_ID_KEY) ?? null,
  );
  useEffect(() => {
    if (!contracts) return;
    getNamedAdapterId(contracts.reads).then(setNamedAdapterId).catch(() => {});
  }, [contracts]);
  const extraAdapters = namedAdapterId == null
    ? []
    : adapters.filter((a) => a.id > 3 && a.id !== namedAdapterId);
  const {
    resolveGameId, resolveGameIds,
    getGamesByStream, getGamesByStreams, createGame, predictGame, setGameName, setGameAuthority,
  } = useGames();
  // Bounties + votes are game-keyed; the UI stays stream-primary (1:1
  // stream<->game). The bounty loader and funding/cleanup handlers resolve the
  // owning gameId on demand via the bridge (resolveGameIds / resolveGameId).
  // Resolve the effective game-keyed vote back to its 1:1 stream so we can
  const [filter, setFilter] = useState<Filter>('all');
  const [showCreate, setShowCreate] = useState(false);
  const createRef = useRef<HTMLDivElement>(null);

  // Opened from elsewhere (the vote tab's Create button). The parent switches to
  // this tab and bumps the signal; this instance mounts fresh, so the effect
  // runs on mount with the new value.
  //
  // Two phases: opening and scrolling cannot share an effect, because the form
  // is rendered BY the state update the first one schedules — at that moment
  // the target does not exist and the ref is null.
  const wantScrollRef = useRef(false);
  useEffect(() => {
    if (!openCreateSignal) return;
    wantScrollRef.current = true;
    setShowCreate(true);
  }, [openCreateSignal]);

  // Jump — no smooth scrolling, no observers, no position sampling.
  //
  // Three earlier versions failed on the reporter's device (mobile Chrome, not
  // the PWA): one frame after render, a ResizeObserver re-asserting through the
  // async panels, and a plain 500ms smooth scroll. Two of those measured correct
  // against a reproduction, which only proved the reproduction was wrong. The
  // report each time was that NOTHING moved, even after several seconds — and
  // "nothing, ever" does not fit a timing bug, so this stops trying to out-time
  // the layout and covers the other candidate instead.
  //
  // Both suspects are handled at once:
  //
  //   * WRONG SCROLLER. Which element actually scrolls the document differs by
  //     browser and by quirks mode. `window.scrollTo` targets the one the
  //     browser nominates, but assigning `scrollTop` on BOTH documentElement and
  //     body is the long-standing way to hit whichever it is. Costs nothing when
  //     the first one already worked.
  //   * SMOOTH IGNORED. `behavior: 'smooth'` is silently dropped by some mobile
  //     browsers, and a dropped smooth scroll moves nothing at all. An instant
  //     jump has no such mode to lose.
  //
  // Fired twice, at 300ms and 800ms, because the reporter measured the page
  // settling around a quarter second after the tap. Two plain timeouts, no
  // cleverness: the first lands once things have popped in, the second corrects
  // for anything slower.
  useEffect(() => {
    if (!showCreate || !wantScrollRef.current) return;
    wantScrollRef.current = false;

    const jump = () => {
      const el = createRef.current;
      // The form sits above the (usually empty) list of streams you provide, so
      // the bottom of the page is at worst slightly past it — which the owner
      // confirmed is fine, and is the robust fallback if the ref is gone.
      const y = el
        ? el.getBoundingClientRect().top + (window.scrollY || window.pageYOffset || 0) - 12
        : document.documentElement.scrollHeight;
      const top = Math.max(0, y);
      window.scrollTo(0, top);
      document.documentElement.scrollTop = top;
      document.body.scrollTop = top;
    };

    const a = window.setTimeout(jump, 300);
    const b = window.setTimeout(jump, 800);
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, [showCreate]);
  // Adapter registration panels, relocated here from the old Adapters tab.
  const [showStreamAdapters, setShowStreamAdapters] = useState(false);
  const [showGameAdapters, setShowGameAdapters] = useState(false);
  const [newStreamName, setNewStreamName] = useState('');
  const [keepNameCase, setKeepNameCase] = useState(false);
  const [newStreamKind, setNewStreamKind] = useState<StreamKind>('simple');
  const nameChainTaken = useNamedNameTaken(
    contracts?.reads.registry as NamedNameRegistry | undefined,
    newStreamKind === 'named' ? submitNameOf(newStreamName, keepNameCase) : '',
  );
  // The 'named' tab exists only on a chain with the adapter wired.
  useEffect(() => {
    if (namedAdapterId === 0) setNewStreamKind((k) => (k === 'named' ? 'simple' : k));
  }, [namedAdapterId]);
  const [newStreamTarget, setNewStreamTarget] = useState('');
  // Cadence in MINUTES end-to-end: 60 = hourly (the contract floor), 1440 =
  // daily (the default), 10080 = weekly, 43200 = monthly.
  const [newStreamCadence, setNewStreamCadence] = useState<number>(1440);
  const [cadenceMode, setCadenceMode] = useState<'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'>('daily');
  const [customCadence, setCustomCadence] = useState<string>('');
  // Chainlink-only: reject the aggregator answer if older than this many
  // seconds (encoded as the adapter config). Default 3600 = 1 hour.
  const [maxFeedAge, setMaxFeedAge] = useState<string>('3600');
  // Generic community/official adapter path (registry IDs > 3). When the user
  // picks one of these extra tabs, newStreamKind becomes 'adapter' and the
  // chosen registry id is stored here; configHex carries optional raw config
  // bytes the adapter expects.
  const [selectedAdapterId, setSelectedAdapterId] = useState<number | null>(null);
  const [configHex, setConfigHex] = useState<string>('');
  const selectedAdapter = selectedAdapterId != null
    ? extraAdapters.find((a) => a.id === selectedAdapterId) ?? null
    : null;
  // Descriptor-driven create-stream config fields for community/official
  // adapters (the kind='adapter' path), cached per adapterId. A present-but-null
  // entry means "probed, no usable descriptor schema" so the form falls back to
  // the W5 generic advanced-config-hex field. The values map holds the creator's
  // per-field inputs (keyed by field key) and is reset whenever the picked
  // adapter changes.
  const [streamConfigFields, setStreamConfigFields] = useState<Map<number, ConfigField[] | null>>(new Map());
  const [streamFieldValues, setStreamFieldValues] = useState<Record<string, string>>({});
  const resolvingStreamConfig = React.useRef<Set<number>>(new Set());
  // Inline error for a descriptor-config encode failure in the create form
  // (the createError prop only covers the tx side).
  const [streamConfigError, setStreamConfigError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // The expanded row has two sub-views: the default (predict / vote / admin)
  // and a games view (the full per-game list). `gamesViewId` is the stream
  // currently showing its games view; null = default view. Toggled by the small
  // "games" pill on the row, which only appears when a stream hosts >1 game.
  const [gamesViewId, setGamesViewId] = useState<number | null>(null);
  const [valueInput, setValueInput] = useState('');
  const [setValueAction, setSetValueAction] = useState<{ streamId: number; status: 'pending' | 'success' | 'error'; message?: string } | null>(null);
  const [search, setSearch] = useState('');
  const [streamBounties, setStreamBounties] = useState<Map<number, BountyEntry[]>>(new Map());
  // + Bounty form state (creates a new bounty / re-funds existing token)
  const [bountyOpenFor, setBountyOpenFor] = useState<number | null>(null);
  const [bountyTokenAddr, setBountyTokenAddr] = useState('');
  const [bountyAmount, setBountyAmount] = useState('');
  const [bountyRate, setBountyRate] = useState('');
  const [bountyAction, setBountyAction] = useState<{ streamId: number; status: 'pending' | 'success' | 'error'; message?: string } | null>(null);
  // Two-step confirm gate on the Fund Bounty form. Set to the streamId when
  // the funder has filled the form and clicked Review; cleared on Confirm /
  // Cancel / form-input change. Surfaces the irrevocable-commit semantic
  // (item X) before the tx fires.
  const [bountyConfirmFor, setBountyConfirmFor] = useState<number | null>(null);
  // Top-up form state (adds to an existing (stream, token) pool)
  const [topUpKey, setTopUpKey] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpRate, setTopUpRate] = useState('');
  const [topUpAction, setTopUpAction] = useState<{ key: string; status: 'pending' | 'success' | 'error'; message?: string } | null>(null);
  // Per-(stream, token) cleanup action — fires `cleanupDrainedBountyToken`.
  const [cleanupAction, setCleanupAction] = useState<{ key: string; status: 'pending' | 'success' | 'error'; message?: string } | null>(null);

  // ---- Games-per-stream (W7) -------------------------------------------------
  // A stream can host MANY games: the built-in binary game (type 0) plus any
  // adapter games (type 1+). The list is lazy-loaded when a row expands and
  // cached per stream id so re-expands and sibling re-renders don't refetch.
  const [streamGames, setStreamGames] = useState<Map<number, GameWithId[]>>(new Map());
  const [gamesLoading, setGamesLoading] = useState<Set<number>>(new Set());

  // Resolve a game-type id to its registered adapter name. Type 0 has no
  // adapter (it's the built-in binary game) -> undefined, so gameKind() falls
  // through to 'binary'. Used to classify games (binary / yesno / generic).
  const adapterNameFor = useCallback(
    (gameTypeId: number): string | undefined => {
      if (gameTypeId === 0) return undefined;
      return gameAdapters.find((a) => a.id === gameTypeId)?.name;
    },
    [gameAdapters],
  );

  // Load (or reload) the games on a stream, caching by stream id. Forced
  // reloads (after createGame) pass force=true to bypass the cache.
  const loadStreamGames = useCallback(
    async (streamId: number, force = false) => {
      if (!force && streamGames.has(streamId)) return;
      setGamesLoading((prev) => new Set(prev).add(streamId));
      try {
        const games = await getGamesByStream(streamId);
        setStreamGames((prev) => new Map(prev).set(streamId, games));
      } finally {
        setGamesLoading((prev) => {
          const next = new Set(prev);
          next.delete(streamId);
          return next;
        });
      }
    },
    [getGamesByStream, streamGames],
  );

  // Eager-load each visible stream's games (cached) so the "games" pill can show
  // on COLLAPSED rows — a stream's game count must be known before expand. Keyed
  // on the visible id-set so it runs once per page, fetching uncached rows in
  // parallel; the functional setState dedups against concurrent lazy loads.
  const visibleIdsKey = streams.map((x) => x.id).join(',');
  useEffect(() => {
    let cancelled = false;
    const toLoad = streams.filter((x) => !streamGames.has(x.id));
    if (toLoad.length === 0) return;
    // Review #21: one batched call (2 multicall eth_calls total) instead of
    // 2 RPCs per visible stream.
    getGamesByStreams(toLoad.map((x) => x.id)).then((map) => {
      if (cancelled) return;
      setStreamGames((prev) => {
        const next = new Map(prev);
        map.forEach((games, sid) => { if (!next.has(sid)) next.set(sid, games); });
        return next;
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey]);

  // ---- Descriptor-resolved game UI (W7 Phase 2) ------------------------------
  // For each visible game we resolve its PREDICT/CREATE UI once via
  // resolveGameUI (probes the adapter's optional IGameUIDescriptor, falling back
  // to the gameTypes.ts heuristics). The result is cached per gameId so re-
  // expands and sibling re-renders never re-probe. resolveGameUI never throws,
  // so a missing/partial descriptor degrades to the W7 behavior, never regresses.
  const [resolvedGameUI, setResolvedGameUI] = useState<Map<number, ResolvedGameUI>>(new Map());
  // gameIds currently being resolved — dedupes concurrent probes for the same id.
  const resolvingGameUI = React.useRef<Set<number>>(new Set());
  const ensureGameUI = useCallback(
    async (game: GameWithId) => {
      if (!provider) return;
      if (resolvedGameUI.has(game.gameId) || resolvingGameUI.current.has(game.gameId)) return;
      resolvingGameUI.current.add(game.gameId);
      try {
        // Type-0 binary games need no adapter probe; for type>0 resolve the
        // adapter impl so the descriptor (if any) rides the same RPC list.
        let impl: string | undefined;
        if (game.gameTypeId !== 0 && contracts) {
          try {
            impl = await contracts.cached.live.games.gameAdapterFor(game.gameId);
          } catch {
            impl = undefined;
          }
        }
        const ui = await resolveGameUI({
          gameId: game.gameId,
          gameTypeId: game.gameTypeId,
          adapterName: adapterNameFor(game.gameTypeId),
          impl,
          provider,
        });
        setResolvedGameUI((prev) => new Map(prev).set(game.gameId, ui));
      } finally {
        resolvingGameUI.current.delete(game.gameId);
      }
    },
    [provider, contracts, resolvedGameUI, adapterNameFor],
  );

  // Resolve the UI for every game in every loaded stream (cached per gameId).
  useEffect(() => {
    streamGames.forEach((games) => {
      games.forEach((g) => { void ensureGameUI(g); });
    });
  }, [streamGames, ensureGameUI]);

  // ---- Descriptor-resolved stream-value display (Phase 2) --------------------
  // For each adapter stream (adapterId>0) we resolve its value display once via
  // resolveStreamAdapterUI (probes the adapter impl's optional
  // IStreamAdapterUIDescriptor for a valueDisplay(target,config) tuple, falling
  // back gracefully). The result is cached per streamId; in-flight probes are
  // deduped with a ref. Mirrors the W8 game-UI resolve above. resolveStreamAdapterUI
  // never throws, so a missing/partial descriptor degrades to the raw value
  // display (formatStreamValue(value, null)) — never a regression. Simple
  // streams (adapterId 0) need no probe.
  //
  // StreamBasic carries the stream's adapter config bytes (from the streams()
  // tuple), so we pass the real `config` — descriptor valueDisplays that read
  // it get the right bytes; the three reference valueDisplays use only `target`
  // (Chainlink reads decimals/description from it) and ignore config harmlessly.
  const [resolvedStreamUI, setResolvedStreamUI] = useState<Map<number, ResolvedStreamAdapterUI>>(new Map());
  const resolvingStreamUI = React.useRef<Set<number>>(new Set());
  const ensureStreamUI = useCallback(
    async (stream: StreamBasic) => {
      if (!provider || !contracts) return;
      if (stream.adapterId <= 0) return; // Simple stream — raw value, no probe.
      if (resolvedStreamUI.has(stream.id) || resolvingStreamUI.current.has(stream.id)) return;
      resolvingStreamUI.current.add(stream.id);
      try {
        let impl: string | undefined;
        try {
          impl = await contracts.cached.round.registry.adapter(stream.adapterId);
        } catch {
          impl = undefined;
        }
        const ui = await resolveStreamAdapterUI({
          adapterId: stream.adapterId,
          impl,
          target: stream.provider,
          config: stream.config,
          provider,
        });
        setResolvedStreamUI((prev) => new Map(prev).set(stream.id, ui));
        // Publish the orientation for surfaces that only have a streamId.
        rememberOrientation(stream.id, ui.valueDisplay);
      } finally {
        resolvingStreamUI.current.delete(stream.id);
      }
    },
    [provider, contracts, resolvedStreamUI],
  );

  // Resolve the value display for every adapter stream currently in the list
  // (cached per streamId). Depends on a stable id-set fingerprint rather than
  // the streams array reference so cascading parent re-renders don't re-probe
  // (the `streamIdsKey` used elsewhere is declared further down — recompute the
  // equivalent locally to avoid reordering existing code).
  const streamValueIdsKey = streams.map((s) => s.id).sort((a, b) => a - b).join(',');
  useEffect(() => {
    streams.forEach((s) => { void ensureStreamUI(s); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamValueIdsKey, ensureStreamUI]);

  // ---- Descriptor-driven create-stream config (community/official adapters) --
  // When the user selects an extra adapter tab (kind='adapter'), probe that
  // adapter's impl for a configSchema() once, caching the parsed ConfigField[]
  // (or null) per adapterId. impl comes straight from the useAdapters
  // enumeration (selectedAdapter.impl); target/config are omitted because only
  // configFields is consumed here. resolveStreamAdapterUI never throws — on
  // failure the entry stays absent and the form keeps the W5 hex path.
  useEffect(() => {
    if (newStreamKind !== 'adapter' || !selectedAdapter || !provider) return;
    const adapterId = selectedAdapter.id;
    if (streamConfigFields.has(adapterId) || resolvingStreamConfig.current.has(adapterId)) return;
    resolvingStreamConfig.current.add(adapterId);
    let cancelled = false;
    (async () => {
      try {
        const ui = await resolveStreamAdapterUI({
          adapterId,
          impl: selectedAdapter.impl,
          provider,
        });
        if (!cancelled) {
          setStreamConfigFields((prev) => new Map(prev).set(adapterId, ui.configFields));
        }
      } finally {
        resolvingStreamConfig.current.delete(adapterId);
      }
    })();
    return () => { cancelled = true; };
  }, [newStreamKind, selectedAdapter, provider, streamConfigFields]);

  // Per-descriptor-form predict inputs, keyed by gameId. Used when the resolved
  // UI exposes a non-discrete predictInput (kind 'number' / 'text').
  const [predictFormInput, setPredictFormInput] = useState<Map<number, string>>(new Map());

  // Per-game predict: direction-button kinds share one busy/result slot keyed
  // by gameId; generic kinds carry their own hex input keyed by gameId too.
  const [predictAction, setPredictAction] = useState<{ gameId: number; status: 'pending' | 'success' | 'error'; message?: string } | null>(null);
  const [genericPayload, setGenericPayload] = useState<Map<number, string>>(new Map());
  const handlePredictGame = useCallback(
    async (game: GameWithId, payloadHex: string) => {
      setPredictAction({ gameId: game.gameId, status: 'pending' });
      try {
        await predictGame(game.gameId, payloadHex);
        setPredictAction({ gameId: game.gameId, status: 'success', message: 'Prediction submitted.' });
      } catch (e: any) {
        setPredictAction({ gameId: game.gameId, status: 'error', message: e?.message ?? explainError(e) });
      }
    },
    [predictGame],
  );

  // Per-game vote. Voting BURNS the amount passed — it is not free, and the
  // "Vote eligible" button no longer votes on click: it opens the composer below,
  // which is where the amount is chosen and the burn is spelled out.
  const [voteGameId, setVoteGameId] = useState<number | null>(null);
  const handleVoteGame = useCallback((gameId: number, amount: string) => {
    setVoteGameId(gameId);
    return Promise.resolve(onVoteGame(gameId, amount)).finally(() => setVoteGameId(null));
  }, [onVoteGame]);

  // Which row (or game) currently has the vote composer open. Only one at a time —
  // it is a destructive action, and two open amount fields invite voting on the
  // wrong thing.
  const [votePanelFor, setVotePanelFor] = useState<{ kind: 'stream' | 'game'; id: number; name: string } | null>(null);

  // Create-game form state (one form per expanded stream; the picked type
  // drives whether a yes/no threshold or a generic config-hex editor shows).
  const [createGameType, setCreateGameType] = useState<number | ''>('');
  const [createGameName, setCreateGameName] = useState('');
  const [createGameThreshold, setCreateGameThreshold] = useState('');
  const [createGameConfigHex, setCreateGameConfigHex] = useState('');
  const [createGameAction, setCreateGameAction] = useState<{ streamId: number; status: 'pending' | 'success' | 'error'; message?: string } | null>(null);
  // Descriptor-driven create-game config fields, cached per gameTypeId. A
  // present-but-null entry means "probed, no usable descriptor schema" so the
  // form falls back to the gameTypes.ts heuristic (yes/no threshold or hex).
  // The field values map holds the creator's per-field inputs (keyed by field
  // key) and is reset whenever the selected type changes.
  const [createConfigFields, setCreateConfigFields] = useState<Map<number, ConfigField[] | null>>(new Map());
  const [createFieldValues, setCreateFieldValues] = useState<Record<string, string>>({});
  const resolvingConfigType = React.useRef<Set<number>>(new Set());

  // Probe the SELECTED game type's adapter for a configSchema() once, caching
  // the parsed ConfigField[] (or null) per gameTypeId. We resolve the adapter
  // impl straight from the useGameAdapters enumeration (gameAdapters[].impl) and
  // run resolveGameUI with a sentinel gameId — only configFields is consumed
  // here, and configSchema()/uiSchemaVersion() don't depend on a real gameId.
  // Never throws (resolveGameUI is graceful); on failure the entry stays absent
  // and the form keeps the heuristic path.
  useEffect(() => {
    if (createGameType === '') return;
    const typeId = Number(createGameType);
    if (typeId === 0) return; // built-in binary type isn't a create option
    if (!provider) return;
    if (createConfigFields.has(typeId) || resolvingConfigType.current.has(typeId)) return;
    const adapter = gameAdapters.find((a) => a.id === typeId);
    if (!adapter) return;
    resolvingConfigType.current.add(typeId);
    let cancelled = false;
    (async () => {
      try {
        const ui = await resolveGameUI({
          gameId: 0,
          gameTypeId: typeId,
          adapterName: adapter.name,
          impl: adapter.impl,
          provider,
        });
        if (!cancelled) {
          setCreateConfigFields((prev) => new Map(prev).set(typeId, ui.configFields));
        }
      } finally {
        resolvingConfigType.current.delete(typeId);
      }
    })();
    return () => { cancelled = true; };
  }, [createGameType, provider, gameAdapters, createConfigFields]);

  const handleCreateGame = useCallback(
    async (streamId: number) => {
      if (createGameType === '') {
        setCreateGameAction({ streamId, status: 'error', message: 'Pick a game type.' });
        return;
      }
      const name = createGameName.trim();
      if (!name) {
        setCreateGameAction({ streamId, status: 'error', message: 'Game name is required.' });
        return;
      }
      const typeId = Number(createGameType);
      const fields = createConfigFields.get(typeId) ?? null;
      let config: string;
      try {
        if (fields && fields.length > 0) {
          // Descriptor-driven: ABI-encode the per-field values in schema order.
          config = encodeConfigFromFields(fields, createFieldValues);
        } else {
          // Heuristic fallback (unchanged W7 behavior).
          const kind = gameKind(typeId, adapterNameFor(typeId));
          config = kind === 'yesno'
            ? encodeGameConfig('yesno', { threshold: createGameThreshold })
            : encodeGameConfig('generic', { configHex: createGameConfigHex.trim() || '0x' });
        }
      } catch (e: any) {
        setCreateGameAction({ streamId, status: 'error', message: e?.message ?? 'Invalid game config.' });
        return;
      }
      setCreateGameAction({ streamId, status: 'pending' });
      try {
        const newId = await createGame(streamId, typeId, config, name);
        setCreateGameAction({ streamId, status: 'success', message: `Created game #${newId}.` });
        setCreateGameType('');
        setCreateGameName('');
        setCreateGameThreshold('');
        setCreateGameConfigHex('');
        setCreateFieldValues({});
        await loadStreamGames(streamId, true);
      } catch (e: any) {
        setCreateGameAction({ streamId, status: 'error', message: e?.message ?? explainError(e) });
      }
    },
    [createGameType, createGameName, createGameThreshold, createGameConfigHex, createConfigFields, createFieldValues, adapterNameFor, createGame, loadStreamGames],
  );

  // Per-game rename (setGameName) for games the connected wallet authorities.
  const [renameGameInput, setRenameGameInput] = useState<{ gameId: number; value: string } | null>(null);
  const [renameGameAction, setRenameGameAction] = useState<{ gameId: number; status: 'pending' | 'success' | 'error'; message?: string } | null>(null);
  const handleRenameGame = useCallback(
    async (streamId: number, gameId: number) => {
      if (!renameGameInput || renameGameInput.gameId !== gameId) return;
      const next = renameGameInput.value.trim();
      if (!next) {
        setRenameGameAction({ gameId, status: 'error', message: 'Name cannot be empty.' });
        return;
      }
      setRenameGameAction({ gameId, status: 'pending' });
      try {
        await setGameName(gameId, next);
        setRenameGameAction({ gameId, status: 'success', message: `Renamed to "${next}".` });
        setRenameGameInput(null);
        await loadStreamGames(streamId, true);
      } catch (e: any) {
        setRenameGameAction({ gameId, status: 'error', message: e?.message ?? explainError(e) });
      }
    },
    [renameGameInput, setGameName, loadStreamGames],
  );

  // Per-game transfer-authority (setGameAuthority) for owned games.
  const [transferGameInput, setTransferGameInput] = useState<{ gameId: number; value: string } | null>(null);
  const [transferGameAction, setTransferGameAction] = useState<{ gameId: number; status: 'pending' | 'success' | 'error'; message?: string } | null>(null);
  const handleTransferGame = useCallback(
    async (streamId: number, gameId: number) => {
      if (!transferGameInput || transferGameInput.gameId !== gameId) return;
      const next = transferGameInput.value.trim();
      if (!ethers.isAddress(next)) {
        setTransferGameAction({ gameId, status: 'error', message: 'Enter a valid 0x address.' });
        return;
      }
      setTransferGameAction({ gameId, status: 'pending' });
      try {
        await setGameAuthority(gameId, next);
        setTransferGameAction({ gameId, status: 'success', message: `Authority transferred to ${shortAddress(next)}.` });
        setTransferGameInput(null);
        await loadStreamGames(streamId, true);
      } catch (e: any) {
        setTransferGameAction({ gameId, status: 'error', message: e?.message ?? explainError(e) });
      }
    },
    [transferGameInput, setGameAuthority, loadStreamGames],
  );

  // Lazily load merged-pool bounty details per stream. Bounties moved to the
  // SatoriBounties contract and are GAME-keyed (gameBountyTokenCount/
  // gameBountyTokens/pool/ratePerRound all take a gameId). The UI is stream-
  // primary, so we resolve each visible stream to its 1:1 binary gameId first
  // (one batched eth_call via the bridge), query the bounty contract by gameId,
  // then fold the results back into a Map keyed by STREAM id for display.
  // Depending on the streams array reference would cancel every load (parent
  // useStreamList re-creates the array on cascading state updates). Depend on a
  // stable id-set fingerprint + a manual refresh counter that bumps after
  // fundBounty calls.
  const [bountyRefresh, setBountyRefresh] = useState(0);
  const streamIdsKey = streams.map((s) => s.id).sort((a, b) => a - b).join(',');
  useEffect(() => {
    if (!contracts || streams.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        // Resolve each stream's 1:1 binary gameId. Bounty reads are game-keyed,
        // so we walk only streams that actually have a game (gameId > 0) and
        // remember the owning streamId to re-key results for display.
        const gameIdMap = await resolveGameIds(streams.map((s) => s.id));
        if (cancelled) return;
        const gameStreams = streams
          .map((s) => ({ streamId: s.id, gameId: gameIdMap.get(s.id) ?? 0 }))
          .filter((g) => g.gameId > 0);
        if (gameStreams.length === 0) { if (!cancelled) setStreamBounties(new Map()); return; }

        // PASSES 1-3: every registered (game, token) pair and its pool and rate.
        // The first load takes them from the indexer (a pair is registered while
        // no cleanup follows its latest fund or reclaim). Every refresh follows a
        // fund, top-up or cleanup, which the indexer may not have seen yet, so
        // those read the chain.
        type Pair = { streamId: number; gameId: number; token: string };
        let pairs: Pair[] = [];
        let poolOf: (p: Pair, i: number) => [bigint, bigint];
        const indexed = bountyRefresh === 0 ? await indexerBountyPairs() : null;
        if (cancelled) return;
        if (indexed && indexed.every((r) => r.pool != null && r.rateScaled != null && r.cleanedAfter != null)) {
          const streamOfGame = new Map(gameStreams.map((g) => [g.gameId, g.streamId]));
          const byKey = new Map<string, [bigint, bigint]>();
          for (const r of indexed) {
            const sid = streamOfGame.get(r.gameId);
            if (sid == null || r.cleanedAfter !== 0) continue;
            pairs.push({ streamId: sid, gameId: r.gameId, token: r.token });
            byKey.set(`${r.gameId}-${r.token}`, [r.pool!, r.rateScaled!]);
          }
          poolOf = (p) => byKey.get(`${p.gameId}-${p.token}`)!;
        } else {
          // PASS 1: token counts per game — one Multicall round-trip.
          const countReqs = gameStreams.map((g) => ({
            contract: contracts.bounties, fn: 'gameBountyTokenCount', args: [g.gameId], allowFailure: true,
          }));
          const countResults = await multicallRead(contracts.reads.multicall, countReqs);
          if (cancelled) return;

          // PASS 2: enumerate tokens for games with count > 0.
          type Slot = { streamId: number; gameId: number; idx: number };
          const tokenSlots: Slot[] = [];
          gameStreams.forEach((g, i) => {
            const n = Number(countResults[i] ?? 0);
            for (let j = 0; j < n; j++) tokenSlots.push({ streamId: g.streamId, gameId: g.gameId, idx: j });
          });
          const tokenReqs = tokenSlots.map((slot) => ({
            contract: contracts.bounties, fn: 'gameBountyTokens', args: [slot.gameId, slot.idx],
          }));
          const tokenResults = tokenReqs.length > 0
            ? await multicallRead(contracts.reads.multicall, tokenReqs)
            : [];
          if (cancelled) return;

          // PASS 3: pool + ratePerRound per (game, token), tracked by streamId.
          pairs = tokenSlots.map((slot, i) => ({
            streamId: slot.streamId,
            gameId: slot.gameId,
            token: (tokenResults[i] as string).toLowerCase(),
          }));
          const poolReqs = pairs.flatMap((p) => [
            { contract: contracts.bounties, fn: 'pool', args: [p.gameId, p.token] },
            { contract: contracts.bounties, fn: 'ratePerRound', args: [p.gameId, p.token] },
          ]);
          const poolResults = poolReqs.length > 0
            ? await multicallRead(contracts.reads.multicall, poolReqs)
            : [];
          if (cancelled) return;
          poolOf = (_p, i) => [BigInt(poolResults[i * 2].toString()), BigInt(poolResults[i * 2 + 1].toString())];
        }

        // PASS 4: ERC20 symbol + decimals for the unique token set.
        const uniqueTokens = Array.from(new Set(pairs.map((p) => p.token)));
        const erc20Iface = new ethers.Interface([
          'function symbol() view returns (string)',
          'function decimals() view returns (uint8)',
        ]);
        const metaCalls = uniqueTokens.flatMap((tok) => [
          { target: tok, allowFailure: true, callData: erc20Iface.encodeFunctionData('symbol', []) },
          { target: tok, allowFailure: true, callData: erc20Iface.encodeFunctionData('decimals', []) },
        ]);
        const metaResults = metaCalls.length > 0
          ? await contracts.multicall.aggregate3.staticCall(metaCalls)
          : [];
        if (cancelled) return;
        const metaByToken = new Map<string, { symbol: string; decimals: number }>();
        uniqueTokens.forEach((tok, i) => {
          const symRes = metaResults[i * 2];
          const decRes = metaResults[i * 2 + 1];
          let symbol = `${tok.slice(0, 6)}…${tok.slice(-4)}`;
          let decimals = 18;
          if (symRes?.success) {
            try { symbol = String(erc20Iface.decodeFunctionResult('symbol', symRes.returnData)[0]); }
            catch { /* keep short-form */ }
          }
          if (decRes?.success) {
            try { decimals = Number(erc20Iface.decodeFunctionResult('decimals', decRes.returnData)[0]); }
            catch { /* keep 18 */ }
          }
          metaByToken.set(tok, { symbol, decimals });
        });

        // ASSEMBLE: keep every entry from streamBountyTokens, flagging the
        // ones with both pool == 0 AND ratePerRound == 0 as `drained`. The
        // UI surfaces a "Clean up" button on drained rows; the contract's
        // `cleanupDrainedBountyToken` requires exactly that state.
        const next = new Map<number, BountyEntry[]>();
        pairs.forEach((p, i) => {
          const [pool, ratePerRound] = poolOf(p, i);
          const meta = metaByToken.get(p.token) ?? {
            symbol: `${p.token.slice(0, 6)}…${p.token.slice(-4)}`, decimals: 18,
          };
          const arr = next.get(p.streamId) ?? [];
          arr.push({
            token: p.token,
            symbol: meta.symbol,
            decimals: meta.decimals,
            pool,
            ratePerRound,
            drained: pool === BigInt(0) && ratePerRound === BigInt(0),
          });
          next.set(p.streamId, arr);
        });
        if (!cancelled) setStreamBounties(next);
      } catch (e) {
        console.warn('bounty load failed', e);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, streamIdsKey, bountyRefresh, resolveGameIds]);

  // Subscribe to on-chain bounty-mutation events so the list refreshes when
  // another address funds or cleans up a (game, token) pool — not just when
  // the local user does. `BountyFunded` and `BountyTokenCleaned` now live on
  // the SatoriBounties contract and are indexed by gameId; bounties.filters[*]()
  // with no args matches all and we bump the refresh counter for any hit.
  // ethers listener teardown via contract.off() to avoid the
  // .removeAllListeners surface.
  useEffect(() => {
    if (!contracts) return;
    const bump = () => setBountyRefresh((n) => n + 1);
    const fundedFilter = contracts.bounties.filters.BountyFunded();
    const cleanedFilter = contracts.bounties.filters.BountyTokenCleaned();
    contracts.bounties.on(fundedFilter, bump);
    contracts.bounties.on(cleanedFilter, bump);
    return () => {
      contracts.bounties.off(fundedFilter, bump);
      contracts.bounties.off(cleanedFilter, bump);
    };
  }, [contracts]);

  // Denominator for the per-stream SATORI payout share (the round's payable
  // budget, split by weight). Eligibility + weight are GAME-keyed now:
  // the old voting.streamWeight is gone. Sum gameWeight over the full eligible
  // GAME set (derived from voting.getGameWeights) rather than over just the loaded stream
  // page, so the share is correct even mid-pagination. Falls back to the
  // loaded-stream sum until the game-set total resolves.
  // The payout share now comes from useStreamList's `payoutPerRound`, which
  // uses the SAME numerator and denominator the contract does —
  // getGameVotesAtRound(gameId, govRound) / roundTotals(govRound), per
  // SatoriRewards._gameRoundAllocation.
  //
  // What used to be here summed the LIVE gameWeight over the LIVE eligible set.
  // Every part of that was the wrong number: the live heap is not the set the
  // chain settles on, and live weights move on every vote cast during the round
  // while the governing round's votes are frozen. Deleted rather than
  // repaired — the hook already fetches this correctly and once.

  const filtered = streams.filter((s) => {
    // Advanced "manage" mode lists only the streams you provide/author.
    if (variant === 'manage' && !(userAddress && s.provider.toLowerCase() === userAddress.toLowerCase())) return false;
    // Filter pill
    if (filter === 'eligible' && !isEligible(s.id)) return false;
    if (filter === 'favorites' && !isFavorite(s.id)) return false;
    if (filter === 'mine' && !(userAddress && s.provider.toLowerCase() === userAddress.toLowerCase())) return false;
    if (filter === 'bounties' && !streamBounties.has(s.id)) return false;

    // Search by stream name OR provider address (case-insensitive contains)
    const q = search.trim().toLowerCase();
    if (q) {
      const matchesName = s.name.toLowerCase().includes(q);
      const matchesProvider = s.provider.toLowerCase().includes(q);
      if (!matchesName && !matchesProvider) return false;
    }

    return true;
  });

  const handleCreate = () => {
    const name = newStreamName.trim();
    if (!name) return;
    // Resolve cadence: presets are direct minutes; "custom" reads the input as
    // DAYS (decimal) and converts to minutes, clamped to the contract's
    // 60-minute floor (anything below reverts InvalidCadence). A named stream
    // has no cadence to resolve — the picker is hidden for it, so a stale
    // custom entry from another kind must not be allowed to block the submit.
    let cadence = newStreamCadence;
    if (newStreamKind !== 'named' && cadenceMode === 'custom') {
      const parsed = parseFloat(customCadence);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      cadence = Math.max(60, Math.round(parsed * 1440));
    }
    if (newStreamKind === 'simple') {
      onCreateStream({ name, kind: 'simple', minCadenceMinutes: cadence });
    } else if (newStreamKind === 'named') {
      onCreateStream({ name: submitNameOf(newStreamName, keepNameCase), kind: 'named' });
    } else if (newStreamKind === 'adapter') {
      // Generic community/official adapter selected via an extra tab.
      const target = newStreamTarget.trim();
      if (!target || !selectedAdapterId) return;
      // Descriptor-driven config (if the adapter advertised a configSchema):
      // ABI-encode the per-field values in schema order. Otherwise keep the W5
      // generic advanced-config-hex field.
      const fields = streamConfigFields.get(selectedAdapterId) ?? null;
      let configHexToSend: string | undefined;
      if (fields && fields.length > 0) {
        try {
          configHexToSend = encodeConfigFromFields(fields, streamFieldValues);
        } catch (e: any) {
          setStreamConfigError(e?.message ?? 'Invalid adapter config.');
          return;
        }
      } else {
        configHexToSend = configHex.trim() || undefined;
      }
      setStreamConfigError(null);
      onCreateStream({
        name,
        kind: 'adapter',
        adapterId: selectedAdapterId,
        target,
        configHex: configHexToSend,
        minCadenceMinutes: cadence,
      });
    } else {
      const target = newStreamTarget.trim();
      if (!target) return;
      // Chainlink takes a max-feed-age (seconds); fall back to 3600 (1h) when
      // the input is blank or not a positive number.
      const parsedAge = parseInt(maxFeedAge, 10);
      const feedAge = Number.isFinite(parsedAge) && parsedAge > 0 ? parsedAge : 3600;
      onCreateStream({
        name,
        kind: newStreamKind,
        target,
        minCadenceMinutes: cadence,
        ...(newStreamKind === 'chainlink' ? { maxFeedAge: feedAge } : {}),
      });
    }
    setNewStreamName('');
    setKeepNameCase(false);
    setNewStreamTarget('');
    setCadenceMode('daily');
    setNewStreamCadence(1440);
    setCustomCadence('');
    setMaxFeedAge('3600');
    setSelectedAdapterId(null);
    setConfigHex('');
    setStreamFieldValues({});
    setStreamConfigError(null);
  };

  // Adapter-stream pull: permissionless. Anyone can call `updateValue` to
  // tick an Adapter stream; the cadence guards in the registry block early
  // calls, so the button reverts cleanly if pressed off-cadence.
  const [updateAction, setUpdateAction] = useState<{
    streamId: number; status: 'pending' | 'success' | 'error'; message?: string;
  } | null>(null);
  const handleUpdateValue = useCallback(async (streamId: number) => {
    if (!contracts) return;
    setUpdateAction({ streamId, status: 'pending' });
    try {
      const tx = await sendPreflighted(contracts.reads.registry, contracts.registry, 'updateValue', [streamId], userAddress);
      noteStreamWrite(streamId);
      await afterTx(tx);
      setUpdateAction({ streamId, status: 'success', message: 'Value updated from the adapter.' });
    } catch (e: any) {
      setUpdateAction({ streamId, status: 'error', message: explainError(e) });
    }
  }, [contracts, userAddress]);

  // BATCH pull. `registry.updateValues(uint32[])` ticks many adapter streams in one
  // transaction and costs ~77k gas per stream against ~150k for individual calls — about
  // half — because the shared state (satoriCore, satoriRewards, the adapter mapping, the
  // rewards contract's per-round slots) is cold once and warm for every stream after, and
  // getCurrentRound() collapses from N external calls to one. On an L2 the calldata saving
  // compounds it: one signed envelope instead of N.
  //
  // It serves EVERY adapter kind — Uniswap, Chainlink, Custom, anything registered later —
  // because they are all DataStreamType.Adapter dispatching through the same readValue.
  //
  // It is BEST-EFFORT on chain: a stream that is not due, has no adapter, or whose external
  // read fails is skipped rather than reverting the batch. We still pre-filter to the
  // streams the UI believes are due, for two reasons — smaller calldata, and an honest
  // count to compare the result against. The staticCall below returns how many WOULD take,
  // so the confirmation reports what actually happened instead of assuming.
  const [batchUpdateAction, setBatchUpdateAction] = useState<{
    status: 'pending' | 'success' | 'error'; message?: string;
  } | null>(null);

  // WHEN MAY A STREAM BE WRITTEN AGAIN — one helper trio every due/not-due
  // surface reads, so the batch buttons and the per-stream buttons can never
  // disagree. The cadence guard wants the last write's exact TIMESTAMP; the
  // stream list carries only its HOUR (`valueHour`, timestamp/3600), so the
  // hour floor stands in for it. That errs at most 59 minutes EARLY — the safe
  // direction: the preflight then names the real reason instead of the button
  // lying about availability.
  // TODO(hooks): read the exact lastUpdateTimestamp onto StreamBasic and pass
  // it here instead of valueHour * 3600.
  const nowSec = Math.floor(Date.now() / 1000);
  const tickableNow = (s: StreamBasic) =>
    canTickNow(s.valueHour, s.minCadenceMinutes, s.valueHour * 3600, nowSec);
  const nextTickAt = (s: StreamBasic) =>
    nextTickTime(s.valueHour, s.minCadenceMinutes, s.valueHour * 3600);
  /// A cadence gate lifts at a TIME now, not at a round — say the time.
  const fmtTickTime = (sec: number) =>
    new Date(sec * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Adapter streams the UI believes are tickable right now. Recomputed per render off the
  // same canTickNow the per-stream button uses, so the two can never disagree.
  const dueAdapterStreamIds = filtered
    .filter((s) => s.streamType === 1 && tickableNow(s))
    .map((s) => s.id);

  const handleUpdateValues = useCallback(async (ids: number[]) => {
    if (!contracts || ids.length === 0) return;
    setBatchUpdateAction({ status: 'pending' });
    try {
      // Simulate first: it surfaces a revert as its reason rather than as an encoding
      // error, AND hands back the count, which is the whole point of a best-effort call.
      const willUpdate = Number(
        await (contracts.reads.registry as any).updateValues.staticCall(ids, { from: userAddress }),
      );
      const tx = await (contracts.registry as any).updateValues(ids);
      await afterTx(tx);
      setBatchUpdateAction({
        status: 'success',
        message: willUpdate === ids.length
          ? `Updated ${willUpdate} stream${willUpdate === 1 ? '' : 's'} in one transaction.`
          : `Updated ${willUpdate} of ${ids.length}. The rest were not due yet or their source did not answer.`,
      });
    } catch (e: any) {
      setBatchUpdateAction({ status: 'error', message: explainError(e) });
    }
  }, [contracts, userAddress]);

  // Authority-only stream-management actions: rename and transfer authority.
  // Both fire on direct registry calls (no fee, no core hop).
  const [renameInput, setRenameInput] = useState<{ streamId: number; value: string } | null>(null);
  const [renameAction, setRenameAction] = useState<{
    streamId: number; status: 'pending' | 'success' | 'error'; message?: string;
  } | null>(null);
  const handleRename = useCallback(async (streamId: number) => {
    if (!contracts || !renameInput || renameInput.streamId !== streamId) return;
    const next = renameInput.value.trim();
    if (!next) {
      setRenameAction({ streamId, status: 'error', message: 'Name cannot be empty.' });
      return;
    }
    setRenameAction({ streamId, status: 'pending' });
    try {
      const tx = await sendPreflighted(contracts.reads.registry, contracts.registry, 'setDataStreamName', [streamId, next], userAddress);
      await afterTx(tx);
      setRenameAction({ streamId, status: 'success', message: `Renamed to "${next}".` });
      setRenameInput(null);
    } catch (e: any) {
      setRenameAction({ streamId, status: 'error', message: explainError(e) });
    }
  }, [contracts, renameInput, userAddress]);

  const [transferInput, setTransferInput] = useState<{ streamId: number; value: string } | null>(null);
  const [transferAction, setTransferAction] = useState<{
    streamId: number; status: 'pending' | 'success' | 'error'; message?: string;
  } | null>(null);
  // Transfer the value-provider role for a Simple stream. setAuthority is gone;
  // the registry now exposes setProvider(streamId, newProvider) and it only
  // applies to Simple streams (streamType === 0) — adapter streams read their
  // value from the on-chain adapter/provider, so there's no provider handoff.
  const handleTransferProvider = useCallback(async (streamId: number) => {
    if (!contracts || !transferInput || transferInput.streamId !== streamId) return;
    const next = transferInput.value.trim();
    if (!ethers.isAddress(next)) {
      setTransferAction({ streamId, status: 'error', message: 'Enter a valid 0x address.' });
      return;
    }
    setTransferAction({ streamId, status: 'pending' });
    try {
      const tx = await sendPreflighted(contracts.reads.registry, contracts.registry, 'setProvider', [streamId, next], userAddress);
      await afterTx(tx);
      setTransferAction({ streamId, status: 'success', message: `Provider transferred to ${shortAddress(next)}. Action takes effect immediately.` });
      setTransferInput(null);
    } catch (e: any) {
      setTransferAction({ streamId, status: 'error', message: explainError(e) });
    }
  }, [contracts, transferInput, userAddress]);

  const handleSetValue = useCallback(async (streamId: number) => {
    if (!contracts) return;
    const trimmed = valueInput.trim();
    if (!trimmed) return;
    let parsed: bigint;
    try {
      parsed = BigInt(trimmed);
    } catch {
      setSetValueAction({ streamId, status: 'error', message: 'Value must be a whole number' });
      return;
    }
    setSetValueAction({ streamId, status: 'pending' });
    try {
      const tx = await sendPreflighted(contracts.reads.registry, contracts.registry, 'setValue', [streamId, parsed], userAddress);
      noteStreamWrite(streamId);
      await afterTx(tx);
      setSetValueAction({ streamId, status: 'success', message: `Value set to ${parsed.toString()}` });
      setValueInput('');
    } catch (e: any) {
      setSetValueAction({ streamId, status: 'error', message: explainError(e) });
    }
  }, [contracts, valueInput, userAddress]);

  // BATCH PUSH — `registry.setValues(uint32[], int232[])` for a provider posting to many of
  // their own Simple streams at once. ~68k gas per stream against ~137k individually.
  //
  // ITS FAILURE SEMANTICS DIFFER FROM THE PULL BATCH, and the form is shaped around that.
  // `updateValues` skips everything it cannot do, because a keeper sweeping a public list
  // does not own it. `setValues` is the provider publishing their OWN data, so the contract
  // treats an unowned id, a bad id or a non-Simple stream as a BUG and
  // reverts the whole batch. Only the cadence guards skip.
  //
  // So this form only ever offers rows that cannot trigger that revert: Simple,
  // and provided by the connected address. And because a not-due row is SILENTLY SKIPPED
  // rather than rejected, it warns before sending — a provider who types a price and is told
  // "sent" has every reason to believe it landed.
  const [pushInputs, setPushInputs] = useState<Record<number, string>>({});
  const [batchSetAction, setBatchSetAction] = useState<{
    status: 'pending' | 'success' | 'error'; message?: string;
  } | null>(null);

  const pushableStreams = filtered.filter((s) =>
    s.streamType === 0 &&
    !!userAddress && s.provider.toLowerCase() === userAddress.toLowerCase());

  // Rows the provider actually filled in, split by whether the chain will take them now.
  const pushEntered = pushableStreams.filter((s) => (pushInputs[s.id] ?? '').trim() !== '');
  const pushDue = pushEntered.filter((s) => tickableNow(s));
  const pushNotDue = pushEntered.filter((s) => !tickableNow(s));

  const handleSetValues = useCallback(async () => {
    if (!contracts) return;
    const ids: number[] = [];
    const values: bigint[] = [];
    for (const s of pushDue) {
      const raw = (pushInputs[s.id] ?? '').trim();
      let parsed: bigint;
      try {
        parsed = BigInt(raw);
      } catch {
        setBatchSetAction({ status: 'error', message: `"${raw}" on ${s.name} is not a whole number.` });
        return;
      }
      ids.push(s.id);
      values.push(parsed);
    }
    if (ids.length === 0) return;
    setBatchSetAction({ status: 'pending' });
    try {
      // Simulate first. On this path a revert means a CALLER error (the batch would roll
      // back entirely), so catching it before it costs gas matters more than it does on
      // the pull side.
      const willWrite = Number(
        await (contracts.reads.registry as any).setValues.staticCall(ids, values, { from: userAddress }),
      );
      const tx = await (contracts.registry as any).setValues(ids, values);
      await afterTx(tx);
      setBatchSetAction({
        status: 'success',
        message: willWrite === ids.length
          ? `Wrote ${willWrite} value${willWrite === 1 ? '' : 's'} in one transaction.`
          : `Wrote ${willWrite} of ${ids.length}. The rest were not due yet, so those values were NOT stored.`,
      });
      setPushInputs((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
    } catch (e: any) {
      setBatchSetAction({ status: 'error', message: explainError(e) });
    }
  }, [contracts, userAddress, pushDue, pushInputs]);

  const toggleExpand = (streamId: number) => {
    if (expandedId === streamId) {
      if (gamesViewId === streamId) {
        // In the games sub-view → a tap anywhere on the row returns to the
        // default (predict / vote / admin) view rather than collapsing.
        setGamesViewId(null);
      } else {
        setExpandedId(null);
      }
    } else {
      setExpandedId(streamId);
      setGamesViewId(null);
      // Lazy-load this stream's games on first expand (cached thereafter) so the
      // "games" pill knows whether this stream has more than the binary game.
      loadStreamGames(streamId);
    }
    setValueInput('');
    setSetValueAction(null);
    setBountyOpenFor(null);
  };

  // Open the games sub-view directly (the small "games" pill on the row).
  const showGames = (streamId: number) => {
    setExpandedId(streamId);
    setGamesViewId(streamId);
    loadStreamGames(streamId);
  };

  /// Fund (or re-fund) a (game, token) bounty pool on an EXPLICIT gameId.
  /// `fundBounty` is the single GAME-keyed entry point on SatoriBounties; for a
  /// re-fund the proposed rate is weighted-averaged with the existing rate
  /// (quadratic). Caller pre-approves the BOUNTIES contract (the token custodian
  /// now — not rewards) for `amount` of `token`. This is the gameId-keyed core
  /// used both by the stream-primary path (binary game) and the per-adapter-game
  /// funding affordance.
  const fundBountyByGameId = useCallback(async (
    gameId: number, token: string, amount: bigint, proposedRate: bigint,
  ) => {
    if (!contracts) throw new Error('Not connected');
    if (!gameId) throw new Error('No game to fund a bounty on');

    // ONE transaction per press. Funding a new non-SATORI pair needs TWO
    // allowances on two different tokens with two different spenders — the
    // deposit to SatoriBounties, and the one-off SATORI posting burn to the HUB,
    // which `chargeBountyBurn` pulls. This only ever asked for the first, so a
    // first post reverted unless leftover allowance from an earlier stream
    // creation happened to cover it.
    // (docs/issues/closed/dapp-never-approves-the-bounty-posting-fee.md)
    //
    // The approvals are separate presses rather than chained signatures: a wallet
    // round trip unloads the page on mobile, so anything queued after the first
    // signature ceases to exist (`563a9539`).
    const [satoriAddress, bountiesAddress, hubAddress] = await Promise.all([
      contracts.reads.token.getAddress(),
      contracts.bounties.getAddress(),
      contracts.hub.getAddress(),
    ]);
    const steps = await planBountyFunding(
      { gameId, token, amount, satoriAddress, bountiesAddress, hubAddress },
      makeAllowanceReaders(contracts, userAddress),
    );
    if (steps.length > 0) {
      // One press: sign the outstanding allowances and let fundBountyWithPermit
      // consume them inside the same transaction. Signing is free and off-chain,
      // so this removes a wallet confirmation AND a gas payment.
      // Permit first, then wallet batching, then nothing — see
      // fundBountyOneConfirmation for why that order.
      const oneShot = userAddress
        ? await fundBountyOneConfirmation(contracts, userAddress, { gameId, token, amount, proposedRate }, steps)
        : null;
      if (oneShot) {
        if (oneShot.failed) throw new Error(oneShot.failed);
        if (oneShot.tx) await afterTx(oneShot.tx); else chainCache.invalidateAll();
        return { done: true as const };
      }

      // Neither route available. Fall back to approving one step at a time —
      // never two signatures in one press, which a wallet round trip on mobile
      // cannot survive.
      const step = steps[0];
      const erc20 = new ethers.Contract(
        step.token,
        ['function approve(address,uint256) returns (bool)'],
        (contracts.satori as any).runner,
      );
      await afterTx(await erc20.approve(step.spender, step.amount));
      return {
        done: false,
        message: steps.length > 1
          ? `${step.label.replace(/^Approve/, 'Approved')}. One more approval, then press again.`
          : `${step.label.replace(/^Approve/, 'Approved')}. Press again to fund.`,
      };
    }

    const tx = await sendPreflighted(contracts.reads.bounties, contracts.bounties, 'fundBounty', [gameId, token, amount, proposedRate], userAddress);
    await afterTx(tx);
    return { done: true as const };
  }, [contracts, userAddress]);

  /// Fund (or re-fund) a (game, token) bounty pool for a STREAM. The UI is
  /// stream-primary, so we resolve the stream's 1:1 binary gameId via the
  /// bridge first, then delegate to the gameId-keyed core.
  const fundBountyTx = useCallback(async (
    streamId: number, token: string, amount: bigint, proposedRate: bigint,
  ) => {
    const gameId = await resolveGameId(streamId);
    if (!gameId) throw new Error(`Stream #${streamId} has no game to fund a bounty on yet`);
    return fundBountyByGameId(gameId, token, amount, proposedRate);
  }, [resolveGameId, fundBountyByGameId]);

  const handleTopUp = useCallback(async (streamId: number, entry: BountyEntry) => {
    if (!contracts) return;
    const key = `${streamId}-${entry.token}`;
    const amtStr = topUpAmount.trim();
    const rateStr = topUpRate.trim();
    if (!amtStr || !rateStr) {
      setTopUpAction({ key, status: 'error', message: 'Amount and per-day rate are required' });
      return;
    }
    let amt: bigint;
    let rate: bigint;
    try {
      amt = ethers.parseUnits(amtStr, entry.decimals);
      rate = ethers.parseUnits(rateStr, entry.decimals);
    } catch {
      setTopUpAction({ key, status: 'error', message: 'Invalid amount or rate' });
      return;
    }
    setTopUpAction({ key, status: 'pending' });
    try {
      const res = await fundBountyTx(streamId, entry.token, amt, rate);
      if (!res.done) { setTopUpAction({ key, status: 'success', message: res.message }); return; }
      setTopUpAction({ key, status: 'success', message: 'Topped up' });
      setTopUpAmount('');
      setTopUpRate('');
      setTopUpKey(null);
      setBountyRefresh((n) => n + 1);
      publishDappEvent('bounty-funded', { streamId, token: entry.token });
    } catch (e: any) {
      setTopUpAction({ key, status: 'error', message: explainError(e) });
    }
  }, [contracts, topUpAmount, topUpRate, fundBountyTx]);

  /// Fire `cleanupDrainedBountyToken(gameId, token)` on the SatoriBounties
  /// contract (game-keyed; resolve the stream's 1:1 gameId first). Contract
  /// requires pool == 0 AND ratePerRound == 0 (asserted by the entry's
  /// `drained` flag); reverts otherwise. Permissionless — the caller pays gas
  /// and the only benefit is a smaller gameBountyTokens array on next read.
  const handleCleanup = useCallback(async (streamId: number, entry: BountyEntry) => {
    if (!contracts) return;
    const key = `${streamId}-${entry.token}`;
    setCleanupAction({ key, status: 'pending' });
    try {
      const gameId = await resolveGameId(streamId);
      if (!gameId) throw new Error(`Stream #${streamId} has no game`);
      const tx = await sendPreflighted(contracts.reads.bounties, contracts.bounties, 'cleanupDrainedBountyToken', [gameId, entry.token], userAddress);
      await afterTx(tx);
      setCleanupAction({ key, status: 'success', message: 'Cleaned up' });
      setBountyRefresh((n) => n + 1);
      publishDappEvent('bounty-token-cleaned', { streamId, token: entry.token });
    } catch (e: any) {
      setCleanupAction({ key, status: 'error', message: explainError(e) });
    }
  }, [contracts, resolveGameId, userAddress]);

  const handleCreateBounty = useCallback(async (streamId: number) => {
    if (!contracts) return;
    const tokenAddr = bountyTokenAddr.trim();
    if (!ethers.isAddress(tokenAddr)) {
      setBountyAction({ streamId, status: 'error', message: 'Invalid token address' });
      return;
    }
    if (!bountyAmount.trim() || !bountyRate.trim()) {
      setBountyAction({ streamId, status: 'error', message: 'Amount and per-day rate are required' });
      return;
    }
    // Token decimals unknown at this point; parse in 18 decimals as the
    // conventional default. Funders of non-18 tokens see the error from
    // the chain and can retry; a more rigorous flow would fetch decimals
    // before parsing, but the rewrite keeps the touch minimal.
    let amt: bigint;
    let rate: bigint;
    try {
      amt = ethers.parseEther(bountyAmount.trim());
      rate = ethers.parseEther(bountyRate.trim());
    } catch {
      setBountyAction({ streamId, status: 'error', message: 'Amounts must be valid numbers' });
      return;
    }
    setBountyAction({ streamId, status: 'pending' });
    try {
      const res = await fundBountyTx(streamId, tokenAddr, amt, rate);
      if (!res.done) { setBountyAction({ streamId, status: 'success', message: res.message }); return; }
      setBountyAction({ streamId, status: 'success', message: 'Bounty funded' });
      setBountyAmount('');
      setBountyRate('');
      setBountyTokenAddr('');
      setBountyOpenFor(null);
      setBountyRefresh((n) => n + 1);
      publishDappEvent('bounty-funded', { streamId, token: tokenAddr });
    } catch (e: any) {
      setBountyAction({ streamId, status: 'error', message: explainError(e) });
    }
  }, [contracts, bountyAmount, bountyRate, bountyTokenAddr, fundBountyTx]);

  // ---- Per-adapter-game bounty funding (C1) ----------------------------------
  // The stream-primary bounty form above funds the stream's 1:1 BINARY game.
  // Adapter games (gameTypeId > 0) are independent gameId-keyed pools, so they
  // need their own funding affordance that calls the gameId-keyed core directly
  // (no streamId -> binary-game resolution). The form is keyed by gameId; one is
  // open at a time. Token decimals are unknown here, so amounts parse in 18
  // decimals like handleCreateBounty (non-18 funders see the chain error and
  // retry — kept consistent with the existing minimal flow).
  const [gameBountyOpenFor, setGameBountyOpenFor] = useState<number | null>(null);
  const [gameBountyTokenAddr, setGameBountyTokenAddr] = useState('');
  const [gameBountyAmount, setGameBountyAmount] = useState('');
  const [gameBountyRate, setGameBountyRate] = useState('');
  const [gameBountyAction, setGameBountyAction] = useState<{ gameId: number; status: 'pending' | 'success' | 'error'; message?: string } | null>(null);
  const handleFundGameBounty = useCallback(async (streamId: number, gameId: number) => {
    if (!contracts) return;
    const tokenAddr = gameBountyTokenAddr.trim();
    if (!ethers.isAddress(tokenAddr)) {
      setGameBountyAction({ gameId, status: 'error', message: 'Invalid token address' });
      return;
    }
    if (!gameBountyAmount.trim() || !gameBountyRate.trim()) {
      setGameBountyAction({ gameId, status: 'error', message: 'Amount and per-day rate are required' });
      return;
    }
    let amt: bigint;
    let rate: bigint;
    try {
      amt = ethers.parseEther(gameBountyAmount.trim());
      rate = ethers.parseEther(gameBountyRate.trim());
    } catch {
      setGameBountyAction({ gameId, status: 'error', message: 'Amounts must be valid numbers' });
      return;
    }
    setGameBountyAction({ gameId, status: 'pending' });
    try {
      const res = await fundBountyByGameId(gameId, tokenAddr, amt, rate);
      if (!res.done) { setGameBountyAction({ gameId, status: 'success', message: res.message }); return; }
      setGameBountyAction({ gameId, status: 'success', message: 'Bounty funded' });
      setGameBountyAmount('');
      setGameBountyRate('');
      setGameBountyTokenAddr('');
      setGameBountyOpenFor(null);
      setBountyRefresh((n) => n + 1);
      publishDappEvent('bounty-funded', { streamId, token: tokenAddr });
    } catch (e: any) {
      setGameBountyAction({ gameId, status: 'error', message: explainError(e) });
    }
  }, [contracts, gameBountyTokenAddr, gameBountyAmount, gameBountyRate, fundBountyByGameId]);

  return (
    <div className="space-y-4" data-testid="streams-tab">
      {variant === 'vote' && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Voting burns tokens, and directs the attention of the entire network.
        </p>
      )}

      {/* Toolbar — search + Create */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 min-w-0">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none"
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or provider address"
            className="w-full bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded pl-8 pr-3 py-1.5 text-sm"
            data-testid="streams-search"
          />
        </div>
        {variant === 'manage' && (
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded text-sm font-medium transition-colors whitespace-nowrap"
            data-testid="btn-create-stream"
          >
            + Create Stream
          </button>
        )}
        {/* The same affordance on the vote tab, where people are actually
            looking at streams and thinking "I want one of these". The form lives
            on the advanced tab, so this hands off to the parent rather than
            toggling local state.
            Styled as an OUTLINE with a trailing arrow, deliberately unlike the
            solid "+ Create Stream" beside it on the manage tab. Solid-with-a-plus
            reads as "this does the thing"; this one takes you somewhere else to
            do it, and the shape should say so before the tab changes under
            you. */}
        {variant === 'vote' && onRequestCreate && (
          <button
            onClick={onRequestCreate}
            className="px-3 py-1.5 border border-green-600 text-green-700 dark:text-green-500 hover:bg-green-600 hover:!text-white rounded text-sm font-medium transition-colors whitespace-nowrap"
            data-testid="btn-create-stream-from-vote"
          >
            Create Stream &rarr;
          </button>
        )}
      </div>

      {/* BATCH PUSH — the provider's side. Only rendered in "manage" (which already lists
          just your own streams) and only when you have more than one pushable stream, since
          for a single stream the per-stream form below is simpler.

          Every row here is guaranteed Simple and yours, because anything else
          makes the contract revert the WHOLE batch rather than skip the row. Not-due rows
          are the one thing it skips silently, so they are called out before sending. */}
      {variant === 'manage' && pushableStreams.length > 1 && (
        <details className="card-themed p-3" data-testid="batch-push">
          <summary className="cursor-pointer text-sm font-medium">
            Post values to several streams at once ({pushableStreams.length} eligible)
          </summary>
          <div className="mt-3 space-y-2">
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              One transaction for all of them, about half the gas per stream. Leave a box empty
              to skip that stream.
            </p>
            {pushableStreams.map((s) => {
              const due = tickableNow(s);
              return (
                <div key={s.id} className="flex items-center gap-2" data-testid={`batch-push-row-${s.id}`}>
                  <span className="text-xs flex-1 min-w-0 truncate" title={s.name}>
                    {s.name} <span className="text-gray-500">#{s.id}</span>
                  </span>
                  {!due && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 whitespace-nowrap">
                      not due until {fmtTickTime(nextTickAt(s))}
                    </span>
                  )}
                  <input
                    type="text"
                    inputMode="numeric"
                    value={pushInputs[s.id] ?? ''}
                    onChange={(e) => setPushInputs((prev) => ({ ...prev, [s.id]: e.target.value }))}
                    placeholder="value"
                    disabled={batchSetAction?.status === 'pending'}
                    className="w-32 flex-shrink-0 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-sm"
                    data-testid={`batch-push-input-${s.id}`}
                  />
                </div>
              );
            })}

            {pushNotDue.length > 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400" data-testid="batch-push-notdue-warning">
                {pushNotDue.length} of the values you have entered {pushNotDue.length === 1 ? 'is' : 'are'} on a
                stream that is not due yet. The contract skips those silently. They will NOT be
                stored, and nothing will tell you afterwards except the count below.
              </p>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={handleSetValues}
                disabled={batchSetAction?.status === 'pending' || pushDue.length === 0}
                className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-sm font-medium transition-colors"
                data-testid="btn-batch-push"
              >
                {batchSetAction?.status === 'pending'
                  ? 'Posting…'
                  : `Post ${pushDue.length} value${pushDue.length === 1 ? '' : 's'}`}
              </button>
              {batchSetAction?.status === 'success' && batchSetAction.message && (
                <span className="text-xs text-green-700 dark:text-green-400" data-testid="batch-push-success">
                  {batchSetAction.message}
                </span>
              )}
              {batchSetAction?.status === 'error' && batchSetAction.message && (
                <span className="text-xs text-red-600 dark:text-red-400" data-testid="batch-push-error">
                  {batchSetAction.message}
                </span>
              )}
            </div>
          </div>
        </details>
      )}

      {/* BATCH PULL. Ticking adapter streams is permissionless and unpaid — the caller
          eats the gas because they want the data fresh — so the single biggest thing the
          UI can do for whoever does it is not make them pay N times. One transaction is
          about half the gas per stream (warm storage across the loop, plus one
          getCurrentRound instead of N) and one signed envelope on the L1 instead of N.

          Shown only when something is actually due, so it never invites a transaction
          that can only be a no-op. */}
      {dueAdapterStreamIds.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="batch-update-row">
          <button
            onClick={() => handleUpdateValues(dueAdapterStreamIds)}
            disabled={batchUpdateAction?.status === 'pending'}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-sm font-medium transition-colors whitespace-nowrap"
            data-testid="btn-update-all-due"
          >
            {batchUpdateAction?.status === 'pending'
              ? 'Refreshing…'
              : `Refresh ${dueAdapterStreamIds.length} due stream${dueAdapterStreamIds.length === 1 ? '' : 's'}`}
          </button>
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            One transaction, about half the gas per stream. No reward for doing it: you pay
            the gas, everyone gets the fresher data.
          </span>
          {batchUpdateAction?.status === 'success' && batchUpdateAction.message && (
            <span className="text-xs text-green-700 dark:text-green-400 w-full" data-testid="batch-update-success">
              {batchUpdateAction.message}
            </span>
          )}
          {batchUpdateAction?.status === 'error' && batchUpdateAction.message && (
            <span className="text-xs text-red-600 dark:text-red-400 w-full" data-testid="batch-update-error">
              {batchUpdateAction.message}
            </span>
          )}
        </div>
      )}

      {/* Adapter registration — relocated from the old Adapters tab. Hidden
          until the Create area is opened via "+ Create Stream". */}
      {showCreate && (
        <>
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setShowStreamAdapters((v) => !v)}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm font-medium transition-colors whitespace-nowrap"
          data-testid="btn-create-stream-adapter"
        >
          {showStreamAdapters ? '− Stream Adapters' : '+ Create Stream Adapter'}
        </button>
        <button
          onClick={() => setShowGameAdapters((v) => !v)}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm font-medium transition-colors whitespace-nowrap"
          data-testid="btn-create-game-adapter"
        >
          {showGameAdapters ? '− Game Adapters' : '+ Create Game Adapter'}
        </button>
      </div>

      {showStreamAdapters && (
        <div className="card-themed p-4" data-testid="stream-adapters-section">
          <h4 className="font-medium mb-2">Stream adapters</h4>
          <StreamAdaptersPanel />
        </div>
      )}
      {showGameAdapters && (
        <div className="card-themed p-4" data-testid="game-adapters-section">
          <h4 className="font-medium mb-2">Game adapters</h4>
          <GameAdaptersPanel />
        </div>
      )}
        </>
      )}

      {/* Create form */}
      {showCreate && (
        <div className="card-themed p-4 space-y-3" data-testid="create-form">
          <div>
            <h4 className="font-medium flex items-center justify-between gap-1.5">
              <span>Start your own stream</span>
              <InfoTip>
                A stream is a data feed people predict on. You pick where its value comes from
                (you update it yourself, or it reads from a contract, a Chainlink feed, a Uniswap
                pool, or a registered adapter) and how often it can change.
              </InfoTip>
            </h4>
            <p className="text-xs text-gray-400" data-testid="create-fee-line">
              {newStreamKind === 'named'
                ? 'Free — the name is coined on Coined if it isn’t already (gas only).'
                : `Costs ${streamCreationFee} SATORI (burned)`}
            </p>
          </div>

          {/* Type picker */}
          <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Stream type">
            {(['simple', ...(namedAdapterId ? ['named'] : []), 'custom', 'chainlink', 'uniswap'] as StreamKind[]).map((k) => (
              <button
                key={k}
                onClick={() => { setNewStreamKind(k); setSelectedAdapterId(null); setStreamFieldValues({}); }}
                className={`px-3 py-1 rounded text-sm capitalize transition-colors
                  ${newStreamKind === k
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                data-testid={`create-kind-${k}`}
              >
                {k}
              </button>
            ))}
            {/* Extra adapter tabs (registry IDs > 3). Selecting one switches the
                create path to the generic kind='adapter' route and stores the
                chosen adapter id. */}
            {extraAdapters.map((a) => {
              const active = newStreamKind === 'adapter' && selectedAdapterId === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => { setNewStreamKind('adapter'); setSelectedAdapterId(a.id); setStreamFieldValues({}); }}
                  className={`px-3 py-1 rounded text-sm transition-colors flex items-center gap-1.5
                    ${active
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                  data-testid={`create-adapter-${a.id}`}
                >
                  <span>{a.name || `Adapter #${a.id}`}</span>
                  <span
                    className={`text-[10px] px-1 py-0.5 rounded ${
                      a.isCommunity
                        ? 'text-orange-400 bg-orange-900/30'
                        : 'text-cyan-400 bg-cyan-900/30'
                    }`}
                  >
                    {a.isCommunity ? 'community' : 'official'}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Per-type explainer */}
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {newStreamKind === 'simple' && 'You become the authority and update the value manually, no faster than the cadence below.'}
            {newStreamKind === 'named' && 'Just a name. Its value is the network’s own net prediction flow on this stream’s daily game (UP adds, DOWN subtracts), snapshotted hourly and shown as a shape, never a number. Nothing to configure. One name, shared with Coined.'}
            {newStreamKind === 'custom' && 'Reads from a contract you deployed that implements getValue() returns int256.'}
            {newStreamKind === 'chainlink' && 'Reads from a Chainlink V3 price aggregator. Provide the aggregator address.'}
            {newStreamKind === 'uniswap' && 'Reads an 8-hour TWAP from a Uniswap V3 pool. Provide the pool address.'}
            {newStreamKind === 'adapter' && selectedAdapter &&
              `Reads from the "${selectedAdapter.name || `Adapter #${selectedAdapter.id}`}" ${selectedAdapter.isCommunity ? 'community' : 'official'} adapter. Provide the data-source address it reads from.`}
          </p>

          {/* Cadence picker — minimum MINUTES between updates. 60 (hourly) is
              the contract floor; 1440 is daily, 10080 weekly, 43200 monthly.
              A named stream is fixed at 60 by the registry — nothing to pick. */}
          {newStreamKind !== 'named' && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300 flex items-center justify-between gap-1.5">
              <span>How often it can change</span>
              <InfoTip>
                The minimum time between updates, recorded in minutes. Hourly (60 minutes) is the
                floor — nothing may update faster. Daily is 1440 minutes, Weekly 10080, Monthly
                43200. Custom lets you set the floor in days. This is the stream&apos;s own update
                pace; predictions are scored on the game&apos;s target duration, whatever the cadence.
              </InfoTip>
            </label>
            <div className="flex gap-1 flex-wrap" role="tablist" aria-label="Update cadence">
              {([
                { mode: 'hourly', cadence: 60, label: 'Hourly' },
                { mode: 'daily', cadence: 1440, label: 'Daily' },
                { mode: 'weekly', cadence: 10080, label: 'Weekly' },
                { mode: 'monthly', cadence: 43200, label: 'Monthly' },
                { mode: 'custom', cadence: 0, label: 'Custom' },
              ] as const).map((opt) => (
                <button
                  key={opt.mode}
                  onClick={() => {
                    setCadenceMode(opt.mode);
                    if (opt.mode !== 'custom') setNewStreamCadence(opt.cadence);
                  }}
                  className={`px-3 py-1 rounded text-sm transition-colors
                    ${cadenceMode === opt.mode
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
                  data-testid={`create-cadence-${opt.mode}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {cadenceMode === 'custom' && (() => {
              const days = parseFloat(customCadence);
              const validDays = Number.isFinite(days) && days > 0;
              // Days → minutes, clamped to the 60-minute contract floor.
              const cadenceMinutes = validDays ? Math.max(60, Math.round(days * 1440)) : null;
              return (
                <>
                  <input
                    type="number"
                    min="0.05"
                    step="any"
                    value={customCadence}
                    onChange={(e) => setCustomCadence(e.target.value)}
                    placeholder="Days between updates (e.g. 0.5, 1, 7, 30)"
                    className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
                    data-testid="input-stream-cadence-custom"
                  />
                  {cadenceMinutes !== null && (
                    <p className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="cadence-custom-preview">
                      → updates every {formatCadenceDays(cadenceMinutes)}.
                    </p>
                  )}
                </>
              );
            })()}
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              {cadenceMode === 'hourly' && 'Updates allowed at most once an hour — the floor. More updates means predictions can settle sooner (a prediction settles on the first value at least the game\u2019s target duration after it).'}
              {cadenceMode === 'daily' && 'Updates allowed at most once per day. A prediction settles on the first value published at least the game\u2019s target duration after it was made.'}
              {cadenceMode === 'weekly' && 'Updates allowed at most once per week. Predictions settle on the first value at least the game\u2019s target duration later — a slow cadence makes them wait for it.'}
              {cadenceMode === 'monthly' && 'Updates allowed at most once per month. Predictions settle on the first value at least the game\u2019s target duration later — a slow cadence makes them wait for it.'}
              {cadenceMode === 'custom' && 'Minimum days between updates (60 minutes is the floor). Predictions settle on the first value at least the game\u2019s target duration later.'}
            </p>
          </div>
          )}

          {createError && (
            <div className="p-2 bg-red-900/30 border border-red-700 rounded text-sm text-red-300">
              {createError}
            </div>
          )}

          {newStreamKind === 'named' ? (
            <NameSuggest
              value={newStreamName}
              keepCase={keepNameCase}
              chainTaken={nameChainTaken}
              onChange={(raw, keep) => { setNewStreamName(raw); setKeepNameCase(keep); }}
              streams={streams}
            />
          ) : (
          <input
            type="text"
            value={newStreamName}
            onChange={(e) => setNewStreamName(e.target.value)}
            placeholder="Stream name (e.g. SOL/USD)"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
            data-testid="input-stream-name"
          />
          )}

          {newStreamKind !== 'simple' && newStreamKind !== 'named' && (
            <input
              type="text"
              value={newStreamTarget}
              onChange={(e) => setNewStreamTarget(e.target.value)}
              placeholder={
                newStreamKind === 'custom' ? 'IDataStream contract address (0x…)'
                  : newStreamKind === 'chainlink' ? 'Chainlink aggregator address (0x…)'
                  : newStreamKind === 'adapter' ? 'Provider/data-source address (0x…)'
                  : 'Uniswap V3 pool address (0x…)'
              }
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
              data-testid="input-stream-target"
            />
          )}

          {/* Chainlink-only: max feed age (seconds), encoded into the adapter
              config. Older answers are rejected on read. */}
          {newStreamKind === 'chainlink' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
                Max feed age (seconds)
              </label>
              <input
                type="number"
                min="60"
                max="93600"
                value={maxFeedAge}
                onChange={(e) => setMaxFeedAge(e.target.value)}
                placeholder="3600"
                className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
                data-testid="input-stream-maxfeedage"
              />
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                Reject the Chainlink answer if older than this. Default 3600 = 1 hour.
                Must be 60s–26h (the adapter rejects values outside that range).
              </p>
            </div>
          )}

          {/* Generic adapter config. When the picked adapter advertises a
              descriptor configSchema(), render one input per ConfigField
              (number for int/uint types with min/max applied, text otherwise)
              and ABI-encode them on create. Otherwise fall back to the W5
              generic advanced-config-hex field. */}
          {newStreamKind === 'adapter' && selectedAdapterId != null && (() => {
            const fields = streamConfigFields.get(selectedAdapterId) ?? null;
            const hasDescriptorFields = !!(fields && fields.length > 0);
            if (hasDescriptorFields) {
              return (
                <div className="space-y-2">
                  <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
                    Adapter config
                  </label>
                  {fields!.map((field) => {
                    const isNumeric = /^u?int(\d+)?$/.test(field.type.trim());
                    return (
                      <div key={field.key} className="space-y-0.5">
                        <input
                          type={isNumeric ? 'number' : 'text'}
                          min={isNumeric ? field.min : undefined}
                          max={isNumeric ? field.max : undefined}
                          value={streamFieldValues[field.key] ?? ''}
                          onChange={(e) => setStreamFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                          placeholder={field.label || field.key}
                          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
                          data-testid={`input-streamconfig-${field.key}`}
                        />
                        {field.help && (
                          <p className="text-[11px] text-gray-500 dark:text-gray-400">{field.help}</p>
                        )}
                      </div>
                    );
                  })}
                  {streamConfigError && (
                    <p className="text-[11px] text-red-700 dark:text-red-300">{streamConfigError}</p>
                  )}
                </div>
              );
            }
            return (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Config (hex, advanced)
                </label>
                <input
                  type="text"
                  value={configHex}
                  onChange={(e) => setConfigHex(e.target.value)}
                  placeholder="0x… (optional, leave blank for none)"
                  className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
                  data-testid="input-stream-confighex"
                />
                <p className="text-[11px] text-gray-500 dark:text-gray-400">
                  Optional raw config bytes this adapter reads. Leave blank unless the adapter documents otherwise.
                </p>
              </div>
            );
          })()}

          {/* Both blockers are stated BEFORE the button, not discovered after
              filling the form in and signing. Each one used to surface only as a
              revert at the very end. */}
          {!canCreateStream && (
            <div
              className="p-3 rounded-lg text-sm bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300"
              data-testid="create-disabled-notice"
            >
              <strong>Stream creation is not enabled yet.</strong> The protocol launches
              with only predicting, voting and claiming switched on, and each further
              action is enabled deliberately by the admin.
            </div>
          )}
          {/* A named stream burns nothing, so the token lock cannot stop it. */}
          {canCreateStream && tokensLocked && newStreamKind !== 'named' && (
            <div
              className="p-3 rounded-lg text-sm bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300"
              data-testid="create-locked-notice"
            >
              {/* TWO rounds, not one, and the numbers must not be off by one.
                  Predicting in round R calls engineLock(user, R + 1), and the
                  token's gate blocks while `lockUntil >= currentRound` — so the
                  predict round AND the next are both locked, and the first free
                  round is lockUntil + 1. Verified on chain: predicted in 8,
                  lockUntil 9, locked in 8 and 9, free at 10. An earlier version
                  said "for the rest of the round", which is wrong, and named the
                  first free round as though it were still locked. */}
              <strong>
                Your tokens are locked
                {tokenLockedUntilRound > 0 && toDisplayRound
                  ? ` through round ${toDisplayRound(tokenLockedUntilRound)}`
                  : ' for this round'}.
              </strong>{' '}
              Predicting locks your balance for the round you predict in <em>and</em> the
              one after it, and creating a stream costs SATORI, so the two cannot overlap.
              {tokenLockedUntilRound > 0 && toDisplayRound
                ? ` You can create one from round ${toDisplayRound(tokenLockedUntilRound) + 1}.`
                : ' Try again once the lock lifts.'}
            </div>
          )}

          {/* TWO presses, never one.
              Creating a stream burns SATORI, so the hub needs an ERC-20
              allowance first. Doing both in one press cannot work on mobile: the
              signature request deep-links to the wallet app, which UNLOADS this
              page, and the create queued behind it never runs. It does not error
              — the code stops existing. That produced the worst report of the
              lot: one signature, no error anywhere, and no stream. */}
          {needsApproval && canCreateStream && !tokensLocked && newStreamKind !== 'named' ? (
            <>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Creating a stream burns{creationFee ? ` ${Number(creationFee).toFixed(2)}` : ''} SATORI,
                so this needs one approval first. Two steps, and you only do the approval once.
              </div>
              <button
                onClick={onApprove}
                disabled={creating || !onApprove}
                className="w-full px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-sm font-medium transition-colors"
                data-testid="btn-approve-stream"
              >
                {creating ? 'Approving…' : 'Step 1: approve SATORI'}
              </button>
            </>
          ) : (
            <button
              onClick={handleCreate}
              disabled={
                creating
                  || !canCreateStream
                  || (tokensLocked && newStreamKind !== 'named')
                  || !newStreamName.trim()
                  || (newStreamKind === 'named' && !!nameBlocker(streams, newStreamName, keepNameCase, nameChainTaken))
                  || (newStreamKind !== 'simple' && newStreamKind !== 'named' && !newStreamTarget.trim())
                  || (newStreamKind === 'adapter' && !selectedAdapterId)
              }
              className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-sm font-medium transition-colors"
              data-testid="btn-confirm-create"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          )}
        </div>
      )}

      {/* Filter pills */}
      <div className="flex gap-1 flex-wrap">
        {(['all', 'eligible', 'favorites', 'mine', 'bounties'] as Filter[])
          .filter((f) => !(variant === 'manage' && f === 'mine'))
          .map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded text-sm capitalize transition-colors
              ${filter === f
                ? 'bg-blue-600 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'}`}
            data-testid={`filter-${f}`}
          >
            {f === 'eligible' ? 'rewarding' : f}
          </button>
        ))}
      </div>

      {/* Stream list */}
      <div className="space-y-1.5">
        {filtered.map((s) => {
          const eligible = isEligible(s.id);
          const payout = payoutPerRound(s.id);
          const isOwner = !!(userAddress && s.provider.toLowerCase() === userAddress.toLowerCase());
          const expanded = expandedId === s.id;
          const inGamesView = expanded && gamesViewId === s.id;
          const gameCount = streamGames.get(s.id)?.length ?? 0;
          const action = setValueAction?.streamId === s.id ? setValueAction : null;
          // Descriptor-resolved value display for this adapter stream (cached per
          // streamId; resolved by the effect above). When the adapter advertises
          // a valueDisplay (decimals/unit/label) we format the raw value through
          // it; otherwise we keep the existing compact rendering so Simple
          // streams and undescribed adapters never regress.
          const streamUI = resolvedStreamUI.get(s.id) ?? null;
          // streamValueDisplayFor supplies stream 1's percentage display: it is
          // a Simple stream, so the probe returns null and the raw 1e18-scaled
          // ratio would print as "420000000000000000".
          const valueDisplay = streamValueDisplayFor(s.id, streamUI?.valueDisplay ?? null);
          // A stream that has never had a value stamped (valueHour 0) has no
          // reading to show — and MUST NOT be run through the tick->price
          // conversion, which turns the sentinel 0 into 1.0001^0 * decimals =
          // ~1e12 ("a billion USDC per WETH"). Adapter streams are created empty
          // and stay so until someone pulls the first value. Stream 1 (the
          // default) is always freshly flushed, so it is never in this state.
          const hasValue = s.valueHour > 0 || s.id === DEFAULT_STREAM_ID;
          // A named stream's value is the network's signed prediction flow:
          // only its sign is shown here, never the number. The chart carries
          // the change against the previous hour; this row has no previous
          // observation, so it is worded as a sign, not an arrow.
          const valueText = !hasValue
            ? '—'
            : s.isNamed
              ? leanSignLabel(s.currentValue)
              : valueDisplay
                ? formatStreamValue(s.currentValue, valueDisplay)
                : formatCompact(s.currentValue);
          return (
            <div
              key={s.id}
              className="card-themed !p-0 overflow-hidden"
              data-testid={`stream-row-${s.id}`}
            >
              <div
                className="px-3 py-2 flex items-start gap-3 cursor-pointer"
                onClick={() => toggleExpand(s.id)}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); onToggleFavorite(s.id); }}
                  className="text-lg leading-none flex-shrink-0 pt-0.5"
                >
                  {isFavorite(s.id) ? (
                    <span className="text-yellow-400">&#9733;</span>
                  ) : (
                    <span className="text-gray-500 hover:text-yellow-400">&#9734;</span>
                  )}
                </button>

                {/* Left column: name (with tags inline) / address / eligibility */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium truncate">{s.name}</span>
                    {s.minCadenceMinutes > 0 && (
                      <InfoTip trigger={
                        <span className="text-xs text-purple-400 bg-purple-900/30 px-1.5 py-0.5 rounded">
                          {formatCadenceLabel(s.minCadenceMinutes)}
                        </span>
                      }>
                        Updates every {formatCadenceDays(s.minCadenceMinutes)}
                      </InfoTip>
                    )}
                    {s.streamType === 1 && (s.isNamed ? (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded text-pink-400 bg-pink-900/30"
                        title="A stream that is just a name: its value is the network's own prediction flow, shown as a shape, never a number."
                        data-testid={`stream-named-${s.id}`}
                      >
                        named
                      </span>
                    ) : (
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          s.isCommunityAdapter
                            ? 'text-orange-400 bg-orange-900/30'
                            : 'text-cyan-400 bg-cyan-900/30'
                        }`}
                        title={
                          s.isCommunityAdapter
                            ? 'Community-registered adapter (permissionless path).'
                            : 'Official adapter (registered by the protocol owner).'
                        }
                      >
                        {s.isCommunityAdapter ? 'community' : 'official'}
                      </span>
                    ))}
                    {isOwner && (
                      <span className="text-xs text-blue-400 bg-blue-900/30 px-1.5 py-0.5 rounded">owner</span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 font-mono truncate">
                    #{s.id} · {shortAddress(s.provider)}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    {/* Games are BORN unapproved (opt-in; an admin approves
                        them). An unapproved game earns nothing no matter how it
                        was voted, and its voters keep their weight and can
                        re-point it via Move votes — so say so first, ahead of
                        the rewarding/not-rewarding pill, which would otherwise
                        read as "just needs more votes". */}
                    {!s.approved && (
                      <span
                        className="text-xs text-amber-800 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700/50 px-1.5 py-0.5 rounded"
                        title="This game is not approved (games start unapproved; an admin approves them), so it earns no rewards yet. Your vote is untouched, and you can move its weight to an approved game whenever you like."
                        data-testid="badge-not-approved"
                      >
                        not approved
                      </span>
                    )}
                    {/* A stream with NO value yet can't be predicted on at all,
                        so it is neither rewarding nor "not rewarding — needs
                        votes"; it needs its first reading pulled. Say that
                        instead, or the badge claims "rewarding" on a stream the
                        predict flow will refuse (the empty WETH/USDC case). */}
                    {!hasValue ? (
                      <span className="text-xs text-amber-800 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700/50 px-1.5 py-0.5 rounded" title="This stream has no value yet. Someone must pull its first reading (Update) before it can be predicted on or earn.">awaiting first value</span>
                    ) : eligible ? (
                      <span className="text-xs text-green-400 bg-green-900/30 px-1.5 py-0.5 rounded" title="This data stream rewards predictors because it's been voted up high enough.">rewarding</span>
                    ) : (
                      <span className="text-xs text-gray-500 bg-gray-700/50 px-1.5 py-0.5 rounded" title="This data stream doesn't reward predictors yet because it hasn't been voted up high enough.">not rewarding</span>
                    )}
                    {/* "games" pill — only when this stream hosts more than the
                        built-in binary game. Tapping it opens the games sub-view;
                        tapping anywhere else on the row stays on the default view. */}
                    {gameCount > 1 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); inGamesView ? setGamesViewId(null) : showGames(s.id); }}
                        className={`text-xs px-1.5 py-0.5 rounded transition-colors ${inGamesView ? 'bg-blue-600 !text-white' : 'bg-blue-900/30 text-blue-300 hover:bg-blue-900/50'}`}
                        data-testid={`btn-games-${s.id}`}
                      >
                        {inGamesView ? '✕ games' : `games (${gameCount})`}
                      </button>
                    )}
                  </div>
                </div>

                {/* Right column: value / weight / payout per round (payable budget basis) */}
                <div className="text-right whitespace-nowrap flex-shrink-0">
                  <div className="font-medium" data-testid={`stream-value-${s.id}`}>{valueText}</div>
                  {/* The unit for the reading above. For a tick stream the
                      descriptor's own label describes the tick, which is no longer
                      what the value shows — so the price unit wins. */}
                  {(() => {
                    const unit = !hasValue ? null
                      : s.isNamed ? 'network lean'
                      : (orientationOf(valueDisplay).unitLabel || valueDisplay?.label);
                    return unit ? (
                      <div className="text-[10px] text-gray-400 dark:text-gray-500 truncate max-w-[10rem] ml-auto" title={unit}>
                        {unit}
                      </div>
                    ) : null;
                  })()}
                  {/* Never round a real vote to "0". trimZeros(_, 1) turned a
                      genuine 0.000101 weight into "0 weight", so a successful
                      vote read as a failed one. Show enough precision that any
                      nonzero weight is visibly nonzero. */}
                  <div className="text-xs text-gray-500">{formatWeight(s.weight / 1e18)} weight</div>
                  <div className="mt-0.5">
                    {/* A DASH, not 0.0, before the round is snapshotted. The
                        frozen set and roundTotals are written by the round's
                        first prediction, so until then every stream computes to
                        zero — which reads as "earns nothing" when it means "not
                        decided yet". A stream holding live vote weight showing
                        0.0 is how this surfaced. */}
                    <span
                      className={`text-xs px-1.5 py-0.5 rounded ${govSnapshotTaken
                        ? 'text-green-400 bg-green-900/30'
                        : 'text-gray-400 bg-gray-700/40'}`}
                      data-testid={`payout-${s.id}`}
                      title={govSnapshotTaken
                        ? 'SATORI this stream is on track to pay this round, on the votes cast so far. It moves as other streams are voted for.'
                        : 'Nobody has predicted this round yet, so nothing is allocated. Vote weight is already counting.'}
                    >
                      {govSnapshotTaken ? trimZeros(payout) : '—'}
                    </span>
                  </div>
                </div>

                {/* Compact vote button pinned to the far right of the row (Vote
                    tab only); value/weight/payout sit to its left. Hidden while
                    stopPropagation so it votes without toggling the row's expand.
                    There is no "remove" counterpart: a vote BURNS SATORI, so it
                    cannot be withdrawn. */}
                {variant === 'vote' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setVotePanelFor(votePanelFor?.kind === 'stream' && votePanelFor.id === s.id
                        ? null
                        : { kind: 'stream', id: s.id, name: s.name });
                    }}
                    disabled={voting}
                    className="self-center flex-shrink-0 w-20 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed disabled:opacity-60 !text-white text-xs font-medium rounded transition-colors"
                    data-testid={`btn-vote-up-${s.id}`}
                  >
                    {voting ? '…' : 'Vote'}
                  </button>
                )}
              </div>

              {/* Vote composer for this row. A vote BURNS SATORI, so the button
                  above only opens this — it never votes on click. */}
              <div className="px-3 pb-2">
                {votePanelFor?.kind === 'stream' && votePanelFor.id === s.id && (
                    <VotePanel
                      streamName={votePanelFor.name}
                      balance={voterBalance}
                      allowance={voterHubAllowance}
                      canSign={voterCanSign}
                      busy={voting}
                      error={voteError}
                      onApprove={(amt) => onApproveVote(amt)}
                      onVote={(amt) => { Promise.resolve(onVote(s.id, amt)).then((ok) => { if (ok) setVotePanelFor(null); }); }}
                      onCancel={() => setVotePanelFor(null)}
                      testIdSuffix={s.id}
                      approved={s.approved}
                      sourceStreamId={s.id}
                      moveTargets={streams.filter((x) => x.approved).map((x) => ({ streamId: x.id, name: x.name }))}
                      onMoved={() => setVotePanelFor(null)}
                    />
                  )}
              </div>

              {/* Bounty summary lines on the row (collapsed view). One line per
                  token; drained tokens render dimmed with a "drained" tag so
                  the row still surfaces they can be cleaned up. Always visible. */}
              {streamBounties.has(s.id) && (
                <div className="px-3 pb-2 -mt-1 flex items-start gap-3" data-testid={`bounty-summary-${s.id}`}>
                  {/* Invisible spacer matches the row header's star icon so
                      the bounty lines line up with the stream name above. */}
                  <span className="text-lg leading-none flex-shrink-0 pt-0.5 invisible" aria-hidden>&#9734;</span>
                  <div className="flex-1 min-w-0 space-y-0.5">
                    {streamBounties.get(s.id)!.map((entry) => (
                      <div
                        key={entry.token}
                        className={`flex items-center justify-between text-xs ${entry.drained ? 'text-gray-400 dark:text-gray-500' : 'text-green-600 dark:text-green-300'}`}
                        title={entry.drained
                          ? 'Pool drained, eligible for cleanup'
                          : 'Irrevocable bounty pool, drips daily to correct predictors'}
                      >
                        <span className="font-medium">{entry.symbol}{entry.drained && ' · drained'}</span>
                        <span>{fmtUnits(dripPerRound(entry), entry.decimals)} / {fmtUnits(entry.pool, entry.decimals)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Expanded panel: bounty section → vote section → set value (owner) */}
              {expanded && (
                <div className="p-3 pt-0 space-y-3">
                  {/* Default sub-view: bounties + predict + adapter tick + admin
                      + set value + vote. The full games list is gated behind the
                      "games" pill (inGamesView) so it isn't dumped on every row. */}
                  {!inGamesView && (<>
                  {/* Per-(stream, token) merged pool with Top-up button. */}
                  {streamBounties.has(s.id) && (
                    <div className="space-y-2">
                      {streamBounties.get(s.id)!.map((entry) => {
                        const key = `${s.id}-${entry.token}`;
                        const isOpen = topUpKey === key;
                        const act = topUpAction?.key === key ? topUpAction : null;
                        const cleanAct = cleanupAction?.key === key ? cleanupAction : null;
                        // Drained rows swap the Top-up affordance for a
                        // permissionless Clean Up button calling
                        // cleanupDrainedBountyToken. This is the ONLY way a
                        // drained token is pruned — the score path never
                        // evicts drained tokens.
                        if (entry.drained) {
                          return (
                            <div key={entry.token} className="rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 p-2 space-y-1">
                              <div className="flex items-center justify-between gap-2 text-xs font-medium text-gray-500 dark:text-gray-400">
                                <span>{entry.symbol} · drained</span>
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleCleanup(s.id, entry); }}
                                  disabled={cleanAct?.status === 'pending'}
                                  className="px-2 py-1 bg-gray-500 hover:bg-gray-600 disabled:bg-gray-400 !text-white rounded text-xs font-medium transition-colors"
                                  data-testid={`btn-cleanup-${key}`}
                                >
                                  {cleanAct?.status === 'pending' ? '…' : 'Clean up'}
                                </button>
                              </div>
                              <p className="text-[10px] text-gray-500 dark:text-gray-400 px-1">
                                Permissionless. Removes this drained token from the stream's bounty list. Nothing else prunes it automatically.
                              </p>
                              {cleanAct?.status === 'error' && cleanAct.message && (
                                <div className="mt-1 px-1 text-red-700 dark:text-red-300 text-xs">{cleanAct.message}</div>
                              )}
                              {cleanAct?.status === 'success' && cleanAct.message && (
                                <div className="mt-1 px-1 text-green-700 dark:text-green-300 text-xs">{cleanAct.message}</div>
                              )}
                            </div>
                          );
                        }
                        return (
                          <div key={entry.token} className="rounded border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-2 space-y-1">
                            <div className="flex items-center justify-between gap-2 text-xs font-medium text-green-600 dark:text-green-300">
                              <span>{entry.symbol}</span>
                              <div className="flex items-center gap-2">
                                <span>{fmtUnits(dripPerRound(entry), entry.decimals)} / {fmtUnits(entry.pool, entry.decimals)}</span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setTopUpKey(isOpen ? null : key);
                                    setTopUpAmount('');
                                    setTopUpRate('');
                                    setTopUpAction(null);
                                  }}
                                  className="px-2 py-1 bg-blue-600 hover:bg-blue-700 !text-white rounded text-xs font-medium transition-colors"
                                  data-testid={`btn-add-bounty-${key}`}
                                >
                                  {isOpen ? 'Cancel' : 'Top up'}
                                </button>
                              </div>
                            </div>
                            {isOpen && (
                              <div className="mt-1 space-y-1 px-1">
                                <div className="flex gap-2">
                                  <input
                                    type="text"
                                    value={topUpAmount}
                                    onChange={(e) => setTopUpAmount(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    placeholder={`Amount (${entry.symbol})`}
                                    className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                                    data-testid={`topup-amount-${key}`}
                                  />
                                  <input
                                    type="text"
                                    value={topUpRate}
                                    onChange={(e) => setTopUpRate(e.target.value)}
                                    onClick={(e) => e.stopPropagation()}
                                    placeholder="Per day"
                                    className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                                    data-testid={`topup-rate-${key}`}
                                  />
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleTopUp(s.id, entry); }}
                                    disabled={!topUpAmount.trim() || !topUpRate.trim() || act?.status === 'pending'}
                                    className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                                    data-testid={`btn-topup-${key}`}
                                  >
                                    {act?.status === 'pending' ? '…' : 'Confirm'}
                                  </button>
                                </div>
                                <p className="text-[10px] text-gray-500 dark:text-gray-400">
                                  Per-day rate is re-pledged on every top-up. The pool's stored rate is the quadratic weighted average of all funders' rates.
                                </p>
                              </div>
                            )}
                            {act?.status === 'error' && act.message && (
                              <div className="mt-1 px-1 text-red-700 dark:text-red-300 text-xs">{act.message}</div>
                            )}
                            {act?.status === 'success' && act.message && (
                              <div className="mt-1 px-1 text-green-700 dark:text-green-300 text-xs">{act.message}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Fund Bounty + Predict, side by side. Fund Bounty opens the
                      bounty form just below; it's hidden while that form is open,
                      so Predict goes full-width. Predict jumps to this stream in
                      the top prediction flow. */}
                  <div className="flex gap-2">
                    {bountyOpenFor !== s.id && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setBountyOpenFor(s.id);
                          setBountyAction(null);
                        }}
                        className="flex-1 py-2 bg-green-400 hover:bg-green-500 !text-white text-sm font-medium rounded transition-colors"
                        data-testid={`btn-open-bounty-${s.id}`}
                      >
                        + Fund Bounty
                      </button>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); onPredictStream(s.id); }}
                      className="flex-1 py-2 bg-blue-400 hover:bg-blue-500 !text-white text-sm font-medium rounded transition-colors"
                      data-testid={`btn-predict-${s.id}`}
                    >
                      Predict
                    </button>
                  </div>

                  {/* + Bounty form (sits where the button was) */}
                  {bountyOpenFor === s.id && (
                    <div className="space-y-2 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded p-3" data-testid={`bounty-form-${s.id}`}>
                      <div className="text-xs text-green-700 dark:text-green-300 flex items-start justify-between gap-1.5">
                        <span>Add a prize for sharp predictors here.</span>
                        <InfoTip>
                          Fund a bounty for predictors on this stream. <strong>Irrevocable</strong>: once committed, the only egress is drips to correct predictors (daily, one per 24-hour round). Pick the ERC-20 token, total amount, and per-day release rate.
                        </InfoTip>
                      </div>
                      <input
                        type="text"
                        value={bountyTokenAddr}
                        onChange={(e) => setBountyTokenAddr(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="Token contract address (0x…)"
                        className="w-full bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
                        data-testid={`bounty-token-addr-${s.id}`}
                      />
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={bountyAmount}
                          onChange={(e) => setBountyAmount(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="Total amount"
                          className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-3 py-2 text-sm"
                          data-testid={`bounty-amount-${s.id}`}
                        />
                        <input
                          type="text"
                          value={bountyRate}
                          onChange={(e) => setBountyRate(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="Per day"
                          className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-3 py-2 text-sm"
                          data-testid={`bounty-rate-${s.id}`}
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); setBountyConfirmFor(s.id); setBountyAction(null); }}
                          disabled={
                            !bountyAmount.trim() || !bountyRate.trim() ||
                            !ethers.isAddress(bountyTokenAddr) ||
                            bountyAction?.status === 'pending'
                          }
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-sm font-medium transition-colors whitespace-nowrap"
                          data-testid={`btn-create-bounty-${s.id}`}
                        >
                          {bountyAction?.streamId === s.id && bountyAction.status === 'pending' ? 'Funding…' : 'Review →'}
                        </button>
                      </div>

                      {/* Irrevocable-commit confirmation (item X). Renders
                          inline below the form once Review is clicked. The
                          summary mirrors what's about to hit the chain and
                          calls out the no-recover-path semantic explicitly. */}
                      {bountyConfirmFor === s.id && (
                        <div className="space-y-2 border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded p-3" data-testid={`bounty-confirm-${s.id}`}>
                          <div className="text-xs font-medium text-amber-800 dark:text-amber-300">
                            Confirm irrevocable bounty
                          </div>
                          <ul className="text-xs text-amber-900 dark:text-amber-200 space-y-0.5">
                            <li>&#8226; Stream: <strong>#{s.id} {s.name}</strong></li>
                            <li>&#8226; Token: <span className="font-mono">{shortAddress(bountyTokenAddr.trim())}</span></li>
                            <li>&#8226; Amount: <strong>{bountyAmount.trim()}</strong></li>
                            <li>&#8226; Per-day rate (proposed): <strong>{bountyRate.trim()}</strong></li>
                          </ul>
                          <p className="text-xs text-amber-900 dark:text-amber-200">
                            <strong>Irrevocable.</strong> Once funded, the only egress is twice-a-day drips to predictors on this stream. There is no recover path: you cannot withdraw the deposit if the stream loses eligibility or no one predicts.
                          </p>
                          <p className="text-xs text-amber-900 dark:text-amber-200">
                            <strong>Upfront fee.</strong> Posting a bounty in any non-SATORI token charges a one-time SATORI burn (paid from your balance). Funding a bounty in SATORI is free. Winners keep 100% of the bounty. There is no payout fee.
                          </p>
                          <div className="flex gap-2">
                            <button
                              onClick={(e) => { e.stopPropagation(); setBountyConfirmFor(null); handleCreateBounty(s.id); }}
                              disabled={bountyAction?.status === 'pending'}
                              className="flex-1 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                              data-testid={`btn-confirm-bounty-${s.id}`}
                            >
                              {bountyAction?.streamId === s.id && bountyAction.status === 'pending' ? 'Funding…' : 'I understand, Fund Bounty'}
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setBountyConfirmFor(null); }}
                              disabled={bountyAction?.status === 'pending'}
                              className="py-2 px-4 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 text-sm font-medium rounded transition-colors disabled:opacity-50"
                              data-testid={`btn-cancel-bounty-${s.id}`}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {bountyAction?.streamId === s.id && bountyAction.status === 'success' && bountyAction.message && (
                        <div className="p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-xs text-green-800 dark:text-green-300">
                          {bountyAction.message}
                        </div>
                      )}
                      {bountyAction?.streamId === s.id && bountyAction.status === 'error' && bountyAction.message && (
                        <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-300">
                          {bountyAction.message}
                        </div>
                      )}
                    </div>
                  )}
                  </>)}

                  {/* Games sub-view (the "games" pill). A stream hosts MANY games:
                      the built-in binary game (type 0) plus any adapter games
                      (type 1+). Lazy-loaded on expand, cached per stream id. */}
                  {inGamesView && (
                  <div className="space-y-2 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 rounded p-2" data-testid={`stream-games-${s.id}`}>
                    <div className="text-xs font-medium text-gray-600 dark:text-gray-300">Games</div>

                    {gamesLoading.has(s.id) && !streamGames.has(s.id) && (
                      <p className="text-xs text-gray-500">Loading games…</p>
                    )}
                    {streamGames.has(s.id) && streamGames.get(s.id)!.length === 0 && (
                      <p className="text-xs text-gray-500">No games on this stream yet.</p>
                    )}

                    {(streamGames.get(s.id) ?? []).map((g) => {
                      const adapterName = adapterNameFor(g.gameTypeId);
                      const kind = gameKind(g.gameTypeId, adapterName);
                      // Descriptor-resolved UI for this game (cached per gameId;
                      // resolved by the effect above). Until it lands we fall
                      // back to the gameTypes.ts heuristic so the row never
                      // blocks on a probe. The descriptor can only IMPROVE the
                      // labels/options it provides.
                      const ui = resolvedGameUI.get(g.gameId) ?? null;
                      const heuristicDirs = directionOptions(kind);
                      const name = gameDisplayName(g.name, s.name);
                      const pAct = predictAction?.gameId === g.gameId ? predictAction : null;
                      const isAuthority = !!(userAddress && g.authority.toLowerCase() === userAddress.toLowerCase());
                      const reAct = renameGameAction?.gameId === g.gameId ? renameGameAction : null;
                      const trAct = transferGameAction?.gameId === g.gameId ? transferGameAction : null;

                      // Predict mode (descriptor first, heuristic fallback):
                      //  - options  -> one button per discrete choice
                      //  - input    -> a single number/text widget (encode per schema)
                      //  - else     -> raw-hex payload field (generic)
                      const options = ui?.options ?? null;
                      const predictInput = ui ? ui.predictInput : null;
                      // Heuristic 2-choice buttons used only when no descriptor
                      // resolved yet (or the descriptor offered no options/input).
                      const heuristicButtons = !ui && heuristicDirs
                        ? heuristicDirs.map((d) => {
                            try {
                              return { label: d.label, payloadHex: encodePredictPayload(kind, { direction: d.value }), key: String(d.value) };
                            } catch {
                              return null;
                            }
                          }).filter((o): o is { label: string; payloadHex: string; key: string } => o !== null)
                        : null;
                      const inputKind = typeof predictInput?.kind === 'string' ? predictInput.kind : '';
                      const supportedInput = inputKind === 'number' || inputKind === 'text';
                      return (
                        <div
                          key={g.gameId}
                          className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 p-2 space-y-1.5"
                          data-testid={`stream-${s.id}-game-${g.gameId}`}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                              {gameKindLabel(kind)}
                            </span>
                            <span className="font-medium text-sm truncate">{name}</span>
                            <span className="text-xs text-gray-500 font-mono">#{g.gameId}</span>
                          </div>

                          {/* These predict controls are RAW: the payload goes to
                              chain exactly as labelled, and the labels come from
                              three different sources (descriptor options, the kind
                              heuristic, or hand-typed hex). The Predict tab flips
                              direction for an inverted Uniswap stream so the
                              buttons match the price chart; this tab deliberately
                              does not, because flipping only the labels we own
                              would leave the other two sources disagreeing. So say
                              so instead of quietly meaning the opposite. */}
                          {orientationFor(s.id).inverted && (
                            <div className="text-[11px] text-amber-600 dark:text-amber-500">
                              Raw direction: UP here means the pool tick rises, which is a
                              falling {orientationFor(s.id).unitLabel}. The Predict tab flips this for you.
                            </div>
                          )}

                          {/* Predict controls. Descriptor-driven options/input
                              when present; otherwise the W7 heuristic buttons /
                              raw-hex field. */}
                          {options && options.length > 0 ? (
                            <div className="flex gap-2 flex-wrap">
                              {options.map((opt, i) => (
                                <button
                                  key={`${opt.payloadHex}-${i}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!opt.payloadHex || opt.payloadHex === '0x') {
                                      setPredictAction({ gameId: g.gameId, status: 'error', message: 'This option has no payload to predict with.' });
                                      return;
                                    }
                                    handlePredictGame(g, opt.payloadHex);
                                  }}
                                  disabled={pAct?.status === 'pending'}
                                  className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors"
                                  data-testid={`predict-game-${g.gameId}-${i}`}
                                >
                                  {pAct?.status === 'pending' ? '…' : opt.label}
                                </button>
                              ))}
                            </div>
                          ) : heuristicButtons && heuristicButtons.length > 0 ? (
                            <div className="flex gap-2">
                              {heuristicButtons.map((b) => (
                                <button
                                  key={b.key}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handlePredictGame(g, b.payloadHex);
                                  }}
                                  disabled={pAct?.status === 'pending'}
                                  className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors"
                                  data-testid={`predict-game-${g.gameId}-${b.key}`}
                                >
                                  {pAct?.status === 'pending' ? '…' : b.label}
                                </button>
                              ))}
                            </div>
                          ) : predictInput && supportedInput ? (
                            <div className="flex gap-2">
                              <input
                                type={inputKind === 'number' ? 'number' : 'text'}
                                value={predictFormInput.get(g.gameId) ?? ''}
                                onChange={(e) => setPredictFormInput((prev) => new Map(prev).set(g.gameId, e.target.value))}
                                onClick={(e) => e.stopPropagation()}
                                placeholder={typeof predictInput.label === 'string' ? predictInput.label : (inputKind === 'number' ? 'Enter a number' : 'Enter a value')}
                                className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                                data-testid={`input-predict-payload-${g.gameId}`}
                              />
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  // Encode the single field per the schema's
                                  // encode.type via the shared AbiCoder path.
                                  const encodeType = typeof (predictInput as any).encode === 'object' && predictInput.encode
                                    && typeof (predictInput as any).encode.type === 'string'
                                    ? (predictInput as any).encode.type as string
                                    : (inputKind === 'number' ? 'int256' : 'string');
                                  const raw = (predictFormInput.get(g.gameId) ?? '').trim();
                                  let payload: string;
                                  try {
                                    payload = encodeConfigFromFields(
                                      [{ key: 'v', label: 'value', type: encodeType }],
                                      { v: raw },
                                    );
                                  } catch (err: any) {
                                    setPredictAction({ gameId: g.gameId, status: 'error', message: err?.message ?? 'Invalid prediction value.' });
                                    return;
                                  }
                                  handlePredictGame(g, payload);
                                }}
                                disabled={pAct?.status === 'pending'}
                                className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                                data-testid={`btn-predict-game-${g.gameId}`}
                              >
                                {pAct?.status === 'pending' ? '…' : 'Predict'}
                              </button>
                            </div>
                          ) : (
                            <div className="flex gap-2">
                              <input
                                type="text"
                                value={genericPayload.get(g.gameId) ?? ''}
                                onChange={(e) => setGenericPayload((prev) => new Map(prev).set(g.gameId, e.target.value))}
                                onClick={(e) => e.stopPropagation()}
                                placeholder="Payload (hex, e.g. 0x01)"
                                className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs font-mono"
                                data-testid={`input-predict-payload-${g.gameId}`}
                              />
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  let payload: string;
                                  try {
                                    payload = encodePredictPayload('generic', { payloadHex: (genericPayload.get(g.gameId) ?? '').trim() });
                                  } catch (err: any) {
                                    setPredictAction({ gameId: g.gameId, status: 'error', message: err?.message ?? 'Invalid payload.' });
                                    return;
                                  }
                                  handlePredictGame(g, payload);
                                }}
                                disabled={pAct?.status === 'pending'}
                                className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                                data-testid={`btn-predict-game-${g.gameId}`}
                              >
                                {pAct?.status === 'pending' ? '…' : 'Predict'}
                              </button>
                            </div>
                          )}
                          {pAct?.status === 'error' && pAct.message && (
                            <div className="text-xs text-red-700 dark:text-red-300">{pAct.message}</div>
                          )}
                          {pAct?.status === 'success' && pAct.message && (
                            <div className="text-xs text-green-700 dark:text-green-300">{pAct.message}</div>
                          )}

                          {/* Vote eligible (game-keyed; free — only stream/game creation charges a burn). */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setVotePanelFor(votePanelFor?.kind === 'game' && votePanelFor.id === g.gameId
                                ? null
                                : { kind: 'game', id: g.gameId, name: g.name || `Game #${g.gameId}` });
                            }}
                            disabled={voteGameId === g.gameId}
                            className="w-full py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors"
                            data-testid={`vote-game-${g.gameId}`}
                          >
                            {voteGameId === g.gameId ? '…' : 'Vote eligible'}
                          </button>
                          {votePanelFor?.kind === 'game' && votePanelFor.id === g.gameId && (
                            <VotePanel
                              streamName={votePanelFor.name}
                              balance={voterBalance}
                              allowance={voterHubAllowance}
                              canSign={voterCanSign}
                              busy={voteGameId === g.gameId}
                              error={voteError}
                              onApprove={(amt) => onApproveVote(amt)}
                              onVote={(amt) => { Promise.resolve(handleVoteGame(g.gameId, amt)).then((ok) => { if (ok) setVotePanelFor(null); }); }}
                              onCancel={() => setVotePanelFor(null)}
                              testIdSuffix={`g${g.gameId}`}
                            />
                          )}

                          {/* Fund bounty on THIS game (C1). Only adapter games
                              (gameTypeId > 0) get their own affordance — the
                              binary game (type 0) is funded via the stream-level
                              "+ Fund Bounty" button. Reuses the gameId-keyed
                              fund core; the form is keyed by gameId. */}
                          {g.gameTypeId !== 0 && (() => {
                            const gbOpen = gameBountyOpenFor === g.gameId;
                            const gbAct = gameBountyAction?.gameId === g.gameId ? gameBountyAction : null;
                            return (
                              <div className="pt-1 border-t border-gray-200 dark:border-gray-700">
                                {!gbOpen ? (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setGameBountyOpenFor(g.gameId);
                                      setGameBountyTokenAddr('');
                                      setGameBountyAmount('');
                                      setGameBountyRate('');
                                      setGameBountyAction(null);
                                    }}
                                    className="w-full py-1.5 bg-green-400 hover:bg-green-500 !text-white rounded text-xs font-medium transition-colors"
                                    data-testid={`btn-fund-bounty-game-${g.gameId}`}
                                  >
                                    + Fund bounty
                                  </button>
                                ) : (
                                  <div className="space-y-1.5 border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 rounded p-2" data-testid={`game-bounty-form-${g.gameId}`}>
                                    <div className="text-[11px] text-green-700 dark:text-green-300 flex items-start justify-between gap-1.5">
                                      <span>Add a prize for this game.</span>
                                      <InfoTip>
                                        Fund a bounty on this game. <strong>Irrevocable</strong>: egress is twice-a-day drips to correct predictors only.
                                      </InfoTip>
                                    </div>
                                    <input
                                      type="text"
                                      value={gameBountyTokenAddr}
                                      onChange={(e) => setGameBountyTokenAddr(e.target.value)}
                                      onClick={(e) => e.stopPropagation()}
                                      placeholder="Token contract address (0x…)"
                                      className="w-full bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs font-mono"
                                      data-testid={`game-bounty-token-addr-${g.gameId}`}
                                    />
                                    <div className="flex gap-2">
                                      <input
                                        type="text"
                                        value={gameBountyAmount}
                                        onChange={(e) => setGameBountyAmount(e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                        placeholder="Total amount"
                                        className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                                        data-testid={`game-bounty-amount-${g.gameId}`}
                                      />
                                      <input
                                        type="text"
                                        value={gameBountyRate}
                                        onChange={(e) => setGameBountyRate(e.target.value)}
                                        onClick={(e) => e.stopPropagation()}
                                        placeholder="Per day"
                                        className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                                        data-testid={`game-bounty-rate-${g.gameId}`}
                                      />
                                    </div>
                                    <div className="flex gap-2">
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleFundGameBounty(s.id, g.gameId); }}
                                        disabled={
                                          !gameBountyAmount.trim() || !gameBountyRate.trim() ||
                                          !ethers.isAddress(gameBountyTokenAddr) ||
                                          gbAct?.status === 'pending'
                                        }
                                        className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors"
                                        data-testid={`btn-confirm-bounty-game-${g.gameId}`}
                                      >
                                        {gbAct?.status === 'pending' ? 'Funding…' : 'Fund bounty'}
                                      </button>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setGameBountyOpenFor(null); setGameBountyAction(null); }}
                                        disabled={gbAct?.status === 'pending'}
                                        className="px-3 py-1 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 rounded text-xs font-medium transition-colors disabled:opacity-50"
                                        data-testid={`btn-cancel-bounty-game-${g.gameId}`}
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                    {gbAct?.status === 'error' && gbAct.message && (
                                      <div className="text-xs text-red-700 dark:text-red-300">{gbAct.message}</div>
                                    )}
                                    {gbAct?.status === 'success' && gbAct.message && (
                                      <div className="text-xs text-green-700 dark:text-green-300">{gbAct.message}</div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                          {/* Authority-only management: rename + transfer. */}
                          {isAuthority && variant === 'manage' && (
                            <div className="space-y-1 pt-1 border-t border-gray-200 dark:border-gray-700">
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={renameGameInput?.gameId === g.gameId ? renameGameInput.value : ''}
                                  onChange={(e) => setRenameGameInput({ gameId: g.gameId, value: e.target.value })}
                                  onClick={(e) => e.stopPropagation()}
                                  placeholder="New game name"
                                  className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                                  data-testid={`input-rename-game-${g.gameId}`}
                                />
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleRenameGame(s.id, g.gameId); }}
                                  disabled={
                                    renameGameInput?.gameId !== g.gameId ||
                                    !renameGameInput.value.trim() ||
                                    reAct?.status === 'pending'
                                  }
                                  className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                                  data-testid={`btn-rename-game-${g.gameId}`}
                                >
                                  {reAct?.status === 'pending' ? '…' : 'Rename'}
                                </button>
                              </div>
                              {reAct?.status === 'error' && reAct.message && (
                                <div className="text-xs text-red-700 dark:text-red-300">{reAct.message}</div>
                              )}
                              {reAct?.status === 'success' && reAct.message && (
                                <div className="text-xs text-green-700 dark:text-green-300">{reAct.message}</div>
                              )}
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  value={transferGameInput?.gameId === g.gameId ? transferGameInput.value : ''}
                                  onChange={(e) => setTransferGameInput({ gameId: g.gameId, value: e.target.value })}
                                  onClick={(e) => e.stopPropagation()}
                                  placeholder="0x… new authority"
                                  className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs font-mono"
                                  data-testid={`input-transfer-game-${g.gameId}`}
                                />
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleTransferGame(s.id, g.gameId); }}
                                  disabled={
                                    transferGameInput?.gameId !== g.gameId ||
                                    !transferGameInput.value.trim() ||
                                    trAct?.status === 'pending'
                                  }
                                  className="px-3 py-1 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                                  data-testid={`btn-transfer-game-${g.gameId}`}
                                >
                                  {trAct?.status === 'pending' ? '…' : 'Transfer'}
                                </button>
                              </div>
                              {trAct?.status === 'error' && trAct.message && (
                                <div className="text-xs text-red-700 dark:text-red-300">{trAct.message}</div>
                              )}
                              {trAct?.status === 'success' && trAct.message && (
                                <div className="text-xs text-green-700 dark:text-green-300">{trAct.message}</div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Create a game on this stream. Only adapter types (id>=1)
                        are offered — every stream already auto-has its one
                        type-0 binary game; a duplicate reverts DuplicateBinaryGame. */}
                    {variant === 'manage' && (() => {
                      const createAct = createGameAction?.streamId === s.id ? createGameAction : null;
                      const selectedTypeId = createGameType === '' ? null : Number(createGameType);
                      const selectedKind = selectedTypeId != null
                        ? gameKind(selectedTypeId, adapterNameFor(selectedTypeId))
                        : null;
                      // Descriptor-driven config fields for the picked type, if
                      // the adapter advertised a configSchema(). null/absent =>
                      // keep the gameTypes.ts heuristic inputs (yes/no threshold
                      // or generic hex). Probed once, cached per gameTypeId.
                      const descriptorFields = selectedTypeId != null
                        ? (createConfigFields.get(selectedTypeId) ?? null)
                        : null;
                      const hasDescriptorFields = !!(descriptorFields && descriptorFields.length > 0);
                      return (
                        <div className="pt-1 border-t border-gray-200 dark:border-gray-700 space-y-1.5" data-testid={`create-game-form-${s.id}`}>
                          <div className="text-[11px] text-gray-500 dark:text-gray-400">Add a game (costs spam fee)</div>
                          <select
                            value={createGameType}
                            onChange={(e) => { setCreateGameType(e.target.value === '' ? '' : Number(e.target.value)); setCreateGameAction(null); setCreateFieldValues({}); }}
                            onClick={(e) => e.stopPropagation()}
                            className="w-full bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                            data-testid="select-create-game-type"
                          >
                            <option value="">Select game type…</option>
                            {gameAdapters.map((a) => (
                              <option key={a.id} value={a.id}>
                                type #{a.id}: {a.name || `Adapter #${a.id}`} ({a.isCommunity ? 'community' : 'official'})
                              </option>
                            ))}
                          </select>
                          {gameAdapters.length === 0 && (
                            <p className="text-[10px] text-gray-500 dark:text-gray-400">No game-type adapters registered yet.</p>
                          )}
                          <input
                            type="text"
                            value={createGameName}
                            onChange={(e) => setCreateGameName(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            placeholder="Game name"
                            className="w-full bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                            data-testid="input-create-game-name"
                          />
                          {/* Descriptor-driven config: one input per ConfigField
                              (number for int/uint types, text otherwise). Encoded
                              via encodeConfigFromFields on submit. Supersedes the
                              heuristic inputs below when present. */}
                          {hasDescriptorFields ? (
                            descriptorFields!.map((field) => {
                              const isNumeric = /^u?int(\d+)?$/.test(field.type.trim());
                              return (
                                <div key={field.key} className="space-y-0.5">
                                  <input
                                    type={isNumeric ? 'number' : 'text'}
                                    value={createFieldValues[field.key] ?? ''}
                                    onChange={(e) => setCreateFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                    onClick={(e) => e.stopPropagation()}
                                    placeholder={field.label || field.key}
                                    className="w-full bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                                    data-testid={`input-config-field-${field.key}`}
                                  />
                                  {field.help && (
                                    <p className="text-[10px] text-gray-500 dark:text-gray-400">{field.help}</p>
                                  )}
                                </div>
                              );
                            })
                          ) : (
                            <>
                              {selectedKind === 'yesno' && (
                                <input
                                  type="number"
                                  value={createGameThreshold}
                                  onChange={(e) => setCreateGameThreshold(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  placeholder="Threshold (int128)"
                                  className="w-full bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                                  data-testid="input-create-game-threshold"
                                />
                              )}
                              {selectedKind === 'generic' && (
                                <input
                                  type="text"
                                  value={createGameConfigHex}
                                  onChange={(e) => setCreateGameConfigHex(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  placeholder="Config (hex, advanced, optional)"
                                  className="w-full bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs font-mono"
                                  data-testid="input-create-game-confighex"
                                />
                              )}
                            </>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); handleCreateGame(s.id); }}
                            disabled={createGameType === '' || !createGameName.trim() || createAct?.status === 'pending'}
                            className="w-full py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors"
                            data-testid={`btn-create-game-${s.id}`}
                          >
                            {createAct?.status === 'pending' ? 'Creating…' : 'Create Game'}
                          </button>
                          {createAct?.status === 'error' && createAct.message && (
                            <div className="text-xs text-red-700 dark:text-red-300">{createAct.message}</div>
                          )}
                          {createAct?.status === 'success' && createAct.message && (
                            <div className="text-xs text-green-700 dark:text-green-300">{createAct.message}</div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                  )}

                  {!inGamesView && (<>
                  {/* Adapter streams: permissionless tick. Anyone can call
                      updateValue; the registry's cadence guards block early
                      attempts cleanly. Not shown for Simple streams (they
                      use the setValue path below). */}
                  {s.streamType === 1 && (() => {
                    // Say it BEFORE the tap. The contract takes one tick per cadence
                    // period, so a second tap in the same round can only revert — and
                    // paying gas to be told that is the worst possible way to learn a
                    // rule the UI already has the numbers for.
                    const tickable = tickableNow(s);
                    const pending = updateAction?.streamId === s.id && updateAction.status === 'pending';
                    return (
                    <div data-testid={`pull-form-${s.id}`} className="space-y-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleUpdateValue(s.id); }}
                        disabled={pending || !tickable}
                        className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                        data-testid={`btn-update-value-${s.id}`}
                      >
                        {pending
                          ? 'Updating…'
                          : tickable
                            ? 'Tick (pull adapter value)'
                            : 'Already ticked this period'}
                      </button>
                      {!tickable && (
                        <p className="text-[10px] text-gray-500 dark:text-gray-400" data-testid={`tick-wait-${s.id}`}>
                          One update per {formatCadenceLabel(s.minCadenceMinutes)} period. Next tick
                          from {fmtTickTime(nextTickAt(s))}.
                        </p>
                      )}
                      <p className="text-[10px] text-gray-500 dark:text-gray-400 flex items-start justify-between gap-1.5">
                        <span>Refresh this stream&apos;s value.</span>
                        <InfoTip>
                          Permissionless: anyone may tick it. {formatCadenceUpdateHint(s.minCadenceMinutes)} There is no reward for doing so: providers are not paid, so the caller pays the gas and the whole round pool goes to predictors. People tick because they want the stream fresh.
                        </InfoTip>
                      </p>
                      {updateAction?.streamId === s.id && updateAction.status === 'success' && updateAction.message && (
                        <div className="p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-xs text-green-800 dark:text-green-300">
                          {updateAction.message}
                        </div>
                      )}
                      {updateAction?.streamId === s.id && updateAction.status === 'error' && updateAction.message && (
                        <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-300">
                          {updateAction.message}
                        </div>
                      )}
                    </div>
                    );
                  })()}

                  {/* Authority-only: rename + transfer authority. Both fire
                      directly against the registry (no fee, no core hop). */}
                  {isOwner && variant === 'manage' && (
                    <div className="space-y-2 border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/40 rounded p-2" data-testid={`stream-admin-${s.id}`}>
                      <div className="text-xs font-medium text-gray-600 dark:text-gray-300">
                        Stream admin
                      </div>

                      {/* Rename */}
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={renameInput?.streamId === s.id ? renameInput.value : ''}
                          onChange={(e) => setRenameInput({ streamId: s.id, value: e.target.value })}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="New stream name"
                          className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs"
                          data-testid={`input-rename-${s.id}`}
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); handleRename(s.id); }}
                          disabled={
                            renameInput?.streamId !== s.id ||
                            !renameInput.value.trim() ||
                            (renameAction?.streamId === s.id && renameAction.status === 'pending')
                          }
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                          data-testid={`btn-rename-${s.id}`}
                        >
                          {renameAction?.streamId === s.id && renameAction.status === 'pending' ? '…' : 'Rename'}
                        </button>
                      </div>
                      {renameAction?.streamId === s.id && renameAction.status === 'error' && renameAction.message && (
                        <div className="text-xs text-red-700 dark:text-red-300">{renameAction.message}</div>
                      )}
                      {renameAction?.streamId === s.id && renameAction.status === 'success' && renameAction.message && (
                        <div className="text-xs text-green-700 dark:text-green-300">{renameAction.message}</div>
                      )}

                      {/* Transfer provider — Simple streams only. setProvider
                          reassigns the value-provider role; adapter streams
                          read from their on-chain adapter, so there's no
                          provider handoff for them. */}
                      {s.streamType === 0 && (
                        <>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={transferInput?.streamId === s.id ? transferInput.value : ''}
                              onChange={(e) => setTransferInput({ streamId: s.id, value: e.target.value })}
                              onClick={(e) => e.stopPropagation()}
                              placeholder="0x… new provider"
                              className="flex-1 min-w-0 bg-white text-gray-900 border border-gray-300 dark:bg-gray-700 dark:text-gray-100 dark:border-gray-600 rounded px-2 py-1 text-xs font-mono"
                              data-testid={`input-transfer-${s.id}`}
                            />
                            <button
                              onClick={(e) => { e.stopPropagation(); handleTransferProvider(s.id); }}
                              disabled={
                                transferInput?.streamId !== s.id ||
                                !transferInput.value.trim() ||
                                (transferAction?.streamId === s.id && transferAction.status === 'pending')
                              }
                              className="px-3 py-1 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white rounded text-xs font-medium transition-colors whitespace-nowrap"
                              data-testid={`btn-transfer-${s.id}`}
                            >
                              {transferAction?.streamId === s.id && transferAction.status === 'pending' ? '…' : 'Transfer'}
                            </button>
                          </div>
                          <p className="text-[10px] text-gray-500 dark:text-gray-400 flex items-start justify-between gap-1.5">
                            <span>Hand this stream to someone else, right away.</span>
                            <InfoTip>
                              Transfer is immediate. There is no two-step handoff. You lose Set Value / rename / transfer rights on the next block.
                            </InfoTip>
                          </p>
                          {transferAction?.streamId === s.id && transferAction.status === 'error' && transferAction.message && (
                            <div className="text-xs text-red-700 dark:text-red-300">{transferAction.message}</div>
                          )}
                          {transferAction?.streamId === s.id && transferAction.status === 'success' && transferAction.message && (
                            <div className="text-xs text-green-700 dark:text-green-300">{transferAction.message}</div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* Owner-only Set Value form (Simple streams) */}
                  {isOwner && s.streamType === 0 && variant === 'manage' && (
                    <div data-testid={`set-value-form-${s.id}`} className="space-y-2">
                      <div className="text-xs text-gray-500 flex items-center justify-between gap-1.5">
                        <span>Post the latest value.</span>
                        <InfoTip>
                          Update this stream's value. {formatCadenceUpdateHint(s.minCadenceMinutes)}
                        </InfoTip>
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={valueInput}
                          onChange={(e) => setValueInput(e.target.value)}
                          placeholder="New value (whole number)"
                          className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
                          data-testid={`input-set-value-${s.id}`}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <button
                          onClick={(e) => { e.stopPropagation(); handleSetValue(s.id); }}
                          disabled={!valueInput.trim() || action?.status === 'pending'}
                          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 rounded text-sm font-medium transition-colors !text-white"
                          data-testid={`btn-set-value-${s.id}`}
                        >
                          {action?.status === 'pending' ? 'Setting...' : 'Set Value'}
                        </button>
                      </div>
                      {action?.status === 'success' && action.message && (
                        <div className="p-2 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded text-xs text-green-800 dark:text-green-300">
                          {action.message}
                        </div>
                      )}
                      {action?.status === 'error' && action.message && (
                        <div className="p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-800 dark:text-red-300">
                          {action.message}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Vote section — at the very bottom of the expanded panel.
                      A vote BURNS SATORI for this stream's 1:1 game: the weight is
                      permanent and there is no withdrawing it, so there is no
                      "remove vote" counterpart and no delegated-vote state. */}
                  {variant === 'manage' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setVotePanelFor(votePanelFor?.kind === 'stream' && votePanelFor.id === s.id
                          ? null
                          : { kind: 'stream', id: s.id, name: s.name });
                      }}
                      disabled={voting}
                      className="w-full py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed disabled:opacity-60 !text-white text-sm font-medium rounded transition-colors"
                      data-testid={`btn-vote-up-${s.id}`}
                    >
                      {voting ? '...' : 'Vote For'}
                    </button>
                  )}
                  {votePanelFor?.kind === 'stream' && votePanelFor.id === s.id && (
                    <VotePanel
                      streamName={votePanelFor.name}
                      balance={voterBalance}
                      allowance={voterHubAllowance}
                      busy={voting}
                      error={voteError}
                      onApprove={(amt) => onApproveVote(amt)}
                      onVote={(amt) => { Promise.resolve(onVote(s.id, amt)).then((ok) => { if (ok) setVotePanelFor(null); }); }}
                      onCancel={() => setVotePanelFor(null)}
                      testIdSuffix={s.id}
                      approved={s.approved}
                      sourceStreamId={s.id}
                      moveTargets={streams.filter((x) => x.approved).map((x) => ({ streamId: x.id, name: x.name }))}
                      onMoved={() => setVotePanelFor(null)}
                    />
                  )}
                  </>)}

                  {/* Streams are permanent — no delete path. To remove a
                      misbehaving stream from the eligible set, voters move
                      their power to stronger streams until this one drops
                      below the weakest eligible weight. */}
                </div>
              )}
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="text-gray-500 text-sm text-center py-4">No streams match this filter.</p>
        )}
        {hasMore && onLoadMore && (
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="w-full py-3 mt-2 text-sm text-gray-400 hover:text-gray-200 bg-gray-700/30 hover:bg-gray-700/50 rounded-lg transition-colors disabled:opacity-50"
          >
            {loadingMore ? 'Loading...' : 'Load More Streams'}
          </button>
        )}
      </div>
    </div>
  );
}
