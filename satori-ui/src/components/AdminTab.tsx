import React, { useState } from 'react';
import { useStreamList } from '../hooks/useStreamList';
import { useGames } from '../hooks/useGames';
import { ethers } from 'ethers';
import { useOwner } from '../hooks/useOwner';
import { useDeploymentRound, formatElapsedRound } from '../hooks/useDeploymentRound';
import { Row, ActionState, shortAddress, fmtSatori, bpsToPercentStr } from './privilegedRow';
import { parseRatioWad, formatRatio, RATIO_DEFAULT, RATIO_NEVER_CHANGE } from '../lib/emissionStatus';

// Admin panel: the rewards-admin's operational levers (fee schedule read-out, the
// off-chain budget dial, airdrop loading, admin rotation), the Merkle root-publisher
// actions, and the permissionless housekeeping calls. Each action is gated on-chain to
// its own role; the tab is shown to the rewards admin and the emission holder
// (App.tsx, useTabProbes.ts). Governor-only curve
// dials + Merkle wiring live on the Governor tab.
export function AdminTab() {
  const owner = useOwner();
  const { data } = owner;
  const deploymentRound = useDeploymentRound();

  const [adminInput, setAdminInput] = useState('');
  const [adminAction, setAdminAction] = useState<ActionState>(null);
  const [initAction, setInitAction] = useState<ActionState>(null);
  const [flushAction, setFlushAction] = useState<ActionState>(null);
  const [accrueAction, setAccrueAction] = useState<ActionState>(null);
  const [budgetInput, setBudgetInput] = useState('');
  const [budgetAction, setBudgetAction] = useState<ActionState>(null);
  const [ratioInput, setRatioInput] = useState('');
  const [ratioAction, setRatioAction] = useState<ActionState>(null);
  const [reporterInput, setReporterInput] = useState('');
  const [reporterAction, setReporterAction] = useState<ActionState>(null);
  const [airdropInput, setAirdropInput] = useState('');
  const [airdropAction, setAirdropAction] = useState<ActionState>(null);
  const [earlyAction, setEarlyAction] = useState<ActionState>(null);

  const [busy, setBusy] = useState<string | null>(null);
  // Game approval: games are BORN unapproved (opt-in; the default game is live
  // by construction). Pick a stream, toggle its 1:1 binary game's approval.
  const streamList = useStreamList();
  const { resolveGameId } = useGames();
  const [approveStreamId, setApproveStreamId] = useState('');
  const [approveAction, setApproveAction] = useState<ActionState>(null);

  if (owner.loading) {
    return <div className="card-themed p-6 text-center text-gray-500 text-sm">Loading admin data…</div>;
  }
  if (!data) {
    return <div className="card-themed p-6 text-center text-gray-500 text-sm">Could not load admin data.</div>;
  }

  const wrap = async (
    key: string,
    setter: (s: ActionState) => void,
    fn: () => Promise<{ ok: true } | { ok: false; error: string }>,
    successMsg: string,
  ) => {
    setBusy(key);
    setter(null);
    const res = await fn();
    if (res.ok) setter({ kind: 'success', msg: successMsg });
    else setter({ kind: 'error', msg: res.error });
    setBusy(null);
  };

  const approveCandidates = streamList.streams;
  const pickedStream = approveCandidates.find((x) => String(x.id) === approveStreamId);
  const onToggleApproved = async () => {
    if (!pickedStream) return;
    const gameId = await resolveGameId(pickedStream.id);
    if (!gameId) { setApproveAction({ kind: 'error', msg: 'That stream has no game yet.' }); return; }
    // true = approve. Games are born unapproved, so approving is the normal
    // admission step; disapproving is the (reversible) kill switch.
    const next = !pickedStream.approved;
    await wrap('gameapprove', setApproveAction, () => owner.setGameApproved(Number(gameId), next),
      next
        ? `${pickedStream.name} approved. It can enter the eligible set and earn`
        : `${pickedStream.name} disapproved. It earns nothing now; its voters keep their weight and can re-point it with Move votes`);
    streamList.reload();
  };

  const onTransferAdmin = () => {
    const t = adminInput.trim();
    if (!t) return;
    wrap('admin', setAdminAction, () => owner.setAdmin(t),
      `Admin transferred to ${shortAddress(t)}, you will lose access`);
    setAdminInput('');
  };
  const onFlush = () => wrap('flush', setFlushAction, () => owner.flushDefaultStream(),
    'Default stream flushed (yesterday\'s prediction count stamped into history)');
  const onInit = () => {
    if (data.defaultStreamInitialized) return;
    wrap('init', setInitAction, () => owner.initializeDefaultStream(), 'Default stream initialized');
  };
  const onAccrue = () => wrap('accrue', setAccrueAction, () => owner.accrueProtocolFee(),
    'Protocol fee accrued (cursor advanced; recipient credited for elapsed rounds)');
  const onSetBudget = () => {
    const v = budgetInput.trim();
    if (!v) return;
    wrap('budget', setBudgetAction, () => owner.setOffchainBudget(v),
      `Off-chain dial set to ${v} SATORI/round (applies to future rounds)`);
    setBudgetInput('');
  };
  const ratioWad = ratioInput.trim() ? parseRatioWad(ratioInput) : null;
  const onSetRatio = () => {
    const v = ratioInput.trim();
    if (!v) return;
    wrap('ratio', setRatioAction, () => owner.setEmissionRatio(v),
      `Emission multiplier set to ${typeof ratioWad === 'bigint' ? formatRatio(ratioWad) : v}. It applies at the next step`);
    setRatioInput('');
  };
  const em = data.emission;
  const quickBtn = 'flex-1 py-1.5 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50';
  const onSetReporter = () => {
    const a = reporterInput.trim();
    if (!a) return;
    wrap('reporter', setReporterAction, () => owner.setOffchainReporter(a),
      a === ethers.ZeroAddress
        ? 'Off-chain reporting switched off'
        : `Off-chain reporter set to ${shortAddress(a)}`);
    setReporterInput('');
  };
  const onLoadAirdrop = () => {
    const entries = airdropInput.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [address, amountSatori] = l.split(/[,\s]+/).map((x) => x.trim());
      return { address: address ?? '', amountSatori: amountSatori ?? '' };
    });
    if (entries.length === 0) return;
    wrap('airdrop', setAirdropAction, () => owner.loadAirdropBatch(entries),
      `Loaded ${entries.length} airdrop allocation${entries.length === 1 ? '' : 's'}`);
    setAirdropInput('');
  };

  return (
    <div className="space-y-4" data-testid="admin-tab">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Rewards-admin and operational levers. Each action is gated on-chain to its specific role
        (admin, root publisher) or is permissionless. This page shows what your connected
        wallet can actually do. The governor-only streak-curve dials live on the Governor tab.
      </p>

      {/* Roles (read-only) */}
      <div className="card-themed p-3 text-xs space-y-1" data-testid="admin-roles">
        <div className="flex justify-between">
          <span className="text-gray-500">Rewards admin (fee anchor, budget dial)</span>
          <span className="font-mono">{shortAddress(data.admin)}{owner.isOwner && <span className="text-green-500"> · you</span>}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Emission split (the on-chain/off-chain dial)</span>
          <span className="font-mono">
            {shortAddress(data.emissionSplitHolder)}
            {data.emissionSplitHolder === data.admin && <span className="text-gray-400"> · via admin</span>}
            {owner.isEmissionSplitHolder && <span className="text-green-500"> · you</span>}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Emission schedule (the step multiplier)</span>
          <span className="font-mono">
            {data.emissionHolder === ethers.ZeroAddress ? '—' : shortAddress(data.emissionHolder)}
            {data.emissionHolder === data.admin && <span className="text-gray-400"> · via admin</span>}
            {owner.isEmissionHolder && <span className="text-green-500"> · you</span>}
          </span>
        </div>
        {data.airdropHolder !== ethers.ZeroAddress && (
          <div className="flex justify-between">
            <span className="text-gray-500">Airdrop loader (on SatoriAirdrop)</span>
            <span className="font-mono">
              {shortAddress(data.airdropHolder)}
              {owner.isAirdropHolder && <span className="text-green-500"> · you</span>}
            </span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-gray-500">Merkle root publisher</span>
          <span className="font-mono">
            {data.merkleWired ? shortAddress(data.rootPublisher) : '—'}
            {owner.isRootPublisher && <span className="text-green-500"> · you</span>}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-500">Off-chain prediction reporter</span>
          <span className="font-mono">
            {data.offchainReporter === ethers.ZeroAddress ? 'not set' : shortAddress(data.offchainReporter)}
            {owner.isOffchainReporter && <span className="text-green-500"> · you</span>}
          </span>
        </div>
      </div>

      <div className="space-y-1.5">
        <Row
          title="Platform Fee"
          subtitle={<>A percentage of everything the protocol mints as rewards — never the airdrop. Ships at 15% and is <strong>not an admin lever</strong>: only the <strong>governor</strong> can move it, only within the immutable band <strong>{bpsToPercentStr(data.devFeeBpsMin)}%&ndash;{bpsToPercentStr(data.devFeeBpsMax)}%</strong>, and only in two steps (propose, then accept in a later block). Reserved off the top of each round before anything reaches predictors, so it is never a subtraction from a payout. The recipient is fixed in the contract and has no setter at all.{data.pendingDevFeeBps > 0 && <span className="block mt-1 text-amber-600 dark:text-amber-400">Change pending: <strong>{bpsToPercentStr(data.pendingDevFeeBps)}%</strong> ({data.pendingDevFeeBps} bps) — awaiting the governor's acceptance.</span>}</>}
          summary={<span><strong>{bpsToPercentStr(data.platformFeeBps)}%</strong> ({data.platformFeeBps} bps) · {fmtSatori(data.protocolFeePerRound)} this round</span>}
          input={null} action={null} onSave={() => {}} saving={false} disabled readOnly
        />
        <Row
          title="Fee Recipient"
          subtitle="The address that receives the platform fee. Set once at deploy (immutable): there is no setter."
          summary={<span className="font-mono text-xs">{shortAddress(data.platformFeeRecipient)}</span>}
          input={null} action={null} onSave={() => {}} saving={false} disabled readOnly
        />
        <Row
          title="Emission This Round"
          subtitle={<>The protocol's per-round emission, from SatoriHub's schedule. It follows how much SATORI has been issued, not the calendar: 846.62 per round until 1,460 rounds-worth has been issued, then multiplied by the emission ratio (default &phi;&minus;1 &asymp; 0.618) each time another 730 rounds-worth at the current rate is issued. The fee and the off-chain dial are both slices of this figure &mdash; not of the token's 1,440 constitutional envelope, which the schedule never exceeds. Current round {formatElapsedRound(data.currentRound, deploymentRound)}.</>}
          summary={<span><strong>{fmtSatori(data.emissionRatePerRound)}</strong></span>}
          input={null} action={null} onSave={() => {}} saving={false} disabled readOnly
        />
        <Row
          title="Emission Schedule"
          subtitle={<>
            The holder&apos;s one lever: the multiplier the <strong>next</strong> step applies to the rate. It never moves this round&apos;s or next round&apos;s rate. 1 means the rate never changes again; above 1 raises it at each step, never past 1,440 per round.
            <span className="block mt-1 text-gray-400" data-testid="emission-ratio-zero-note">0 is not allowed (the hub rejects it); a tiny multiplier winds emission down instead.</span>
            {em ? (
              <span className="block mt-1 text-gray-400" data-testid="emission-schedule-status">
                Issued so far: {fmtSatori(em.issued)}{em.issuedProjected > em.issued && <> ({fmtSatori(em.issuedProjected)} with the unbanked off-chain reserve)</>}
                {' · '}Next step at: {em.stepsActive ? <>{fmtSatori(em.nextStepAt)} issued</> : 'none'}
                {' · '}Rate after next step: {em.stepsActive ? `${fmtSatori(em.rateAfterStep)}/round` : 'unchanged'}
                {em.rateNext !== em.rateNow && <>{' · '}Next round: {fmtSatori(em.rateNext)}/round</>}
                {' · '}Steps taken: {em.stepsTaken}
              </span>
            ) : (
              <span className="block mt-1 text-gray-400">Schedule read unavailable on this deployment&apos;s lens.</span>
            )}
          </>}
          summary={<span data-testid="emission-ratio-current">{em ? <>&times;<strong>{formatRatio(em.ratioWad)}</strong></> : '—'}</span>}
          input={
            <div className="space-y-2">
              <input type="text" inputMode="decimal" value={ratioInput} onChange={(e) => { setRatioInput(e.target.value); setRatioAction(null); }} placeholder="Multiplier (e.g. 0.618, 1, 2)" data-testid="input-emission-ratio" className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono" disabled={busy !== null || !owner.isEmissionHolder} />
              <div className="flex gap-2">
                <button type="button" className={quickBtn} data-testid="btn-ratio-default" disabled={busy !== null || !owner.isEmissionHolder} onClick={() => { setRatioInput(RATIO_DEFAULT); setRatioAction(null); }}>0.618 (default)</button>
                <button type="button" className={quickBtn} data-testid="btn-ratio-never-change" disabled={busy !== null || !owner.isEmissionHolder} onClick={() => { setRatioInput(RATIO_NEVER_CHANGE); setRatioAction(null); }}>1.0 (never change)</button>
              </div>
              {ratioWad !== null && typeof ratioWad !== 'bigint' && <div className="text-xs text-red-600 dark:text-red-400">{ratioWad.err}</div>}
            </div>
          }
          action={ratioAction} onSave={onSetRatio} saving={busy === 'ratio'}
          disabled={typeof ratioWad !== 'bigint' || !owner.isEmissionHolder}
          saveLabel={typeof ratioWad === 'bigint' ? `Set multiplier to ${formatRatio(ratioWad)}` : 'Set multiplier'}
          saveTestId="btn-set-emission-ratio"
        />
        <Row
          title="Accrue Protocol Fee"
          subtitle="Permissionless: advances the fee cursor and credits the fee recipient for elapsed rounds. Anyone can call; it only ever pays the configured recipient."
          summary={null} action={accrueAction} input={null}
          onSave={onAccrue} saving={busy === 'accrue'} disabled={busy !== null}
          saveLabel="Accrue protocol fee" saveTestId="btn-accrue-protocol-fee"
        />
        <Row
          title="Off-chain Budget (dial)"
          subtitle={<>SATORI per round routed to the off-chain Merkle channel. Must stay below next round's emission net of the platform fee &mdash; the contract rejects anything at or above it. The on-chain reward system gets the remainder. Applies to FUTURE rounds.<span className="block mt-1 text-gray-400">Lanes now, on-chain: {fmtSatori(data.onChainRewardCeiling)} · Merkle: {fmtSatori(data.merkleReserveCeiling)} SATORI claimable.</span>{data.emission && data.emission.dialEffective < data.emission.dial && <span className="block mt-1 text-amber-600 dark:text-amber-400" data-testid="dial-effective">The rate has stepped under this dial: the off-chain reserve accrues {fmtSatori(data.emission.dialEffective)}/round, not {fmtSatori(data.emission.dial)}.</span>}</>}
          summary={<span><strong>{fmtSatori(data.offchainBudget)}</strong> <span className="text-xs text-gray-500">/round off-chain</span></span>}
          input={<input type="text" value={budgetInput} onChange={(e) => setBudgetInput(e.target.value)} placeholder="Off-chain SATORI/round (e.g. 200)" className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono" disabled={busy !== null} />}
          action={budgetAction} onSave={onSetBudget} saving={busy === 'budget'} disabled={!budgetInput.trim() || !owner.isEmissionSplitHolder}
          saveLabel="Set dial" saveTestId="btn-set-offchain-budget"
        />
        <Row
          title="Approve a Game"
          subtitle={<>Games are <strong>born unapproved</strong> and earn nothing until approved here (the default game is live by construction). Approving admits a game to the eligible set; disapproving one — a community adapter that scores dishonestly, a stream feeding it garbage — takes it back out. Either way <strong>voters keep their weight</strong>: nobody&apos;s burn is touched, and weight on an unapproved game can be re-pointed to a live one via <strong>Move votes</strong>. Fully reversible.</>}
          summary={pickedStream
            ? (pickedStream.approved
                ? <span className="text-xs text-green-600 dark:text-green-400">approved</span>
                : <span className="text-xs text-amber-600 dark:text-amber-400">not approved</span>)
            : <span className="text-xs text-gray-500">pick a stream</span>}
          input={
            <select
              value={approveStreamId}
              onChange={(e) => { setApproveStreamId(e.target.value); setApproveAction(null); }}
              disabled={busy !== null}
              data-testid="select-approve-game"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
            >
              <option value="">Select a stream…</option>
              {approveCandidates.map((x) => (
                <option key={x.id} value={String(x.id)}>
                  #{x.id} {x.name}{!x.approved ? ' (not approved)' : ''}
                </option>
              ))}
            </select>
          }
          action={approveAction} onSave={onToggleApproved} saving={busy === 'gameapprove'}
          disabled={!pickedStream}
          saveLabel={pickedStream?.approved ? 'Disapprove' : 'Approve'}
          saveTestId="btn-toggle-game-approved"
        />
        {/* Merkle Root and Rotate Root Publisher moved to the Off-chain tab.
            Both are gated on-chain to `rootPublisher`, not to the rewards admin
            who sees this tab, so they were unreachable from the key that
            actually holds the role. They now sit beside off-chain reporting,
            which is the same operator's job. */}
        <Row
          title="Off-chain Prediction Reporter"
          subtitle={<>The one key allowed to add <strong>off-chain</strong> predictions to the default stream&apos;s
            running count. Predictors settled by Merkle are still participating; without this the headline
            number falls as they move off-chain, reading as decline while the platform grows. The holder gets
            a <strong>Report</strong> tab. Paste the zero address to switch the feature off.</>}
          summary={<span className="font-mono text-xs">{data.offchainReporter === ethers.ZeroAddress ? 'not set' : shortAddress(data.offchainReporter)}</span>}
          input={<input type="text" value={reporterInput} onChange={(e) => setReporterInput(e.target.value)} placeholder="0x… (reporter address, or 0x0 to disable)" className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono" disabled={busy !== null} />}
          action={reporterAction} onSave={onSetReporter} saving={busy === 'reporter'} disabled={!reporterInput.trim()}
          saveLabel="Set reporter" saveTestId="btn-set-offchain-reporter"
        />
        <Row
          title="Load Airdrop Batch"
          subtitle={<>Seed airdrop allocations (loader-gated, on the SatoriAirdrop contract). One entry per line: <span className="font-mono">address, amount</span> (amount in SATORI). A sixth of each allocation is claimable at once, the rest vests linearly on-chain; the total is hard-capped by the contract.</>}
          summary={<span className="text-xs text-gray-500">admin only</span>}
          input={<textarea value={airdropInput} onChange={(e) => setAirdropInput(e.target.value)} placeholder={'0xabc…, 1000\n0xdef…, 250.5'} rows={3} className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono" disabled={busy !== null || !owner.isAirdropHolder} />}
          action={airdropAction} onSave={onLoadAirdrop} saving={busy === 'airdrop'} disabled={!airdropInput.trim() || !owner.isAirdropHolder}
          saveLabel="Load batch" saveTestId="btn-load-airdrop"
        />
        {data.airdropHolder !== ethers.ZeroAddress && (
          <Row
            title="Early Airdrop Claim"
            subtitle={<>Lets a recipient take their whole airdrop at once: the vested part in full, plus the locked remainder at the fraction of the five years already elapsed, forfeiting the rest for good. Ships <strong>off</strong>. Switching it off later strands nobody — anyone who already took the deal stays settled, everyone else keeps vesting as normal. Loader-gated.</>}
            summary={<span className={`text-xs font-medium ${data.earlyClaimEnabled ? 'text-green-500' : 'text-gray-500'}`} data-testid="early-claim-state">{data.earlyClaimEnabled ? 'on' : 'off'}</span>}
            input={null}
            action={earlyAction}
            onSave={() => wrap('early', setEarlyAction, () => owner.setEarlyClaimEnabled(!data.earlyClaimEnabled),
              data.earlyClaimEnabled ? 'Early claiming switched off' : 'Early claiming switched on')}
            saving={busy === 'early'} disabled={!owner.isAirdropHolder}
            saveLabel={data.earlyClaimEnabled ? 'Turn off' : 'Turn on'} saveTestId="btn-toggle-early-claim"
            danger={!data.earlyClaimEnabled}
          />
        )}
        <Row
          title="Transfer Admin"
          subtitle={<>Hand the rewards-admin role to a different wallet. The admin sets the off-chain dial, toggles capabilities, and can rotate itself. The airdrop loader is a separate role on the SatoriAirdrop contract and does not move with it. it can NOT change the platform fee or its recipient. After transfer you lose these actions. Current admin: <span className="font-mono">{shortAddress(data.admin)}</span>.</>}
          summary={<span className="font-mono text-xs">{shortAddress(data.admin)}</span>}
          input={<input type="text" value={adminInput} onChange={(e) => setAdminInput(e.target.value)} placeholder="New admin address (0x…)" className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono" disabled={busy !== null} />}
          action={adminAction} onSave={onTransferAdmin} saving={busy === 'admin'} disabled={!adminInput.trim()}
          saveLabel="Transfer Admin" danger
        />
        <Row
          title="Default Stream"
          subtitle={data.defaultStreamInitialized ? "Already initialized. This only runs once after deploy." : "One-time bootstrap: creates the self-referential 'Predictions' stream and casts a 1 SATORI seed vote on it."}
          summary={<span className={data.defaultStreamInitialized ? 'text-green-600 dark:text-green-400 text-xs' : 'text-amber-600 dark:text-amber-400 text-xs'}>{data.defaultStreamInitialized ? 'Initialized' : 'Not initialized'}</span>}
          input={null} action={initAction} onSave={onInit} saving={busy === 'init'} disabled={data.defaultStreamInitialized}
          saveLabel="Initialize Default Stream"
        />
        <Row
          title="Flush Default Stream"
          subtitle="Permissionless. Stamps yesterday's prediction-count value into the default stream's history. The first predictor of every round triggers this automatically, so manual calls are only needed after a fully-quiet round."
          summary={null} input={null} action={flushAction} onSave={onFlush} saving={busy === 'flush'} disabled={!data.defaultStreamInitialized}
          saveLabel="Flush Default Stream"
        />
      </div>
    </div>
  );
}
