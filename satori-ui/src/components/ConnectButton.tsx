import React, { useState, useEffect, useRef } from 'react';
import { useWallet, WalletChoice } from '../hooks/useWallet';
import { InBrowserWalletModal } from './InBrowserWalletModal';

/// Connect control.
///
/// When a wallet is injected — a desktop extension, or a wallet app's own
/// browser — there is nothing to choose: one button, straight through.
///
/// Otherwise (ordinary Chrome or Safari on a phone) the wallet has to be
/// reached over a relay, and which relay depends on the wallet, so the user
/// picks. MetaMask goes through MetaMask's own relay and needs no key from us;
/// everything else goes through WalletConnect, which does, so that option only
/// appears when this build has one.
///
/// Nothing here navigates away. The previous version sent the whole page to
/// MetaMask's in-app browser, which meant pressing Connect twice and losing the
/// tab you started in.
export function ConnectButton({ className }: { className?: string }) {
  const wallet = useWallet();
  const [picking, setPicking] = useState(false);
  const [inBrowser, setInBrowser] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const injected = typeof window !== 'undefined' && !!(window as any).ethereum;

  // Dismiss the picker on an outside click, so it cannot be left stranded open
  // over the rest of the header.
  useEffect(() => {
    if (!picking) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [picking]);

  const run = async (choice?: WalletChoice) => {
    setError(null);
    setPicking(false);
    try {
      await wallet.connect(choice);
    } catch (e: any) {
      // 4001 is the user closing the approval. That is an answer, not a fault —
      // returning quietly to the disconnected state is the whole response.
      const code = e?.code ?? e?.error?.code;
      if (code === 4001 || /user rejected|user denied/i.test(e?.message ?? '')) return;
      setError(e?.message ?? 'Could not connect');
    }
  };

  const onClick = () => {
    if (wallet.connecting) return;
    // Always a choice now: connect an external wallet, or use an in-browser one.
    setPicking((p) => !p);
  };

  const openInBrowser = () => {
    setPicking(false);
    setError(null);
    setInBrowser(true);
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={onClick}
        disabled={wallet.connecting}
        className={className ?? 'bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-wait px-4 py-2 rounded text-sm text-white'}
        data-testid="connect-button"
      >
        {wallet.connecting ? 'Connecting…' : 'Connect Wallet'}
      </button>

      {picking && (
        <div
          className="absolute right-0 mt-2 w-56 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg z-50 overflow-hidden"
          data-testid="wallet-picker"
        >
          {injected ? (
            <button
              onClick={() => run()}
              className="w-full text-left px-3 py-2.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
              data-testid="pick-injected"
            >
              <div className="font-medium">Browser extension</div>
              <div className="text-xs text-gray-500">MetaMask, Rabby, Coinbase, …</div>
            </button>
          ) : (
            <>
              <button
                onClick={() => run('metamask')}
                className="w-full text-left px-3 py-2.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm"
                data-testid="pick-metamask"
              >
                <div className="font-medium">MetaMask</div>
                <div className="text-xs text-gray-500">Opens the app to approve</div>
              </button>
              {wallet.canUseWalletConnect && (
                <button
                  onClick={() => run('walletconnect')}
                  className="w-full text-left px-3 py-2.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm border-t border-gray-200 dark:border-gray-700"
                  data-testid="pick-walletconnect"
                >
                  <div className="font-medium">Other wallet</div>
                  <div className="text-xs text-gray-500">Rainbow, Trust, Coinbase, …</div>
                </button>
              )}
            </>
          )}
          <button
            onClick={openInBrowser}
            className="w-full text-left px-3 py-2.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm border-t border-gray-200 dark:border-gray-700"
            data-testid="pick-inbrowser"
          >
            <div className="font-medium">In-browser wallet</div>
            <div className="text-xs text-gray-500">Generate or import — no extension needed</div>
          </button>
        </div>
      )}

      {inBrowser && <InBrowserWalletModal onClose={() => setInBrowser(false)} />}

      {error && (
        <div
          className="absolute right-0 mt-2 w-64 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-3 text-xs text-red-800 dark:text-red-300 shadow-lg z-50 whitespace-pre-line"
          data-testid="connect-error"
        >
          {error}
          <button
            onClick={() => setError(null)}
            className="block mt-2 underline"
          >
            dismiss
          </button>
        </div>
      )}
    </div>
  );
}
