import { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';

export interface KnownToken {
  address: string;
  symbol: string;
  decimals: number;
  /** The connected wallet's balance, formatted. '0' if they hold none. */
  balance: string;
  /** Raw balance, for sorting and the has-any check. */
  raw: bigint;
  /** Why this token is on the list — shown as a hint in the picker. */
  source: 'staked' | 'bounty';
}

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

/**
 * Candidate bounty tokens, discovered ON-CHAIN.
 *
 * There is deliberately no "every token in your wallet" option here, because that
 * information does not exist on-chain and no wallet exposes it. ERC-20 has no
 * registry — a token contract knows only its own balances — and EIP-1193 has no
 * method to enumerate an account's assets (`wallet_watchAsset` is the reverse
 * direction: it lets a dapp SUGGEST a token to the wallet). Wallets build their
 * own lists from an off-chain indexer. Getting a true wallet dump here would mean
 * adding a third-party API (Alchemy/Moralis/Covalent) or indexing every ERC-20
 * Transfer ourselves.
 *
 * What we CAN enumerate is the set that actually matters for funding a bounty,
 * because SatoriBounties tracks it:
 *   - `userStakedTokens(user, i)`  — tokens you already have a stake in
 *   - `gameBountyTokens(gameId, i)` — tokens already funding a game
 *
 * Union those, read symbol/decimals/balance for each, and you get the tokens a
 * funder is realistically reaching for. The manual address field remains for
 * anything genuinely new.
 */
export function useKnownTokens(gameIds: number[]) {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [tokens, setTokens] = useState<KnownToken[]>([]);
  const [loading, setLoading] = useState(false);

  const key = gameIds.join(',');

  const load = useCallback(async () => {
    if (!contracts || !address) { setTokens([]); return; }
    setLoading(true);
    try {
      const { bounties } = contracts;
      const seen = new Map<string, 'staked' | 'bounty'>();

      // Tokens the user already staked — the strongest signal of intent.
      const nStaked = Number(await bounties.userStakedTokenCount(address));
      for (let i = 0; i < nStaked; i++) {
        const t: string = await bounties.userStakedTokens(address, i);
        seen.set(ethers.getAddress(t), 'staked');
      }

      // Tokens already funding any game the caller passed in.
      for (const gid of gameIds) {
        const n = Number(await bounties.gameBountyTokenCount(gid));
        for (let i = 0; i < n; i++) {
          const t: string = await bounties.gameBountyTokens(gid, i);
          const a = ethers.getAddress(t);
          if (!seen.has(a)) seen.set(a, 'bounty');
        }
      }

      const provider = contracts.token.runner;
      const out: KnownToken[] = [];
      for (const [addr, source] of Array.from(seen.entries())) {
        try {
          const erc = new ethers.Contract(addr, ERC20_ABI, provider as any);
          const [symbol, decimals, raw] = await Promise.all([
            erc.symbol(), erc.decimals(), erc.balanceOf(address),
          ]);
          out.push({
            address: addr,
            symbol: String(symbol),
            decimals: Number(decimals),
            raw: BigInt(raw),
            balance: ethers.formatUnits(raw, Number(decimals)),
            source,
          });
        } catch {
          // A non-conforming or self-destructed token: skip it rather than
          // breaking the whole picker.
        }
      }

      // Ones you actually hold first, then by balance.
      out.sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));
      setTokens(out);
    } catch {
      setTokens([]);
    } finally {
      setLoading(false);
    }
  }, [contracts, address, key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  return { tokens, loading, reload: load };
}
