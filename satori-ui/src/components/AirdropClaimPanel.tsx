import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { InfoTip } from './InfoTip';
import { explainError } from '../utils/errors';
import { afterTx } from '../lib/afterTx';

/// Claim the vested slice of an airdrop allocation — or, while the loader has
/// the door open, buy out the whole remainder at once.
///
/// Here rather than on the dashboard, and separate from the ordinary Claim
/// button, for the same reason MerkleClaimPanel is: `claimAirdrop` lives on
/// SatoriAirdrop (its own contract, no proxy) and mints through the token's own
/// `airdropMint` door, while the normal claim moves `unclaimedRewards` through
/// the hub. They are different contracts and different balances, so one button
/// would mean two transactions and two signatures. Multicall cannot merge them
/// either — `claimAirdrop` mints to `msg.sender`, which would become the
/// Multicall contract.
///
/// Renders nothing at all for an address with no allocation, which is almost
/// everyone. There is no point putting a permanently-empty panel in front of
/// people who were never in the drop.
const VEST_DAYS = 1825;
const ZERO = BigInt(0);

export function AirdropClaimPanel() {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [alloc, setAlloc] = useState<bigint | null>(null);
  const [claimable, setClaimable] = useState<bigint>(ZERO);
  const [claimed, setClaimed] = useState<bigint>(ZERO);
  // The early-claim door (docs/issues/airdrop-early-claim.md): the switch, and
  // the exact quote the contract would honour right now.
  const [earlyOn, setEarlyOn] = useState(false);
  const [earlyPaid, setEarlyPaid] = useState<bigint>(ZERO);
  const [earlyForfeit, setEarlyForfeit] = useState<bigint>(ZERO);
  const [confirmEarly, setConfirmEarly] = useState(false);
  const [busy, setBusy] = useState<'claim' | 'early' | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!contracts || !address) { setAlloc(null); return; }
    try {
      const [a, c, m, on, quote] = await Promise.all([
        contracts.cached.live.airdrop.airdropAllocation(address),
        contracts.cached.live.airdrop.claimableAirdrop(address),
        contracts.cached.live.satori.airdropMintedTo(address),
        contracts.cached.live.airdrop.earlyClaimEnabled(),
        contracts.cached.live.airdrop.earlyClaimQuote(address),
      ]);
      setAlloc(BigInt(a));
      setClaimable(BigInt(c));
      setClaimed(BigInt(m));
      setEarlyOn(Boolean(on));
      setEarlyPaid(BigInt(quote[0]));
      setEarlyForfeit(BigInt(quote[1]));
    } catch {
      // No allocation, or the read failed. Either way there is nothing to show,
      // and an error banner for "you are not in the airdrop" would be noise.
      setAlloc(null);
    }
  }, [contracts, address]);

  useEffect(() => { load(); }, [load]);

  const send = async (which: 'claim' | 'early', fn: () => Promise<any>, okText: string) => {
    if (!contracts) return;
    setBusy(which); setMsg(null);
    try {
      await afterTx(await fn());
      setMsg({ kind: 'ok', text: okText });
      setConfirmEarly(false);
      await load();
    } catch (e: any) {
      setMsg({ kind: 'err', text: explainError(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!address || alloc === null || alloc === ZERO) return null;

  const fmt = (v: bigint) => Number(ethers.formatEther(v)).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 6,
  });
  // Share of the allocation already minted. Claimed can only ever reach alloc.
  const pct = alloc > ZERO
    ? Number((claimed * BigInt(10000)) / alloc) / 100
    : 0;
  // Settled: a buyout shrank the allocation to exactly what was minted. Nothing
  // more will ever vest, and the contract says so by quoting zero.
  const settled = claimed === alloc;
  const locked = alloc - claimed - claimable;
  const earlyTotal = claimable + earlyPaid;

  return (
    <div className="card-themed p-4 space-y-3" data-testid="airdrop-claim-panel">
      <h3 className="font-semibold flex items-center justify-between gap-1.5">
        <span>Airdrop</span>
        <InfoTip>
          One sixth of your allocation is available right away. The rest vests evenly
          over {VEST_DAYS} days from the day the protocol launched, not from the day it
          was allocated. You can claim the vested part at any time, as often as you
          like, and whatever is left keeps vesting. Nothing expires.
        </InfoTip>
      </h3>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div>
          <div className="text-xs text-gray-500">Allocation</div>
          <div className="font-semibold" data-testid="airdrop-alloc">{fmt(alloc)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Claimed</div>
          <div className="font-semibold" data-testid="airdrop-claimed">{fmt(claimed)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Ready now</div>
          <div className="font-semibold text-green-500" data-testid="airdrop-claimable">{fmt(claimable)}</div>
        </div>
      </div>

      {/* Progress through the vest, not progress toward a deadline. Nothing is
          lost by claiming late, so this is information rather than pressure. */}
      <div className="h-1.5 w-full rounded bg-gray-200 dark:bg-gray-700 overflow-hidden">
        <div className="h-full bg-green-500 transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="text-xs text-gray-500">
        {settled
          ? 'Your airdrop is settled: you took the early-claim deal, and nothing more will vest.'
          : <>{pct.toFixed(2)}% of your allocation claimed so far. The rest keeps vesting
              whether or not you claim, and never expires.</>}
      </div>

      {msg && (
        <div className={`p-2 rounded text-xs ${msg.kind === 'ok'
          ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
          : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'}`}
          data-testid="airdrop-msg">
          {msg.text}
        </div>
      )}

      {!settled && (
        <button
          onClick={() => send('claim', () => contracts!.airdrop.claimAirdrop(), 'Claimed. The SATORI is in your wallet.')}
          disabled={busy !== null || claimable === ZERO}
          className="w-full py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
          data-testid="btn-claim-airdrop"
        >
          {busy === 'claim' ? 'Claiming…'
            : claimable === ZERO ? 'Nothing vested yet'
            : `Claim ${fmt(claimable)} SATORI`}
        </button>
      )}

      {/* THE EARLY-CLAIM DEAL. Only while the loader has it switched on, and only
          while there is something locked to buy. The three numbers are the whole
          decision, so they are shown before anything is signed, and it asks
          twice: the forfeit is permanent. */}
      {!settled && earlyOn && locked > ZERO && earlyPaid > ZERO && (
        <div className="border border-amber-300 dark:border-amber-700/50 rounded p-3 space-y-2" data-testid="airdrop-early">
          <div className="text-sm font-medium">Or take everything now</div>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <div className="text-xs text-gray-500">You get now</div>
              <div className="font-semibold" data-testid="early-get">{fmt(earlyTotal)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">You give up</div>
              <div className="font-semibold text-red-500" data-testid="early-forfeit">{fmt(earlyForfeit)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">If you wait</div>
              <div className="font-semibold" data-testid="early-wait">{fmt(alloc - claimed)}</div>
            </div>
          </div>
          <div className="text-xs text-gray-500">
            The vested part (your sixth, plus what has dripped) is paid in full. The locked
            part is paid at the fraction of the {VEST_DAYS}-day window already elapsed, and
            the rest is gone for good. The deal only gets better with time; it never gets worse.
          </div>
          {!confirmEarly ? (
            <button
              onClick={() => setConfirmEarly(true)}
              disabled={busy !== null}
              className="w-full py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
              data-testid="btn-early-claim"
            >
              Claim everything now
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={() => send('early', () => contracts!.airdrop.claimAirdropEarly(),
                  `Done. ${fmt(earlyTotal)} SATORI is in your wallet; your airdrop is settled.`)}
                disabled={busy !== null}
                className="flex-1 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                data-testid="btn-early-claim-confirm"
              >
                {busy === 'early' ? 'Claiming…' : `Yes, forfeit ${fmt(earlyForfeit)} SATORI`}
              </button>
              <button
                onClick={() => setConfirmEarly(false)}
                disabled={busy !== null}
                className="flex-1 py-2 bg-gray-200 dark:bg-gray-700 text-sm font-medium rounded"
                data-testid="btn-early-claim-cancel"
              >
                Keep vesting
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
