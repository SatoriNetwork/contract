import { useCallback, useEffect, useState } from 'react';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';

/**
 * Is this wallet below the farming threshold?
 *
 * Below it a correct call still pays, it just cannot GROW a streak
 * (docs/design/farming-threshold.md). The UI stays quiet about this unless it
 * actually applies to you: a number most people are comfortably above is noise.
 *
 * **Compared against prediction POWER, not the balance on screen.** Power is
 * balance plus unclaimed rewards plus delegated-in, so someone with a small
 * balance and a pile of unclaimed winnings is above the line and must not be
 * told otherwise. The balance is what gets coloured because it is what is
 * displayed; the test behind the colour is the one the contract actually applies.
 *
 * Staleness: the threshold moves only with the round clock, so it reads through
 * the per-round cache. Power moves whenever the holder does, so it reads through
 * the live cache.
 */
export interface FarmingThresholdState {
  /// Minimum prediction power needed to grow a streak, in wei. Null while loading.
  threshold: bigint | null;
  /// This wallet's prediction power, in wei. Null while loading.
  power: bigint | null;
  /// True only when both are known AND power is short. Never true on a failed
  /// read: an unknown answer must not paint someone's balance red.
  below: boolean;
}

export function useFarmingThreshold(): FarmingThresholdState {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [state, setState] = useState<FarmingThresholdState>({
    threshold: null, power: null, below: false,
  });

  const load = useCallback(async () => {
    if (!contracts || !address) {
      setState({ threshold: null, power: null, below: false });
      return;
    }
    try {
      const [threshold, power] = await Promise.all([
        contracts.cached.round.satori.farmingThreshold(),
        contracts.cached.live.rewards.getPredictionPower(address),
      ]);
      const t = BigInt(threshold);
      const p = BigInt(power);
      setState({ threshold: t, power: p, below: p < t });
    } catch {
      // An older deployment without the view, or a failed read. Report "not
      // below" so the UI simply says nothing, rather than accusing someone of
      // being under a line we could not read.
      setState({ threshold: null, power: null, below: false });
    }
  }, [contracts, address]);

  useEffect(() => { load(); }, [load]);

  return state;
}
