// The dapp's hardcoded chain config must match the deployment book.
//
// WHY THIS EXISTS
// `addresses.ts` has said, since it was written, that its Base Sepolia entries
// are "taken from satori/deployments/baseSepolia.json rather than typed by hand;
// every one is checked against that book by the dapp's own test."
//
// **There was no such test.** The comment described an intention. On 2026-08-21
// a Sepolia redeploy changed all nine addresses and they were updated by a
// scripted edit — which happened to be right, but nothing would have caught it
// if it had not been. This is that test, written the day the claim was checked
// and found to be false.
//
// It also guards `deploymentRound`, which is new here and is the reason the
// guard finally mattered enough to write. That number decides every round shown
// on screen (display = absolute - deploymentRound + 1). Shipping it as a
// build-time constant is what removes the placeholder from a first-ever page
// load, and a wrong constant would confidently print a wrong round forever —
// exactly the bug it was added to fix.
//
// SCOPE. Only chains with a deployment book. The dev chain is redeployed
// constantly and its addresses are nonce-derived, so pinning it here would fail
// on every `npx hardhat node` restart for no safety gained.
import fs from 'fs';
import path from 'path';
import { getChainConfig, TESTNET_CHAIN_ID } from './addresses';

const BOOKS: Array<{ chainId: number; file: string; label: string }> = [
  { chainId: TESTNET_CHAIN_ID, file: 'baseSepolia.json', label: 'Base Sepolia' },
  // Add mainnet here the moment satori/deployments/base.json exists.
];

const DEPLOYMENTS = path.join(__dirname, '..', '..', '..', 'satori', 'deployments');

// Keys the dapp holds that the book also names. `merkle` and `multicall` are
// deliberately absent: merkle is not deployed in this rehearsal (the dapp
// carries the zero address on purpose) and multicall is a chain-wide preinstall,
// not something this project deploys.
const PINNED = ['token', 'engine', 'hub', 'registry', 'voting', 'rewards', 'games', 'bounties', 'lens'] as const;
// Pinned like the rest once the book names it. A book that PREDATES
// SatoriAirdrop has no such key, and then the dapp must carry the zero address
// rather than invent one (the panel and admin row hide on zero).
const PINNED_WHEN_PRESENT = ['airdrop'] as const;
const ZERO = '0x0000000000000000000000000000000000000000';

describe('dapp chain config matches the deployment book', () => {
  for (const { chainId, file, label } of BOOKS) {
    const full = path.join(DEPLOYMENTS, file);

    it(`${label}: the book exists (a missing book means this test guards nothing)`, () => {
      expect(fs.existsSync(full)).toBe(true);
    });

    if (!fs.existsSync(full)) continue;
    const book = JSON.parse(fs.readFileSync(full, 'utf8'));
    const cfg = getChainConfig(chainId);

    it(`${label}: chainId agrees`, () => {
      expect(book.chainId).toBe(chainId);
    });

    for (const key of PINNED) {
      it(`${label}: ${key} matches the book`, () => {
        const fromBook = book.addresses?.[key];
        expect(typeof fromBook).toBe('string');
        expect((cfg as unknown as Record<string, string>)[key].toLowerCase())
          .toBe(String(fromBook).toLowerCase());
      });
    }
    for (const key of PINNED_WHEN_PRESENT) {
      it(`${label}: ${key} matches the book, or is zero on a book that predates it`, () => {
        const fromBook = book.addresses?.[key];
        const inDapp = (cfg as unknown as Record<string, string>)[key].toLowerCase();
        if (fromBook == null) expect(inDapp).toBe(ZERO);
        else expect(inDapp).toBe(String(fromBook).toLowerCase());
      });
    }

    it(`${label}: deploymentRound matches the book`, () => {
      // If the book has not recorded it, the dapp must not invent one — an
      // unpinned constant is worse than no constant, because the UI would print
      // it with full confidence.
      if (book.deploymentRound == null) {
        expect(cfg.deploymentRound).toBeUndefined();
        return;
      }
      expect(cfg.deploymentRound).toBe(Number(book.deploymentRound));
    });

    it(`${label}: the pinned round makes the deployment round display as 1`, () => {
      // The whole point of the number, asserted as arithmetic rather than trust.
      const absolute = Number(book.deploymentRound);
      expect(absolute - (cfg.deploymentRound as number) + 1).toBe(1);
    });
  }
});
