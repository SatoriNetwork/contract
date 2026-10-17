import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { useGames } from '../hooks/useGames';
import { useAllBounties, bountyDripPerRound, BountyListing } from '../hooks/useAllBounties';
import { useBountyStakes } from '../hooks/useBountyStakes';
import { useKnownTokens } from '../hooks/useKnownTokens';
import { explainError } from '../utils/errors';
import { publishDappEvent } from '../utils/events';
import { afterTx } from '../lib/afterTx';
import { planBountyFunding, ApprovalStep } from '../lib/bountyAllowances';
import { makeAllowanceReaders, fundBountyOneConfirmation, tokenCanPermit, walletCanBatch } from '../lib/bountyAllowanceReaders';
import { NAMED_NO_BOUNTY } from '../lib/namedStream';

interface StreamOption { id: number; name: string; isNamed?: boolean }

interface BountiesTabProps {
  streams: StreamOption[];
  // Jump to a stream in the top batched prediction flow. Predicting is a single
  // once-per-round batch (SatoriEngine enforces one prediction batch per round),
  // so we never predict inline here — we route to the shared flow up top.
  onPredictStream: (streamId: number) => void;
}

function fmtUnits(amount: bigint, decimals: number): string {
  try {
    const n = parseFloat(ethers.formatUnits(amount, decimals));
    if (n === 0) return '0';
    if (n < 0.0001) return '<0.0001';
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  } catch {
    return '0';
  }
}

function bountyKey(b: { gameId: number; token: string }): string {
  return `${b.gameId}-${b.token}`;
}

type Status = { kind: 'success' | 'error'; msg: string } | null;

export function BountiesTab({ streams, onPredictStream }: BountiesTabProps) {
  const { contracts, isConnected } = useContracts();
  const { address } = useWallet();
  const { resolveGameId } = useGames();
  const { bounties, loading, reload } = useAllBounties();
  const stakes = useBountyStakes();
  // Candidate tokens discovered on-chain (see useKnownTokens for why a full
  // wallet-holdings list is not obtainable).
  const knownTokens = useKnownTokens(streams.map((s) => Number(s.id)));

  // Stake-in-token lookup so each bounty row can show what the user already has
  // staked (i.e. whether they've already opted into this bounty's token).
  const stakeByToken = useMemo(() => {
    const m = new Map<string, bigint>();
    for (const e of stakes.entries) m.set(e.token, e.stake);
    return m;
  }, [stakes.entries]);

  // ---- Active-bounty opt-in (stake) state ------------------------------------
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [addStake, setAddStake] = useState<Record<string, string>>({});
  const [rowStatus, setRowStatus] = useState<Record<string, Status>>({});
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const setRowStat = (key: string, s: Status) => setRowStatus((m) => ({ ...m, [key]: s }));

  // Stake the bounty's token (opt in). We NEVER predict here — prediction is a
  // single once-per-round batch, so it happens in the top flow (Predict button).
  const doStake = useCallback(async (b: BountyListing) => {
    const key = bountyKey(b);
    if (!isConnected) { setRowStat(key, { kind: 'error', msg: 'Connect your wallet first.' }); return; }
    const amtStr = (addStake[key] ?? '').trim();
    if (!amtStr) { setRowStat(key, { kind: 'error', msg: `Enter an amount of ${b.symbol} to stake.` }); return; }
    let amt: bigint;
    try { amt = ethers.parseUnits(amtStr, b.decimals); }
    catch { setRowStat(key, { kind: 'error', msg: 'Invalid amount.' }); return; }
    if (amt <= BigInt(0)) { setRowStat(key, { kind: 'error', msg: 'Amount must be greater than zero.' }); return; }
    setRowBusy(key);
    setRowStat(key, null);
    try {
      // Approve as its OWN press when the allowance is short. Chaining the two
      // signatures cannot work on mobile: the wallet round trip unloads the page
      // and the queued stake never runs (`563a9539`).
      if (await stakes.stakeNeedsApproval(b.token, amt)) {
        const appr = await stakes.approveForStake(b.token, amt);
        setRowStat(key, appr.ok
          ? { kind: 'success', msg: `Approved ${b.symbol}. Press Stake again to complete it.` }
          : { kind: 'error', msg: appr.error });
        return;
      }
      const res = await stakes.stake(b.token, amt);
      if (!res.ok) { setRowStat(key, { kind: 'error', msg: res.error }); return; }
      setRowStat(key, { kind: 'success', msg: `Staked ${b.symbol}. Now predict this stream from the top (one prediction per round) to lock in your share.` });
      setAddStake((m) => ({ ...m, [key]: '' }));
      await Promise.all([reload(), stakes.reload()]);
    } catch (e: unknown) {
      setRowStat(key, { kind: 'error', msg: explainError(e) });
    } finally {
      setRowBusy(null);
    }
  }, [isConnected, addStake, stakes, reload]);

  // ---- Create-a-bounty state -------------------------------------------------
  const [cStreamId, setCStreamId] = useState<number | ''>('');
  const [cToken, setCToken] = useState('');
  const [cMeta, setCMeta] = useState<{ symbol: string; decimals: number } | null>(null);
  const [cMetaErr, setCMetaErr] = useState<string | null>(null);
  const [cAmount, setCAmount] = useState('');
  const [cRate, setCRate] = useState('');
  const [cConfirm, setCConfirm] = useState(false);
  const [cStatus, setCStatus] = useState<Status>(null);
  const [cBusy, setCBusy] = useState(false);
  const cNamed = streams.find((s) => s.id === cStreamId)?.isNamed === true;

  /// The one-off SATORI burn for posting a NEW token on a game, read from the
  /// contract rather than computed here. lib/round has the formula, but the burn
  /// schedule is a rule the contract owns and may change on upgrade — quoting a
  /// locally-derived number is how a displayed fee drifts from the charged one.
  /// Null while loading or on failure, and the copy degrades to plain "SATORI".
  const [postingBurn, setPostingBurn] = useState<string | null>(null);
  useEffect(() => {
    if (!contracts) return;
    let cancelled = false;
    (async () => {
      try {
        const wei: bigint = await contracts.cached.round.satori.bountyBurn();
        if (!cancelled) {
          const n = parseFloat(ethers.formatEther(wei));
          setPostingBurn(n >= 1 ? n.toFixed(2).replace(/\.00$/, '') : n.toPrecision(3));
        }
      } catch {
        if (!cancelled) setPostingBurn(null);
      }
    })();
    return () => { cancelled = true; };
  }, [contracts]);

  const checkToken = useCallback(async () => {
    setCMeta(null); setCMetaErr(null);
    const t = cToken.trim();
    if (!ethers.isAddress(t)) { setCMetaErr('Enter a valid token address.'); return; }
    const meta = await stakes.fetchTokenMetadata(t);
    if (!meta) { setCMetaErr('Could not read this token (symbol/decimals).'); return; }
    setCMeta(meta);
  }, [cToken, stakes]);

  /// Approvals still owed before `fundBounty` can be sent. Each is ONE press and
  /// ONE signature — never chained, because a wallet round trip unloads the page
  /// on mobile and the code queued after it ceases to exist (`563a9539`).
  const [cSteps, setCSteps] = useState<ApprovalStep[] | null>(null);
  /// Set when the outstanding allowances can all be signed for, so funding is a
  /// single press. Carries the plan the signing path needs.
  const [cOnePress, setCOnePress] = useState<
    { gameId: number; token: string; amount: bigint; proposedRate: bigint; steps: ApprovalStep[] } | null
  >(null);

  /// Parse the form once, so the review, the approvals and the send all agree on
  /// the same numbers. Returns null and sets the error when the form is not valid.
  const parseForm = useCallback(() => {
    if (!contracts) { setCStatus({ kind: 'error', msg: 'Not connected.' }); return null; }
    if (cStreamId === '') { setCStatus({ kind: 'error', msg: 'Pick a stream.' }); return null; }
    const t = cToken.trim();
    if (!ethers.isAddress(t)) { setCStatus({ kind: 'error', msg: 'Invalid token address.' }); return null; }
    const decimals = cMeta?.decimals ?? 18;
    let amt: bigint; let rate: bigint;
    try {
      amt = ethers.parseUnits(cAmount.trim(), decimals);
      rate = ethers.parseUnits(cRate.trim(), decimals);
    } catch { setCStatus({ kind: 'error', msg: 'Amount and drip must be valid numbers.' }); return null; }
    if (amt <= BigInt(0) || rate <= BigInt(0)) {
      setCStatus({ kind: 'error', msg: 'Amount and drip must be greater than zero.' }); return null;
    }
    return { token: t, amt, rate, decimals };
  }, [contracts, cStreamId, cToken, cMeta, cAmount, cRate]);

  /// Recompute what is still owed. Called on entering review and after each
  /// approval lands, so the panel always offers the next single action.
  const refreshSteps = useCallback(async (): Promise<ApprovalStep[] | null> => {
    const form = parseForm();
    if (!form || !contracts) return null;
    const gameId = await resolveGameId(cStreamId as number);
    if (!gameId) { setCStatus({ kind: 'error', msg: `Stream #${cStreamId} has no game to fund a bounty on yet.` }); return null; }
    const [satoriAddress, bountiesAddress, hubAddress] = await Promise.all([
      contracts.reads.token.getAddress(),
      contracts.bounties.getAddress(),
      contracts.hub.getAddress(),
    ]);
    const steps = await planBountyFunding(
      { gameId, token: form.token, amount: form.amt, symbol: cMeta?.symbol, decimals: form.decimals, satoriAddress, bountiesAddress, hubAddress },
      makeAllowanceReaders(contracts, address),
    );
    // If every outstanding allowance can be SIGNED for, there is nothing to
    // approve and the whole thing is one press. Probing costs reads only, no
    // wallet interaction, so it is safe to do before the user commits.
    if (steps.length > 0 && address
        && (await tokenCanPermit(contracts, form.token) || await walletCanBatch(contracts, address))) {
      setCSteps([]);
      setCOnePress({ gameId, token: form.token, amount: form.amt, proposedRate: form.rate, steps });
      return [];
    }
    setCOnePress(null);
    setCSteps(steps);
    return steps;
  }, [parseForm, contracts, resolveGameId, cStreamId, cMeta, address]);

  /// Send exactly one approval, then re-plan.
  const runApproval = useCallback(async (step: ApprovalStep) => {
    if (!contracts) return;
    setCBusy(true); setCStatus(null);
    try {
      const erc20 = new ethers.Contract(
        step.token,
        ['function approve(address,uint256) returns (bool)'],
        (contracts.satori as unknown as { runner: ethers.ContractRunner }).runner,
      );
      await afterTx(await erc20.approve(step.spender, step.amount));
      await refreshSteps();
    } catch (e: unknown) {
      setCStatus({ kind: 'error', msg: explainError(e) });
    } finally {
      setCBusy(false);
    }
  }, [contracts, refreshSteps]);

  /// Sends ONE transaction. Everything it needs was approved by earlier presses.
  const createBounty = useCallback(async () => {
    const form = parseForm();
    if (!form || !contracts) return;
    setCBusy(true); setCStatus(null); setCConfirm(false);
    try {
      const gameId = await resolveGameId(cStreamId as number);
      if (!gameId) throw new Error(`Stream #${cStreamId} has no game to fund a bounty on yet.`);

      // One press: sign the outstanding allowances and let fundBountyWithPermit
      // consume them inside this same transaction. `cOnePress` is set during
      // review only when every outstanding allowance CAN be signed for.
      const oneShot = cOnePress && address
        ? await fundBountyOneConfirmation(contracts, address, cOnePress, cOnePress.steps)
        : null;
      if (cOnePress && !oneShot) {
        // Neither route worked after all (a wallet that declined typed data, or
        // batching that vanished between review and press). Re-plan so the panel
        // offers the approval presses instead of failing.
        setCStatus({ kind: 'error', msg: 'Could not do this in one step. Approve it instead.' });
        await refreshSteps();
        return;
      }
      if (oneShot?.failed) throw new Error(oneShot.failed);
      if (oneShot) {
        if (oneShot.tx) await afterTx(oneShot.tx);
      } else {
        await afterTx(await contracts.bounties.fundBounty(gameId, form.token, form.amt, form.rate));
      }
      setCStatus({ kind: 'success', msg: 'Bounty funded. It will appear in the active list.' });
      setCAmount(''); setCRate(''); setCToken(''); setCMeta(null); setCSteps(null); setCOnePress(null);
      publishDappEvent('bounty-funded', { streamId: cStreamId, token: form.token });
      await Promise.all([reload(), stakes.reload()]);
    } catch (e: unknown) {
      setCStatus({ kind: 'error', msg: explainError(e) });
    } finally {
      setCBusy(false);
    }
  }, [parseForm, contracts, cStreamId, resolveGameId, reload, stakes, cOnePress, address, refreshSteps]);

  // ---- Manage stakes / earnings (add / unstake / withdraw, per token) --------
  const [manageRow, setManageRow] = useState<{ token: string; mode: 'add' | 'unstake' } | null>(null);
  const [manageAmt, setManageAmt] = useState('');
  const [manageStatus, setManageStatus] = useState<Status>(null);

  const openManage = (token: string, mode: 'add' | 'unstake') => {
    setManageRow((cur) => (cur && cur.token === token && cur.mode === mode ? null : { token, mode }));
    setManageAmt('');
    setManageStatus(null);
  };

  const doAddStake = useCallback(async (token: string, decimals: number) => {
    let amt: bigint;
    try { amt = ethers.parseUnits(manageAmt.trim(), decimals); }
    catch { setManageStatus({ kind: 'error', msg: 'Invalid amount.' }); return; }
    if (amt <= BigInt(0)) { setManageStatus({ kind: 'error', msg: 'Enter an amount greater than zero.' }); return; }
    // One press per signature — see doStake.
    if (await stakes.stakeNeedsApproval(token, amt)) {
      const appr = await stakes.approveForStake(token, amt);
      setManageStatus(appr.ok
        ? { kind: 'success', msg: 'Approved. Press Add again to complete it.' }
        : { kind: 'error', msg: appr.error });
      return;
    }
    const res = await stakes.stake(token, amt); // additive
    setManageStatus(res.ok
      ? { kind: 'success', msg: 'Added to your stake. Your share of the bounty grows with it.' }
      : { kind: 'error', msg: res.error });
    if (res.ok) { setManageRow(null); setManageAmt(''); await reload(); }
  }, [manageAmt, stakes, reload]);

  const doUnstake = useCallback(async (token: string, decimals: number) => {
    if (!address) return;
    let amt: bigint;
    try { amt = ethers.parseUnits(manageAmt.trim(), decimals); }
    catch { setManageStatus({ kind: 'error', msg: 'Invalid amount.' }); return; }
    const res = await stakes.unstake(token, amt, address);
    setManageStatus(res.ok
      ? { kind: 'success', msg: 'Unstaked to your wallet.' }
      : { kind: 'error', msg: res.error });
    if (res.ok) { setManageRow(null); setManageAmt(''); await reload(); }
  }, [address, manageAmt, stakes, reload]);

  // (doWithdraw removed — the dead unclaimedBounty withdraw path is gone;
  // bounty winnings compound into bountyStake, cashed out via unstake — A4.)

  // ---------------------------------------------------------------------------
  return (
    <div className="space-y-6" data-testid="bounties-tab">
      {/* Intro */}
      <div className="card-themed p-4">
        <h2 className="font-semibold mb-1">Bounties</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          A bounty pays predictors, in any token, for predicting on a specific stream,{' '}
          <strong>including streams that aren't winning SATORI votes</strong>. That's the point:
          incentivize attention where the protocol's own rewards don't reach. To earn one you{' '}
          <strong>stake the bounty's token</strong> and <strong>predict the stream's direction</strong>;
          if you're right, your share of the pool auto-compounds into your stake. Winners keep 100%
          (no payout fee). Posting a bounty in a non-SATORI token costs a one-time SATORI burn;
          SATORI bounties are free.
        </p>
      </div>

      {/* Active bounties */}
      <div className="card-themed p-4" data-testid="active-bounties">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">Active bounties</h3>
          <button
            onClick={() => reload()}
            className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
          >
            Refresh
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading bounties…</p>
        ) : bounties.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            No active bounties right now. Fund one below to attract predictors to your stream.
          </p>
        ) : (
          <div className="space-y-2">
            {bounties.map((b) => {
              const key = bountyKey(b);
              const open = openKey === key;
              const drip = bountyDripPerRound(b.ratePerRound, b.pool);
              const myStake = stakeByToken.get(b.token) ?? BigInt(0);
              const busy = rowBusy === key;
              const st = rowStatus[key];
              return (
                <div key={key} className="border border-gray-200 dark:border-gray-600 rounded">
                  <button
                    onClick={() => setOpenKey(open ? null : key)}
                    className="w-full flex items-center justify-between px-3 py-2.5 text-left"
                    data-testid={`bounty-row-${b.gameId}-${b.symbol}`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{b.name}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {fmtUnits(b.pool, b.decimals)} {b.symbol} pool
                        {' · '}{fmtUnits(drip * BigInt(2), b.decimals)} {b.symbol}/day
                        {myStake > BigInt(0) && (
                          <span className="text-green-600 dark:text-green-400">
                            {' · '}you staked {fmtUnits(myStake, b.decimals)}
                          </span>
                        )}
                      </div>
                    </div>
                    <span
                      title={b.eligible
                        ? 'Vote-eligible: a correct prediction also earns SATORI on top of the bounty.'
                        : 'Not vote-eligible: a correct prediction earns the bounty only (no SATORI). You can still predict. That is what the bounty is for.'}
                      className={`ml-3 shrink-0 text-[10px] px-2 py-0.5 rounded-full font-medium
                      ${b.eligible
                        ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'}`}>
                      {b.eligible ? '+ SATORI' : 'bounty only'}
                    </span>
                  </button>

                  {open && (
                    <div className="px-3 pb-3 pt-1 border-t border-gray-100 dark:border-gray-700 space-y-3">
                      {/* Step 1 — stake this token to opt in (this is what earns the
                          bounty; prediction happens separately, up top). */}
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-xs text-gray-500 dark:text-gray-400">
                            <span className="font-medium text-gray-700 dark:text-gray-200">1. Stake {b.symbol}</span> to opt in
                          </label>
                          <span className="text-[11px] text-gray-400 shrink-0">
                            {myStake > BigInt(0) ? `you have ${fmtUnits(myStake, b.decimals)} staked` : 'you have none staked'}
                          </span>
                        </div>
                        <div className="mt-1 flex gap-2">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={addStake[key] ?? ''}
                            onChange={(e) => setAddStake((m) => ({ ...m, [key]: e.target.value }))}
                            placeholder={`Amount of ${b.symbol}`}
                            disabled={busy}
                            className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
                          />
                          <button
                            onClick={() => doStake(b)}
                            disabled={busy || !isConnected || !(addStake[key] ?? '').trim()}
                            className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                            data-testid={`stake-${b.gameId}`}
                          >
                            {busy ? '…' : (myStake > BigInt(0) ? 'Add' : 'Stake')}
                          </button>
                        </div>
                        <p className="mt-1 text-[11px] text-gray-400">
                          The bounty pays out daily (every 24-hour round) in proportion to how much
                          {' '}{b.symbol} you have staked when you predict, split among everyone who calls it
                          right. Winnings compound into the stake; manage or unstake it from “Your stakes” below.
                        </p>
                      </div>

                      {/* Step 2 — predict this stream in the top batched flow. You get
                          ONE prediction per round, so it must go through the shared flow. */}
                      <div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                          <span className="font-medium text-gray-700 dark:text-gray-200">2. Predict this stream</span>. You get one prediction per round, so make all your calls together up top.
                        </div>
                        <button
                          onClick={() => onPredictStream(b.streamId)}
                          disabled={!b.streamId}
                          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                          data-testid={`predict-${b.gameId}`}
                          title="Jump to this stream in the prediction flow at the top of the page"
                        >
                          Predict {b.name} ↑
                        </button>
                        {myStake === BigInt(0) && (
                          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                            Stake {b.symbol} above first. Predicting with no stake earns <strong>no bounty</strong>.
                          </p>
                        )}
                      </div>

                      {!b.eligible && (
                        <p className="text-[11px] text-gray-500 dark:text-gray-400">
                          This stream isn't vote-eligible, so a correct prediction earns the bounty
                          but no SATORI, which is exactly what a bounty is for.
                        </p>
                      )}

                      {st && (
                        <div className={`text-xs rounded p-2 ${st.kind === 'success'
                          ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                          : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'}`}>
                          {st.msg}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Create a bounty */}
      <div className="card-themed p-4" data-testid="create-bounty">
        <h3 className="font-semibold mb-3">Create a bounty</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400">Stream</label>
            <select
              value={cStreamId}
              onChange={(e) => setCStreamId(e.target.value === '' ? '' : Number(e.target.value))}
              disabled={cBusy}
              className="mt-1 w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
              data-testid="create-bounty-stream"
            >
              <option value="">Select a stream…</option>
              {streams.map((s) => (
                <option key={s.id} value={s.id}>#{s.id} {s.name}</option>
              ))}
            </select>
            {cNamed && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="create-bounty-named">{NAMED_NO_BOUNTY}</p>
            )}
          </div>

          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400">Bounty token address</label>
            {knownTokens.tokens.length > 0 && (
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  setCToken(e.target.value);
                  setCMeta(null);
                  setCMetaErr(null);
                }}
                disabled={cBusy}
                data-testid="bounty-token-picker"
                className="mt-1 w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
              >
                <option value="">Pick a known token…</option>
                {knownTokens.tokens.map((t) => (
                  <option key={t.address} value={t.address}>
                    {t.symbol}: you hold {Number(t.balance).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    {t.source === 'staked' ? ' · staked' : ' · funds a bounty'}
                  </option>
                ))}
              </select>
            )}
            <div className="mt-1 flex gap-2">
              <input
                type="text"
                value={cToken}
                onChange={(e) => { setCToken(e.target.value); setCMeta(null); setCMetaErr(null); }}
                placeholder="0x… (any ERC-20 contract address)"
                disabled={cBusy}
                className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
              />
              <button
                onClick={checkToken}
                disabled={cBusy}
                className="px-3 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-sm rounded transition-colors"
              >
                Check
              </button>
            </div>
            {cMeta && (
              <p className="mt-1 text-xs text-green-700 dark:text-green-400">
                {cMeta.symbol} · {cMeta.decimals} decimals
              </p>
            )}
            {cMetaErr && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{cMetaErr}</p>}
            {/* The old placeholder said "use the SATORI address for a free bounty",
                which reads as free money. The actual rule is a POSTING fee, and it
                is worth stating properly because it is a heavy one-off burn. */}
            <p className="mt-1 text-[11px] text-gray-500 dark:text-gray-400" data-testid="bounty-posting-fee-note">
              The token this bounty pays out in. Putting a <em>new</em> token on this game burns{' '}
              {postingBurn != null ? `${postingBurn} SATORI` : 'SATORI'}, a one-off posting fee
              charged the first time this game and token are paired. Paying in SATORI itself has no
              posting fee, and topping up a token already on this game is always free.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Total to deposit</label>
              <input
                type="text"
                inputMode="decimal"
                value={cAmount}
                onChange={(e) => setCAmount(e.target.value)}
                placeholder="e.g. 1000"
                disabled={cBusy}
                className="mt-1 w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 dark:text-gray-400">Drip per round (24h)</label>
              <input
                type="text"
                inputMode="decimal"
                value={cRate}
                onChange={(e) => setCRate(e.target.value)}
                placeholder="e.g. 50"
                disabled={cBusy}
                className="mt-1 w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
              />
              {/* How long the deposit LASTS, which is the thing a funder is
                  actually deciding. Rounds are 24h now, so rounds and days are
                  the same number — say it once. */}
              {(() => {
                const total = Number(cAmount);
                const rate = Number(cRate);
                if (!cAmount.trim() || !cRate.trim()) return null;
                if (!Number.isFinite(total) || !Number.isFinite(rate) || rate <= 0 || total <= 0) return null;
                const days = total / rate; // one round per day
                const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
                return (
                  <p className="mt-1 text-[11px] text-gray-400" data-testid="bounty-drip-duration">
                    lasts ≈ {fmt(days)} day{days === 1 ? '' : 's'} (one round per day)
                  </p>
                );
              })()}
            </div>
          </div>

          {!cConfirm ? (
            <button
              onClick={async () => {
                setCStatus(null);
                if (cStreamId === '' || !ethers.isAddress(cToken.trim()) || !cAmount.trim() || !cRate.trim()) {
                  setCStatus({ kind: 'error', msg: 'Fill in stream, token, amount and drip.' });
                  return;
                }
                setCConfirm(true);
                // Work out what still needs approving BEFORE the user commits, so
                // the panel can offer them one at a time rather than discovering
                // a missing allowance as a revert.
                await refreshSteps();
              }}
              disabled={cBusy || cNamed}
              className="w-full py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
              data-testid="create-bounty-review"
            >
              Review
            </button>
          ) : (
            <div className="space-y-2 border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 rounded p-3">
              <div className="text-xs font-medium text-amber-800 dark:text-amber-300">Confirm irrevocable bounty</div>
              <ul className="text-xs text-amber-900 dark:text-amber-200 space-y-0.5">
                <li>&#8226; Stream: <strong>#{cStreamId}</strong></li>
                <li>&#8226; Token: <span className="font-mono">{cToken.trim()}</span>{cMeta ? ` (${cMeta.symbol})` : ''}</li>
                <li>&#8226; Deposit: <strong>{cAmount.trim()}</strong></li>
                <li>&#8226; Drip: <strong>{cRate.trim()}</strong> per round</li>
              </ul>
              <p className="text-xs text-amber-900 dark:text-amber-200">
                <strong>Irrevocable.</strong> Once funded, the only egress is per-round drips to
                predictors. There is no withdraw path for the deposit.
              </p>
              <p className="text-xs text-amber-900 dark:text-amber-200">
                <strong>Upfront fee.</strong> A non-SATORI bounty charges a one-time SATORI burn from
                your balance (SATORI bounties are free). Winners keep 100% of the bounty.
              </p>
              {/* Approvals first, ONE PRESS EACH. Funding a new non-SATORI pair
                  needs two allowances on two different tokens with two different
                  spenders — the deposit to SatoriBounties, the posting burn in
                  SATORI to the hub — and asking for both in one press cannot work
                  on mobile, where each wallet round trip unloads the page. */}
              {cSteps && cSteps.length > 0 && (
                <div className="space-y-1" data-testid="bounty-approval-steps">
                  <div className="text-xs text-amber-900 dark:text-amber-200">
                    {cSteps.length === 1
                      ? 'One approval first, then funding.'
                      : `${cSteps.length} approvals first, one at a time, then funding.`}
                  </div>
                  <button
                    onClick={() => runApproval(cSteps[0])}
                    disabled={cBusy}
                    className="w-full py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                    data-testid="bounty-approve-step"
                  >
                    {cBusy ? 'Approving…' : cSteps[0].label}
                  </button>
                  {cSteps[0].kind === 'satori' && (
                    <p className="text-[11px] text-amber-800 dark:text-amber-300">
                      This is the one-time posting burn for a new token on this game. It is
                      approved to the hub, not to the bounty contract, because the hub is what
                      charges it.
                    </p>
                  )}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={createBounty}
                  disabled={cBusy || cNamed || cSteps === null || cSteps.length > 0}
                  className="flex-1 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                  data-testid="create-bounty-confirm"
                >
                  {cBusy ? 'Funding…' : cSteps === null ? 'Checking approvals…' : 'I understand, fund it'}
                </button>
                <button
                  onClick={() => { setCConfirm(false); setCSteps(null); setCOnePress(null); }}
                  disabled={cBusy}
                  className="py-2 px-3 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-sm rounded transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {cStatus && (
            <div className={`text-xs rounded p-2 ${cStatus.kind === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'}`}>
              {cStatus.msg}
            </div>
          )}
        </div>
      </div>

      {/* Your stakes & earnings */}
      <div className="card-themed p-4" data-testid="your-bounty-stakes">
        <h3 className="font-semibold mb-3">Your stakes &amp; earnings</h3>
        {!isConnected ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Connect your wallet to see your bounty stakes.</p>
        ) : stakes.loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        ) : stakes.entries.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            You haven't staked any bounty tokens yet. Stake one from a bounty above to start earning.
          </p>
        ) : (
          <div className="space-y-2">
            {stakes.entries.map((e) => {
              const openMode = manageRow && manageRow.token === e.token ? manageRow.mode : null;
              return (
                <div key={e.token} className="border border-gray-200 dark:border-gray-600 rounded p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium">{e.symbol}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        staked {fmtUnits(e.stake, e.decimals)}
                        {e.locked && <span className="text-amber-600 dark:text-amber-400"> · unlocks in ~{e.unlocksInRounds} day{e.unlocksInRounds === 1 ? '' : 's'}</span>}
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button
                        onClick={() => openManage(e.token, 'add')}
                        disabled={stakes.acting !== null}
                        title="Stake more of this token to grow your share of its bounties"
                        className={`text-xs px-2.5 py-1.5 rounded transition-colors disabled:opacity-40 ${openMode === 'add'
                          ? 'bg-green-600 !text-white'
                          : 'bg-green-600/15 hover:bg-green-600/25 text-green-700 dark:text-green-300'}`}
                      >
                        Add
                      </button>
                      <button
                        onClick={() => openManage(e.token, 'unstake')}
                        disabled={e.locked || stakes.acting !== null}
                        title={e.locked ? 'Stake is locked from a recent boosted prediction' : 'Unstake to your wallet'}
                        className={`text-xs px-2.5 py-1.5 rounded transition-colors disabled:opacity-40 ${openMode === 'unstake'
                          ? 'bg-gray-400 dark:bg-gray-500 !text-white'
                          : 'bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600'}`}
                      >
                        Unstake
                      </button>
                    </div>
                  </div>
                  {openMode && (
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        inputMode="decimal"
                        value={manageAmt}
                        onChange={(ev) => setManageAmt(ev.target.value)}
                        placeholder={openMode === 'add'
                          ? `Amount of ${e.symbol} to stake`
                          : `Amount to unstake (have ${fmtUnits(e.stake, e.decimals)})`}
                        className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-1.5 text-sm"
                      />
                      <button
                        onClick={() => openMode === 'add' ? doAddStake(e.token, e.decimals) : doUnstake(e.token, e.decimals)}
                        disabled={stakes.acting !== null || !manageAmt.trim()}
                        className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-40 !text-white text-sm rounded transition-colors"
                      >
                        {stakes.acting !== null ? '…' : openMode === 'add' ? 'Stake' : 'Unstake'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {manageStatus && (
              <div className={`text-xs rounded p-2 ${manageStatus.kind === 'success'
                ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'}`}>
                {manageStatus.msg}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
