import React, { useState } from 'react';
import { useWallet } from '../hooks/useWallet';
import { explainError } from '../utils/errors';
import { MIN_PASSPHRASE_LENGTH } from '../lib/gameWallet';
import { InstantMark } from './WalletMark';

/// The "in-browser wallet" path from the Connect dropdown: a local ethers key
/// that IS the acting wallet, so the app is usable with no extension and no
/// MetaMask at all. It drives the same vetted store as the game wallet
/// (lib/gameWallet.ts, encrypted V3 keystore in localStorage) via
/// wallet.gameWallet, then `setPreferred(true)` makes it the acting signer —
/// so predict/vote/claim flow through it unchanged (useWallet gwActing).
///
/// This is the STANDALONE flavour: unlike GameWalletPanel's delegation wizard,
/// nothing here assumes a main wallet. A generated key is funded directly by
/// the user; an imported key is the user's own funded key.
type Mode = 'menu' | 'create' | 'import' | 'backup' | 'unlock' | 'ready';

export function InBrowserWalletModal({ onClose }: { onClose: () => void }) {
  const wallet = useWallet();
  const gw = wallet.gameWallet;

  // A wallet already on this device cannot be re-generated over (that would
  // destroy it): resume into unlock, or straight to activation if it is open.
  const initialMode: Mode = gw.exists ? (gw.unlocked ? 'ready' : 'unlock') : 'menu';
  const [mode, setMode] = useState<Mode>(initialMode);
  const [secret, setSecret] = useState('');
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState(false);
  const [backupSaved, setBackupSaved] = useState(false);

  const passphraseOk = pass1.length >= MIN_PASSPHRASE_LENGTH && pass1 === pass2;

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e: any) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  // Make the local key the acting wallet and close. `setPreferred` + unlocked =
  // active, and useWallet then returns it as `signer`/`address` app-wide.
  const activateAndClose = () => {
    gw.setPreferred(true);
    onClose();
  };

  const body = (() => {
    switch (mode) {
      case 'menu':
        return (
          <>
            <p className="text-xs text-gray-500">
              A wallet that lives in this browser — no extension, no MetaMask. The key is
              encrypted with a passphrase and only the encrypted copy is stored on this device.
            </p>
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-800 dark:text-amber-300">
              <strong>Testnet use.</strong> A key held in a browser is only as safe as this device.
              Clearing site data erases it — back up a generated key, and only import a key you are
              willing to keep in browser storage.
            </div>
            <button
              onClick={() => { setPass1(''); setPass2(''); setMode('create'); }}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 !text-white text-sm font-medium rounded transition-colors flex items-center justify-center gap-1.5"
              data-testid="ibw-generate"
            >
              <InstantMark /> Generate a new wallet
            </button>
            <button
              onClick={() => { setSecret(''); setPass1(''); setPass2(''); setMode('import'); }}
              className="w-full py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-sm rounded transition-colors"
              data-testid="ibw-import"
            >
              Import a private key or recovery phrase
            </button>
          </>
        );

      case 'create':
      case 'import': {
        const isImport = mode === 'import';
        return (
          <>
            {isImport && (
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="Private key or recovery phrase"
                className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
                data-testid="ibw-secret"
              />
            )}
            <input
              type="password"
              value={pass1}
              onChange={(e) => setPass1(e.target.value)}
              placeholder={`Passphrase (min ${MIN_PASSPHRASE_LENGTH} characters)`}
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
              data-testid="ibw-pass-1"
            />
            <input
              type="password"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
              placeholder="Repeat passphrase"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
              data-testid="ibw-pass-2"
            />
            {pass2.length > 0 && pass1 !== pass2 && (
              <p className="text-xs text-red-700 dark:text-red-400">Passphrases do not match.</p>
            )}
            <p className="text-[11px] text-gray-500">
              The passphrase never leaves this device and cannot be recovered — losing it means
              setting up again{isImport ? ' from your own backup of the key' : ''}.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => guard(async () => {
                  if (isImport) {
                    await gw.importSecret(secret, pass1);
                    setSecret(''); setPass1(''); setPass2('');
                    activateAndClose();
                  } else {
                    await gw.create(pass1);
                    setPass1(''); setPass2('');
                    setRevealKey(false); setBackupSaved(false);
                    setMode('backup');
                  }
                })}
                disabled={busy || !passphraseOk || (isImport && !secret.trim())}
                className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                data-testid="ibw-confirm"
              >
                {busy ? 'Encrypting…' : isImport ? 'Encrypt and import' : 'Create the wallet'}
              </button>
              <button
                onClick={() => { setMode('menu'); setError(null); }}
                disabled={busy}
                className="py-2 px-4 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-sm rounded transition-colors"
              >
                Back
              </button>
            </div>
          </>
        );
      }

      case 'backup':
        return (
          <>
            <p className="text-xs text-gray-500">
              Back up this key. Browsers can clear site storage, and your passphrase cannot bring
              back a cleared keystore — this backup can. Keep it somewhere safe and offline.
            </p>
            <div className="text-xs text-gray-500 font-mono break-all bg-gray-100 dark:bg-gray-700 rounded px-3 py-2" data-testid="ibw-key">
              {revealKey ? (gw.privateKey ?? '') : '•'.repeat(66)}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setRevealKey((r) => !r)}
                className="flex-1 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-sm rounded transition-colors"
                data-testid="ibw-reveal"
              >
                {revealKey ? 'Hide key' : 'Reveal key'}
              </button>
              <button
                onClick={() => { if (gw.privateKey) navigator.clipboard?.writeText(gw.privateKey).catch(() => {}); }}
                className="flex-1 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-sm rounded transition-colors"
              >
                Copy key
              </button>
            </div>
            <label className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300">
              <input
                type="checkbox"
                checked={backupSaved}
                onChange={(e) => setBackupSaved(e.target.checked)}
                className="mt-0.5"
                data-testid="ibw-backup-saved"
              />
              I saved a backup (or accept losing this wallet if the browser's storage is cleared).
            </label>
            <button
              onClick={activateAndClose}
              disabled={!backupSaved}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
              data-testid="ibw-backup-continue"
            >
              Use this wallet
            </button>
          </>
        );

      case 'unlock':
        return (
          <>
            <p className="text-xs text-gray-500">
              This browser already holds a wallet ({gw.address}). Enter its passphrase to unlock and use it.
            </p>
            <input
              type="password"
              value={pass1}
              onChange={(e) => setPass1(e.target.value)}
              placeholder="Passphrase"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
              data-testid="ibw-unlock-pass"
              onKeyDown={(e) => { if (e.key === 'Enter' && pass1 && !busy) guard(async () => { await gw.unlock(pass1); setPass1(''); activateAndClose(); }); }}
            />
            <button
              onClick={() => guard(async () => { await gw.unlock(pass1); setPass1(''); activateAndClose(); })}
              disabled={busy || !pass1}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
              data-testid="ibw-unlock"
            >
              {busy ? 'Unlocking…' : 'Unlock and use'}
            </button>
          </>
        );

      case 'ready':
        return (
          <>
            <p className="text-xs text-gray-500">
              This browser's wallet ({gw.address}) is unlocked. Use it as your acting wallet?
            </p>
            <button
              onClick={activateAndClose}
              className="w-full py-2 bg-blue-600 hover:bg-blue-700 !text-white text-sm font-medium rounded transition-colors"
              data-testid="ibw-use"
            >
              Use this wallet
            </button>
          </>
        );
    }
  })();

  const title = mode === 'import' ? 'Import an in-browser wallet'
    : mode === 'unlock' ? 'Unlock in-browser wallet'
    : mode === 'backup' ? 'Back up your key'
    : 'In-browser wallet';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="ibw-modal"
    >
      <div className="w-full max-w-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <div className="font-medium flex items-center gap-1.5"><InstantMark /> {title}</div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-lg leading-none" aria-label="Close">×</button>
        </div>
        <div className="px-4 py-4 space-y-3">
          {body}
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg text-xs text-red-800 dark:text-red-300" data-testid="ibw-error">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
