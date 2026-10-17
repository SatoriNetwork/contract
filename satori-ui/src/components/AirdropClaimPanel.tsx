import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { InfoTip } from './InfoTip';
import { explainError } from '../utils/errors';
import { afterTx } from '../lib/afterTx';

/// Claim an airdrop allocation: the whole of it, once claims open one day after
/// the table is finalized (docs/issues/airdrop-claim-after-a-day.md).
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
const ZERO = BigInt(0);

export function AirdropClaimPanel() {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [alloc, setAlloc] = useState<bigint | null>(null);
  const [claimable, setClaimable] = useState<bigint>(ZERO);
  const [claimed, setClaimed] = useState<bigint>(ZERO);
  const [opensAt, setOpensAt] = useState<bigint>(ZERO);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!contracts || !address) { setAlloc(null); return; }
    try {
      const [a, c, m, o] = await Promise.all([
        contracts.cached.live.airdrop.airdropAllocation(address),
        contracts.cached.live.airdrop.claimableAirdrop(address),
        contracts.cached.live.satori.airdropMintedTo(address),
        contracts.cached.live.airdrop.claimsOpenAt(),
      ]);
      setAlloc(BigInt(a));
      setClaimable(BigInt(c));
      setClaimed(BigInt(m));
      setOpensAt(BigInt(o));
    } catch {
      // No allocation, or the read failed. Either way there is nothing to show,
      // and an error banner for "you are not in the airdrop" would be noise.
      setAlloc(null);
    }
  }, [contracts, address]);

  useEffect(() => { load(); }, [load]);

  // Claims open on a clock, not on an event this page sees, so re-read while
  // waiting; otherwise the button stays shut until a reload.
  const waiting = alloc !== null && alloc > ZERO && claimed < alloc && claimable === ZERO;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [waiting, load]);

  const claim = async () => {
    if (!contracts) return;
    setBusy(true); setMsg(null);
    try {
      await afterTx(await contracts.airdrop.claimAirdrop());
      setMsg({ kind: 'ok', text: 'Claimed. Your whole allocation is in your wallet.' });
      await load();
    } catch (e: any) {
      setMsg({ kind: 'err', text: explainError(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!address || alloc === null || alloc === ZERO) return null;

  const fmt = (v: bigint) => Number(ethers.formatEther(v)).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 6,
  });
  const done = claimed >= alloc;
  // `claimableAirdrop` already answers on chain time, so a zero here while
  // something is still owed means the opening moment has not arrived.
  const notOpen = !done && claimable === ZERO;
  const opensText = opensAt > ZERO
    ? new Date(Number(opensAt) * 1000).toLocaleString()
    : null;

  return (
    <div className="card-themed p-4 space-y-3" data-testid="airdrop-claim-panel">
      <h3 className="font-semibold flex items-center justify-between gap-1.5">
        <span>Airdrop</span>
        <InfoTip>
          Your whole allocation becomes claimable one day after the airdrop list is
          finalized. Claim it in one go, any time after that. Nothing expires.
        </InfoTip>
      </h3>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-xs text-gray-500">Allocation</div>
          <div className="font-semibold" data-testid="airdrop-alloc">{fmt(alloc)}</div>
        </div>
        <div>
          <div className="text-xs text-gray-500">Claimed</div>
          <div className="font-semibold" data-testid="airdrop-claimed">{fmt(claimed)}</div>
        </div>
      </div>

      <div className="text-xs text-gray-500" data-testid="airdrop-status">
        {done ? 'Your airdrop is claimed.'
          : !notOpen ? 'Ready to claim.'
          : opensText ? `Claims open ${opensText}.`
          : 'The airdrop list is still being loaded. Claims open one day after it is finalized.'}
      </div>

      {msg && (
        <div className={`p-2 rounded text-xs ${msg.kind === 'ok'
          ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
          : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'}`}
          data-testid="airdrop-msg">
          {msg.text}
        </div>
      )}

      {!done && (
        <button
          onClick={claim}
          disabled={busy || notOpen}
          className="w-full py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
          data-testid="btn-claim-airdrop"
        >
          {busy ? 'Claiming…'
            : notOpen ? 'Not open yet'
            : `Claim ${fmt(claimable)} SATORI`}
        </button>
      )}
    </div>
  );
}
