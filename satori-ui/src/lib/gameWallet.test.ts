import { ethers } from 'ethers';
import {
  createGameWallet, importGameWallet, unlockGameWallet, deleteGameWallet,
  getGameWalletMeta, hasGameWallet, setScryptNForTests, MIN_PASSPHRASE_LENGTH,
} from './gameWallet';

// Production uses the keystore-standard scrypt N (2^17). The tests only need
// the ROUNDTRIP to be faithful, not the work factor, so shrink it — otherwise
// every encrypt/decrypt here costs seconds.
beforeAll(() => setScryptNForTests(1 << 10));
beforeEach(() => { localStorage.clear(); });

const PASS = 'correct horse battery';

describe('gameWallet keystore', () => {
  it('create → unlock roundtrip yields the same key, and meta records the address', async () => {
    const created = await createGameWallet(PASS);
    expect(hasGameWallet()).toBe(true);
    expect(getGameWalletMeta()).toMatchObject({ address: created.address, kind: 'generated' });

    const unlocked = await unlockGameWallet(PASS);
    expect(unlocked.address).toBe(created.address);
    expect(unlocked.privateKey).toBe(created.privateKey);
  });

  it('the wrong passphrase is refused and never yields a wallet', async () => {
    await createGameWallet(PASS);
    await expect(unlockGameWallet('not the passphrase')).rejects.toThrow(/wrong passphrase/i);
  });

  it('only ciphertext touches storage — the private key is never persisted in the clear', async () => {
    const w = await createGameWallet(PASS);
    const everything = Object.keys(localStorage)
      .map((k) => localStorage.getItem(k) ?? '')
      .join('\n')
      .toLowerCase();
    expect(everything).not.toContain(w.privateKey.slice(2).toLowerCase());
    if (w.mnemonic) {
      expect(everything).not.toContain(w.mnemonic.phrase.toLowerCase());
    }
  });

  it('refuses a short passphrase', async () => {
    await expect(createGameWallet('short')).rejects.toThrow(
      new RegExp(String(MIN_PASSPHRASE_LENGTH))
    );
    expect(hasGameWallet()).toBe(false);
  });

  it('never silently overwrites an existing keystore', async () => {
    const first = await createGameWallet(PASS);
    await expect(createGameWallet(PASS)).rejects.toThrow(/already exists/i);
    await expect(importGameWallet(first.privateKey, PASS)).rejects.toThrow(/already exists/i);
    // The original is untouched.
    expect((await unlockGameWallet(PASS)).address).toBe(first.address);
  });

  it('imports a raw private key', async () => {
    const source = ethers.Wallet.createRandom();
    const imported = await importGameWallet(source.privateKey, PASS);
    expect(imported.address).toBe(source.address);
    expect(getGameWalletMeta()).toMatchObject({ address: source.address, kind: 'imported' });
    expect((await unlockGameWallet(PASS)).address).toBe(source.address);
  });

  it('imports a mnemonic phrase (default derivation path)', async () => {
    const source = ethers.Wallet.createRandom();
    const phrase = source.mnemonic!.phrase;
    const imported = await importGameWallet(phrase, PASS);
    expect(imported.address).toBe(source.address);
  });

  // Vectors from Evrmore's own library: str(CEvrmoreSecret.from_secret_bytes(KEY)).
  const EVR_KEY = '0x0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d';

  it.each([
    ['compressed', 'KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98617'],
    ['uncompressed', '5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ'],
  ])('imports an Evrmore/Ravencoin WIF key (%s) as the same secret', async (_, wif) => {
    const imported = await importGameWallet(`  ${wif}\n`, PASS);
    expect(imported.privateKey).toBe(EVR_KEY);
    expect((await unlockGameWallet(PASS)).privateKey).toBe(EVR_KEY);
  });

  it('rejects a WIF with a bad checksum or a testnet version byte', async () => {
    await expect(
      importGameWallet('KwdMAjGmerYanjeui5SHS7JkmpZvVipYvB2LJGU1ZxJwYvP98618', PASS)
    ).rejects.toThrow(/not a valid/i);
    await expect(
      importGameWallet('cMzLdeGd5vEqxB8B6VFQoRopQ3sLAAvEzDAoQgvX54xwofSWj1fx', PASS)
    ).rejects.toThrow(/not a valid/i);
    expect(hasGameWallet()).toBe(false);
  });

  it('rejects garbage secrets with a plain message', async () => {
    await expect(importGameWallet('0xnotakey', PASS)).rejects.toThrow(/not a valid/i);
    await expect(importGameWallet('some random words but not twelve', PASS)).rejects.toThrow(/not a valid/i);
    expect(hasGameWallet()).toBe(false);
  });

  it('delete removes the keystore and unlock then reports no wallet', async () => {
    await createGameWallet(PASS);
    deleteGameWallet();
    expect(hasGameWallet()).toBe(false);
    expect(getGameWalletMeta()).toBeNull();
    await expect(unlockGameWallet(PASS)).rejects.toThrow(/no game wallet/i);
  });
});
