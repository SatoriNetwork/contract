import React, { useState, useEffect, useMemo, useCallback, useRef, useContext, createContext } from 'react';
import { ethers } from 'ethers';
import { createResilientProvider } from '../utils/rpcProvider';
import {
  getRpcUrls,
  DEFAULT_CHAIN_ID,
  getChainConfig,
  WALLETCONNECT_PROJECT_ID,
} from '../contracts/addresses';
import {
  getGameWalletMeta,
  createGameWallet as gwCreate,
  importGameWallet as gwImport,
  unlockGameWallet as gwUnlock,
  deleteGameWallet as gwDelete,
  GameWalletKind,
} from '../lib/gameWallet';

// Hardhat's deterministic dev accounts, DERIVED rather than pasted.
//
// This used to be four hardcoded private keys, which meant the switcher could
// only ever reach signers 0-3. The seeder casts fourteen — eight predictors and
// six delegators — so most of a seeded chain, including every delegator and
// therefore everything about loyalty, was unreachable from the UI entirely.
//
// Derived from the standard Hardhat mnemonic so the list cannot drift from the
// node's accounts, and so adding an actor to the seed needs no change here.
const HARDHAT_MNEMONIC =
  'test test test test test test test test test test test junk';
const DEV_ACCOUNT_COUNT = 20; // hardhat's default

export interface DevAccount {
  name: string;
  key: string;
  address: string;
  /// Role from the seeder's cast, when one has been published. Purely a label.
  role?: string;
}

function deriveDevAccounts(): DevAccount[] {
  try {
    // ethers v6: derive the account node once, then index into it.
    const root = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0");
    return Array.from({ length: DEV_ACCOUNT_COUNT }, (_, i) => {
      const w = root.deriveChild(i);
      return {
        name: i === 0 ? 'Owner' : `Account ${i}`,
        key: w.privateKey,
        address: w.address,
      };
    });
  } catch {
    return [];
  }
}

const isDev = process.env.NODE_ENV === 'development';

const DEV_ACCOUNTS: DevAccount[] = isDev ? deriveDevAccounts() : [];

/// Names and roles for the seeded cast, published by
/// `scripts/seed-demo-activity.js` to `public/dev-cast.json`.
///
/// Read at runtime rather than hardcoded so the UI does not carry a copy of the
/// seeder's cast that silently rots the moment the seed changes. Absent file
/// (unseeded chain, or a plain deploy) simply leaves the "Account N" labels.
async function applyDevCast(accounts: DevAccount[]): Promise<DevAccount[]> {
  if (!isDev || accounts.length === 0) return accounts;
  try {
    const res = await fetch('/dev-cast.json', { cache: 'no-store' });
    if (!res.ok) return accounts;
    const cast: { index: number; name: string; role?: string }[] = await res.json();
    const next = accounts.map((a) => ({ ...a }));
    for (const c of cast) {
      if (c.index >= 0 && c.index < next.length) {
        next[c.index].name = c.name;
        next[c.index].role = c.role;
      }
    }
    return next;
  } catch {
    return accounts;
  }
}

/// Phone or tablet. Used only to choose a fallback when there is no injected
/// provider and no WalletConnect — never to gate functionality, so a wrong guess
/// costs a less helpful error message and nothing else. User-agent sniffing is
/// unreliable in general and adequate for exactly that.
export function isMobileBrowser(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /Android|iPhone|iPad|iPod|Windows Phone/i.test(ua);
}

/// Is this a host a public service could resolve? A relay has to be able to
/// reach back to this origin, so a tailnet name, a `.local`, a bare hostname or
/// a private IP cannot work. Kept after the deep-link removal because the same
/// question decides whether to warn the user rather than let them hit a silent
/// dead end.
export function isPublicHost(host: string): boolean {
  if (!host) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;   // any bare IPv4
  if (host === 'localhost' || host.endsWith('.local')) return false;
  if (host.startsWith('[') || host.includes(':')) return false; // IPv6 literal
  return host.includes('.');                                 // needs a real TLD
}

// MetaMask Connect client — singleton, created once and reused.
//
// This replaces the old `metamask.app.link/dapp/<url>` redirect, which did not
// connect anything: it handed the whole SITE to MetaMask's in-app browser, so
// the user arrived at a fresh copy of the page and had to press Connect a
// second time. That link is for browsing a dapp inside MetaMask, not for
// connecting one running in Chrome.
//
// MetaMask Connect keeps the dapp where it is and talks to the app over
// MetaMask's own relay (@metamask/mobile-wallet-protocol-*), so the phone
// switches to MetaMask only to approve, then comes back.
let mmClient: any = null;
let mmInit: Promise<any> | null = null;

async function getOrInitMetaMask(chainId: number, rpcUrls: string[]): Promise<any> {
  if (mmClient) return mmClient;
  // Share the in-flight init rather than starting a second one. Two taps on
  // Connect before the first resolves would otherwise build two clients, and
  // the second would not be the one holding the session.
  if (mmInit) return mmInit;

  mmInit = (async () => {
    const { createEVMClient } = await import('@metamask/connect-evm');
    const hex = `0x${chainId.toString(16)}` as `0x${string}`;
    mmClient = await createEVMClient({
      dapp: {
        name: 'Satori',
        url: typeof window !== 'undefined' ? window.location.origin : 'https://satori.app',
        iconUrl: typeof window !== 'undefined' ? `${window.location.origin}/logo192.png` : undefined,
      },
      api: { supportedNetworks: { [hex]: rpcUrls[0] } },
      // Defaults to true. Off: nothing here needs MetaMask to be told how the
      // site is used, and it is not ours to send.
      analytics: { enabled: false },
      // Do NOT announce over EIP-6963. When the real extension is installed it
      // announces itself, and the injected path below already handles that;
      // a second announcement only adds a duplicate entry to wallet pickers.
      skipAutoAnnounce: true,
    });
    return mmClient;
  })();

  try {
    return await mmInit;
  } finally {
    mmInit = null;
  }
}

// WalletConnect provider singleton — initialized lazily on first connect or on
// session-restore. WC SDK itself handles reconnection across reloads via
// localStorage; we just need to re-bind a signer when a saved session exists.
let wcProvider: any = null;

async function getOrInitWalletConnect(chainId: number, rpcUrls: string[]): Promise<any> {
  if (!WALLETCONNECT_PROJECT_ID) {
    throw new Error('WalletConnect not configured (set WALLETCONNECT_PROJECT_ID)');
  }
  if (wcProvider) return wcProvider;
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  wcProvider = await EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    chains: [chainId],
    showQrModal: true,
    rpcMap: { [chainId]: rpcUrls[0] },
    metadata: {
      name: 'Satori',
      description: 'Daily Prediction Game',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://satori.app',
      icons: typeof window !== 'undefined' ? [`${window.location.origin}/logo192.png`] : [],
    },
  });
  return wcProvider;
}

// Tracks an active wallet connection so we can detach listeners and drop the
// session cleanly on disconnect. Lives in a ref (not state) because handlers
// fire from outside React and need synchronous access.
interface Connection {
  type: 'injected' | 'walletconnect' | 'metamask';
  cleanup: () => void;
  /// The raw EIP-1193 provider, kept so `disconnect` can also tell the WALLET —
  /// clearing our own state leaves the site still permitted, which is what makes
  /// a reconnect silently reuse the same account.
  raw?: any;
}

/// Which path to connect through. Omitted means "pick the sensible one": an
/// injected provider if there is one, otherwise MetaMask over its relay.
/// 'walletconnect' is the escape hatch for every other wallet.
export type WalletChoice = 'metamask' | 'walletconnect';

/// The encrypted local Game Wallet (see lib/gameWallet.ts). While `active` it
/// IS the dapp's signer — predictions run with zero wallet popups — and the
/// underlying wallet-app connection stays reachable as `mainSigner` /
/// `mainAddress` so setup flows (funding, delegating) can use both sides.
export interface GameWalletState {
  exists: boolean;
  address: string | null;
  kind: GameWalletKind | null;
  /// Decrypted and held in memory. Locks itself after inactivity.
  unlocked: boolean;
  /// The user chose the game wallet as their acting identity. Effective (the
  /// signer actually switches) only while ALSO unlocked.
  preferred: boolean;
  active: boolean;
  /// The in-memory signer while unlocked — connected to the read provider, so
  /// it transacts without any wallet app. Null while locked.
  ///
  /// Wrapped in a NonceManager: this key sends transactions BACK TO BACK with
  /// no human in the loop (the setup step alone sends two), and a plain wallet
  /// asks the provider for its nonce each time. The provider can still answer
  /// from before the previous transaction landed, so the second send reuses the
  /// nonce and fails with "nonce has already been used" — reproduced in the
  /// Game Wallet e2e. NonceManager tracks the nonce locally and increments per
  /// send, which is what makes an unattended sequence safe.
  signer: ethers.Signer | null;
  /// The raw private key, for the backup-reveal step ONLY. Null while locked.
  privateKey: string | null;
  /// Drop the locally-tracked nonce so the next send re-reads it from chain.
  /// Call after a failed send: a transaction that never entered the mempool
  /// leaves the local counter one ahead of reality.
  resetNonces: () => void;
  create: (passphrase: string) => Promise<string>;
  importSecret: (secret: string, passphrase: string) => Promise<string>;
  unlock: (passphrase: string) => Promise<void>;
  lock: () => void;
  setPreferred: (on: boolean) => void;
  /// Remove the keystore from this device. Irreversible without the user's own
  /// backup — callers confirm before invoking.
  forget: () => void;
}

/// How to name and picture the user's OWN wallet in the UI.
///
/// "Main wallet" meant nothing to anyone: people do not think "main", they
/// think "my MetaMask". EIP-6963 is how a wallet introduces itself to a page —
/// every modern extension announces its name and an icon as a data URI — so the
/// app can say "MetaMask" (or Rabby, or Coinbase Wallet) and show that wallet's
/// own mark instead of inventing a label for it.
///
/// `name` falls back to a neutral "your wallet" rather than guessing MetaMask:
/// most alternatives set `isMetaMask` for compatibility, so a guess would
/// confidently mislabel a Rabby user. The icon simply goes absent and callers
/// draw a generic glyph.
export interface ExternalWalletInfo {
  name: string;
  icon: string | null;
}

export interface WalletState {
  address: string | null;
  chainId: number;
  isConnected: boolean;
  // Read provider — always present, points at the configured chain's RPC list.
  // Anyone (no wallet, wrong network) can read state through this.
  provider: ethers.JsonRpcProvider;
  // Signer — null until the user explicitly connects a wallet. Writes go here.
  // While the game wallet is active, THIS is the game wallet.
  signer: ethers.Signer | null;
  /// The wallet-app connection, visible even while the game wallet is the
  /// acting signer (delegation setup needs both sides at once).
  mainAddress: string | null;
  mainSigner: ethers.Signer | null;
  gameWallet: GameWalletState;
  /// The user's own wallet, as it names and pictures itself (EIP-6963).
  externalWallet: ExternalWalletInfo;
  /// The last address the user connected a REAL wallet with — the live one when
  /// connected, otherwise the remembered one. Needed because sweeping a game
  /// wallet's leftover gas has to know where to send it, and that can happen
  /// while only the game wallet is active.
  lastExternalAddress: string | null;
  connect: (choice?: WalletChoice) => Promise<void>;
  disconnect: () => Promise<void>;
  /// A connection request is open. The button binds to this so repeated taps
  /// cannot queue up approval prompts, and so a rejected request visibly
  /// returns to a usable state rather than looking stuck.
  connecting: boolean;
  /// Can this build offer non-MetaMask wallets? False without a WalletConnect
  /// project id, in which case the picker should not advertise the option.
  canUseWalletConnect: boolean;
  isDev: boolean;
  devAccounts: DevAccount[];
  switchDevAccount: (index: number) => void;
  devAccountIndex: number;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const value = useWalletInternal();
  return React.createElement(WalletContext.Provider, { value }, children);
}

export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used within WalletProvider');
  return ctx;
}

function useWalletInternal(): WalletState {
  const chainId = DEFAULT_CHAIN_ID;
  const [address, setAddress] = useState<string | null>(null);
  const [signer, setSigner] = useState<ethers.Signer | null>(null);
  const [devAccountIndex, setDevAccountIndex] = useState(1); // default: signer 1
  // Labels only — the account list itself is derived and never waits on this.
  const [devAccounts, setDevAccounts] = useState<DevAccount[]>(DEV_ACCOUNTS);
  useEffect(() => {
    if (!isDev) return;
    let live = true;
    applyDevCast(DEV_ACCOUNTS).then((a) => { if (live) setDevAccounts(a); });
    return () => { live = false; };
  }, []);
  const [connecting, setConnecting] = useState(false);
  const connectionRef = useRef<Connection | null>(null);
  // Guards against overlapping connects. A ref as well as state because the
  // check has to be synchronous — two taps in the same tick would both see
  // `connecting === false` if it only lived in state.
  const connectingRef = useRef(false);

  // Read provider: a resilient JsonRpcProvider over the configured chain's
  // RPC list. Always present — reads work without any wallet, and they're
  // decoupled from whatever network MetaMask happens to be on.
  const provider = useMemo(
    () => createResilientProvider(getRpcUrls(chainId)),
    [chainId],
  );

  // Dev: auto-create a wallet signer from a known Hardhat private key. The
  // signer shares the read provider so transactions go to the same node.
  useEffect(() => {
    if (!isDev) return;
    const w = new ethers.Wallet(DEV_ACCOUNTS[devAccountIndex].key, provider);
    setSigner(w);
    setAddress(w.address);
  }, [provider, devAccountIndex]);

  // Remember the user's own wallet address across sessions. The game wallet can
  // be the acting signer with no extension connected at all, and a sweep still
  // needs somewhere to send the leftover gas — asking the user to reconnect
  // just to empty a key they are deleting would be a poor trade.
  const LAST_EXTERNAL_KEY = 'satori.lastExternalAddress.v1';
  const [rememberedExternal, setRememberedExternal] = useState<string | null>(() => {
    try { return localStorage.getItem(LAST_EXTERNAL_KEY); } catch { return null; }
  });
  useEffect(() => {
    if (!address) return;
    setRememberedExternal(address);
    try { localStorage.setItem(LAST_EXTERNAL_KEY, address); } catch { /* private mode */ }
  }, [address]);

  // EIP-6963 discovery, for DISPLAY ONLY — the connection paths are unchanged.
  // Wallets announce themselves in response to a request event; we keep the
  // name and icon so the UI can offer "MetaMask" rather than "your main wallet".
  const [externalWallet, setExternalWallet] = useState<ExternalWalletInfo>({
    name: 'your wallet', icon: null,
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onAnnounce = (event: any) => {
      const info = event?.detail?.info;
      if (!info?.name) return;
      const injected = (window as any).ethereum;
      const isTheConnectedOne = injected && event.detail.provider === injected;
      setExternalWallet((prev) => {
        // First announcement wins, unless a later one is demonstrably the
        // provider actually driving this page.
        if (prev.icon && !isTheConnectedOne) return prev;
        return { name: info.name, icon: info.icon ?? null };
      });
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
  }, []);

  // ------------------------------------------------------------------
  // Game Wallet (lib/gameWallet.ts): an encrypted local key that, while
  // unlocked AND preferred, becomes the dapp's acting signer — the daily
  // predict loop then needs no wallet-app popups. The decrypted key lives in
  // React state only; locking drops the reference and the ciphertext in
  // storage is all that remains.
  // ------------------------------------------------------------------
  const GW_PREF_KEY = 'satori.gameWallet.preferred.v1';
  const GW_AUTOLOCK_MS = 30 * 60 * 1000;

  const [gwMeta, setGwMeta] = useState(() => getGameWalletMeta());
  const [gwWallet, setGwWallet] = useState<ethers.Wallet | null>(null);
  const [gwPreferred, setGwPreferredState] = useState<boolean>(() => {
    try { return localStorage.getItem(GW_PREF_KEY) === '1'; } catch { return false; }
  });
  const gwLastActivity = useRef(Date.now());

  const gwLock = useCallback(() => { setGwWallet(null); }, []);

  // Auto-lock on inactivity. Pointer/key events are the activity signal; a
  // minutely sweep compares against the threshold. Attached only while a
  // decrypted key is actually in memory.
  useEffect(() => {
    if (!gwWallet) return;
    gwLastActivity.current = Date.now();
    const touch = () => { gwLastActivity.current = Date.now(); };
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    const sweep = window.setInterval(() => {
      if (Date.now() - gwLastActivity.current > GW_AUTOLOCK_MS) gwLock();
    }, 60_000);
    return () => {
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
      window.clearInterval(sweep);
    };
  }, [gwWallet, gwLock, GW_AUTOLOCK_MS]);

  const gwSetPreferred = useCallback((on: boolean) => {
    setGwPreferredState(on);
    try {
      if (on) localStorage.setItem(GW_PREF_KEY, '1');
      else localStorage.removeItem(GW_PREF_KEY);
    } catch { /* storage unavailable — session-only preference */ }
  }, []);

  const gameWallet: GameWalletState = useMemo(() => {
    const connected = gwWallet ? (gwWallet.connect(provider) as ethers.Wallet) : null;
    // See the `signer` docs on GameWalletState for why this wrapper is required
    // rather than merely nice: unattended back-to-back sends race the provider's
    // nonce view without it.
    const managed = connected ? new ethers.NonceManager(connected) : null;
    return {
      exists: !!gwMeta,
      address: gwMeta?.address ?? null,
      kind: gwMeta?.kind ?? null,
      unlocked: !!gwWallet,
      preferred: gwPreferred,
      active: gwPreferred && !!gwWallet,
      signer: managed,
      privateKey: gwWallet?.privateKey ?? null,
      resetNonces: () => { managed?.reset(); },
      create: async (passphrase: string) => {
        const w = await gwCreate(passphrase);
        setGwMeta(getGameWalletMeta());
        setGwWallet(new ethers.Wallet(w.privateKey)); // keep unlocked — no second decrypt
        return w.address;
      },
      importSecret: async (secret: string, passphrase: string) => {
        const w = await gwImport(secret, passphrase);
        setGwMeta(getGameWalletMeta());
        setGwWallet(new ethers.Wallet(w.privateKey));
        return w.address;
      },
      unlock: async (passphrase: string) => {
        setGwWallet(await gwUnlock(passphrase));
      },
      lock: gwLock,
      setPreferred: gwSetPreferred,
      forget: () => {
        gwLock();
        gwSetPreferred(false);
        gwDelete();
        setGwMeta(null);
      },
    };
  }, [gwMeta, gwWallet, gwPreferred, provider, gwLock, gwSetPreferred]);

  // Tear down the active connection: detach event listeners, drop a WC
  // session if present, clear local state. Safe to call when nothing is
  // connected. Stable across renders (no deps) so handlers can capture it.
  const disconnect = useCallback(async () => {
    const conn = connectionRef.current;
    connectionRef.current = null;
    if (conn) {
      try { conn.cleanup(); } catch { /* swallow */ }
      if (conn.type === 'walletconnect') {
        try { await wcProvider?.disconnect(); } catch { /* swallow */ }
      }
      if (conn.type === 'metamask') {
        // Revoke the relay session, not just our local state. Without this the
        // session survives and the next connect silently reuses it, so
        // "disconnect" would mean "disconnect until you press connect, then you
        // are stuck with whoever you first chose" — the same trap the injected
        // path's revokePermissions call exists to avoid.
        try { await mmClient?.disconnect(); } catch { /* swallow */ }
      }
      if (conn.type === 'injected' && conn.raw?.request) {
        // Tell the wallet too, not just ourselves. Dropping only local state
        // leaves the site permitted, so the next eth_requestAccounts returns the
        // same account with no prompt and "disconnect" turns out to mean
        // "disconnect until you press connect, then you are stuck with whoever
        // you first chose". Not universally supported (MetaMask 11+); where it
        // is missing the picker on connect covers the same ground.
        try {
          await conn.raw.request({
            method: 'wallet_revokePermissions',
            params: [{ eth_accounts: {} }],
          });
        } catch { /* older wallet, or refused — the connect-side picker handles it */ }
      }
    }
    setSigner(null);
    setAddress(null);
  }, []);

  // Bind to an injected wallet (MetaMask / Rabby / Coinbase / etc.). Switches
  // chain if needed, derives a signer, and attaches chainChanged +
  // accountsChanged handlers so the dapp doesn't keep using a stale signer
  // when the user changes networks or accounts in their wallet UI.
  const bindInjected = useCallback(async (eth: any) => {
    const bp = new ethers.BrowserProvider(eth);

    // Ask for the ACCOUNT PICKER, not just for accounts.
    //
    // `eth_requestAccounts` only prompts when the site has no permission yet.
    // Once granted it returns the same account forever, silently — so after a
    // disconnect the user is handed back whichever account they happened to pick
    // first, with no way to choose another from inside the dapp. In a wallet
    // app's own browser, where there is no extension UI to go and change it,
    // that is a dead end.
    //
    // `wallet_requestPermissions` re-opens the picker every time. This runs only
    // on an explicit connect — the mount-time restore path is WalletConnect
    // only — so it costs a deliberate click, never an unprompted popup.
    try {
      await bp.send("wallet_requestPermissions", [{ eth_accounts: {} }]);
    } catch (e: any) {
      const code = e?.code ?? e?.error?.code;
      // 4001 is the user closing the picker. That is an answer: bail rather
      // than falling through and connecting them to an account they declined
      // to choose.
      if (code === 4001) throw e;
      // Anything else means the wallet lacks the method (older builds, some
      // in-app browsers). Fall through: they still get connected, just without
      // the choice, which is strictly what they had before.
    }

    await bp.send("eth_requestAccounts", []);

    const network = await bp.getNetwork();
    if (Number(network.chainId) !== chainId) {
      const hex = '0x' + chainId.toString(16);
      try {
        await bp.send("wallet_switchEthereumChain", [{ chainId: hex }]);
      } catch (e: any) {
        // 4902 = chain not added to the wallet — offer to add it, complete
        // with EIP-3085 fields most wallets require.
        if (e?.code === 4902 || e?.error?.code === 4902) {
          const cfg = getChainConfig(chainId);
          await bp.send("wallet_addEthereumChain", [{
            chainId: hex,
            chainName: cfg.chainName,
            rpcUrls: cfg.rpcUrls,
            nativeCurrency: cfg.nativeCurrency,
            blockExplorerUrls: cfg.blockExplorerUrls,
          }]);
        } else {
          throw e;
        }
      }
    }

    const s = await bp.getSigner();
    const addr = await s.getAddress();

    // chainChanged: if the user moves off our chain in their wallet, drop
    // the session — better than silently signing on the wrong chain.
    const onChainChanged = (raw: string) => {
      if (parseInt(raw, 16) !== chainId) {
        disconnect();
      }
    };
    // accountsChanged: empty array means the user disconnected the dapp from
    // their wallet's site permissions. Otherwise re-bind to the new account.
    const onAccountsChanged = async (accs: string[]) => {
      if (!accs || accs.length === 0) {
        disconnect();
        return;
      }
      try {
        const newSigner = await new ethers.BrowserProvider(eth).getSigner();
        setSigner(newSigner);
        setAddress(await newSigner.getAddress());
      } catch {
        disconnect();
      }
    };
    eth.on?.('chainChanged', onChainChanged);
    eth.on?.('accountsChanged', onAccountsChanged);

    connectionRef.current = {
      type: 'injected',
      raw: eth,
      cleanup: () => {
        eth.removeListener?.('chainChanged', onChainChanged);
        eth.removeListener?.('accountsChanged', onAccountsChanged);
      },
    };
    setSigner(s);
    setAddress(addr);
  }, [chainId, disconnect]);

  // Bind to a WalletConnect provider (already enabled / session-restored).
  // WC's own events ride on top of the same EIP-1193 surface, so the listener
  // shape mirrors the injected path.
  const bindWalletConnect = useCallback(async (wc: any) => {
    const bp = new ethers.BrowserProvider(wc);
    const s = await bp.getSigner();
    const addr = await s.getAddress();

    const onAccountsChanged = async (accs: string[]) => {
      if (!accs || accs.length === 0) {
        disconnect();
        return;
      }
      try {
        const newSigner = await new ethers.BrowserProvider(wc).getSigner();
        setSigner(newSigner);
        setAddress(await newSigner.getAddress());
      } catch {
        disconnect();
      }
    };
    const onWcDisconnect = () => { disconnect(); };
    const onChainChanged = (raw: string) => {
      const n = typeof raw === 'string' ? parseInt(raw, 16) : Number(raw);
      if (n !== chainId) disconnect();
    };
    wc.on?.('accountsChanged', onAccountsChanged);
    wc.on?.('disconnect', onWcDisconnect);
    wc.on?.('chainChanged', onChainChanged);

    connectionRef.current = {
      type: 'walletconnect',
      cleanup: () => {
        wc.removeListener?.('accountsChanged', onAccountsChanged);
        wc.removeListener?.('disconnect', onWcDisconnect);
        wc.removeListener?.('chainChanged', onChainChanged);
      },
    };
    setSigner(s);
    setAddress(addr);
  }, [chainId, disconnect]);

  // Bind to a MetaMask Connect session. Its provider is EIP-1193 like the other
  // two, so this is the same shape as bindWalletConnect — the difference is
  // entirely in how the session was established, not in how it is used.
  const bindMetaMask = useCallback(async (client: any) => {
    const eth = client.getProvider();
    const bp = new ethers.BrowserProvider(eth);
    const s = await bp.getSigner();
    const addr = await s.getAddress();

    const onAccountsChanged = async (accs: string[]) => {
      if (!accs || accs.length === 0) {
        disconnect();
        return;
      }
      try {
        const newSigner = await new ethers.BrowserProvider(eth).getSigner();
        setSigner(newSigner);
        setAddress(await newSigner.getAddress());
      } catch {
        disconnect();
      }
    };
    const onChainChanged = (raw: string) => {
      const n = typeof raw === 'string' ? parseInt(raw, 16) : Number(raw);
      if (n !== chainId) disconnect();
    };
    const onDisconnect = () => { disconnect(); };
    eth.on?.('accountsChanged', onAccountsChanged);
    eth.on?.('chainChanged', onChainChanged);
    eth.on?.('disconnect', onDisconnect);

    connectionRef.current = {
      type: 'metamask',
      raw: eth,
      cleanup: () => {
        eth.removeListener?.('accountsChanged', onAccountsChanged);
        eth.removeListener?.('chainChanged', onChainChanged);
        eth.removeListener?.('disconnect', onDisconnect);
      },
    };
    setSigner(s);
    setAddress(addr);
  }, [chainId, disconnect]);

  // Prod: rehydrate an existing WalletConnect session on mount. The WC SDK
  // persists sessions in localStorage; if the user signed in via WC last
  // visit, we re-bind a signer (and listeners) so they don't have to scan again.
  useEffect(() => {
    if (isDev || !WALLETCONNECT_PROJECT_ID) return;
    let cancelled = false;
    (async () => {
      try {
        const cfg = getChainConfig(chainId);
        const wc = await getOrInitWalletConnect(chainId, cfg.rpcUrls);
        if (cancelled) return;
        if (wc.session && wc.accounts && wc.accounts.length > 0) {
          await bindWalletConnect(wc);
        }
      } catch {
        // Best-effort restore — if it fails, the user can connect manually.
      }
    })();
    return () => { cancelled = true; };
  }, [chainId, bindWalletConnect]);

  // Prod: rehydrate an existing MetaMask Connect session on mount.
  //
  // `createEVMClient` recovers a stored session during construction, so by the
  // time it resolves the client already knows whether one exists. Bind only when
  // it reports connected WITH an account — constructing the client must never
  // itself produce an approval prompt, or every page load would nag someone who
  // has not connected.
  useEffect(() => {
    if (isDev) return;
    // An injected provider means the extension or an in-app browser is driving;
    // do not also stand up a relay client behind it.
    if (typeof window !== 'undefined' && (window as any).ethereum) return;
    let cancelled = false;
    (async () => {
      try {
        const cfg = getChainConfig(chainId);
        const client = await getOrInitMetaMask(chainId, cfg.rpcUrls);
        if (cancelled) return;
        if (client.status === 'connected' && client.getAccount()) {
          await bindMetaMask(client);
        }
      } catch {
        // Best-effort restore — the user can still connect manually.
      }
    })();
    return () => { cancelled = true; };
  }, [chainId, bindMetaMask]);

  // Prod connect. Three paths, and none of them navigates away from this page:
  //   1. Injected provider (desktop extension, or a wallet app's own browser).
  //   2. `choice === 'walletconnect'` — every non-MetaMask wallet.
  //   3. Otherwise MetaMask Connect, which relays to the app and leaves the
  //      dapp in the tab it is already in.
  //
  // What used to be here as (3) was a redirect to metamask.app.link/dapp/<url>,
  // which opened the whole SITE inside MetaMask's browser and made the user
  // press Connect a second time. That was never a connection path.
  const connect = useCallback(async (choice?: WalletChoice) => {
    if (isDev) return;
    // One request at a time. Repeated taps while MetaMask is opening would
    // otherwise each start their own connection, and the user gets a queue of
    // approval prompts for a single intent.
    if (connectingRef.current) return;
    connectingRef.current = true;
    setConnecting(true);
    try {
      // 1. An injected provider means the wallet is right here: a desktop
      //    extension, or a wallet app's own browser. Nothing to relay.
      const eth = (window as any).ethereum;
      if (eth && choice !== 'walletconnect') {
        await bindInjected(eth);
        return;
      }

      // 2. Explicitly asked for something other than MetaMask.
      if (choice === 'walletconnect') {
        if (!WALLETCONNECT_PROJECT_ID) {
          throw new Error(
            'Other wallets need a WalletConnect project id. Set ' +
            'REACT_APP_WALLETCONNECT_PROJECT_ID (free from cloud.reown.com), ' +
            'or connect with MetaMask, which needs no key.'
          );
        }
        const cfg = getChainConfig(chainId);
        const wc = await getOrInitWalletConnect(chainId, cfg.rpcUrls);
        await wc.enable();
        await bindWalletConnect(wc);
        return;
      }

      // 3. No injected provider: ordinary Chrome or Safari on a phone, which is
      //    where most people open this. MetaMask Connect relays to the app and
      //    leaves the dapp in the tab it is already in.
      //
      //    A relay has to reach back to this origin, so a tailnet name or a LAN
      //    IP cannot work. Say so rather than letting the phone switch to
      //    MetaMask and sit on its home screen with nothing to approve.
      if (!isPublicHost(window.location.hostname)) {
        throw new Error(
          "This address is on your private network, so MetaMask cannot reach it.\n\n" +
          "Open MetaMask, tap the Browser tab, and paste:\n" + window.location.href
        );
      }
      const cfg = getChainConfig(chainId);
      const client = await getOrInitMetaMask(chainId, cfg.rpcUrls);
      await client.connect({ chainIds: [`0x${chainId.toString(16)}`] });
      await bindMetaMask(client);
    } finally {
      connectingRef.current = false;
      setConnecting(false);
    }
  }, [chainId, bindInjected, bindWalletConnect, bindMetaMask]);

  // Detach listeners on unmount so they don't leak across hot reloads.
  useEffect(() => {
    return () => {
      const conn = connectionRef.current;
      if (conn) {
        try { conn.cleanup(); } catch { /* swallow */ }
      }
    };
  }, []);

  // Dev mode: switch between test accounts
  const switchDevAccount = (index: number) => {
    if (isDev && index >= 0 && index < DEV_ACCOUNTS.length) {
      setDevAccountIndex(index);
    }
  };

  // While the game wallet is active it IS the dapp's identity — every consumer
  // of `signer`/`address` transparently acts as it, popup-free. The wallet-app
  // connection is still exposed as main*, so setup/claim flows can reach the
  // user's real wallet at the same time.
  const gwActing = gameWallet.active && !!gameWallet.signer && !!gameWallet.address;

  return {
    address: gwActing ? gameWallet.address : address,
    chainId,
    isConnected: gwActing ? true : !!address,
    provider,
    signer: gwActing ? gameWallet.signer : signer,
    mainAddress: address,
    mainSigner: signer,
    gameWallet,
    externalWallet,
    lastExternalAddress: address ?? rememberedExternal,
    connect,
    disconnect,
    connecting,
    canUseWalletConnect: !!WALLETCONNECT_PROJECT_ID,
    isDev,
    devAccounts: isDev ? devAccounts : [],
    switchDevAccount,
    devAccountIndex,
  };
}
