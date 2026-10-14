import React from 'react';
import { useGasless } from '../hooks/useGasless';

/**
 * The two pay-in-SATORI settings, under advanced. Rendered only when a relayer
 * is configured for this chain (useGasless().enabled).
 *
 * The first is also set automatically by answering YES to the out-of-ETH
 * prompt. The second is MANUAL ONLY — nothing in the app ever turns it on for
 * the user, which is what makes it safe as a total override.
 */
export function GasSettings() {
  const { enabled, willing, always, setWilling, setAlways } = useGasless();
  if (!enabled) return null;

  return (
    <div className="card-themed p-4 space-y-3" data-testid="gas-settings">
      <div className="text-sm text-gray-500 dark:text-gray-400">
        Out of ETH? The Satori relayer can pay your transaction gas and charge a
        small SATORI fee instead.
      </div>

      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={willing || always}
          disabled={always}
          onChange={(e) => setWilling(e.target.checked)}
          data-testid="gas-toggle-willing"
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Pay gas in SATORI when out of ETH</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            ETH is still used whenever you have it; the SATORI fee only applies
            when you don&apos;t.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={always}
          onChange={(e) => setAlways(e.target.checked)}
          data-testid="gas-toggle-always"
          className="mt-0.5"
        />
        <span>
          <span className="font-medium">Always pay gas in SATORI</span>
          <span className="block text-xs text-gray-500 dark:text-gray-400">
            Every transaction goes through the relayer, even when you have ETH.
          </span>
        </span>
      </label>
    </div>
  );
}
