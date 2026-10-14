import React from 'react';
import { useGasless } from '../hooks/useGasless';

/**
 * The one-time "pay gas in SATORI?" question, shown only when a transaction is
 * attempted with too little ETH and no standing preference exists. One dialog,
 * one decision (the GameWalletPanel modal rule): YES turns the willing setting
 * on permanently and the transaction proceeds; NO is remembered until the
 * wallet holds ETH again.
 */
export function GasSatoriPrompt() {
  const { prompt } = useGasless();
  if (!prompt) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      role="dialog" aria-modal="true"
      aria-label="Pay gas in SATORI?"
      data-testid="gas-satori-prompt"
    >
      <div className="card-themed w-full max-w-sm p-4 space-y-3">
        <div className="font-medium">Pay your transaction gas in SATORI?</div>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Your wallet doesn&apos;t have enough ETH to pay this transaction&apos;s gas.
          Satori can send it for you and charge a fee of{' '}
          <strong className="whitespace-nowrap">~{prompt.feeText}</strong> instead.
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Saying yes turns this on for every future transaction while you&apos;re out
          of ETH. You can change it anytime under <em>advanced</em>.
        </p>
        <div className="flex gap-2">
          <button
            onClick={() => prompt.resolve(true)}
            data-testid="gas-satori-yes"
            className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 !text-white text-sm font-medium rounded transition-colors"
          >
            Yes, pay in SATORI
          </button>
          <button
            onClick={() => prompt.resolve(false)}
            data-testid="gas-satori-no"
            className="flex-1 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded transition-colors hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            No, I&apos;ll add ETH
          </button>
        </div>
      </div>
    </div>
  );
}
