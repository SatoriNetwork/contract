import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { InfoTip } from './InfoTip';
import { explainError } from '../utils/errors';
import { afterTx } from '../lib/afterTx';

/// Claim an airdrop allocation: the whole of it, from the moment it is loaded
/// (docs/issues/airdrop-claim-at-finalize.md).
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
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [failed, setFailed] = useState(false);
  // Whether any read has succeeded for this wallet and chain. After one has, a
  // failed re-read keeps the last answer on screen rather than hiding the panel.
  const readOnce = useRef(false);

  const load = useCallback(async () => {
    // A chain with no airdrop contract has it at zero: every read would fail,
    // and the retry below would then poll it forever.
    if (!contracts || !address || String(contracts.reads.airdrop.target) === ethers.ZeroAddress) {
      setAlloc(null); setFailed(false); return;
    }
    try {
      const [a, c, m] = await Promise.all([
        contracts.cached.live.airdrop.airdropAllocation(address),
        contracts.cached.live.airdrop.claimableAirdrop(address),
        contracts.cached.live.satori.airdropMintedTo(address),
      ]);
      setAlloc(BigInt(a));
      setClaimable(BigInt(c));
      setClaimed(BigInt(m));
      readOnce.current = true;
      setFailed(false);
    } catch {
      // No error banner: for most people "you are not in the airdrop" would be
      // noise. The poll below retries.
      if (!readOnce.current) setAlloc(null);
      setFailed(true);
    }
  }, [contracts, address]);

  useEffect(() => { readOnce.current = false; load(); }, [load]);

  // A failed read is retried, so the panel does not wait for a reload.
  useEffect(() => {
    if (!failed) return;
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [failed, load]);

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
  // Zero while something is still owed: the token's airdrop pointer is not
  // this contract, so it cannot mint.
  const notOpen = !done && claimable === ZERO;

  return (
    <div className="card-themed p-4 space-y-3" data-testid="airdrop-claim-panel">
      <h3 className="font-semibold flex items-center justify-between gap-1.5">
        <span>Airdrop</span>
        <InfoTip>
          Your whole allocation is claimable as soon as it is on the airdrop
          list. Claim it in one go, any time. Nothing expires.
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
          : 'Not claimable from this airdrop contract.'}
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
            : notOpen ? 'Not claimable'
            : `Claim ${fmt(claimable)} SATORI`}
        </button>
      )}
    </div>
  );
}
