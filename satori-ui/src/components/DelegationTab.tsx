import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { trimZeros } from '../utils/format';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { useGasless } from '../hooks/useGasless';
import { useClaimDelegation, DelegateAuth } from '../hooks/useClaimDelegation';
import { explainError } from '../utils/errors';
import { InfoTip } from './InfoTip';
import { afterTx } from '../lib/afterTx';

const ZERO = '0x0000000000000000000000000000000000000000';

function formatWei(wei: string): string {
  try {
    return trimZeros(ethers.formatEther(wei));
  } catch {
    return '0.0';
  }
}

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function DelegationTab() {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const { sendOrRelay } = useGasless();

  const [predDelegate, setPredDelegate] = useState('');
  const [claimDelegate, setClaimDelegate] = useState('');
  const [predInput, setPredInput] = useState('');
  const [claimInput, setClaimInput] = useState('');
  const [inboundPred, setInboundPred] = useState('0');
  // The predictor's own fee on the delegated portion of their rewards (item 3).
  // Set-once, and the cap EQUALS the default: MAX_PREDICTOR_FEE_BPS is 1000 (10%),
  // so a predictor can only ever undercut the baseline, never exceed it.
  const [predictorFeeBps, setPredictorFeeBps] = useState<number>(1000);
  const [predictorFeeInput, setPredictorFeeInput] = useState<number>(1000);
  // Non-zero `predictorFeeStored` means the rate is COMMITTED and setPredictorFee
  // will revert AlreadySet. Read it so the control can be disabled rather than
  // letting the user discover the lock via a failed transaction.
  const [predictorFeeLocked, setPredictorFeeLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /// NOTE: this deliberately does NOT flip `loading` back on for refreshes.
  ///
  /// It used to, and the early return below then replaced the whole tab with a
  /// "Loading delegation..." div on EVERY reload — unmounting its children and
  /// destroying their state. That is not cosmetic: the game wallet's removal
  /// dialog verifies the passphrase by unlocking the key, unlocking changes the
  /// wallet context, the context change re-ran this load, and the dialog
  /// vanished between "passphrase accepted" and the sweep offer, leaving the key
  /// un-swept and un-deleted with nothing on screen to say why. The spinner is
  /// for the FIRST load only; refreshes now happen under the rendered tab.
  const load = useCallback(async () => {
    if (!contracts || !address) return;
    try {
      const [predInfo, claimInfo, pfEffective, pfStored] = await Promise.all([
        contracts.cached.live.rewards.predictionDelegateInfo(address),
        contracts.cached.live.rewards.claimDelegateInfo(address),
        contracts.cached.round.rewards.effectivePredictorFee(address),
        contracts.cached.round.rewards.predictorFeeStored(address),
      ]);
      // `effectivePredictorFee` decodes the set-once sentinel on-chain — the
      // single source of truth in SatoriRewards (stored 0 -> 10% default; stored
      // 1000 -> explicit 0%; else verbatim). We no longer duplicate that rule in
      // JS; read the effective bps directly.
      const effectiveBps = Number(pfEffective);
      setPredictorFeeBps(effectiveBps);
      setPredictorFeeInput(effectiveBps);
      setPredictorFeeLocked(Number(pfStored) !== 0);
      const pred = predInfo.delegate;
      const inPred = predInfo.power;
      // A bare address, unlike predictionDelegateInfo's struct. Yourself
      // means no delegate: SatoriRewards lets the owner claim either way.
      const claim: string = claimInfo;
      const p = pred === ZERO ? '' : pred;
      const c = claim === ZERO || claim.toLowerCase() === address.toLowerCase() ? '' : claim;
      setPredDelegate(p);
      setClaimDelegate(c);
      setPredInput(p);
      setClaimInput(c);
      setInboundPred(inPred.toString());
    } catch (e) {
      console.error('Delegation load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [contracts, address]);

  useEffect(() => { load(); }, [load]);

  const doAction = useCallback(async (label: string, fn: () => Promise<any>) => {
    setActing(label);
    setError(null);
    setSuccess(null);
    try {
      const tx = await fn();
      await afterTx(tx);
      setSuccess(`${label} successful`);
      await load();
    } catch (e: any) {
      setError(explainError(e));
    } finally {
      setActing(null);
    }
  }, [load]);

  if (loading) {
    return <div className="card-themed p-6 text-center text-gray-500 text-sm">Loading delegation...</div>;
  }

  return (
    <div className="space-y-4" data-testid="delegation-tab">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Your tokens come with three separate powers: predicting, voting, and claiming.
        Hand any of them to someone you trust.
      </p>


      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
      )}
      {success && (
        <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">{success}</div>
      )}

      <div className="space-y-1.5">
        {/* Prediction Delegation. Renamed from "Staking" to avoid colliding
            with the Bounty Staking tab — both delegations and bounty-token
            stakes are sometimes colloquially called "staking" but they're
            independent mechanisms. */}
        <DelegationRow
          title="Prediction Power"
          subtitle="Let someone predict for you."
          detail="Assign your prediction power to an expert. They predict on your behalf, and you keep the majority of the rewards your power earns."
          delegate={predDelegate}
          input={predInput}
          setInput={setPredInput}
          inboundLabel={inboundPred !== '0' ? `${formatWei(inboundPred)} SATORI delegated to you` : null}
          actingKey="Staking"
          acting={acting}
          onSet={() => predInput && doAction('Staking', () => sendOrRelay(
            { kind: 'delegatePrediction', delegate: predInput },
            () => contracts!.satori.delegatePredictionPower(predInput)))}
          onUpdate={() => predInput && predInput !== predDelegate && doAction('Staking update', () => sendOrRelay(
            { kind: 'delegatePrediction', delegate: predInput },
            () => contracts!.satori.delegatePredictionPower(predInput)))}
          onRevoke={() => doAction('Staking revoke', () => sendOrRelay(
            { kind: 'delegatePrediction', delegate: ZERO },
            () => contracts!.satori.delegatePredictionPower(ZERO)))}
          setLabel="Delegate Prediction Power"
        />

        {/* Predictor fee — only meaningful for users who actually have
            delegators routing prediction power to them. Set-once and immutable,
            capped at 1000 bps (10%) — MAX_PREDICTOR_FEE_BPS, which EQUALS the
            default, so a predictor may only undercut the baseline. The remainder
            of the delegated-portion reward flows to the delegators. */}
        {inboundPred !== '0' && (
          <div className="card-themed !p-0 overflow-hidden">
            <div className="px-3 py-3 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium flex items-center justify-between gap-1.5">
                    <span>Your Predictor Fee</span>
                    <InfoTip>
                      Your cut of the rewards earned on power delegated to you. The cap EQUALS the
                      default (10%), so you can only ever undercut the baseline, never charge more.
                      Lower fees leave more for your delegators. Committing a rate below 10% is
                      permanent; leaving it at 10% changes nothing and keeps your options open.
                    </InfoTip>
                  </div>
                  <div className="text-xs text-gray-500">
                    Your cut when others predict with your power.
                  </div>
                </div>
                <div className="text-right whitespace-nowrap text-sm">
                  <strong>{predictorFeeBps / 100}%</strong>
                  {predictorFeeLocked && <div className="text-[11px] text-gray-500">committed</div>}
                </div>
              </div>

              {predictorFeeLocked ? (
                /* Committed rates are immutable — setPredictorFee reverts AlreadySet.
                   Show that instead of offering a control that cannot work. */
                <div className="text-xs text-gray-500 bg-gray-100 dark:bg-gray-700 rounded px-3 py-2">
                  Locked at <strong>{predictorFeeBps / 100}%</strong>. A committed rate is permanent, so
                  delegators can rely on it.
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={1000}
                      step={25}
                      value={predictorFeeInput}
                      onChange={(e) => setPredictorFeeInput(Number(e.target.value))}
                      className="flex-1 accent-blue-600"
                      disabled={acting !== null}
                      aria-label="Predictor fee percentage"
                    />
                    <div className="w-24 text-right text-sm tabular-nums">
                      <strong>{(predictorFeeInput / 100).toFixed(2)}%</strong>
                      <div className="text-[11px] text-gray-500">you keep</div>
                    </div>
                  </div>
                  <div className="flex justify-between text-[11px] text-gray-500">
                    <span>0%: delegators take the whole delegated portion</span>
                    <span>10%: the default</span>
                  </div>
                  <div className="text-xs text-gray-500">
                    Delegators receive <strong>{((10000 - predictorFeeInput) / 100).toFixed(2)}%</strong> of
                    the delegated portion of every win.
                    {predictorFeeInput === 1000
                      ? ' Leaving it at the 10% default changes nothing and does not lock you in.'
                      : ' This is permanent once set.'}
                  </div>
                  <button
                    onClick={() => {
                      const n = predictorFeeInput;
                      if (!Number.isInteger(n) || n < 0 || n > 1000) return;
                      doAction('Predictor fee', () => sendOrRelay(
                        { kind: 'setPredictorFee', bps: n },
                        () => contracts!.rewards.setPredictorFee(n)));
                    }}
                    disabled={acting !== null || predictorFeeInput === 1000}
                    className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                  >
                    {acting === 'Predictor fee'
                      ? 'Setting…'
                      : predictorFeeInput === 1000
                        ? 'Already at the default'
                        : `Commit ${(predictorFeeInput / 100).toFixed(2)}% permanently`}
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* Voting Delegation is GONE — deleted, not disabled. Burn voting has no
            delegable vote: you burn SATORI for a game and the weight is permanent,
            so there is no standing voting power to hand to anyone. The hub has no
            setVoteDelegation, and this row called it on every button. Prediction
            and claim delegation below are unaffected and still live. */}

        {/* Claim Delegation */}
        <DelegationRow
          title="Claim Delegation"
          subtitle="Let someone claim for you."
          detail="Assign claim authority to a hot wallet. Your tokens stay safe in cold storage; the delegate can claim rewards on your behalf."
          delegate={claimDelegate}
          input={claimInput}
          setInput={setClaimInput}
          inboundLabel={null}
          actingKey="Claim"
          acting={acting}
          onSet={() => claimInput && doAction('Claim delegation', () => contracts!.satori.delegateClaimAbility(claimInput))}
          onUpdate={() => claimInput && claimInput !== claimDelegate && doAction('Claim update', () => contracts!.satori.delegateClaimAbility(claimInput))}
          onRevoke={() => doAction('Claim revoke', () => contracts!.satori.delegateClaimAbility(ZERO))}
          setLabel="Delegate Claim Authority"
        />
      </div>

      {/* Act-as-a-claim-delegate (EXECUTE side). The rows above let a holder
          NAME a claim delegate; this panel lets the connected wallet — when it
          IS someone's claim delegate — trigger that owner's SATORI claim and/or
          bounty withdrawal. Self-contained: own auth/busy/error state. */}
      <ActAsClaimDelegate />

      <Collapsible title="How it works:">
        <ul className="space-y-1 text-sm text-blue-800 dark:text-blue-300">
          <li>&#8226; <strong>Prediction Power</strong>: your tokens stay in your wallet but lock while delegated. The delegate predicts using your power, and the reward on your share of their power is split with them: the predictor keeps their fee (<strong>10%</strong> unless they set another) and the rest is shared among everyone delegating to them in proportion to the tokens each delegated. One-day lock after revoking. Only your token <em>balance</em> is delegated. Any <strong>unclaimed rewards</strong> stay with you, so claim them first if you want them counted toward your delegate&apos;s power.</li>
          <li>&#8226; <strong>Claim</strong>: pure authorization, the delegate can trigger your claim and pick the recipient. No token lock. They can't predict or vote on your behalf.</li>
          <li>&#8226; All three are independent, delegating one doesn't affect the others. None of these are related to the bounty-token stakes on the Bounty Staking tab, which lock ERC-20s for predict-time boost.</li>
        </ul>
      </Collapsible>
    </div>
  );
}

/// EXECUTE side of claim delegation. Distinct from the SET-side rows above:
/// here the connected wallet acts AS a delegate for some other owner. We gate
/// the action buttons on `auth.isAuthorized` (connected wallet === the owner's
/// claim delegate, per rewards.claimDelegateInfo(owner)) and surface a clear
/// "you are not the claim delegate of this address" message otherwise.
function ActAsClaimDelegate() {
  const {
    acting, checkAuth,
    claimForDelegator,
  } = useClaimDelegation();

  const [ownerInput, setOwnerInput] = useState('');
  const [recipientInput, setRecipientInput] = useState('');
  const [auth, setAuth] = useState<DelegateAuth | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Re-validate whenever the owner input settles on a valid address. Clears any
  // prior result/error as the target changes.
  useEffect(() => {
    setAuth(null);
    setError(null);
    setSuccess(null);
    if (!ethers.isAddress(ownerInput)) return;
    let cancelled = false;
    setChecking(true);
    (async () => {
      const result = await checkAuth(ownerInput);
      if (cancelled) return;
      setAuth(result);
      setChecking(false);
    })();
    return () => { cancelled = true; };
  }, [ownerInput, checkAuth]);

  const ownerValid = ethers.isAddress(ownerInput);
  const recipientValid = recipientInput === '' || ethers.isAddress(recipientInput);
  // Recipient defaults to the owner address when left blank.
  const recipient = recipientInput.trim() !== '' ? recipientInput : ownerInput;
  const authorized = !!auth?.isAuthorized;

  const runClaim = useCallback(async () => {
    setError(null);
    setSuccess(null);
    const res = await claimForDelegator(ownerInput, recipient);
    if (res.ok) {
      const amt = res.amount !== undefined ? formatWei(res.amount.toString()) : null;
      setSuccess(amt !== null ? `Claimed ${amt} SATORI for delegator` : 'Claim successful');
    } else {
      setError(res.error);
    }
  }, [claimForDelegator, ownerInput, recipient]);

  // (Bounty withdraw for delegator removed — the dead unclaimedBounty withdraw
  // path is gone; winnings compound into bountyStake, cashed out via unstake — A4.)

  return (
    <div className="card-themed !p-0 overflow-hidden" data-testid="act-as-claim-delegate">
      <div className="px-3 py-3 space-y-2">
        <div className="font-medium flex items-center justify-between gap-1.5">
          <span>Act as a Claim Delegate</span>
          <InfoTip>
            If another address has named you its claim delegate, you can trigger their reward claim and
            bounty withdrawal here. Enter the delegator (owner) address to check your authorization.
          </InfoTip>
        </div>
        <p className="text-xs text-gray-500">
          Claim for someone who picked you.
        </p>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>
        )}
        {success && (
          <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">{success}</div>
        )}

        <input
          type="text"
          value={ownerInput}
          onChange={(e) => setOwnerInput(e.target.value)}
          placeholder="Delegator (owner) address (0x…)"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
          disabled={acting !== null}
          data-testid="input-claimfor-owner"
        />

        {/* Authorization feedback. Only render once we have a valid address. */}
        {ownerValid && checking && (
          <p className="text-xs text-gray-500">Checking authorization…</p>
        )}
        {ownerValid && !checking && authorized && (
          <p className="text-xs text-green-700 dark:text-green-300">
            You are the claim delegate of {shortAddress(auth!.owner)}.
          </p>
        )}
        {ownerValid && !checking && auth && !authorized && (
          <p className="text-xs text-red-700 dark:text-red-400">
            You are not the claim delegate of this address.
          </p>
        )}

        <input
          type="text"
          value={recipientInput}
          onChange={(e) => setRecipientInput(e.target.value)}
          placeholder="Recipient (defaults to delegator)"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
          disabled={acting !== null}
          data-testid="input-claimfor-recipient"
        />
        {!recipientValid && (
          <p className="text-xs text-red-700 dark:text-red-400">Recipient is not a valid address.</p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            onClick={runClaim}
            disabled={acting !== null || !authorized || !recipientValid}
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
            data-testid="btn-claimfor"
          >
            {acting === 'claimFor' ? 'Claiming…' : 'Claim SATORI for delegator'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface DelegationRowProps {
  title: string;
  subtitle: string;
  detail?: React.ReactNode;
  delegate: string;
  input: string;
  setInput: (v: string) => void;
  inboundLabel: string | null;
  actingKey: string;
  acting: string | null;
  onSet: () => void;
  onUpdate: () => void;
  onRevoke: () => void;
  setLabel: string;
}

function DelegationRow({
  title, subtitle, detail, delegate, input, setInput, inboundLabel, actingKey, acting,
  onSet, onUpdate, onRevoke, setLabel,
}: DelegationRowProps) {
  const isDelegated = !!delegate;
  return (
    <div className="card-themed !p-0 overflow-hidden">
      <div className="px-3 py-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="font-medium flex items-center justify-between gap-1.5">
              <span>{title}</span>
              {detail && <InfoTip>{detail}</InfoTip>}
            </div>
            <div className="text-xs text-gray-500 font-mono truncate">
              {isDelegated ? `Delegated to ${shortAddress(delegate)}` : 'Not delegated'}
            </div>
          </div>
          {inboundLabel && (
            <span className="text-xs text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-2 py-0.5 rounded self-center whitespace-nowrap">
              {inboundLabel}
            </span>
          )}
        </div>

        <p className="text-xs text-gray-500">{subtitle}</p>

        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Address (0x…)"
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
          disabled={acting !== null}
        />

        {isDelegated ? (
          <div className="flex gap-2">
            <button
              onClick={onUpdate}
              disabled={acting !== null || !input || input === delegate}
              className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
            >
              {acting === `${actingKey} update` ? 'Processing…' : 'Update'}
            </button>
            <button
              onClick={onRevoke}
              disabled={acting !== null}
              className="py-2 px-4 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 text-sm font-medium rounded transition-colors disabled:opacity-50"
            >
              {acting === `${actingKey} revoke` ? '…' : 'Revoke'}
            </button>
          </div>
        ) : (
          <button
            onClick={onSet}
            disabled={acting !== null || !input}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
          >
            {acting === actingKey || acting === `${actingKey} delegation` ? 'Processing…' : setLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (contentRef.current) setHeight(contentRef.current.scrollHeight);
  }, [children]);

  return (
    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full p-4 flex items-center justify-between text-left"
      >
        <h4 className="font-medium text-blue-900 dark:text-blue-300">{title}</h4>
        <svg
          className={`h-4 w-4 text-blue-600 dark:text-blue-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div
        style={{
          maxHeight: open ? height : 0,
          opacity: open ? 1 : 0,
          transition: 'max-height 0.25s ease-out, opacity 0.2s ease-out',
          overflow: 'hidden',
        }}
      >
        <div ref={contentRef} className="px-4 pb-4">{children}</div>
      </div>
    </div>
  );
}
