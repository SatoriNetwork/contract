import { renderHook, act } from '@testing-library/react';
import { useVoting } from './useVoting';
import { signPermit } from '../lib/permit';

/// A NAMED stream costs no SATORI: the hub skips the stream burn for the named
/// adapter, so the create must sign no fee permit and need no allowance. Every
/// other kind still pays, so the simple create is pinned alongside.

const HUB = '0x' + '11'.repeat(20);
const ENGINE = '0x' + '22'.repeat(20);
const TOKEN = '0x' + '33'.repeat(20);
const ME = '0x' + '44'.repeat(20);
const FEE = BigInt('1000000000000000');
const NAMED_ID = 7;
const SIG5 = 'createAdapterDataStream(string,uint32,address,bytes,uint24)';

let mockContracts: any;

jest.mock('./useContracts', () => ({ useContracts: () => ({ contracts: mockContracts }) }));
jest.mock('./useWallet', () => ({ useWallet: () => ({ address: '0x' + '44'.repeat(20) }) }));
jest.mock('./useGasless', () => ({ useGasless: () => ({ sendOrRelay: async () => null }) }));
jest.mock('./useGames', () => ({ useGames: () => ({ resolveGameId: async () => 0 }) }));
jest.mock('../lib/afterTx', () => ({ afterTx: async (tx: unknown) => tx }));
jest.mock('../lib/chainValues', () => ({
  getStreamBurn: async () => BigInt('1000000000000000'),
  getCurrentRound: async () => 1,
  getNamedAdapterId: async () => 7,
}));
jest.mock('../lib/permit', () => ({
  ...jest.requireActual('../lib/permit'),
  signPermit: jest.fn(),
  resolvePermitDomain: async () => null,
}));

beforeEach(() => {
  (signPermit as jest.Mock).mockImplementation(async ({ value }: { value: bigint }) =>
    ({ value, deadline: BigInt(9999999999), raw: '0xsig' }));
  mockContracts = {
    hub: {
      getAddress: async () => HUB,
      createSimpleDataStreamWithPermit: jest.fn(async () => ({ hash: '0xs' })),
      createAdapterDataStreamWithPermit: jest.fn(async () => ({ hash: '0xa' })),
    },
    engine: { getAddress: async () => ENGINE },
    satori: { [SIG5]: jest.fn(async () => ({ hash: '0xn' })), runner: {} },
    token: { approve: jest.fn() },
    reads: {
      lens: { streamBurn: jest.fn(async () => FEE) },
      token: {
        allowance: jest.fn(async () => BigInt(0)),
        getAddress: async () => TOKEN,
        runner: { getNetwork: async () => ({ chainId: BigInt(31337) }) },
      },
      satori: { [SIG5]: { staticCall: jest.fn(async () => undefined) } },
    },
    cached: { live: {
      rewards: { capabilityAllowed: async () => true },
      token: { transferLockedUntil: async () => BigInt(0), allowance: async () => BigInt(0), balanceOf: async () => BigInt(0) },
    } },
  };
});

test('a named create sends the name as given, with no fee permit and no allowance check', async () => {
  const { result } = renderHook(() => useVoting(false));
  await act(async () => { await result.current.createStream({ name: 'bitcoin', kind: 'named' }); });

  expect(result.current.createError).toBeNull();
  expect(signPermit).not.toHaveBeenCalled();
  expect(mockContracts.reads.token.allowance).not.toHaveBeenCalled();
  expect(mockContracts.hub.createAdapterDataStreamWithPermit).not.toHaveBeenCalled();
  expect(mockContracts.reads.satori[SIG5].staticCall).toHaveBeenCalledWith('bitcoin', NAMED_ID, ENGINE, '0x', 60, { from: ME });
  expect(mockContracts.satori[SIG5]).toHaveBeenCalledWith('bitcoin', NAMED_ID, ENGINE, '0x', 60);
});

test('a named create keeps capitals the form chose to keep', async () => {
  const { result } = renderHook(() => useVoting(false));
  await act(async () => { await result.current.createStream({ name: 'Bitcoin', kind: 'named' }); });
  expect(mockContracts.satori[SIG5].mock.calls[0][0]).toBe('Bitcoin');
});

test('a simple create still signs for the fee', async () => {
  const { result } = renderHook(() => useVoting(false));
  await act(async () => { await result.current.createStream({ name: 'SOL/USD', kind: 'simple' }); });

  expect(result.current.createError).toBeNull();
  expect(signPermit).toHaveBeenCalledTimes(1);
  expect((signPermit as jest.Mock).mock.calls[0][0].value).toBe(FEE * BigInt(2));
  expect(mockContracts.hub.createSimpleDataStreamWithPermit).toHaveBeenCalledTimes(1);
});
