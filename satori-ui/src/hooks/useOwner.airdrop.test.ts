import { renderHook, act, waitFor } from '@testing-library/react';
import { ethers } from 'ethers';
import { useOwner } from './useOwner';

/// Loading refuses past the cap and after finalize, and rows loaded into a
/// contract the token does not point at would never pay. The hook checks the
/// same before it sends, on uncached reads, so the owner sees why.

const AIRDROP = '0x' + '66'.repeat(20);
const OTHER = '0x' + '77'.repeat(20);
const E = (n: number) => ethers.parseEther(String(n));

let mockContracts: any;
let chain: { loaded: bigint; cap: bigint; finalized: boolean; door: string };

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
  chain = { loaded: E(1099000), cap: E(1100000), finalized: false, door: AIRDROP };
  mockContracts = {
    reads: {
      airdrop: {
        target: AIRDROP,
        airdropLoadedTotal: jest.fn(async () => chain.loaded),
        AIRDROP_TOTAL_SUPPLY: jest.fn(async () => chain.cap),
        airdropLoadingFinalized: jest.fn(async () => chain.finalized),
      },
      token: {
        airdrop: jest.fn(async () => chain.door),
      },
    },
    cached: { round: {}, live: {} },
    airdrop: {
      loadAirdropBatch: jest.fn(async () => ({ hash: '0xl' })),
      finalizeAirdropLoading: jest.fn(async () => ({ hash: '0xfin' })),
    },
    token: {},
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
    expect(res.error).not.toMatch(/freeze/i);
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

  it('refuses once loading is finalized: the table is closed', async () => {
    chain.finalized = true;
    const r = await hook();
    const res = await call(() => r.current.loadAirdropBatch([{ address: OTHER, amountSatori: '1' }]));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/table is closed/);
    expect(mockContracts.airdrop.loadAirdropBatch).not.toHaveBeenCalled();
  });
});

describe('no freeze', () => {
  it('the hook no longer offers freezeAirdrop', async () => {
    const r = await hook();
    expect((r.current as any).freezeAirdrop).toBeUndefined();
  });

  it('finalizeAirdropLoading sends with no freeze precondition', async () => {
    const r = await hook();
    const res = await call(() => r.current.finalizeAirdropLoading());
    expect(res.ok).toBe(true);
    expect(mockContracts.airdrop.finalizeAirdropLoading).toHaveBeenCalled();
  });
});
