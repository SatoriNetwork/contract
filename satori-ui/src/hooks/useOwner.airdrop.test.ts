import { renderHook, act, waitFor } from '@testing-library/react';
import { ethers } from 'ethers';
import { useOwner } from './useOwner';

/// The freeze closes the airdrop table and pins the door for good, and the token
/// refuses it over the cap or when the table moved. The hook checks the same
/// before it sends, on uncached reads, so the owner sees why.

const AIRDROP = '0x' + '66'.repeat(20);
const OTHER = '0x' + '77'.repeat(20);
const E = (n: number) => ethers.parseEther(String(n));

let mockContracts: any;
let chain: { loaded: bigint; cap: bigint; frozen: boolean; door: string };

jest.mock('./useContracts', () => ({ useContracts: () => ({ contracts: mockContracts }) }));
jest.mock('./useWallet', () => ({ useWallet: () => ({ address: '0x' + '44'.repeat(20) }) }));
jest.mock('../lib/afterTx', () => ({ afterTx: async (tx: unknown) => tx }));
jest.mock('../lib/chainValues', () => ({
  getCurrentRound: async () => 1,
  getPlatformFeeRecipient: async () => '0x' + '00'.repeat(20),
  getDeploymentRound: async () => 0,
}));

beforeEach(() => {
  // The page-data load has nothing to read here and logs its failure; the
  // actions under test do not depend on it.
  jest.spyOn(console, 'error').mockImplementation(() => {});
  chain = { loaded: E(1199000), cap: E(1200000), frozen: false, door: AIRDROP };
  mockContracts = {
    reads: {
      airdrop: {
        target: AIRDROP,
        airdropLoadedTotal: jest.fn(async () => chain.loaded),
        AIRDROP_TOTAL_SUPPLY: jest.fn(async () => chain.cap),
      },
      token: {
        airdropFrozen: jest.fn(async () => chain.frozen),
        airdrop: jest.fn(async () => chain.door),
      },
    },
    cached: { round: {}, live: {} },
    airdrop: { loadAirdropBatch: jest.fn(async () => ({ hash: '0xl' })) },
    token: { freezeAirdrop: jest.fn(async () => ({ hash: '0xf' })) },
  };
});

afterEach(() => { jest.restoreAllMocks(); });

async function hook() {
  const { result } = renderHook(() => useOwner());
  await waitFor(() => expect(result.current.loading).toBe(false));
  return result;
}

async function call(fn: () => Promise<{ ok: boolean; error?: string }>) {
  let res: { ok: boolean; error?: string } = { ok: false };
  await act(async () => { res = await fn(); });
  return res;
}

describe('loadAirdropBatch', () => {
  it('refuses a batch that would take the table over the cap, and sends nothing', async () => {
    const r = await hook();
    const res = await call(() => r.current.loadAirdropBatch([{ address: OTHER, amountSatori: '1001' }]));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Over the cap/);
    expect(mockContracts.airdrop.loadAirdropBatch).not.toHaveBeenCalled();
  });

  it('sends a batch that lands exactly on the cap', async () => {
    const r = await hook();
    const res = await call(() => r.current.loadAirdropBatch([{ address: OTHER, amountSatori: '1000' }]));
    expect(res.ok).toBe(true);
    expect(mockContracts.airdrop.loadAirdropBatch).toHaveBeenCalledWith([OTHER], [E(1000)]);
  });

  it('refuses when the door points at another contract: those rows would not pay', async () => {
    chain.door = OTHER;
    const r = await hook();
    const res = await call(() => r.current.loadAirdropBatch([{ address: OTHER, amountSatori: '1' }]));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/would not pay/);
    expect(mockContracts.airdrop.loadAirdropBatch).not.toHaveBeenCalled();
  });

  it('refuses once the door is frozen: the table is closed', async () => {
    chain.frozen = true;
    const r = await hook();
    const res = await call(() => r.current.loadAirdropBatch([{ address: OTHER, amountSatori: '1' }]));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/table is closed/);
    expect(mockContracts.airdrop.loadAirdropBatch).not.toHaveBeenCalled();
  });
});

describe('freezeAirdrop', () => {
  it('refuses when the door no longer points at this airdrop', async () => {
    chain.door = OTHER;
    const r = await hook();
    const res = await call(() => r.current.freezeAirdrop(chain.loaded));
    expect(res).toEqual({ ok: false, error: 'The airdrop door no longer points at this airdrop; reload.' });
    expect(mockContracts.token.freezeAirdrop).not.toHaveBeenCalled();
  });

  it('refuses an empty table', async () => {
    chain.loaded = BigInt(0);
    const r = await hook();
    const res = await call(() => r.current.freezeAirdrop(BigInt(0)));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty for good/);
    expect(mockContracts.token.freezeAirdrop).not.toHaveBeenCalled();
  });

  it('refuses when the table holds anything but the total that was checked', async () => {
    const r = await hook();
    const res = await call(() => r.current.freezeAirdrop(chain.loaded - BigInt(1)));
    expect(res.ok).toBe(false);
    expect(res.error).toBe('The table holds 1199000.0 SATORI, not the 1198999.999999999999999999 you checked. Check it again before freezing.');
    expect(mockContracts.token.freezeAirdrop).not.toHaveBeenCalled();
  });

  it('refuses a table over the ceiling: the token would refuse it too', async () => {
    chain.loaded = E(1200000) + BigInt(1);
    const r = await hook();
    const res = await call(() => r.current.freezeAirdrop(chain.loaded));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Over the ceiling/);
    expect(mockContracts.token.freezeAirdrop).not.toHaveBeenCalled();
  });

  it('sends the door and the checked total when the door points here and the table holds something', async () => {
    const r = await hook();
    const res = await call(() => r.current.freezeAirdrop(chain.loaded));
    expect(res.ok).toBe(true);
    expect(mockContracts.token.freezeAirdrop).toHaveBeenCalledWith(AIRDROP, E(1199000));
  });
});
