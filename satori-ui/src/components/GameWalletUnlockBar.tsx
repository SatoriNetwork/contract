import React, { useState } from 'react';
import { useWallet } from '../hooks/useWallet';
import { explainError } from '../utils/errors';
import { InstantMark } from './WalletMark';

/// Resume prompt for a preferred-but-locked Game Wallet.
///
/// WHY THIS EXISTS. The game wallet's key is encrypted at rest and decrypted
/// only into memory, so a page reload necessarily loses it — that is the whole
/// security model, not an oversight. What the reload must NOT do is quietly
/// hand the app back to the wallet extension as though nothing had been set up:
/// the user configured a delegate, chose to play through it, and would come
/// back a day later to find MetaMask signing again with no explanation.
///
/// So the CHOICE persists (localStorage) even though the key cannot, and this
/// bar is what honours it: while the preference stands and the key is locked,
/// the app says so at the top of every screen and offers the one thing that can
/// resume it.
///
/// The X HIDES THE BOX AND NOTHING ELSE. It used to clear the preference —
/// labelled "use MetaMask" — which quietly put the user back on their wallet
/// while their power was still delegated to a key they had not unlocked, so
/// predicting failed with no visible reason. Dismissing is now cosmetic and
/// lasts until the next load; the only thing that ends instant signing is
/// removing the key, which undelegates on the way out.
///
/// Rendered app-level rather than inside the Delegation tab because the wallet
/// a click will sign with is a property of the whole app, and nobody browses to
/// a settings tab to find out why the wrong account is active.
export function GameWalletUnlockBar() {
  const wallet = useWallet();
  const gw = wallet.gameWallet;
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);

  if (!gw.exists || !gw.preferred || gw.unlocked || hidden) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pass || busy) return;
    setBusy(true);
    setError(null);
    try {
      await gw.unlock(pass);
      setPass('');
    } catch (err: any) {
      setError(explainError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800 px-4 py-2.5"
      data-testid="gw-unlock-bar"
    >
      <div className="max-w-5xl mx-auto flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="text-sm text-blue-900 dark:text-blue-200 flex-1 min-w-[16rem] flex items-center gap-1.5">
          <InstantMark />
          <strong>Unlock instant signing.</strong>
        </div>
        <form onSubmit={submit} className="flex items-center gap-2">
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Passphrase"
            autoComplete="current-password"
            className="w-44 bg-white dark:bg-gray-800 border border-blue-300 dark:border-blue-700 rounded px-2.5 py-1.5 text-sm"
            disabled={busy}
            data-testid="gw-bar-pass"
          />
          <button
            type="submit"
            disabled={busy || !pass}
            className="py-1.5 px-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
            data-testid="gw-bar-unlock"
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
        <button
          type="button"
          onClick={() => setHidden(true)}
          aria-label="Hide this message"
          title="Hide this message"
          className="text-blue-700/60 dark:text-blue-300/60 hover:text-blue-900 dark:hover:text-blue-100 text-lg leading-none px-1"
          data-testid="gw-bar-dismiss"
        >
          ×
        </button>
        {error && (
          <div className="w-full text-xs text-red-700 dark:text-red-400" data-testid="gw-bar-error">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
