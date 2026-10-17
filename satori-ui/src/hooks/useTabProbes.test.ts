import { renderHook, act, waitFor } from '@testing-library/react';
import { useOwnerRoles } from './useTabProbes';

/// The airdrop's freeze and finalize rows live on the Admin tab, so the role
/// probe has to open that tab for the token's freeze authority and for the
/// airdrop loader, not only for the rewards admin and the emission holder.

const ME = '0x' + '44'.repeat(20);
const OTHER = '0x' + '55'.repeat(20);
const ZERO = '0x' + '00'.repeat(20);
const AIRDROP = '0x' + '66'.repeat(20);

let mockContracts: any;
let holders: Record<string, string>;
const mockMulticall = jest.fn();

jest.mock('./useContracts', () => ({ useContracts: () => ({ contracts: mockContracts }) }));
jest.mock('./useWallet', () => ({ useWallet: () => ({ address: '0x' + '44'.repeat(20), chainId: 31337 }) }));
jest.mock('../utils/multicall', () => ({ multicallRead: (...a: any[]) => mockMulticall(...a) }));
jest.mock('../contracts/addresses', () => ({ getChainConfig: () => ({}) }));

beforeEach(() => {
  jest.useFakeTimers();
  try { localStorage.clear(); } catch { /* no storage: the probe still answers */ }
  holders = {
    admin: OTHER, rootAuthority: OTHER, offchainReporter: OTHER, merkle: ZERO,
    emissionHolder: OTHER, freezeAuthority: OTHER, airdropAuthority: OTHER,
  };
  mockMulticall.mockReset();
  mockMulticall.mockImplementation(async (_mc: unknown, reqs: { fn: string }[]) => reqs.map((r) => holders[r.fn]));
  mockContracts = {
    multicall: {},
    reads: { rewards: {}, token: { runner: null }, engine: {}, hub: {}, airdrop: { target: AIRDROP } },
  };
});

afterEach(() => { jest.useRealTimers(); });

async function probe() {
  const { result } = renderHook(() => useOwnerRoles());
  act(() => { jest.advanceTimersByTime(3000); });
  await waitFor(() => expect(result.current.checked).toBe(true));
  return result.current;
}

test('the token freeze authority gets the admin roles', async () => {
  holders.freezeAuthority = ME;
  const roles = await probe();
  expect(roles.isFreezeAuthority).toBe(true);
  expect(roles.isAirdropHolder).toBe(false);
  expect(roles.isOwner || roles.isEmissionHolder).toBe(false);
});

test('the airdrop loader gets the admin roles', async () => {
  holders.airdropAuthority = ME;
  const roles = await probe();
  expect(roles.isAirdropHolder).toBe(true);
  expect(roles.isFreezeAuthority).toBe(false);
});

test('a chain with no airdrop contract leaves that read off and still answers', async () => {
  mockContracts.reads.airdrop.target = ZERO;
  holders.freezeAuthority = ME;
  const roles = await probe();
  const asked = mockMulticall.mock.calls[0][1].map((r: { fn: string }) => r.fn);
  expect(asked).not.toContain('airdropAuthority');
  expect(roles.isFreezeAuthority).toBe(true);
  expect(roles.isAirdropHolder).toBe(false);
});

test('a returning loader or freezer sees the tab before the probe confirms', () => {
  localStorage.setItem(`satori.probe.roles.v1.31337.${ME}`, 'lf');
  const { result } = renderHook(() => useOwnerRoles());
  expect(result.current.isAirdropHolder).toBe(true);
  expect(result.current.isFreezeAuthority).toBe(true);
  expect(result.current.checked).toBe(false);
});
