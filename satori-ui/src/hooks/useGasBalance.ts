import { useCallback, useEffect, useState } from 'react';
import { useWallet } from './useWallet';

/**
 * The native-token balance of whichever key will actually sign, expressed in
 * the unit that matters to a player: how many more rounds they can play.
 *
 * WHOSE BALANCE. Always `wallet.address` — the ACTING signer. With instant
 * signing on that is Satori's own key, which is the thing that runs dry and
 * silently stops the game; with it off it is the user's wallet.
 *
 * WHY A ROUND COUNT. "0.00014 ETH" tells nobody anything. "About 15 more
 * rounds" is the same fact in the unit the player thinks in, and it is what the
 * warning colours key off.
 */
export interface GasBalanceState {
  /// Native balance in wei. Null while loading or with no address.
  wei: bigint | null;
  /// Whole rounds the balance can still pay for at the current gas price. Null
  /// when either input is unknown — an unknown answer must never paint a
  /// warning colour, the same rule useFarmingThreshold follows.
  rounds: number | null;
}

/// Gas for one round of predicting, flat. Measured in
/// `test/BatchPredictionGasScaling.test.js` (steady state — predicting while
/// also settling last round): 480k for one game, 758k for three, 1.01M for
/// five, because a batch is ONE transaction with a fixed overhead plus roughly
/// 133k per game. This takes the three-game figure as a representative middle.
///
/// Flat on purpose. The number drives a coarse three-colour warning at 15 and
/// 30 rounds, so being off by a game or two moves the amber line by a day —
/// which does not matter, and is not worth a per-user calculation to chase.
const ROUND_GAS = BigInt(750_000);

/// Gas moves twice a day at most, so this is a slow number.
const REFRESH_MS = 60_000;

export function useGasBalance(): GasBalanceState {
  const { address, provider } = useWallet();
  const [state, setState] = useState<GasBalanceState>({ wei: null, rounds: null });

  const load = useCallback(async () => {
    if (!address || !provider) {
      setState({ wei: null, rounds: null });
      return;
    }
    try {
      const [wei, fee] = await Promise.all([
        provider.getBalance(address),
        provider.getFeeData(),
      ]);
      const price = fee.maxFeePerGas ?? fee.gasPrice ?? null;
      const perRound = price === null ? null : price * ROUND_GAS;
      setState({
        wei,
        // A zero or missing gas price would divide by zero; report unknown.
        rounds: perRound && perRound > BigInt(0) ? Number(wei / perRound) : null,
      });
    } catch {
      setState({ wei: null, rounds: null });
    }
  }, [address, provider]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return state;
}

/// Colour bands for the round count: under 15 rounds is urgent, under 30 is a
/// nudge, above that is fine. `null` rounds yields the neutral colour — an
/// unreadable balance must not look like an alarm.
export function gasToneClass(rounds: number | null): string {
  if (rounds === null) return 'text-gray-500';
  if (rounds < 15) return 'text-red-500 dark:text-red-400';
  if (rounds < 30) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-green-600 dark:text-green-400';
}
