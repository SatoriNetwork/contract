import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { multicallRead } from '../utils/multicall';
import { explainError } from '../utils/errors';
import { getStreamBurn } from '../lib/chainValues';
import { afterTx } from '../lib/afterTx';

// A registered STREAM adapter as enumerated from contracts.registry. Adapter
// IDs are dense and start at 1; id 0 is the "Simple" (non-adapter) sentinel
// and is never returned here. The canonical official IDs (1=Chainlink,
// 2=Uniswap, 3=Custom) live in useVoting.ts as ADAPTER_ID_* constants.
export interface RegisteredAdapter {
  id: number;
  name: string;
  impl: string;
  isCommunity: boolean;
}

// Per-adapter reads issued in the batched enumeration pass: impl address +
// name + community flag. Three reads per id, one Multicall round-trip total.
const READS_PER_ADAPTER = 3;

export function useAdapters(): {
  adapters: RegisteredAdapter[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  registerCommunityAdapter: (impl: string, name: string) => Promise<number>;
  spamFee: bigint;
} {
  const { contracts } = useContracts();
  const [adapters, setAdapters] = useState<RegisteredAdapter[]>([]);
  const [spamFee, setSpamFee] = useState<bigint>(BigInt(0));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Enumerate registered adapters. nextAdapterId() is the exclusive upper
  // bound, so registered IDs are 1..next-1. Each id's impl/name/community flag
  // is batched into a single eth_call via Multicall. We also read the current
  // spam fee in the same effect so the cost hint is ready alongside the list.
  const load = useCallback(async () => {
    if (!contracts) return;
    setLoading(true);
    setError(null);
    try {
      const [next, fee] = await Promise.all([
        contracts.cached.live.registry.nextAdapterId(),
        getStreamBurn(),
      ]);
      setSpamFee(BigInt(fee));

      const nextId = Number(next);
      if (nextId <= 1) {
        setAdapters([]);
        return;
      }

      const ids: number[] = [];
      for (let i = 1; i < nextId; i++) ids.push(i);

      const reqs = ids.flatMap((id) => [
        { contract: contracts.registry, fn: 'adapter', args: [id], allowFailure: true },
        { contract: contracts.registry, fn: 'adapterName', args: [id], allowFailure: true },
        { contract: contracts.registry, fn: 'isCommunityAdapter', args: [id], allowFailure: true },
      ]);
      const results = await multicallRead(contracts.reads.multicall, reqs);

      const rows: RegisteredAdapter[] = [];
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
      setAdapters(rows);
    } catch (e: any) {
      console.error('useAdapters load failed:', e);
      setError(explainError(e));
    } finally {
      setLoading(false);
    }
  }, [contracts]);

  useEffect(() => { load(); }, [load]);

  // Permissionless registration. Charges streamBurn() SATORI via token.transferFrom
  // to the hub (the caller must first approve the hub for streamBurn) and returns the freshly minted
  // adapter id parsed from the AdapterRegistered event in the receipt.
  //
  // The AdapterRegistered event is declared on the SatoriRegistry ABI (the
  // registry is the contract that actually emits it), NOT on the core Satori
  // ABI. So we parse receipt logs with the registry interface, falling back to
  // the satori interface for robustness across deployments.
  const registerCommunityAdapter = useCallback(
    async (impl: string, name: string): Promise<number> => {
      if (!contracts) throw new Error('Wallet not connected.');
      if (!ethers.isAddress(impl)) throw new Error('Invalid adapter implementation address.');
      if (impl === ethers.ZeroAddress) throw new Error('Adapter implementation cannot be the zero address.');
      try {
        const tx = await contracts.satori.registerCommunityAdapter(impl, name);
        const receipt = await afterTx(tx);

        const interfaces = [contracts.registry.interface, contracts.satori.interface];
        for (const log of receipt.logs ?? []) {
          for (const iface of interfaces) {
            let parsed: ethers.LogDescription | null = null;
            try {
              parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
            } catch {
              parsed = null;
            }
            if (parsed && parsed.name === 'AdapterRegistered') {
              const newId = Number(parsed.args.adapterId);
              await load();
              return newId;
            }
          }
        }
        // No event found — refetch and surface a readable failure rather than
        // returning a bogus id.
        await load();
        throw new Error('Adapter registered but the new id could not be read from the receipt.');
      } catch (e: any) {
        throw new Error(explainError(e));
      }
    },
    [contracts, load],
  );

  return {
    adapters,
    loading,
    error,
    refetch: load,
    registerCommunityAdapter,
    spamFee,
  };
}
