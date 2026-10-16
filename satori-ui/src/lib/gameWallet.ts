import { ethers } from 'ethers';

/// Game Wallet — an encrypted local signing key, so the daily predict loop can
/// run with zero wallet popups.
///
/// WHAT THIS IS AND IS NOT. The private key is encrypted with a key derived
/// from the user's passphrase (scrypt) into a standard V3 keystore — the same
/// format geth and MetaMask exports use — and only the CIPHERTEXT ever touches
/// storage. Unlocking decrypts into memory only; locking drops the reference.
/// That makes at-rest theft (a stolen device, another site, disk forensics)
/// yield nothing without the passphrase. It does NOT make the key safe from a
/// script running inside this page while unlocked — there is no OS-keychain
/// for web pages — which is why the promoted flow keeps only a DELEGATE key
/// here (gas dust; the SATORI never leaves the user's main wallet), and why
/// importing a funded key is offered but not suggested.
///
/// Storage is localStorage: ~1KB of ciphertext, same persistence class the
/// WalletConnect session already relies on. Browsers may still evict it
/// (Safari after long disuse), so the UI must always frame this as a
/// CONVENIENCE COPY — the passphrase cannot resurrect an evicted ciphertext;
/// the user's own backup of the key is the recovery.

const KEYSTORE_KEY = 'satori.gameWallet.keystore.v1';
const META_KEY = 'satori.gameWallet.meta.v1';

export type GameWalletKind = 'generated' | 'imported';

export interface GameWalletMeta {
  address: string;
  kind: GameWalletKind;
  createdAt: number;
}

/// scrypt work factor. 2^17 is the keystore-standard setting (~1-2s on a
/// current phone — felt once per unlock, and exactly what makes offline
/// guessing expensive). Tests shrink it; production never should.
const DEFAULT_SCRYPT_N = 1 << 17;
let scryptN = DEFAULT_SCRYPT_N;
export function setScryptNForTests(n: number) { scryptN = n; }

export const MIN_PASSPHRASE_LENGTH = 8;

export function getGameWalletMeta(): GameWalletMeta | null {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return null;
    const meta = JSON.parse(raw);
    if (!meta || !ethers.isAddress(meta.address)) return null;
    return meta as GameWalletMeta;
  } catch {
    return null;
  }
}

export function hasGameWallet(): boolean {
  try {
    return !!localStorage.getItem(KEYSTORE_KEY) && !!getGameWalletMeta();
  } catch {
    return false;
  }
}

function requirePassphrase(passphrase: string) {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
}

/// Never overwrite silently: a keystore may guard a funded key, and "create"
/// clobbering it would be irreversible loss. The caller must forget() first,
/// which the UI gates behind its own confirmation.
function requireNoWallet() {
  if (hasGameWallet()) {
    throw new Error('A game wallet already exists. Remove it first to create a new one.');
  }
}

async function store(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  passphrase: string,
  kind: GameWalletKind,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const json = await ethers.encryptKeystoreJson(
    { address: wallet.address, privateKey: wallet.privateKey },
    passphrase,
    { scrypt: { N: scryptN }, progressCallback: onProgress },
  );
  localStorage.setItem(KEYSTORE_KEY, json);
  localStorage.setItem(META_KEY, JSON.stringify({
    address: wallet.address, kind, createdAt: Date.now(),
  } satisfies GameWalletMeta));
  // Best-effort: ask the browser not to evict our storage. Matters most for
  // the installed-PWA case; failure changes nothing except eviction odds.
  try { void navigator.storage?.persist?.(); } catch { /* unsupported */ }
  return wallet.address;
}

/// Generate a fresh key and store it encrypted. Returns the UNLOCKED wallet so
/// the caller can keep it in memory (backup reveal, immediate use) without a
/// second decrypt.
export async function createGameWallet(
  passphrase: string,
  onProgress?: (pct: number) => void,
): Promise<ethers.HDNodeWallet> {
  requirePassphrase(passphrase);
  requireNoWallet();
  const wallet = ethers.Wallet.createRandom();
  await store(wallet, passphrase, 'generated', onProgress);
  return wallet;
}

/// An Evrmore/Ravencoin mainnet WIF key as 0x hex, or null if `s` is not one.
/// The neuron's Base account is these same 32 bytes (satorilib
/// EthereumWallet.generateAccount), so the import lands on that address.
function wifToHex(s: string): string | null {
  let bytes: Uint8Array;
  try {
    bytes = ethers.getBytes(ethers.toBeHex(ethers.decodeBase58(s)));
  } catch {
    return null;
  }
  const compressed = bytes.length === 38 && bytes[33] === 0x01;
  if (bytes[0] !== 0x80 || !(bytes.length === 37 || compressed)) return null;
  const checksum = ethers.dataSlice(ethers.sha256(ethers.sha256(bytes.slice(0, -4))), 0, 4);
  if (checksum !== ethers.hexlify(bytes.slice(-4))) return null;
  return ethers.hexlify(bytes.slice(1, 33));
}

/// Import an existing secret — a 0x private key, an Evrmore/Ravencoin WIF key
/// or a mnemonic phrase — and store it encrypted. Same no-overwrite rule as create.
export async function importGameWallet(
  secret: string,
  passphrase: string,
  onProgress?: (pct: number) => void,
): Promise<ethers.Wallet | ethers.HDNodeWallet> {
  requirePassphrase(passphrase);
  requireNoWallet();
  const trimmed = secret.trim();
  let wallet: ethers.Wallet | ethers.HDNodeWallet;
  try {
    wallet = trimmed.includes(' ')
      ? ethers.HDNodeWallet.fromPhrase(trimmed)
      : new ethers.Wallet(wifToHex(trimmed) ?? trimmed);
  } catch {
    throw new Error('That is not a valid private key or recovery phrase.');
  }
  await store(wallet, passphrase, 'imported', onProgress);
  return wallet;
}

/// Decrypt the stored keystore into an in-memory wallet. The caller decides
/// how long to keep it and when to drop it (see useWallet's auto-lock).
export async function unlockGameWallet(
  passphrase: string,
  onProgress?: (pct: number) => void,
): Promise<ethers.Wallet> {
  const json = localStorage.getItem(KEYSTORE_KEY);
  if (!json) throw new Error('No game wallet is set up on this device.');
  let account: { privateKey: string };
  try {
    account = await ethers.decryptKeystoreJson(json, passphrase, onProgress);
  } catch {
    // ethers reports a MAC mismatch for a wrong passphrase; anything else here
    // is a corrupted keystore. Either way the answer to the user is the same
    // actionable one first.
    throw new Error('Wrong passphrase (or the stored keystore is damaged).');
  }
  return new ethers.Wallet(account.privateKey);
}

/// Remove the keystore permanently. The key is unrecoverable afterward unless
/// the user kept their own backup — the UI confirms exactly that before calling.
export function deleteGameWallet(): void {
  try {
    localStorage.removeItem(KEYSTORE_KEY);
    localStorage.removeItem(META_KEY);
  } catch { /* storage unavailable — nothing to delete */ }
}
