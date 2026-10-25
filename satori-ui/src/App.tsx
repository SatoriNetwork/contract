import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { useWallet } from './hooks/useWallet';
import { useContracts } from './hooks/useContracts';
import { useGames } from './hooks/useGames';
import { useStreamList } from './hooks/useStreamList';
import { useStreamDetail } from './hooks/useStreamDetail';
import { usePredictionFlow } from './hooks/usePredictionFlow';
import { useDashboard } from './hooks/useDashboard';
import { useVoting } from './hooks/useVoting';
import { usePendingReferral } from './hooks/useReferralAutoSet';
import { useGasless } from './hooks/useGasless';
import { GasSatoriPrompt } from './components/GasSatoriPrompt';
import { GasSettings } from './components/GasSettings';
import { copyText } from './lib/clipboard';
import { ConnectButton } from './components/ConnectButton';
import { GameWalletUnlockBar } from './components/GameWalletUnlockBar';
import { GameWalletPanel } from './components/GameWalletPanel';
import { StreamChart } from './components/StreamChart';
import { PredictionButtons } from './components/PredictionButtons';
import { StreakMeter } from './components/StreakMeter';
import { StreamProgress } from './components/StreamProgress';
import { Dashboard } from './components/Dashboard';
import { ClaimBanner } from './components/ClaimBanner';
import { StreamsTab } from './components/StreamsTab';
import { DelegationTab } from './components/DelegationTab';
import { HistoryTab } from './components/HistoryTab';
import { BountiesTab } from './components/BountiesTab';
import { ReferralTab } from './components/ReferralTab';
import { LeaderboardTab } from './components/LeaderboardTab';
import { GovernorTab } from './components/GovernorTab';
import { AdminTab } from './components/AdminTab';
import { OffchainTab } from './components/OffchainTab';
import { ScoringSplit } from './components/ScoringSplit';
import { DevFeeTab } from './components/DevFeeTab';
import { DevFeeAdminTab } from './components/DevFeeAdminTab';
import { ProposalsTab } from './components/ProposalsTab';
import { getHolderGovernor, DEFAULT_CHAIN_ID } from './contracts/addresses';
import { MerkleClaimPanel } from './components/MerkleClaimPanel';
import { AirdropClaimPanel } from './components/AirdropClaimPanel';
import { RoundCountdown } from './components/RoundCountdown';
import { InfoTip } from './components/InfoTip';
import { useFarmingThreshold } from './hooks/useFarmingThreshold';
import { formatCadenceLabel } from './utils/cadence';
import { formatBalance, fullBalance } from './utils/format';
import { useOwnerRoles, useSplitterMembership } from './hooks/useTabProbes';
import { useChainHealth } from './hooks/useChainHealth';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { explainError, sendPreflighted } from './utils/errors';
import { resolveStreamAdapterUI, type StreamValueDisplay } from './lib/streamAdapterUI';
import { orientationOf, directionToChain, rememberOrientation } from './lib/streamOrientation';
import './index.css';
import { getCurrentRound, calibrateRound } from './lib/chainValues';
import { currentHour } from './lib/round';
import { predictGate, reopenTime } from './lib/predictGate';
import { describeStream } from './lib/streamDescription';
import { afterTx } from './lib/afterTx';
import { STREAK_THRESHOLD_LABEL, streakThresholdFigures } from './lib/streakThreshold';


type Tab = 'dashboard' | 'leaderboard' | 'streams' | 'bounties' | 'proposals' | 'referral' | 'delegation' | 'history' | 'dev fee' | 'dev fee admin' | 'governor' | 'admin' | 'off-chain';

/// What each tab is CALLED, where that differs from its internal key.
///
/// The keys are load-bearing beyond the tab strip — `?tab=` deep links and the PWA
/// app-shortcuts both use them — so renaming a tab in the UI means adding a label
/// here, never changing the key. Was a nested ternary; a map, because three of these
/// now differ and the next one should not need untangling.
const TAB_LABELS: Partial<Record<Tab, string>> = {
  streams: 'vote',
  referral: 'refer',
  delegation: 'advanced',
};

// Read `?tab=...` from the URL on first paint so PWA app-shortcuts can deep-
// link to a specific tab. Falls back to dashboard for unknown / missing values.
function tabFromUrl(): Tab {
  if (typeof window === 'undefined') return 'dashboard';
  const t = new URLSearchParams(window.location.search).get('tab');
  const allowed: Tab[] = ['dashboard', 'leaderboard', 'streams', 'referral', 'delegation', 'history', 'bounties', 'proposals'];
  return (allowed as string[]).includes(t || '') ? (t as Tab) : 'dashboard';
}

function useTheme() {
  const [dark, setDark] = useState(() => {
    if (typeof window === 'undefined') return true;
    const saved = localStorage.getItem('satori-theme');
    return saved ? saved === 'dark' : true;
  });
  const toggle = () => {
    setDark((d) => {
      localStorage.setItem('satori-theme', d ? 'light' : 'dark');
      return !d;
    });
  };
  return { dark, toggle };
}

function App() {
  const theme = useTheme();
  const wallet = useWallet();
  const proposalsEnabled = !!getHolderGovernor(wallet.chainId ?? DEFAULT_CHAIN_ID);
  // Tapping the address in the app bar copies the FULL address, not the
  // truncated label the user can see. Confirmation is the label swapping to
  // "Copied" for two seconds — and only when the write actually succeeded,
  // since a false confirmation is worse than none.
  const [copiedAddress, setCopiedAddress] = useState(false);
  const copyAddress = useCallback(async () => {
    if (!wallet.address) return;
    if (await copyText(wallet.address)) {
      setCopiedAddress(true);
      setTimeout(() => setCopiedAddress(false), 2000);
    }
  }, [wallet.address]);
  const farming = useFarmingThreshold();
  const { contracts } = useContracts();
  // Paginated stream list — drives tabs, prediction flow ordering, and the
  // dashboard's name lookups. Replaced the legacy `useStreamData` that
  // walked every stream serially.
  const streamList = useStreamList();
  // Bridge to resolve a stream's single 1:1 binary gameId at predict time —
  // predictions are submitted game-keyed via predictMultipleWithPayloads.
  const { resolveGameIds, resolveGameId, getGameMeta } = useGames();
  const [currentRound, setCurrentRound] = useState<string | null>(null);
  const [deploymentRound, setDeploymentRound] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showFullBalance, setShowFullBalance] = useState(false);
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [submittedCount, setSubmittedCount] = useState(0);
  const [advancing, setAdvancing] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>(() => tabFromUrl());
  /// The "you've predicted today" card has been dismissed to reveal the chart.
  /// Session-only on purpose: it resets on reload and on a round rollover (the
  /// card stops rendering at all once hasPredictedToday goes false), so there is
  /// no stale "dismissed" state to reason about later.
  const [predictedCardDismissed, setPredictedCardDismissed] = useState(false);
  /// A submit landed in THIS session. Distinct from dashboard.hasPredictedToday,
  /// which is read from chain and arrives via an async reload: dismissing the
  /// success card immediately would otherwise show the predict buttons again for
  /// the moment before that reload lands. This closes that window from the only
  /// source that knows synchronously — the submit that just succeeded.
  const [justPredicted, setJustPredicted] = useState(false);
  /// Bumped by the vote tab's "Create Stream" button. The form lives on the
  /// advanced tab, so the button switches tabs and raises this; the manage
  /// StreamsTab opens its form and scrolls to it when the number changes.
  ///
  /// A counter rather than a boolean because the manage tab is unmounted while
  /// you are on the vote tab: a flag would need clearing on the way back, and
  /// forgetting that would re-open the form every time you visited the advanced
  /// tab afterwards. A changing number is self-clearing.
  const [createStreamSignal, setCreateStreamSignal] = useState(0);

  // Prediction flow uses paginated list (no history needed for ordering)
  // The predict flow groups on LIVE eligibility (approved + has vote weight =
  // "ready to earn"), NOT the frozen earning snapshot. A stream that's approved
  // and voted but not yet predicted-on this round is ready to earn the instant
  // someone predicts on it — so it belongs in the MAIN predict list where people
  // will actually see and predict on it, not buried behind "keep going." (The
  // chart's "rewarding" badge still uses the frozen set — it only earns once a
  // prediction lands — so the two stay honest without hiding the stream.)
  const flow = usePredictionFlow(streamList.streams, streamList.isLiveEligible, wallet.address);
  const gasless = useGasless();
  // Lazy-load detail (history + counts) for the currently displayed stream
  const currentStreamId = flow.currentStream?.id ?? null;
  const streamDetail = useStreamDetail(currentStreamId);
  const dashboard = useDashboard(streamList.streams);
  // Voting data is Vote/Advanced-tab material; loading it at boot competed
  // with the home screen for the rate-limited public RPC. Gated on the tabs
  // that read it (VotePanel keeps its own eager instance — it mounts in-tab).
  const votingHook = useVoting(activeTab === 'streams' || activeTab === 'delegation');
  const { pendingReferrer, clearPendingReferral } = usePendingReferral();
  // Tab VISIBILITY only. The tabs' full data hooks (useOwner/useDevFee) run
  // inside the tab bodies, which mount on open — these probes are one deferred
  // batched request each, silent on failure (see useTabProbes).
  const ownerHook = useOwnerRoles();
  // The Admin tab holds the rewards admin's and emission holder's rows and the
  // airdrop's load / freeze / finalize rows, so any of those keys opens it.
  const hasAdminTab = ownerHook.isOwner || ownerHook.isEmissionHolder
    || ownerHook.isAirdropHolder || ownerHook.isFreezeAuthority;
  // Gates the dev-fee tab. Presentational only: the splitter is public and
  // anyone can call withdraw on it directly. This keeps a page that means
  // nothing to most visitors out of their way, and guards nobody's money.
  const devFee = useSplitterMembership();
  const { reachable: chainReachable } = useChainHealth();
  const installPrompt = useInstallPrompt();

  // Smooth transition: chart → submit screen
  const [viewPhase, setViewPhase] = useState<'chart' | 'exiting' | 'submit'>(
    flow.atSubmitScreen ? 'submit' : 'chart'
  );
  const prevAtSubmit = useRef(flow.atSubmitScreen);
  // Hold the last stream so it stays visible during exit animation
  const lastStreamRef = useRef(flow.currentStream);
  if (flow.currentStream) lastStreamRef.current = flow.currentStream;

  useEffect(() => {
    if (flow.atSubmitScreen && !prevAtSubmit.current) {
      setViewPhase('exiting');
      const timer = window.setTimeout(() => setViewPhase('submit'), 300);
      prevAtSubmit.current = true;
      return () => window.clearTimeout(timer);
    }
    if (!flow.atSubmitScreen && prevAtSubmit.current) {
      setViewPhase('chart');
      prevAtSubmit.current = false;
    }
  }, [flow.atSubmitScreen]);

  // Use the held stream during exit, live stream otherwise
  const displayStream = flow.currentStream || lastStreamRef.current;

  // Descriptor-resolved value display for the charted stream's adapter
  // (decimals/unit/label). Probes the adapter impl's optional
  // IStreamAdapterUIDescriptor for a valueDisplay(target, config) tuple, cached
  // by streamId. resolveStreamAdapterUI never throws and degrades to null for
  // Simple streams (adapterId 0) or undescribed adapters, so the chart keeps
  // its raw rendering — never a regression. Mirrors the StreamsTab probe.
  const [chartValueDisplay, setChartValueDisplay] = useState<StreamValueDisplay | null>(null);
  const chartDisplayStreamId = displayStream?.id ?? null;
  useEffect(() => {
    setChartValueDisplay(null);
    if (!displayStream || !contracts) return;
    if (displayStream.adapterId <= 0) return; // Simple stream — raw value, no probe.
    const readProvider = wallet.provider;
    let cancelled = false;
    (async () => {
      let impl: string | undefined;
      try {
        impl = await contracts.registry.adapter(displayStream.adapterId);
      } catch {
        impl = undefined;
      }
      const ui = await resolveStreamAdapterUI({
        adapterId: displayStream.adapterId,
        impl,
        target: displayStream.provider,
        config: '0x',
        provider: readProvider,
      });
      if (cancelled) return;
      setChartValueDisplay(ui.valueDisplay);
      // Share what the probe found, so surfaces that only have a streamId (the
      // dashboard's Recent Predictions) can render the direction the user pressed.
      rememberOrientation(displayStream.id, ui.valueDisplay);
    })();
    return () => { cancelled = true; };
    // Keyed on the stream id (+ adapter/provider) so cascading re-renders that
    // keep the same charted stream don't re-probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartDisplayStreamId, contracts, wallet.provider]);

  // The displayed game's ADVERTISED DURATION (GameMeta.targetMinutes): the
  // known span the prediction is scored across — chart tooltip and button
  // wording both speak it. 1440 (the default "higher or lower 24 hours from
  // your moment?" game) until the meta loads, so the wording is never blank
  // and never wrong for the game everyone actually plays.
  const [chartTargetMinutes, setChartTargetMinutes] = useState<number>(1440);
  useEffect(() => {
    setChartTargetMinutes(1440);
    if (!chartDisplayStreamId || !contracts) return;
    let cancelled = false;
    (async () => {
      const gameId = await resolveGameId(chartDisplayStreamId);
      if (cancelled || !gameId) return;
      const meta = await getGameMeta(Number(gameId));
      if (cancelled) return;
      if (meta && meta.targetMinutes > 0) setChartTargetMinutes(meta.targetMinutes);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartDisplayStreamId, contracts]);

  // THE boundary where a button press becomes an on-chain direction.
  //
  // On a Uniswap stream whose readable price runs opposite the tick, the chart
  // shows the inverted price, so "UP" to the reader is a FALLING tick and has to
  // be recorded as DOWN. The flip happens here, once, using the very display the
  // chart is drawn from — so the buttons cannot disagree with the line above them.
  //
  // Both directions are stored: `chain` is what gets submitted, `pressed` is what
  // every list of the queue renders. Nothing further downstream has to know that
  // an inversion happened.
  const pressPrediction = useCallback((streamId: number, pressed: number) => {
    const orient = orientationOf(chartValueDisplay);
    const chain = directionToChain(pressed === 1 ? 1 : 2, orient);
    flow.addPrediction(streamId, chain, pressed);
  }, [chartValueDisplay, flow]);

  // What to highlight on the buttons: the side the user pressed.
  const pressedFor = useCallback((streamId: number) => {
    const p = flow.getPredictionForStream(streamId);
    if (!p) return undefined;
    return { direction: p.displayDirection ?? p.direction };
  }, [flow]);

  // Reset submit state on account switch
  useEffect(() => {
    setSubmitError(null);
    setSubmitSuccess(false);
  }, [wallet.address]);

  // If the active tab is privileged and the current account no longer has that
  // role, fall back to dashboard so we don't render a blank panel.
  useEffect(() => {
    // The governor/admin tabs are role-gated. Vote bounties are PERMISSIONLESS
    // on-chain (create/accept/cancel are open to everyone), so that tab is
    // public — the UI is not an access-control layer (review #17).
    // `checked` gates every bounce: the probes are deferred and cached, so
    // before confirmation the flags may be a restored last-known answer —
    // bouncing on those would flicker a real admin's tab away at every load.
    if (activeTab === 'governor' && ownerHook.checked && !ownerHook.isGovernor) setActiveTab('dashboard');
    if (activeTab === 'admin' && ownerHook.checked && !hasAdminTab) setActiveTab('dashboard');
    // The reporter key is rotatable, so this tab can vanish under a connected
    // wallet mid-session exactly as the admin one can.
    if (activeTab === 'off-chain' && ownerHook.checked && !(ownerHook.isOffchainReporter || ownerHook.isRootPublisher)) setActiveTab('dashboard');
    if (activeTab === 'dev fee' && devFee.checked && !devFee.isPayee) setActiveTab('dashboard');
    if (activeTab === 'dev fee admin' && devFee.checked && !devFee.isAuthority) setActiveTab('dashboard');
  }, [activeTab, ownerHook.checked, ownerHook.isGovernor, hasAdminTab, ownerHook.isOffchainReporter, ownerHook.isRootPublisher, devFee.checked, devFee.isPayee, devFee.isAuthority]);

  // Derive balance from dashboard data (single source of truth)
  const balance = dashboard.data?.balance ?? null;

  // Load current round
  useEffect(() => {
    if (!contracts) return;
    // Calibrate FIRST: currentRound() is wall-clock arithmetic, which is only
    // the chain's answer if the chain's clock tracks the wall clock. On a local
    // node warped by evm_increaseTime it does not, and every comparison against
    // a chain-sourced round is then off by the warp.
    calibrateRound(contracts.reads)
      .then(() => getCurrentRound())
      .then((r: any) => setCurrentRound(r.toString()))
      .catch(() => {});
    // deploymentRound = the protocol's first round; lets the UI show rounds-elapsed
    // numbers (round - deploymentRound + 1) instead of the raw absolute round.
    contracts.satori.deploymentRound().then((r: any) => setDeploymentRound(Number(r))).catch(() => {});
  }, [contracts]);

  const gateFor = useCallback((streamId: number) => predictGate(
    streamId,
    streamList.streams.find((x) => x.id === streamId),
    dashboard.data?.recentPredictions.find((p) => p.streamId === streamId),
    currentRound != null ? Number(currentRound) : null,
  ), [currentRound, streamList.streams, dashboard.data]);
  const isActiveThisRound = useCallback((streamId: number) => gateFor(streamId).active, [gateFor]);

  // How many queued picks will actually be sent (drives the Submit label/enable).
  const activePredictionCount = flow.predictions.filter((p) => isActiveThisRound(p.streamId)).length;

  // Submit predictions to contract
  const handleSubmit = useCallback(async () => {
    if (!contracts || flow.predictions.length === 0) return;
    // Drop any queued picks the engine's gate would reject (no fresh value
    // since the last prediction, or already predicted this round) — sending
    // them would revert the whole batch. They stay visible (grayed) in the
    // review list; we just don't include them in the transaction.
    const live = flow.predictions.filter((p) => isActiveThisRound(p.streamId));
    if (live.length === 0) return;
    setSubmitError(null);
    setSubmitSuccess(false);
    flow.setIsSubmitting(true);

    try {
      // Predictions are game-keyed now: resolve each queued stream to its
      // single 1:1 binary gameId (one batched eth_call), then pack the
      // direction byte (1=UP/YES, 2=DOWN/NO) into the per-request payload.
      // An empty payload reverts on-chain, so a direction is always packed.
      const streamIds = live.map((p) => p.streamId);
      const gameIdMap = await resolveGameIds(streamIds);
      const requests = live.map((p) => {
        const gameId = gameIdMap.get(p.streamId) ?? 0;
        if (!gameId) throw new Error(`Stream #${p.streamId} has no game to predict on yet`);
        return {
          gameId,
          payload: ethers.solidityPacked(['uint8'], [p.direction]),
        };
      });

      // If this client arrived through an invite link, set the referral
      // atomically on this FIRST prediction via the wrapper (its referral side
      // is a no-op if one is already set). Skip an accidental self-referral and
      // fall back to the plain predict otherwise.
      const ref = pendingReferrer;
      const useReferral = !!ref && (!wallet.address || ref.toLowerCase() !== wallet.address.toLowerCase());
      // Simulate on the READ path first. This is the most expensive call in the app
      // to get a bad error from: the user has walked a whole queue of streams, and
      // a revert here otherwise arrives as "invalid BigNumberish value" because the
      // node answers eth_estimateGas with null rather than an error. The reverts
      // that actually happen — already predicted this round, power delegated,
      // tokens locked, a stream that stopped updating — all have real copy waiting
      // in explainError; they just never reached it.
      //
      // preflight ignores a null or garbled READ response rather than treating it
      // as a revert, so a flaky node cannot block a valid prediction.
      const tx = await gasless.sendOrRelay(
        { kind: 'predict', referrer: useReferral ? ref! : ethers.ZeroAddress, requests },
        () => useReferral
          ? sendPreflighted(contracts.reads.satori, contracts.satori, 'predictMultipleWithReferral', [ref, requests], wallet.address)
          : sendPreflighted(contracts.reads.satori, contracts.satori, 'predictMultipleWithPayloads', [requests], wallet.address),
      );
      await afterTx(tx);
      if (useReferral) clearPendingReferral();

      setSubmittedCount(live.length);
      setSubmitSuccess(true);
      // Set BEFORE the reload, not after it: this is the only synchronous
      // evidence that a prediction landed, and dismissing the success card can
      // happen before the async reload reports hasPredictedToday.
      setJustPredicted(true);
      dashboard.reload();
    } catch (e: any) {
      console.error('Submit failed:', e);
      setSubmitError(explainError(e));
    } finally {
      flow.setIsSubmitting(false);
    }
  }, [contracts, flow, dashboard, resolveGameIds, pendingReferrer, clearPendingReferral, wallet.address, isActiveThisRound, gasless]);

  // DEV-ONLY: fast-forward the local hardhat node by one 24h round so you can
  // simulate time passing without waiting it out. Sends evm_increaseTime +
  // evm_mine straight to the node (NO contract changes), then refreshes the
  // on-chain reads (round, stream values, chart history, dashboard). The button
  // that calls this is gated on wallet.isDev, so it never ships in a real build.
  const advanceRound = useCallback(async () => {
    if (!wallet.isDev || advancing) return;
    setAdvancing(true);
    try {
      await wallet.provider.send('evm_increaseTime', [24 * 60 * 60]);
      await wallet.provider.send('evm_mine', []);
      if (contracts) {
        // The warp just moved the chain's clock out from under the wall-clock
        // arithmetic, so re-measure before reading the round back.
        await calibrateRound(contracts.reads);
        const r = await getCurrentRound();
        setCurrentRound(r.toString());
      }
      streamList.reload();
      streamDetail.reload();
      dashboard.reload();
    } catch (e) {
      console.error('[satori] advance round failed:', e);
    } finally {
      setAdvancing(false);
    }
  }, [wallet.isDev, wallet.provider, advancing, contracts, streamList, streamDetail, dashboard]);

  // The stream list is rendered in two places: variant="vote" on the Vote tab
  // (the full list, for voting/predicting) and variant="manage" on the Advanced
  // page (your own streams + the create flow + authority controls). Same data
  // and handlers, one definition.
  // Jump to a stream in the top batched prediction flow and scroll up to it.
  // Shared by the Streams tab and the Bounties tab (predictions are one batch
  // per round, so both route here instead of predicting inline).
  const jumpToPredictStream = (streamId: number) => {
    // goToStreamId handles both the eligible (primary) and ineligible (extended)
    // cases and batches the list switch in one render. The previous version read
    // flow.activeList again right after flow.keepGoing(), but that list is the
    // pre-update (primary) render value, so an ineligible stream was never found
    // and the jump silently did nothing.
    flow.goToStreamId(streamId);
    setActiveTab('dashboard');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderStreamsTab = (variant: 'vote' | 'manage') => (
    <StreamsTab
      variant={variant}
      onRequestCreate={variant === 'vote' ? () => {
        setActiveTab('delegation');
        setCreateStreamSignal((n) => n + 1);
      } : undefined}
      openCreateSignal={variant === 'manage' ? createStreamSignal : undefined}
      canCreateStream={votingHook.data?.canCreateStream ?? true}
      tokensLocked={votingHook.data?.tokensLocked ?? false}
      needsApproval={votingHook.data?.needsStreamApproval ?? false}
      onApprove={votingHook.approveForStream}
      creationFee={votingHook.data?.streamCreationFee}
      tokenLockedUntilRound={votingHook.data?.tokenLockedUntilRound ?? 0}
      toDisplayRound={(abs) => (deploymentRound != null ? abs - deploymentRound + 1 : abs)}
      streams={streamList.streams}
      isEligible={streamList.isEligible}
      payoutPerRound={streamList.payoutPerRound}
      govSnapshotTaken={streamList.govSnapshotTaken}
      userAddress={wallet.address}
      isFavorite={flow.isFavorite}
      onToggleFavorite={flow.toggleFavorite}
      onCreateStream={(args) => { votingHook.createStream(args).then(() => { streamList.reload(); }); }}
      creating={votingHook.creating}
      createError={votingHook.createError}
      streamCreationFee={votingHook.data?.streamCreationFee ?? '1.0'}
      hasMore={streamList.hasMore}
      onLoadMore={streamList.loadMore}
      loadingMore={streamList.loadingMore}
      onVote={(id, amount) => votingHook.vote(id, amount).then((ok) => { if (ok) streamList.reload(); return !!ok; })}
      onVoteGame={(gameId, amount) => votingHook.voteGame(gameId, amount).then((ok) => { if (ok) streamList.reload(); return !!ok; })}
      onApproveVote={(amount) => votingHook.approveForVote(amount)}
      voterBalance={votingHook.data?.balance ?? '0'}
      voterHubAllowance={votingHook.data?.hubAllowance ?? '0'}
      voterCanSign={votingHook.data?.canSignPermit ?? false}
      voteError={votingHook.voteError}
      voting={votingHook.voting}
      onPredictStream={jumpToPredictStream}
    />
  );

  return (
    <div className={`min-h-screen ${theme.dark ? 'dark bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'}`}>
      {/* Header */}
      <header className={`border-b px-4 sm:px-6 py-3 flex justify-between items-center ${theme.dark ? 'border-gray-700' : 'border-gray-100 bg-white shadow-sm'}`}>
        <h1 className="flex items-start gap-2">
          <img
            src={theme.dark ? `${process.env.PUBLIC_URL}/logomark-white.png` : `${process.env.PUBLIC_URL}/logomark-black.png`}
            alt=""
            className="h-10 sm:h-11 w-auto flex-shrink-0"
          />
          <span className="flex flex-col items-end leading-none">
            <span
              className="text-xl sm:text-2xl font-bold tracking-tight"
              style={{ fontFamily: 'ui-rounded, "Quicksand", system-ui, sans-serif' }}
            >
              Satori
            </span>
            <span
              className="text-lg sm:text-xl -mt-1.5 sm:-mt-2.5 leading-none"
              style={{ fontFamily: '"Caveat", cursive', fontWeight: 700 }}
            >
              daily
            </span>
          </span>
        </h1>
        <div className="flex items-center gap-2 sm:gap-4">
          {installPrompt.available && (
            <button
              onClick={installPrompt.install}
              className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
              data-testid="install-button"
              title="Install Satori as an app"
            >
              Install
            </button>
          )}
          {wallet.isDev && !theme.dark && (
            <button
              onClick={advanceRound}
              disabled={advancing}
              className={`text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50 ${theme.dark ? 'border-gray-600 hover:bg-gray-700 text-gray-200' : 'border-gray-300 hover:bg-gray-100 text-gray-700'}`}
              data-testid="dev-advance-round"
              title="DEV: fast-forward the local chain by one 24h round"
            >
              {advancing ? '…' : '⏭ +1 round'}
            </button>
          )}
          {/* Dev controls (account switcher + advance-round) show in LIGHT mode
              only, so dark-mode demo recordings have a clean header. Flip to
              light to drive them. */}
          {wallet.isDev && !theme.dark && (
            <select
              value={wallet.devAccountIndex}
              onChange={(e) => wallet.switchDevAccount(Number(e.target.value))}
              className={`rounded px-2 py-1 text-sm max-w-[120px] truncate ${theme.dark ? 'bg-gray-800 border border-gray-600 text-white' : 'bg-white border border-gray-300 text-gray-900'}`}
              data-testid="dev-account-select"
            >
              {wallet.devAccounts.map((acc, i) => (
                <option key={i} value={i}>
                  {acc.role ? `${acc.name} (${acc.role})` : acc.name}
                </option>
              ))}
            </select>
          )}
          {wallet.isConnected ? (
            <div className="flex items-center gap-2" data-testid="wallet-info">
              {/* Which key is signing, stated rather than inferred: the address
                  alone does not tell a user whether they are on their own wallet
                  or the local game wallet, and the two behave differently. */}
              {wallet.gameWallet.active && (
                <span
                  className="self-start text-[10px] uppercase tracking-wide text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-1.5 py-0.5 rounded"
                  title="Satori signs for you — no wallet approvals"
                  data-testid="gw-header-badge"
                >
                  instant
                </span>
              )}
              <div className="text-sm flex flex-col items-end leading-tight">
                {/* A button, not a span. Tapping the truncated address used to
                    do the one thing nobody wants — select "0x1234...abcd", the
                    shortened text, which is useless when pasted. It now copies
                    the FULL address. `select-none` stops a long-press on mobile
                    from starting a text selection over the top of the tap. */}
                <button
                  type="button"
                  onClick={copyAddress}
                  title={copiedAddress ? 'Copied' : `Copy ${wallet.address ?? ''}`}
                  aria-label={copiedAddress ? 'Address copied' : 'Copy full wallet address'}
                  data-testid="copy-address"
                  className={`select-none cursor-pointer bg-transparent border-0 p-0 font-inherit
                    ${copiedAddress
                      ? 'text-green-600 dark:text-green-400'
                      : (theme.dark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700')}`}
                >
                  {copiedAddress
                    ? 'Copied'
                    : <>{wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}</>}
                </button>
                {balance && (() => {
                  const shortBal = formatBalance(balance);
                  const fullBal = fullBalance(balance);
                  const exact = shortBal !== fullBal; // truncated view differs from the true value
                  return (
                  farming.below ? (
                    // Below the streak growing threshold: the only time this number
                    // says anything. Red, and one tap or hover explains why.
                    // Deliberately quiet otherwise — see docs/design/farming-threshold.md
                    // (the CONTRACT's name for it; users are never shown "farming").
                    //
                    // Not underlined. The red already carries it, and a dotted
                    // underline on a balance reads as a broken link or an error in the
                    // number itself rather than an invitation to tap.
                    <InfoTip
                      label={STREAK_THRESHOLD_LABEL}
                      trigger={
                        <span className="text-red-500 dark:text-red-400 font-medium cursor-help" data-testid="balance" title={exact ? `${fullBal} SATORI` : undefined}>
                          {shortBal}
                        </span>
                      }
                    >
                      {(() => {
                        const f = streakThresholdFigures(farming.threshold, farming.power);
                        return (
                          <>
                            You have exactly <strong>{fullBal} SATORI</strong>. You need{' '}
                            <strong>{f ? `${f.need} SATORI` : "more SATORI"}</strong> to grow
                            your streak{f && <> (you have <strong>{f.have}</strong>)</>}.
                          </>
                        );
                      })()}
                    </InfoTip>
                  ) : (
                    // Tap to reveal every decimal. The default is truncated (never
                    // rounded up) to 6 dp, so it can never show more than is held;
                    // the exact figure is one tap or hover away.
                    <span
                      className={`${theme.dark ? 'text-green-400' : 'text-gray-700 font-medium'}${exact ? ' cursor-pointer' : ''}`}
                      data-testid="balance"
                      title={exact ? `${fullBal} SATORI` : undefined}
                      onClick={exact ? () => setShowFullBalance((v) => !v) : undefined}
                    >
                      {showFullBalance ? fullBal : shortBal}
                    </span>
                  )
                );
                })()}
              </div>
              {!wallet.isDev && (
                <button
                  onClick={wallet.disconnect}
                  className={`p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors ${theme.dark ? 'text-gray-400' : 'text-gray-500'}`}
                  aria-label="Disconnect wallet"
                  title="Disconnect"
                  data-testid="disconnect-button"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                </button>
              )}
            </div>
          ) : (
            <ConnectButton />
          )}
          <button
            onClick={theme.toggle}
            className="p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            aria-label="Toggle theme"
            data-testid="theme-toggle"
          >
            {theme.dark ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {/* A preferred Game Wallet that a reload left locked. App-level because
          which key signs is a property of the whole app — see the component. */}
      <GameWalletUnlockBar />
      <GasSatoriPrompt />

      {/* Chain unreachable — every configured RPC is failing transient errors.
          Shows on every screen so the user knows why nothing is loading; clears
          itself the moment any subsequent RPC call succeeds. */}
      {!chainReachable && (
        <div
          className="bg-red-600 text-white px-4 py-2 text-sm flex items-center justify-between gap-3"
          data-testid="chain-unreachable-banner"
        >
          <span>
            Can't reach the chain right now, all RPC endpoints are unresponsive.
            Check your connection or try again in a moment.
          </span>
          <button
            onClick={() => window.location.reload()}
            className="bg-white/20 hover:bg-white/30 px-3 py-1 rounded text-xs font-medium whitespace-nowrap"
            data-testid="chain-retry-button"
          >
            Retry
          </button>
        </div>
      )}

      {/* Main */}
      {/* Bottom padding is deliberately much larger than the top's.
          Scrolling to the end of a long list and having the last row sit flush
          against the viewport edge reads as "cut off" rather than "finished",
          and several tabs here end in lists. env(safe-area-inset-bottom) is
          added on top because this installs as a PWA: in standalone mode on iOS
          the content area runs under the home indicator, which would eat the
          padding on exactly the devices that need it most. It resolves to 0
          everywhere else. */}
      <main className="max-w-4xl mx-auto px-4 sm:px-6 pt-4 sm:pt-6 pb-[calc(3rem+env(safe-area-inset-bottom))] sm:pb-[calc(4rem+env(safe-area-inset-bottom))]">
        {!wallet.isConnected ? (
          <div className="text-center py-20">
            <h2 className="text-3xl font-bold mb-4">Welcome to Satori</h2>
            <p className="text-gray-400 mb-8">Connect your wallet to start predicting.</p>
          </div>
        ) : streamList.loading ? (
          <div className="bg-gray-800 rounded-lg p-8 text-center" data-testid="loading">
            <p className="text-gray-400">Loading streams...</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* No referral banner: a referred user sees nothing on link open.
                The referral is set silently on their first prediction via the
                predictMultipleWithReferral wrapper. */}

            {/* Claim banner (persistent warning) */}
            {dashboard.data && (
              <ClaimBanner
                claimable={dashboard.data.claimable}
                onClaim={() => dashboard.claim()}
                claiming={dashboard.claiming}
              />
            )}

            {/* Prediction area (top).
                The "predicted today" card can be dismissed to reveal the chart
                beneath it. Predicting again before the round turns over is
                impossible — the contract enforces that, not the UI — so the
                chart shows WITHOUT the UP/DOWN buttons. Offering buttons that
                can only revert would be worse than offering none. */}
            {dashboard.data?.hasPredictedToday && flow.predictions.length === 0 && !predictedCardDismissed ? (
              <div className="card-themed p-8 text-center" data-testid="already-predicted">
                <div className="text-4xl mb-3">&#10003;</div>
                <h3 className="text-xl font-bold mb-2">You've predicted today</h3>
                <p className="text-sm text-gray-500">
                  <RoundCountdown prefix="Next round in" />
                </p>
                <button
                  onClick={() => setPredictedCardDismissed(true)}
                  className="mt-4 text-xs underline text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                  data-testid="btn-dismiss-predicted"
                >
                  Dismiss and show the chart
                </button>
              </div>
            ) : displayStream ? (
              <div className="space-y-4">
                {/* Progress bar — fades out when exiting */}
                <div style={{
                  opacity: viewPhase === 'exiting' || viewPhase === 'submit' ? 0 : 1,
                  maxHeight: viewPhase === 'submit' ? 0 : 40,
                  overflow: 'hidden',
                  transition: 'opacity 0.2s ease-out, max-height 0.3s ease-out 0.15s',
                }}>
                  <StreamProgress
                    currentIndex={flow.currentIndex}
                    totalStreams={flow.totalStreams}
                    predictionsCount={flow.predictionsCount}
                    atMaxPredictions={flow.atMaxPredictions}
                    maxPredictions={flow.displayMax}
                    onPrevious={flow.previous}
                    onNext={flow.skip}
                  />
                </div>

                {/* Chart — fades out first */}
                <div style={{
                  opacity: viewPhase === 'exiting' || viewPhase === 'submit' ? 0 : 1,
                  maxHeight: viewPhase === 'submit' ? 0 : 500,
                  overflow: 'hidden',
                  transition: 'opacity 0.2s ease-out, max-height 0.3s ease-out 0.15s',
                }}>
                  <StreamChart
                    stream={{
                      ...displayStream,
                      isEligible: streamList.isEligible(displayStream.id),
                      history: streamDetail.detail?.id === displayStream.id
                        ? streamDetail.detail.history
                        : [],
                      prevOfFirst: streamDetail.detail?.id === displayStream.id
                        ? streamDetail.detail.prevOfFirst
                        : undefined,
                    }}
                    height={300}
                    isFavorite={flow.isFavorite(displayStream.id)}
                    onToggleFavorite={() => flow.toggleFavorite(displayStream.id)}
                    dark={theme.dark}
                    valueDisplay={chartValueDisplay}
                    targetMinutes={chartTargetMinutes}
                    description={describeStream(displayStream, chartValueDisplay)}
                  />
                  {streamDetail.loading && (
                    <div className="text-center text-xs text-gray-500">Loading chart data...</div>
                  )}
                </div>

                {/* Per-stream streak meter — the streak the user has going on the
                    stream they're about to predict, right where it's on their
                    mind. Fades/collapses with the chart+buttons on submit. */}
                <div style={{
                  opacity: viewPhase === 'exiting' || viewPhase === 'submit' ? 0 : 1,
                  maxHeight: viewPhase === 'submit' ? 0 : 44,
                  overflow: 'hidden',
                  transition: 'opacity 0.2s ease-out 0.05s, max-height 0.3s ease-out 0.18s',
                }}>
                  <StreakMeter
                    streak={dashboard.data?.streaks.find((s) => s.streamId === displayStream.id)?.length ?? 0}
                    bar={dashboard.data?.barByStream[displayStream.id]}
                    dark={theme.dark}
                  />
                </div>

                {/* UP/DOWN buttons — fade out offset (slightly after chart) */}
                <div style={{
                  opacity: viewPhase === 'exiting' || viewPhase === 'submit' ? 0 : 1,
                  maxHeight: viewPhase === 'submit' ? 0 : 300,
                  overflow: 'hidden',
                  transition: 'opacity 0.2s ease-out 0.08s, max-height 0.3s ease-out 0.2s',
                }}>
                  {/* Dismissed the "predicted today" card: chart only, no
                      buttons. The contract's predict gate would reject a second
                      prediction this round anyway, so a button here could only
                      produce a revert. */}
                  {(dashboard.data?.hasPredictedToday || justPredicted) && flow.predictions.length === 0 ? (
                    <div className="card-themed p-4 text-center text-sm text-gray-400" data-testid="already-predicted-inline">
                      You've predicted this round. <RoundCountdown prefix="Next round in" />
                    </div>
                  ) : dashboard.data?.hasPredictionDelegate ? (
                    <div className="card-themed p-4 text-center text-sm text-gray-400" data-testid="delegated-notice">
                      Your prediction power is delegated, so your delegate predicts for you. To predict yourself, revoke the delegation on the Advanced tab.
                    </div>
                  ) : (dashboard.data && dashboard.data.lockedUntil > dashboard.data.currentRound) ? (
                    // Prediction power is locked for the current round (the contract's
                    // predict gate uses `lockedUntil > currentRound`). This happens
                    // after revoking a delegation: you free your power but can't
                    // predict until the next round. Read straight from chain state so
                    // it stays correct across refreshes — no local memory needed.
                    <div className="card-themed p-4 text-center text-sm text-gray-400" data-testid="locked-notice">
                      Your delegation is revoked. Your prediction power stays locked for the current 24-hour round. You can predict again when the next one starts.
                    </div>
                  ) : (
                    <PredictionButtons
                      streamId={displayStream.id}
                      onPredict={pressPrediction}
                      onSkip={flow.skip}
                      disabled={flow.atMaxPredictions}
                      existingPrediction={pressedFor(displayStream.id)}
                      canGoBack={flow.currentIndex > 0}
                      onBack={flow.previous}
                      dark={theme.dark}
                      // The game's question, in the game's own horizon:
                      // "Higher in 24 hours?" on the default game. Same meta
                      // the chart's tooltip speaks from.
                      targetMinutes={chartTargetMinutes}
                    />
                  )}
                </div>

                {/* Prediction summary — fades in after chart/buttons exit.
                    max-height drives the reveal transition; size it to the row
                    count (~48px/row + header/padding) so the list never clips
                    its bottom rows. Over-estimating is safe — the card renders
                    at its natural content height; max-height only caps it. */}
                <div style={{
                  opacity: viewPhase === 'submit' ? 1 : 0,
                  maxHeight: viewPhase === 'submit' ? flow.predictions.length * 48 + 120 : 0,
                  overflow: 'hidden',
                  transition: 'opacity 0.25s ease-out 0.25s, max-height 0.35s ease-out 0.2s',
                }}>
                  <div className="card-themed p-4">
                    <h3 className="text-lg font-bold text-center mb-3">Ready to Submit</h3>
                    <div className="space-y-2">
                      {flow.predictions.map((p) => {
                        const s = streamList.streams.find((s) => s.id === p.streamId);
                        const gate = gateFor(p.streamId);
                        const active = gate.active;
                        // Cadence badge — the same purple chip as the chart
                        // header.
                        const cadenceLabel = s ? formatCadenceLabel(s.minCadenceMinutes) : null;
                        // The row's inner content — shared by the active and the
                        // grayed-out (inactive) variants.
                        const inner = (
                          <>
                            <span className="flex items-center gap-1.5 min-w-0">
                              {!active && <span aria-hidden>&#8856;</span>}
                              <span className="truncate">{s?.name ?? `Stream #${p.streamId}`}</span>
                              {cadenceLabel && (
                                <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded text-purple-300 bg-purple-900/30">
                                  {cadenceLabel}
                                </span>
                              )}
                            </span>
                            {/* The press, not the chain byte — they differ on an
                                inverted Uniswap stream. */}
                            {(() => {
                              const shown = p.displayDirection ?? p.direction;
                              return (
                                <span className={active ? (shown === 1 ? 'text-green-400 font-bold' : 'text-red-400 font-bold') : 'font-bold'}>
                                  {shown === 1 ? 'UP' : 'DOWN'}
                                </span>
                              );
                            })()}
                          </>
                        );
                        // Active: a normal row. Inactive (stream hasn't updated
                        // this round): grayed out, and the whole row is a styled
                        // hover target explaining it'll be skipped on submit.
                        return active ? (
                          <div key={p.streamId} className="flex items-center justify-between bg-gray-700/50 rounded px-3 py-2 text-sm">
                            {inner}
                          </div>
                        ) : (
                          <InfoTip
                            key={p.streamId}
                            label="Why is this grayed out?"
                            triggerClassName="w-full flex items-center justify-between gap-2 bg-gray-800/40 text-gray-500 rounded px-3 py-2 text-sm text-left cursor-help"
                            trigger={inner}
                          >
                            {s?.isNamed ? (
                              <>
                                This stream can&apos;t take a prediction right now, so it&apos;ll be skipped when you submit. Sentiment streams take one call per round.
                                {gate.reopenHour != null && <> You can call this one again at {reopenTime(gate.reopenHour, currentHour())}.</>}
                              </>
                            ) : (
                              <>This stream can&apos;t take a prediction right now, so it&apos;ll be skipped when you submit. Either it hasn&apos;t published a new value since your last prediction on it, or you&apos;ve already predicted it this round: one prediction per stream per 24-hour round.</>
                            )}
                          </InfoTip>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Submit + Continue Predicting + round footer.
                    Visible whenever there's something to act on:
                      - predictions queued → Submit button
                      - at submit screen with ineligible streams left → Continue Predicting button
                      - submit just succeeded → success message */}
                {(flow.predictionsCount > 0 || submitSuccess || (flow.atSubmitScreen && flow.hasIneligibleRemaining && !flow.showKeepGoing)) && (
                  <div className="space-y-2">
                    {flow.predictionsCount > 0 && !submitSuccess && (
                      <button
                        onClick={handleSubmit}
                        disabled={flow.isSubmitting || activePredictionCount === 0}
                        className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 text-white font-bold rounded-lg transition-colors"
                        data-testid="btn-submit"
                      >
                        {flow.isSubmitting
                          ? 'Submitting...'
                          : activePredictionCount === 0
                            ? 'No streams active this round'
                            : `Submit ${activePredictionCount} Prediction${activePredictionCount !== 1 ? 's' : ''}`}
                      </button>
                    )}
                    {/* Soft once-per-round reminder (review #13): a muted line, no
                        alarm chrome, no extra clicks — just enough that nobody
                        expects to fire twice in a row. */}
                    {flow.predictionsCount > 0 && !submitSuccess && (
                      <p className="text-center text-xs text-gray-500">
                        You can predict each stream once every 24 hours. Pick your streams, then submit them together.
                      </p>
                    )}
                    {flow.atSubmitScreen && flow.hasIneligibleRemaining && !flow.showKeepGoing && !submitSuccess && (
                      <button
                        onClick={flow.keepGoing}
                        className="w-full py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg text-sm font-medium transition-colors"
                        data-testid="btn-continue-predicting"
                      >
                        Continue Predicting (streams not rewarding yet)
                      </button>
                    )}
                    {submitError && (
                      <div className="p-2 bg-red-900/30 border border-red-700 rounded text-sm text-red-300" data-testid="submit-error">{submitError}</div>
                    )}
                    {submitSuccess && (
                      <div className="card-themed p-6 text-center">
                        <div className="text-4xl mb-2">&#10003;</div>
                        <h3 className="text-lg font-bold text-green-400">{submittedCount} prediction{submittedCount !== 1 ? 's' : ''} submitted!</h3>
                        <p className="text-gray-400 text-sm mt-1">
                          <RoundCountdown prefix="Next round in" />
                        </p>
                        {/* The same escape hatch as the "predicted today" card,
                            which is what a later visit shows. Without it, the
                            only way back to the chart after submitting was to
                            reload — and these two screens look different enough
                            that it was not obvious a reload would even help.
                            Clearing the flow AND pre-dismissing the card lands
                            straight on the chart, instead of swapping one
                            blocking card for another. */}
                        <button
                          onClick={() => {
                            setSubmitSuccess(false);
                            setPredictedCardDismissed(true);
                            flow.reset();
                          }}
                          className="mt-4 text-xs underline text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                          data-testid="btn-dismiss-submitted"
                        >
                          Dismiss and show the chart
                        </button>
                      </div>
                    )}
                    {currentRound && deploymentRound != null && (
                      <div className="text-center text-xs text-gray-500 pt-1">Round {Number(currentRound) - deploymentRound + 1}</div>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-gray-800 rounded-lg p-8 text-center">
                <p className="text-gray-400">No streams available.</p>
              </div>
            )}

            {/* No app-wide notice for a failed dev-fee probe, deliberately: the
                probe is silent-by-contract (useTabProbes) — it retries in the
                background and remembers a payee's last confirmed answer, so a
                blip no longer hides their tab, and nobody else ever cared. The
                loud error lives in DevFeeTab, which only a payee can mount. */}

            {/* Tabbed sections below */}
            <div className={`border-t pt-4 ${theme.dark ? 'border-gray-700' : 'border-gray-100'}`}>
              <div className="flex gap-1 mb-4 overflow-x-auto pb-1 -mx-1 px-1">
                {([
                  // Order follows the order we expect behaviours to be taken, not
                  // feature importance: far more people will delegate their prediction
                  // power from the Leaderboard than will burn tokens to Vote, so
                  // Leaderboard comes first (owner, 2026-08-22).
                  // Labels: referral = "Refer", streams = "Vote", delegation = "Advanced".
                  'dashboard', 'referral', 'leaderboard', 'streams', 'history', 'delegation', 'bounties',
                  // Holder voting exists only on chains with a deployed
                  // governor + proof pipeline; elsewhere there is nothing to
                  // show, so there is no tab rather than an empty one.
                  ...(proposalsEnabled ? ['proposals'] : []),
                  ...(devFee.isPayee ? ['dev fee'] : []),
                  ...(devFee.isAuthority ? ['dev fee admin'] : []),
                  ...(ownerHook.isOffchainReporter || ownerHook.isRootPublisher ? ['off-chain'] : []),
                  ...(ownerHook.isGovernor ? ['governor'] : []),
                  ...(hasAdminTab ? ['admin'] : []),
                ] as Tab[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`px-4 py-2 rounded-t text-sm font-medium transition-colors capitalize whitespace-nowrap
                      ${activeTab === tab
                        ? theme.dark ? 'bg-gray-800 text-white' : 'bg-white text-gray-900 shadow-sm'
                        : theme.dark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    data-testid={`tab-${tab}`}
                  >
                    {/* Display-only label overrides. Internal ids stay the same so
                        deep-links (?tab=streams / ?tab=referral / ?tab=delegation) and
                        e2e selectors (tab-streams / etc.) keep working. "streams" shows
                        as "Vote", "referral" as "Refer", "delegation" as "Advanced". */}
                    {TAB_LABELS[tab] ?? tab}
                  </button>
                ))}
              </div>

              {activeTab === 'dashboard' && dashboard.data && (
                <Dashboard
                  data={dashboard.data}
                  onClaim={dashboard.claim}
                  claiming={dashboard.claiming}
                  claimError={dashboard.claimError}
                  claimSuccess={dashboard.claimSuccess}
                />
              )}
              {activeTab === 'dashboard' && dashboard.loading && (
                <div className="bg-gray-800 rounded-lg p-6 text-center">
                  <p className="text-gray-400 text-sm">Loading dashboard...</p>
                </div>
              )}
              {/* The tab used to render on `data` OR `loading`, so a load that
                  threw showed literally nothing — no error, no empty state, just
                  a blank page with the reason in the console where nobody looks.
                  Every remaining case now says something. */}
              {activeTab === 'dashboard' && !dashboard.loading && !dashboard.data && (
                <div className="card-themed p-6 text-center space-y-3" data-testid="dashboard-empty">
                  {dashboard.error ? (
                    <>
                      <p className="text-sm font-medium">The dashboard could not load.</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 font-mono break-words">
                        {dashboard.error}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Often a busy public RPC rather than anything wrong with your account. Worth retrying.
                      </p>
                    </>
                  ) : streamList.streams.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      Waiting for the data streams to load. The dashboard is built from them.
                    </p>
                  ) : (
                    <p className="text-sm text-gray-500 dark:text-gray-400">Nothing to show yet.</p>
                  )}
                  <button
                    onClick={() => dashboard.reload()}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 !text-white text-sm font-medium rounded"
                    data-testid="dashboard-retry"
                  >
                    Retry
                  </button>
                </div>
              )}

              {/* INSTANT SIGNING, last on the dashboard and nowhere else.
                  It lived under Advanced beside the manual delegation rows,
                  which is where its PLUMBING belongs — it delegates prediction
                  power to a device-local key — but not where its AUDIENCE is.
                  Nobody opens an Advanced tab to find out their signing could
                  stop prompting them. It is a headline feature filed as an
                  implementation detail, so it moves to the page everyone lands
                  on, at the bottom: under the numbers people came for, not
                  competing with them. Deliberately carries no section heading —
                  the panel titles itself, and any heading here would re-file it
                  under a category again. */}
              {activeTab === 'dashboard' && (
                <div className="mt-4" data-testid="dashboard-instant-signing">
                  <GameWalletPanel />
                </div>
              )}

              {activeTab === 'streams' && renderStreamsTab('vote')}

              {activeTab === 'bounties' && <BountiesTab streams={streamList.streams} onPredictStream={jumpToPredictStream} />}
              {activeTab === 'proposals' && <ProposalsTab />}

              {activeTab === 'history' && (
                <div className="space-y-4">
                  <HistoryTab onSettle={dashboard.settle} />
                </div>
              )}

              {activeTab === 'delegation' && (
                <div className="space-y-8" data-testid="advanced-tab">
                  {/* Off-chain drop claims. Here rather than on the dashboard
                      because it is rare, and because it CANNOT ride along with
                      the ordinary Claim button: that goes to the hub and this
                      goes to the merkle contract, so one click would mean two
                      transactions and two signatures. Multicall cannot merge
                      them either — claimMerkle mints to msg.sender, which would
                      become the Multicall contract. */}
                  <section>
                    <MerkleClaimPanel />
                  </section>
                  {/* Airdrop claim, here for the same reason as the merkle panel
                      above: claimAirdrop mints from airdropAllocation through the
                      token's own airdropMint path, while the ordinary Claim
                      button moves unclaimedRewards through the hub. Different
                      contracts, different balances, so one button cannot do both.
                      Renders nothing for an address with no allocation, which is
                      nearly everyone. */}
                  <section>
                    <AirdropClaimPanel />
                  </section>
                  <section>
                    <h2 className="text-lg font-bold mb-3">Scoring Split</h2>
                    <ScoringSplit />
                  </section>
                  <section>
                    <h2 className="text-lg font-bold mb-3">Delegation</h2>
                    <DelegationTab />
                  </section>
                  {/* Only where a relayer is configured for this chain — the
                      entire pay-in-SATORI surface exists only where one does. */}
                  {gasless.enabled && (
                    <section>
                      <h2 className="text-lg font-bold mb-3">Gas</h2>
                      <GasSettings />
                    </section>
                  )}
                  <section>
                    <h2 className="text-lg font-bold mb-1">Your Streams</h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                      Streams you provide. Set their value, rename, transfer them, or create a new one.
                    </p>
                    {renderStreamsTab('manage')}
                  </section>
                </div>
              )}


              {activeTab === 'referral' && <ReferralTab />}
              {activeTab === 'dev fee' && <DevFeeTab />}
              {activeTab === 'dev fee admin' && <DevFeeAdminTab />}

              {activeTab === 'leaderboard' && <LeaderboardTab streams={streamList.streams} />}

              {activeTab === 'governor' && ownerHook.isGovernor && <GovernorTab />}
              {activeTab === 'admin' && hasAdminTab && <AdminTab />}
              {activeTab === 'off-chain' && (ownerHook.isOffchainReporter || ownerHook.isRootPublisher) && <OffchainTab />}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
