import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { multicallRead } from '../utils/multicall';
import { explainError } from '../utils/errors';
import { afterTx } from '../lib/afterTx';

// A registered GAME-type adapter as enumerated from contracts.games. Game type
// IDs are dense and start at 1; id 0 is reserved for the built-in binary game
// (type 0) and is never returned here. This is the game-adapter analogue of
// RegisteredAdapter in useAdapters.ts (the STREAM-adapter registry).
export interface RegisteredGameAdapter {
  id: number;
  name: string;
  impl: string;
  isCommunity: boolean;
}

// Per-adapter reads issued in the batched enumeration pass: impl address +
// name + community flag. Three reads per id, one Multicall round-trip total.
const READS_PER_ADAPTER = 3;

export function useGameAdapters(): {
  gameAdapters: RegisteredGameAdapter[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  registerCommunityGameAdapter: (impl: string, name: string) => Promise<number>;
  registerGameAdapter: (impl: string, name: string) => Promise<number>;
  spamFee: bigint;
} {
  const { contracts } = useContracts();
  const [gameAdapters, setGameAdapters] = useState<RegisteredGameAdapter[]>([]);
  const [spamFee, setSpamFee] = useState<bigint>(BigInt(0));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Enumerate registered game adapters. nextGameTypeId() is the exclusive upper
  // bound, so registered IDs are 1..next-1 (0 is the built-in binary type and
  // is never an adapter). Each id's impl/name/community flag is batched into a
  // single eth_call via Multicall. We also read the current spam fee in the
  // same effect so the cost hint is ready alongside the list.
  const load = useCallback(async () => {
    if (!contracts) return;
    setLoading(true);
    setError(null);
    try {
      const [next, fee] = await Promise.all([
        contracts.cached.live.games.nextGameTypeId(),
        contracts.reads.lens.registrationFee(),   // admin-set, so read live
      ]);
      setSpamFee(BigInt(fee));

      const nextId = Number(next);
      if (nextId <= 1) {
        setGameAdapters([]);
        return;
      }

      const ids: number[] = [];
      for (let i = 1; i < nextId; i++) ids.push(i);

      const reqs = ids.flatMap((id) => [
        { contract: contracts.games, fn: 'gameAdapter', args: [id], allowFailure: true },
        { contract: contracts.games, fn: 'gameAdapterName', args: [id], allowFailure: true },
        { contract: contracts.games, fn: 'isCommunityGameAdapter', args: [id], allowFailure: true },
      ]);
      const results = await multicallRead(contracts.reads.multicall, reqs);

      const rows: RegisteredGameAdapter[] = [];
      ids.forEach((id, i) => {
        const base = i * READS_PER_ADAPTER;
        const impl = results[base] as string | null;
        const name = results[base + 1] as string | null;
        const community = results[base + 2] as boolean | null;
        // Defensive: skip any id whose impl is missing or the zero address —
        // a gap in the dense range shouldn't surface as a phantom adapter.
        if (!impl || impl === ethers.ZeroAddress) return;
        rows.push({
          id,
          name: name ?? '',
          impl,
          isCommunity: Boolean(community),
        });
      });

      // Already in id order from the loop, but sort defensively to honor the
      // documented "sorted by id" contract regardless of result interleaving.
      rows.sort((a, b) => a.id - b.id);
      setGameAdapters(rows);
    } catch (e: any) {
      console.error('useGameAdapters load failed:', e);
      setError(explainError(e));
    } finally {
      setLoading(false);
    }
  }, [contracts]);

  useEffect(() => { load(); }, [load]);

  // Shared registration helper for both the community (permissionless) and
  // official (admin-only) paths. Registration is on contracts.satori (the
  // CORE), but the GameAdapterRegistered event is declared/emitted on the
  // SatoriGames ABI — so we parse receipt logs with the games interface,
  // falling back to the satori interface for robustness across deployments.
  const register = useCallback(
    async (
      fn: 'registerCommunityGameAdapter' | 'registerGameAdapter',
      impl: string,
      name: string,
    ): Promise<number> => {
      if (!contracts) throw new Error('Wallet not connected.');
      if (!ethers.isAddress(impl)) throw new Error('Invalid game adapter implementation address.');
      if (impl === ethers.ZeroAddress) throw new Error('Game adapter implementation cannot be the zero address.');
      try {
        const tx = await contracts.satori[fn](impl, name);
        const receipt = await afterTx(tx);

        const interfaces = [contracts.games.interface, contracts.satori.interface];
        for (const log of receipt.logs ?? []) {
          for (const iface of interfaces) {
            let parsed: ethers.LogDescription | null = null;
            try {
              parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
            } catch {
              parsed = null;
            }
            if (parsed && parsed.name === 'GameAdapterRegistered') {
              const newId = Number(parsed.args.gameTypeId);
              await load();
              return newId;
            }
          }
        }
        // No event found — refetch and surface a readable failure rather than
        // returning a bogus id.
        await load();
        throw new Error('Game adapter registered but the new id could not be read from the receipt.');
      } catch (e: any) {
        throw new Error(explainError(e));
      }
    },
    [contracts, load],
  );

  // Permissionless registration. Charges registrationFee() SATORI via token.transferFrom
  // to the hub (the caller must first approve the hub for registrationFee) and returns the freshly minted
  // game type id parsed from the GameAdapterRegistered event in the receipt.
  const registerCommunityGameAdapter = useCallback(
    (impl: string, name: string): Promise<number> =>
      register('registerCommunityGameAdapter', impl, name),
    [register],
  );

  // Official registration. Admin-only (admin = contracts.cached.round.rewards.admin()) and
  // free; otherwise identical shape to the community path.
  const registerGameAdapter = useCallback(
    (impl: string, name: string): Promise<number> =>
      register('registerGameAdapter', impl, name),
    [register],
  );

  return {
    gameAdapters,
    loading,
    error,
    refetch: load,
    registerCommunityGameAdapter,
    registerGameAdapter,
    spamFee,
  };
}
