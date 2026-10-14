import React, { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { explainError } from '../utils/errors';
import { InfoTip } from './InfoTip';
import { afterTx } from '../lib/afterTx';
import { MIN_PASSPHRASE_LENGTH } from '../lib/gameWallet';
import { getChainConfig } from '../contracts/addresses';
import { WalletMark, InstantMark } from './WalletMark';

const ZERO = '0x0000000000000000000000000000000000000000';
/// Intrinsic cost of a value transfer to an EOA. Fixed by the EVM, so the
/// funding step pins it instead of asking the wallet to estimate.
const TRANSFER_GAS = BigInt(21000);

function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/// On-chain facts the setup checklist derives its steps from. Loaded fresh
/// after every action, so the wizard is resumable: whatever is already done —
/// this visit or a previous one — simply shows as done.
interface SetupState {
  gasWei: bigint;
  /// The MAIN wallet's native balance, read on the resilient read provider.
  /// Shown next to the funding control and preflighted before sending, because
  /// "main wallet is empty on this chain" is the overwhelmingly likely reason a
  /// funding transfer fails and it deserves to be said outright.
  mainGasWei: bigint;
  restrictedTo: string;      // hub.allowedDelegator(gameWallet)
  feeBps: number;            // effectivePredictorFee(gameWallet)
  feeCommitted: boolean;     // predictorFeeStored != 0 (set-once spent)
  mainDelegate: string;      // rewards.predictionDelegateInfo(main).delegate
}

/// The instant-signing card — the promoted way to play.
///
/// DEFAULT FLOW (delegation): generate a fresh key, encrypt it locally, fund it
/// with gas dust, then wire it as the user's DELEGATE: the game wallet
/// restricts inbound delegation to the user's main address, commits its
/// predictor fee to 0% (so every reward flows to the main wallet's side), and
/// the main wallet signs one delegation. From then on the game wallet predicts
/// with the user's full power and their SATORI never leaves their main wallet.
///
/// The import-an-existing-key path exists but is deliberately UNDER-sold — a
/// funded key in browser storage is a much bigger prize than a delegate key
/// that guards gas dust.
export function GameWalletPanel() {
  const { contracts } = useContracts();
  const wallet = useWallet();
  const gw = wallet.gameWallet;

  type Mode = 'idle' | 'create' | 'backup' | 'import';
  const [mode, setMode] = useState<Mode>('idle');

  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [secret, setSecret] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  const [backupSaved, setBackupSaved] = useState(false);
  const [revealKey, setRevealKey] = useState(false);
  const [fundAmount, setFundAmount] = useState('0.001');

  const [setup, setSetup] = useState<SetupState | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mainAddress = wallet.mainAddress;
  /// What to CALL the user's own wallet. Everything below says "MetaMask" (or
  /// whatever they actually run) instead of "main wallet", which described the
  /// app's plumbing rather than anything the user recognises.
  const walletName = wallet.externalWallet.name;

  /// One snapshot of everything the checklist derives from.
  ///
  /// Reads go through `contracts.reads.*` — the twins bound to the RESILIENT
  /// provider — never `contracts.*`, which is signer-bound and therefore reads
  /// through the wallet's own RPC, losing dedupe, retry and failover exactly
  /// when it matters (docs/issues/closed/dapp-reads-bypass-resilient-provider.md).
  const read = useCallback(async (): Promise<SetupState | null> => {
    if (!contracts || !gw.address) return null;
    const r = contracts.reads;
    const [gasWei, mainGasWei, restrictedTo, feeBps, feeStored, delInfo] = await Promise.all([
      wallet.provider.getBalance(gw.address),
      mainAddress ? wallet.provider.getBalance(mainAddress) : Promise.resolve(BigInt(0)),
      r.hub.allowedDelegator(gw.address),
      r.rewards.effectivePredictorFee(gw.address),
      r.rewards.predictorFeeStored(gw.address),
      mainAddress ? r.rewards.predictionDelegateInfo(mainAddress) : Promise.resolve({ delegate: ZERO }),
    ]);
    return {
      gasWei,
      mainGasWei,
      restrictedTo,
      feeBps: Number(feeBps),
      feeCommitted: Number(feeStored) !== 0,
      mainDelegate: delInfo.delegate,
    };
  }, [contracts, gw.address, mainAddress, wallet.provider]);

  const load = useCallback(async () => {
    try {
      const s = await read();
      setSetup(s);
    } catch (e) {
      console.error('Game wallet state load failed:', e);
    }
  }, [read]);

  useEffect(() => { load(); }, [load]);

  /// Re-read until the chain AGREES that the write landed, or time out.
  ///
  /// A receipt is not a read barrier. On a public RPC the very next read can be
  /// answered by a node that has not applied the block yet, so a single read
  /// after a confirmed transaction can legitimately return the OLD value — the
  /// same read-after-write lag `scripts/live-reads-lib.js` exists for on the
  /// deploy side. Without this the checklist showed a completed step as still
  /// pending, and clicking again re-sent a one-shot call that then failed
  /// `AlreadySet` — telling the user it was already done while the UI insisted
  /// it was not. Locally this never appears: one hardhat node, instant finality.
  const settleUntil = useCallback(async (
    want: (s: SetupState) => boolean,
    timeoutMs = 25_000,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let s: SetupState | null = null;
      try { s = await read(); } catch { /* transient RPC — try again below */ }
      if (s) {
        setSetup(s);
        if (want(s)) return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }, [read]);

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setActing(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (e: any) {
      // A send that never reached the mempool leaves the locally-tracked nonce
      // one ahead of chain, which would make every later send fail too.
      gw.resetNonces();
      setError(explainError(e));
    } finally {
      setActing(null);
    }
  }, [load, gw]);

  /// What a sweep would actually move, read LIVE. Deliberately not taken from
  /// the panel's `setup` snapshot: the removal dialog can open moments after a
  /// remount, and offering to rescue a balance is a decision that must not turn
  /// on whether a background read had finished yet.
  const sweepableNow = useCallback(async (): Promise<bigint> => {
    const to = wallet.lastExternalAddress;
    if (!gw.address || !to) return BigInt(0);
    try {
      const [bal, fee] = await Promise.all([
        wallet.provider.getBalance(gw.address),
        wallet.provider.getFeeData(),
      ]);
      const price = fee.maxFeePerGas ?? fee.gasPrice ?? BigInt(0);
      const cost = price * TRANSFER_GAS;
      return bal > cost ? bal - cost : BigInt(0);
    } catch {
      return BigInt(0);
    }
  }, [gw.address, wallet.lastExternalAddress, wallet.provider]);

  /// Empty the game wallet into the user's own wallet. Signed by the game
  /// wallet itself, so it costs no approval. Leaves exactly the fee for its own
  /// transfer behind, which is unavoidable and dust.
  const sweepNow = useCallback(async (amount: bigint) => {
    const to = wallet.lastExternalAddress;
    if (!gw.signer || !to || amount <= BigInt(0)) return;
    await afterTx(await gw.signer.sendTransaction({
      to, value: amount, gasLimit: TRANSFER_GAS,
    }));
  }, [gw.signer, wallet.lastExternalAddress]);

  /// Undelegate on chain, signed by the user's own wallet. Shared by the
  /// explicit "turn off" button and by key removal, which must undelegate too.
  const undelegateNow = useCallback(async () => {
    if (!contracts || !wallet.mainSigner) return;
    await afterTx(await (contracts.hub.connect(wallet.mainSigner) as any)
      .delegatePredictionPower(ZERO));
  }, [contracts, wallet.mainSigner]);

  // ---- derived flags -------------------------------------------------------
  const restricted = !!setup && !!mainAddress
    && setup.restrictedTo.toLowerCase() === mainAddress.toLowerCase();
  const feeZero = !!setup && setup.feeBps === 0;
  const delegated = !!setup && !!gw.address
    && setup.mainDelegate.toLowerCase() === gw.address.toLowerCase();
  const funded = !!setup && setup.gasWei > BigInt(0);
  const setupComplete = restricted && feeZero && delegated;
  const passphraseOk = pass1.length >= MIN_PASSPHRASE_LENGTH && pass1 === pass2;

  // ---- no wallet yet: the pitch + create/import entry ----------------------
  if (!gw.exists && mode === 'idle') {
    return (
      <div className="card-themed !p-0 overflow-hidden" data-testid="game-wallet-panel">
        <div className="px-3 py-3 space-y-2">
          <div className="font-medium flex items-center justify-between gap-1.5">
            <span className="flex items-center gap-1.5"><InstantMark /> Instant signing</span>
            <InfoTip>
              Satori keeps a signing key inside this app, encrypted with a passphrase you choose.
              You approve it once in {walletName}; after that Satori signs your predictions itself,
              so nothing pops up. Your SATORI never leaves {walletName} — the app's key holds only a
              little gas, so even in the worst case that gas is all it can lose.
            </InfoTip>
          </div>
          <p className="text-xs text-gray-500">
            Right now every prediction asks {walletName} to approve. Set this up once and Satori
            signs for you instantly instead. Your tokens stay in {walletName} the whole time.
          </p>
          <button
            onClick={() => { setPass1(''); setPass2(''); setMode('create'); }}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 !text-white text-sm font-medium rounded transition-colors flex items-center justify-center gap-1.5"
            data-testid="gw-start-setup"
          >
            <InstantMark /> Turn on instant signing
          </button>
          <button
            onClick={() => { setPass1(''); setPass2(''); setSecret(''); setMode('import'); }}
            className="block w-full text-center text-[11px] text-gray-400 hover:text-gray-500 underline"
            data-testid="gw-import-link"
          >
            Advanced: import an existing private key instead
          </button>
        </div>
      </div>
    );
  }

  // ---- create / import forms ----------------------------------------------
  if (!gw.exists && (mode === 'create' || mode === 'import')) {
    const isImport = mode === 'import';
    return (
      <div className="card-themed !p-0 overflow-hidden" data-testid="game-wallet-panel">
        <div className="px-3 py-3 space-y-2">
          <div className="font-medium">{isImport ? 'Import a key for instant signing' : 'Turn on instant signing'}</div>
          {isImport && (
            <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-800 dark:text-amber-300">
              <strong>Not the suggested path.</strong> An imported key signs from THIS browser, so
              anything it holds is only as safe as this device and page. The normal setup instead
              creates a fresh key that guards nothing but gas, while your funds stay in {walletName}.
              Import only if you understand and accept that difference.
            </div>
          )}
          <p className="text-xs text-gray-500">
            {isImport
              ? 'The key is encrypted with your passphrase before it touches storage. Only the encrypted copy is saved.'
              : 'A fresh key is generated and encrypted with your passphrase. Only the encrypted copy is saved on this device.'}
          </p>
          {isImport && (
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Private key (0x…) or recovery phrase"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
              data-testid="gw-import-secret"
            />
          )}
          <input
            type="password"
            value={pass1}
            onChange={(e) => setPass1(e.target.value)}
            placeholder={`Passphrase (min ${MIN_PASSPHRASE_LENGTH} characters)`}
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
            data-testid="gw-pass-1"
          />
          <input
            type="password"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
            placeholder="Repeat passphrase"
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
            data-testid="gw-pass-2"
          />
          {pass2.length > 0 && pass1 !== pass2 && (
            <p className="text-xs text-red-700 dark:text-red-400">Passphrases do not match.</p>
          )}
          <p className="text-[11px] text-gray-500">
            The passphrase never leaves this device and cannot be recovered — losing it means
            setting the game wallet up again{isImport ? ' from your own backup of the key' : ''}.
          </p>
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>}
          <div className="flex gap-2">
            <button
              onClick={() => run(isImport ? 'import' : 'create', async () => {
                if (isImport) await gw.importSecret(secret, pass1);
                else await gw.create(pass1);
                setSecret('');
                setPass1('');
                setPass2('');
                setBackupSaved(false);
                setRevealKey(false);
                if (isImport) {
                  // An imported key IS the funds wallet — no delegation steps.
                  gw.setPreferred(true);
                  setMode('idle');
                } else {
                  setMode('backup');
                }
              })}
              disabled={acting !== null || !passphraseOk || (isImport && !secret.trim())}
              className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
              data-testid="gw-create-confirm"
            >
              {acting !== null ? 'Encrypting…' : isImport ? 'Encrypt and import' : 'Create the key'}
            </button>
            <button
              onClick={() => { setMode('idle'); setError(null); }}
              disabled={acting !== null}
              className="py-2 px-4 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-sm rounded transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- backup step (fresh generated key only) ------------------------------
  if (gw.exists && mode === 'backup' && gw.privateKey) {
    return (
      <div className="card-themed !p-0 overflow-hidden" data-testid="game-wallet-panel">
        <div className="px-3 py-3 space-y-2">
          <div className="font-medium">Back up Satori's signing key</div>
          <p className="text-xs text-gray-500">
            Browsers can clear site storage (Safari does after long disuse). Your passphrase cannot
            bring back a cleared keystore — this backup can. Keep it somewhere safe, offline.
          </p>
          <div className="text-xs text-gray-500 font-mono break-all bg-gray-100 dark:bg-gray-700 rounded px-3 py-2">
            {revealKey ? gw.privateKey : '•'.repeat(66)}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setRevealKey((r) => !r)}
              className="flex-1 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-sm rounded transition-colors"
              data-testid="gw-reveal-key"
            >
              {revealKey ? 'Hide key' : 'Reveal key'}
            </button>
            <button
              onClick={() => { navigator.clipboard?.writeText(gw.privateKey!).catch(() => {}); }}
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
              data-testid="gw-backup-saved"
            />
            I saved a backup of this key (or accept losing the game wallet if this browser's storage is cleared).
          </label>
          <button
            onClick={() => setMode('idle')}
            disabled={!backupSaved}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
            data-testid="gw-backup-continue"
          >
            Continue to setup
          </button>
        </div>
      </div>
    );
  }

  // ---- exists but locked ---------------------------------------------------
  if (gw.exists && !gw.unlocked) {
    return (
      <div className="card-themed !p-0 overflow-hidden" data-testid="game-wallet-panel">
        <div className="px-3 py-3 space-y-2">
          <div className="font-medium flex items-center justify-between gap-1.5">
            <span className="flex items-center gap-1.5"><InstantMark /> Instant signing <span className="text-xs text-gray-500 font-normal">(locked)</span></span>
            <span className="text-xs text-gray-500 font-mono">{gw.address ? shortAddress(gw.address) : ''}</span>
          </div>
          <p className="text-xs text-gray-500">
            Enter your passphrase to sign instantly again on this device. Until you do,
            {' '}{walletName} will be asked to approve each action.
          </p>
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!unlockPass) return;
              run('unlock', async () => { await gw.unlock(unlockPass); setUnlockPass(''); });
            }}
            className="flex gap-2"
          >
            <input
              type="password"
              value={unlockPass}
              onChange={(e) => setUnlockPass(e.target.value)}
              placeholder="Passphrase"
              className="flex-1 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
              disabled={acting !== null}
              data-testid="gw-unlock-pass"
            />
            <button
              type="submit"
              disabled={acting !== null || !unlockPass}
              className="py-2 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
              data-testid="gw-unlock"
            >
              {acting === 'unlock' ? 'Unlocking…' : 'Unlock'}
            </button>
          </form>
          {gw.address && <KeyRow address={gw.address} privateKey={null} walletName={walletName} />}
          <ForgetRow key="gw-forget-row" gw={gw} delegated={delegated} run={run} acting={acting}
            undelegate={undelegateNow} sweep={sweepNow} sweepable={sweepableNow}
            sweepTo={wallet.lastExternalAddress} walletName={walletName}
/>
        </div>
      </div>
    );
  }

  // ---- exists + unlocked: setup checklist, or the live status card ---------
  if (!gw.exists || !gw.signer || !gw.address) return null;
  const gwSigner = gw.signer;
  const gwAddress = gw.address;

  const needsSetup = gw.kind === 'generated' && !setupComplete;

  return (
    <div className="card-themed !p-0 overflow-hidden" data-testid="game-wallet-panel">
      <div className="px-3 py-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="font-medium flex items-center gap-1.5">
            <InstantMark />
            <span>Instant signing</span>
            {gw.active && (
              <span className="text-[11px] text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 px-2 py-0.5 rounded" data-testid="gw-active-badge">
                on
              </span>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-500">
          Satori's key {shortAddress(gwAddress)} · gas{' '}
          <strong>{setup ? parseFloat(ethers.formatEther(setup.gasWei)).toFixed(5) : '…'} ETH</strong>
          {gw.kind === 'imported' && <span> · imported key</span>}
        </div>

        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800">{error}</div>}
        {notice && <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-800">{notice}</div>}

        {needsSetup && (
          <div className="space-y-1.5" data-testid="gw-setup-checklist">
            <p className="text-xs text-gray-500">
              Three one-time steps. Your SATORI stays in {walletName} throughout (it locks there
              while instant signing is on — you can turn it off any time).
            </p>
            {!mainAddress && (
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg text-xs text-amber-800 dark:text-amber-300">
                Connect your main wallet to continue setup.
              </div>
            )}

            <SetupStep
              done={funded}
              label="Fund gas"
              detail={`A little ETH pays for the game wallet's transactions. Pennies cover months.${
                setup ? ` Your main wallet has ${parseFloat(ethers.formatEther(setup.mainGasWei)).toFixed(5)} ETH.` : ''
              }`}
              action={
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={fundAmount}
                    onChange={(e) => setFundAmount(e.target.value)}
                    className="w-24 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 text-sm text-right"
                    aria-label="Gas amount in ETH"
                  />
                  <button
                    onClick={() => run('fund', async () => {
                      const value = ethers.parseEther(fundAmount);
                      // Preflight on the RESILIENT READ provider, not the wallet
                      // relay. An empty main wallet is the likeliest reason this
                      // step fails, and saying so beats any generic rejection.
                      const bal = await wallet.provider.getBalance(mainAddress!);
                      const fee = await wallet.provider.getFeeData();
                      const gasCost = (fee.maxFeePerGas ?? fee.gasPrice ?? BigInt(0)) * TRANSFER_GAS;
                      if (bal < value + gasCost) {
                        throw new Error(
                          `Your main wallet holds ${ethers.formatEther(bal)} ETH on ` +
                          `${getChainConfig(wallet.chainId).chainName}, which will not cover ` +
                          `${fundAmount} ETH plus about ${ethers.formatEther(gasCost)} of gas. ` +
                          `Top it up${wallet.chainId === 84532 ? ' from a Base Sepolia faucet' : ''} and retry.`
                        );
                      }
                      // A plain transfer to an EOA is ALWAYS 21000 gas, so pin it
                      // and skip eth_estimateGas entirely. The wallet relay
                      // answers that call with null often enough that the app has
                      // a dedicated explainer for it — and here that explainer is
                      // actively wrong, since it blames capabilities and cadence
                      // windows that a value transfer never touches.
                      const tx = await wallet.mainSigner!.sendTransaction({
                        to: gwAddress, value, gasLimit: TRANSFER_GAS,
                      });
                      await afterTx(tx);
                      const ok = await settleUntil((s) => s.gasWei > BigInt(0));
                      setNotice(ok
                        ? 'Funded. The game wallet now holds gas and can sign for itself.'
                        : 'Sent. The network has not caught up yet — this step will tick over shortly.');
                    })}
                    disabled={acting !== null || !wallet.mainSigner}
                    className="flex-1 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                    data-testid="gw-fund"
                  >
                    {acting === 'fund' ? 'Sending…' : 'Send from main wallet'}
                  </button>
                </div>
              }
            />

            <SetupStep
              done={restricted && feeZero}
              label="Lock the key to you"
              detail={`Two transactions Satori signs for itself — no approvals. They make sure only ${walletName} can use this key, and that it keeps none of your rewards.`}
              blocked={!funded ? 'Needs gas first' : undefined}
              action={
                <button
                  onClick={() => run('configure', async () => {
                    if (!restricted) {
                      await afterTx(await (contracts!.hub.connect(gwSigner) as any).setAllowedDelegator(mainAddress));
                    }
                    // setPredictorFee is SET-ONCE on chain. Re-sending it after a
                    // stale read is what produced "already been configured" on a
                    // step the UI still showed as pending, so the guard is the
                    // committed flag, and the barrier below keeps that flag fresh.
                    if (!feeZero && !setup?.feeCommitted) {
                      await afterTx(await (contracts!.rewards.connect(gwSigner) as any).setPredictorFee(0));
                    }
                    const ok = await settleUntil((s) =>
                      !!mainAddress && s.restrictedTo.toLowerCase() === mainAddress.toLowerCase() && s.feeBps === 0);
                    setNotice(ok
                      ? 'Configured. Only your main wallet can delegate to this key, and its predictor fee is locked at 0%.'
                      : 'Sent. The network has not caught up yet — this step will tick over shortly.');
                  })}
                  disabled={acting !== null || !funded || !mainAddress}
                  className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                  data-testid="gw-configure"
                >
                  {acting === 'configure' ? 'Configuring…' : 'Configure (no popups)'}
                </button>
              }
            />
            {setup?.feeCommitted && !feeZero && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                This key's predictor fee is already committed to {setup.feeBps / 100}% and cannot be
                changed — it will keep that cut of delegated wins. A fresh game wallet avoids this.
              </p>
            )}

            <SetupStep
              done={delegated}
              label={`Approve once in ${walletName}`}
              detail={`The only approval you have to sign. It lets Satori predict with your SATORI's weight while the tokens stay in ${walletName} — they lock there until you turn instant signing off, which frees them the next round.`}
              blocked={!(restricted && feeZero) ? 'Configure first' : undefined}
              action={
                <button
                  onClick={() => run('delegate', async () => {
                    await afterTx(await (contracts!.hub.connect(wallet.mainSigner!) as any)
                      .delegatePredictionPower(gwAddress));
                    const ok = await settleUntil((s) =>
                      s.mainDelegate.toLowerCase() === gwAddress.toLowerCase());
                    // Finishing setup IS the decision to play this way — asking
                    // again with a "start playing" button was a confirmation of
                    // something the user had already said three steps running.
                    if (ok) gw.setPreferred(true);
                    setNotice(ok
                      ? 'Done. The game wallet is now acting for you — predict with no popups.'
                      : 'Sent. The network has not caught up yet — this step will tick over shortly.');
                  })}
                  disabled={acting !== null || !wallet.mainSigner || !(restricted && feeZero)}
                  className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                  data-testid="gw-delegate"
                >
                  {acting === 'delegate' ? 'Waiting for wallet…' : 'Delegate (1 signature)'}
                </button>
              }
            />
          </div>
        )}

        {/* WHO SIGNS — the only question a user actually has here, asked in
            those terms. The old row offered "Switch to main wallet" next to
            "Lock" and "Stop delegating", three verbs for three different
            concepts with nothing saying what the current state even was. This
            is one choice with two sides, the live one visibly selected. */}
        {(setupComplete || gw.kind === 'imported') && (
          <div className="space-y-1.5">
            <div className="text-xs text-gray-500">Signing</div>
            <div className="grid grid-cols-2 gap-2">
              <ModeButton
                selected={gw.active}
                onClick={() => { gw.setPreferred(true); setNotice(null); }}
                testid="gw-mode-instant"
                icon={<InstantMark size={18} />}
                title="Instant"
                subtitle="Satori signs for you"
              />
              <ModeButton
                selected={!gw.active}
                onClick={() => { gw.setPreferred(false); setNotice(null); }}
                testid="gw-mode-external"
                icon={<WalletMark wallet={wallet.externalWallet} size={18} />}
                title={walletName}
                subtitle="Approve every action"
              />
            </div>
            <p className="text-[11px] text-gray-500" data-testid="gw-mode-explainer">
              {gw.active
                ? `Predictions are signed here and nothing pops up. Switch to ${walletName} any time — your setup is kept either way.`
                : `Every action will ask ${walletName} to approve. Choose Instant to stop that.`}
            </p>
          </div>
        )}

        {(gw.active || setupComplete || gw.kind === 'imported') && (
          <div className="flex flex-wrap gap-2 text-sm pt-1">
            {gw.unlocked && (
              <button
                onClick={() => gw.lock()}
                className="flex-1 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded transition-colors"
                title="Forget the passphrase until you enter it again"
                data-testid="gw-lock"
              >
                Lock
              </button>
            )}
            {delegated && (
              <button
                onClick={() => run('undelegate', undelegateNow)}
                disabled={acting !== null || !wallet.mainSigner}
                className="flex-1 py-1.5 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 rounded transition-colors disabled:opacity-50"
                title="Unlock your SATORI and end instant signing entirely"
                data-testid="gw-undelegate"
              >
                {acting === 'undelegate' ? '…' : 'Turn off & unlock SATORI'}
              </button>
            )}
          </div>
        )}

        {setupComplete && (
          <p className="text-[11px] text-gray-500">
            Your rewards go to {walletName} ({mainAddress ? shortAddress(mainAddress) : '…'}), not
            to Satori's key — claiming works the same as it always did.
          </p>
        )}

        <KeyRow address={gwAddress} privateKey={gw.privateKey} walletName={walletName} />

        <ForgetRow key="gw-forget-row" gw={gw} delegated={delegated} run={run} acting={acting}
          undelegate={undelegateNow} sweep={sweepNow} sweepable={sweepableNow}
          sweepTo={wallet.lastExternalAddress} walletName={walletName}
/>
      </div>
    </div>
  );
}

/// One side of the signing choice. Selected state is carried by border + tint
/// AND a check, so it does not depend on colour alone.
function ModeButton({ selected, onClick, testid, icon, title, subtitle }: {
  selected: boolean;
  onClick: () => void;
  testid: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      data-testid={testid}
      className={`text-left rounded-lg border px-3 py-2 transition-colors ${selected
        ? 'border-green-400 dark:border-green-700 bg-green-50 dark:bg-green-900/20'
        : 'border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/40'}`}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium">
        {icon}
        <span className="truncate">{title}</span>
        {selected && <span className="ml-auto text-green-600 dark:text-green-400">✓</span>}
      </div>
      <div className="text-[11px] text-gray-500 mt-0.5">{subtitle}</div>
    </button>
  );
}

function SetupStep({ done, label, detail, blocked, action }: {
  done: boolean;
  label: string;
  detail: string;
  blocked?: string;
  action: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border px-3 py-2 space-y-1.5 ${done
      ? 'border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-900/10'
      : 'border-gray-200 dark:border-gray-700'}`}
    >
      <div className="flex items-center gap-1.5 text-sm">
        <span className={done ? 'text-green-600' : 'text-gray-400'}>{done ? '✓' : '○'}</span>
        <span className="font-medium">{label}</span>
        {blocked && !done && <span className="text-[11px] text-gray-400 ml-auto">{blocked}</span>}
      </div>
      <p className="text-[11px] text-gray-500">{detail}</p>
      {!done && action}
    </div>
  );
}

/// Address + key, for a wallet that already exists.
///
/// WHY THIS EXISTS. The backup screen that reveals the key is reachable exactly
/// ONCE — `setMode('backup')` fires only on the tap that generates a key, and
/// every path out of it lands on `idle`, which nothing returns from. After that
/// the panel showed a TRUNCATED address and no key at all, so a user who wanted
/// either had no route to them: not to fund the address from elsewhere, not to
/// import the key into another browser, not to back it up late. Owner hit this
/// on 2026-08-28 ("I can't find my address anywhere").
///
/// It sits directly above the remove control because that is the other thing
/// you come here to do, and because the honest order is "take your key, THEN
/// delete it" — deleting without the backup is the one irreversible action in
/// this panel.
function KeyRow({ address, privateKey, walletName }: {
  address: string;
  /// Null while the keystore is locked — the key genuinely is not in memory
  /// then, so the row offers the address alone rather than a dead button.
  privateKey: string | null;
  walletName: string;
}) {
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<'address' | 'key' | null>(null);

  const copy = (what: 'address' | 'key', text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 space-y-2" data-testid="gw-key-row">
      <div className="space-y-1">
        <div className="text-[11px] text-gray-500">Satori&apos;s key address — fund it or look it up here</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-[11px] font-mono break-all bg-gray-100 dark:bg-gray-700 rounded px-2 py-1.5" data-testid="gw-full-address">
            {address}
          </code>
          <button
            onClick={() => copy('address', address)}
            className="text-xs px-2 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded transition-colors whitespace-nowrap"
            data-testid="gw-copy-address"
          >
            {copied === 'address' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-[11px] text-gray-500">Private key</div>
        {privateKey ? (
          <>
            <code
              className="block text-[11px] font-mono break-all bg-gray-100 dark:bg-gray-700 rounded px-2 py-1.5"
              data-testid="gw-key-value"
            >
              {reveal ? privateKey : '\u2022'.repeat(66)}
            </code>
            <div className="flex gap-2">
              <button
                onClick={() => setReveal((r) => !r)}
                className="flex-1 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded transition-colors"
                data-testid="gw-toggle-key"
              >
                {reveal ? 'Hide key' : 'Reveal key'}
              </button>
              <button
                onClick={() => copy('key', privateKey)}
                className="flex-1 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded transition-colors"
                data-testid="gw-copy-key"
              >
                {copied === 'key' ? 'Copied' : 'Copy key'}
              </button>
            </div>
            {/* Blast radius, stated accurately rather than as a generic scare:
                SATORI and rewards live in the main wallet, so this key buys
                predictions and gas, not funds. */}
            <p className="text-[11px] text-gray-500">
              Anyone with this key can predict as you and spend its gas. Your SATORI and your
              rewards stay in {walletName} — this key cannot touch them.
            </p>
          </>
        ) : (
          <p className="text-[11px] text-gray-500" data-testid="gw-key-locked">
            Unlock instant signing to reveal the key.
          </p>
        )}
      </div>
    </div>
  );
}

/// The remove control, shared by the locked and unlocked views.
///
/// Deleting the keystore is the one IRREVERSIBLE action in this panel: without
/// the user's own backup, the key is gone and any SATORI still delegated to it
/// is parked behind an address nobody holds. So it is styled like the other
/// destructive control (a red button, not a grey link that reads as a footnote)
/// and gated on the PASSPHRASE — a second tap only proves the first was not an
/// accident, while typing the passphrase proves the person at the keyboard is
/// the owner. It is verified by actually decrypting the keystore, so a wrong
/// one cannot get through.
function ForgetRow({ gw, delegated, run, acting, undelegate, sweep, sweepable, sweepTo, walletName }: {
  gw: ReturnType<typeof useWallet>['gameWallet'];
  delegated: boolean;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  acting: string | null;
  /// Undelegates on chain. Deleting a key that still has power delegated to it
  /// would strand that power behind an address nobody holds, so removal does
  /// both — this is not an optional extra step for the user to remember.
  undelegate: () => Promise<unknown>;
  /// Empties the key's remaining gas into the user's own wallet.
  sweep: (amount: bigint) => Promise<unknown>;
  /// Live "how much would a sweep move" probe.
  sweepable: () => Promise<bigint>;
  sweepTo: string | null;
  walletName: string;
}) {
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState('');
  const [doSweep, setDoSweep] = useState(true);
  const [sweepWei, setSweepWei] = useState<bigint>(BigInt(0));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const close = () => { setOpen(false); setPass(''); setErr(null); };

  /// ONE dialog, ONE confirm — deliberately, not a wizard.
  ///
  /// An earlier version asked for the passphrase and THEN offered to sweep in a
  /// second dialog. That could not work: verifying the passphrase means
  /// unlocking the key, unlocking changes the wallet context, and this whole tab
  /// remounts on a wallet-context change — so the second dialog was destroyed
  /// before it could be answered, leaving the key un-swept and un-deleted with
  /// nothing on screen explaining why. Collecting every decision BEFORE the one
  /// state-changing step means nothing has to survive that remount.
  const openDialog = async () => {
    setErr(null);
    setPass('');
    const amount = sweepTo ? await sweepable() : BigInt(0);
    setSweepWei(amount);
    setDoSweep(amount > BigInt(0));
    setOpen(true);
  };

  const confirm = async () => {
    if (!pass || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // Proof of ownership: only the real passphrase decrypts the keystore.
      // Also leaves the key unlocked, which the sweep needs in order to sign.
      await gw.unlock(pass);
    } catch (e: any) {
      setErr(explainError(e));
      setBusy(false);
      return;
    }
    const withSweep = doSweep && sweepWei > BigInt(0);
    setBusy(false);
    close();
    await run('forget', async () => {
      // Order matters. Undelegate first, while the key still exists, or the
      // power is parked behind an address the user can no longer act as. Sweep
      // last, because it spends the very gas the key needs to sign anything.
      if (delegated) await undelegate();
      if (withSweep) await sweep(sweepWei);
      gw.forget();
    });
  };

  return (
    <>
      <button
        onClick={openDialog}
        disabled={acting !== null}
        className="w-full py-1.5 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800 rounded text-sm transition-colors disabled:opacity-50"
        data-testid="gw-forget-start"
      >
        Turn off and remove the key
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog" aria-modal="true"
          aria-label="Confirm removing the key"
          data-testid="gw-forget-modal"
        >
          <div className="card-themed w-full max-w-sm p-4 space-y-3">
            <div className="font-medium text-red-700 dark:text-red-400">This cannot be undone</div>
            <p className="text-xs text-gray-600 dark:text-gray-300">
              Removing the key deletes it from this device. Unless you kept the backup, it is gone
              for good and instant signing has to be set up again from scratch.
            </p>
            {delegated && (
              <>
                <p className="text-xs text-gray-600 dark:text-gray-300">
                  This also <strong>undelegates your prediction power</strong> so it is not left
                  behind a key you no longer hold — which means{' '}
                  <strong>you will not be able to predict for about a day</strong> while your
                  SATORI unlocks.
                </p>
                <p className="text-xs text-gray-500">
                  You do not have to delete anything just to stop using instant signing. &ldquo;Turn
                  off &amp; unlock SATORI&rdquo; undelegates and leaves the key in place, so you can
                  go back to predicting with {walletName} and switch back later.
                </p>
              </>
            )}

            {sweepWei > BigInt(0) && (
              <label
                className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700/50 rounded p-2"
                data-testid="gw-sweep-choice"
              >
                <input
                  type="checkbox"
                  checked={doSweep}
                  onChange={(e) => setDoSweep(e.target.checked)}
                  className="mt-0.5"
                  data-testid="gw-sweep-toggle"
                />
                <span>
                  Send the leftover{' '}
                  <strong>{parseFloat(ethers.formatEther(sweepWei)).toFixed(5)} ETH</strong> back to{' '}
                  {walletName} ({sweepTo ? shortAddress(sweepTo) : '—'}) first. Deleting without
                  this puts it out of reach.
                </span>
              </label>
            )}

            <p className="text-xs text-gray-600 dark:text-gray-300">
              Enter your passphrase to confirm.
            </p>
            {err && (
              <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800" data-testid="gw-forget-error">
                {err}
              </div>
            )}
            <form onSubmit={(e) => { e.preventDefault(); confirm(); }} className="space-y-2">
              <input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                placeholder="Passphrase"
                autoFocus
                className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
                disabled={busy}
                data-testid="gw-forget-pass"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={busy || !pass}
                  className="flex-1 py-1.5 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
                  data-testid="gw-forget-confirm"
                >
                  {busy ? 'Checking…' : 'Remove it'}
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="flex-1 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-sm rounded transition-colors"
                >
                  Keep it
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
