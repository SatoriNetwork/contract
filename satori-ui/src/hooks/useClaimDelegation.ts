import { useCallback, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';
import { explainError } from '../utils/errors';
import { afterTx } from '../lib/afterTx';

/// Delegate-side execution of claim delegation. The SET side (a token holder
/// naming a claim delegate) lives in DelegationTab via `delegateClaimAbility`.
/// This hook is the *acting* side: when the connected wallet has been named
/// someone's claim delegate, it can trigger that owner's SATORI claim and/or
/// bounty withdrawal on their behalf.
///
/// Authorization is the same on both sides: the connected wallet must equal
/// `rewards.claimDelegateInfo(owner)` (the owner's chosen claim delegate). The
/// owner themselves is always implicitly authorized on-chain, but this UI is
/// for the delegate, so we surface the delegate match explicitly.

export interface DelegateAuth {
  owner: string;          // checksummed owner address that was queried
  delegate: string;       // current claim delegate of `owner` (ZERO if none)
  isAuthorized: boolean;  // connected wallet === delegate (or === owner)
}

type ActionResult =
  | { ok: true; amount?: bigint }
  | { ok: false; error: string };

const ZERO = '0x0000000000000000000000000000000000000000';

export function useClaimDelegation() {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [acting, setActing] = useState<string | null>(null);

  /// Read `owner`'s current claim delegate and decide whether the connected
  /// wallet may act for them. Mirror of the on-chain check: the delegate, or
  /// the owner acting for themselves, is authorized.
  const checkAuth = useCallback(async (owner: string): Promise<DelegateAuth | null> => {
    if (!contracts || !ethers.isAddress(owner)) return null;
    try {
      const ownerAddr = ethers.getAddress(owner);
      // claimDelegateInfo returns a bare address (the owner's claim delegate),
      // ZERO if none has been set.
      const delegate: string = await contracts.cached.live.rewards.claimDelegateInfo(ownerAddr);
      const connected = address ? ethers.getAddress(address) : ZERO;
      const isAuthorized =
        connected !== ZERO &&
        (connected === ethers.getAddress(delegate) || connected === ownerAddr);
      return { owner: ownerAddr, delegate, isAuthorized };
    } catch (e) {
      console.error('claim-delegate auth check failed:', e);
      return null;
    }
  }, [contracts, address]);

  /// Enumerate `owner`'s staked bounty tokens the same way useBountyStakes
  /// does: read the count, then index into the `userStakedTokens` array.
  const fetchOwnerStakedTokens = useCallback(async (owner: string): Promise<string[]> => {
    if (!contracts || !ethers.isAddress(owner)) return [];
    try {
      const countRaw = await contracts.cached.live.bounties.userStakedTokenCount(owner);
      const count = Number(countRaw);
      if (count === 0) return [];
      const tokens: string[] = [];
      for (let i = 0; i < count; i++) {
        const t: string = await contracts.cached.live.bounties.userStakedTokens(owner, i);
        tokens.push(t);
      }
      return tokens;
    } catch (e) {
      console.error('fetchOwnerStakedTokens failed:', e);
      return [];
    }
  }, [contracts]);

  /// Trigger the owner's SATORI claim, routing the minted reward to `recipient`.
  /// `claimFor` returns the claimed amount; we staticCall first to surface it in
  /// the success message, then send the real tx.
  const claimForDelegator = useCallback(async (
    owner: string, recipient: string,
  ): Promise<ActionResult> => {
    if (!contracts) return { ok: false, error: 'Not connected' };
    setActing('claimFor');
    try {
      let amount: bigint | undefined;
      try {
        amount = await contracts.satori.claimFor.staticCall(owner, recipient);
      } catch {
        // staticCall is best-effort for the preview amount; the real send below
        // still surfaces any genuine revert.
      }
      const tx = await contracts.satori.claimFor(owner, recipient);
      await afterTx(tx);
      return { ok: true, amount };
    } catch (e: any) {
      return { ok: false, error: explainError(e) };
    } finally {
      setActing(null);
    }
  }, [contracts]);

  // (withdrawBountyForDelegator removed — the dead unclaimedBounty withdraw path
  // is gone; bounty winnings auto-compound into bountyStake and are cashed out
  // via unstake — review A4.)

  return {
    acting,
    checkAuth,
    fetchOwnerStakedTokens,
    claimForDelegator,
  };
}
