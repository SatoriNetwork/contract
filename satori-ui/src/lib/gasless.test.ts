import { ethers } from 'ethers';
import { chooseGasRoute, encodeAction } from './gasless';

// The action codes and data encodings must match SatoriHub.RelayAction and
// _dispatchRelay's abi.decode calls exactly — a drift here produces a valid
// signature over garbage the contract decodes into someone else's parameters.
const abi = ethers.AbiCoder.defaultAbiCoder();

describe('gasless encodeAction', () => {
  const A = '0x1111111111111111111111111111111111111111';
  const B = '0x2222222222222222222222222222222222222222';

  it('predict: action 0, (referrer, requests[]) tuple encoding', () => {
    const { action, data, hubPullWei } = encodeAction({
      kind: 'predict', referrer: A,
      requests: [{ gameId: 7, payload: '0x01' }, { gameId: 9, payload: '0x02' }],
    });
    expect(action).toBe(0);
    expect(hubPullWei).toBe(BigInt(0));
    expect(data).toBe(abi.encode(
      ['address', 'tuple(uint32 gameId, bytes payload)[]'],
      [A, [[7, '0x01'], [9, '0x02']]],
    ));
  });

  it('claim: action 1, recipient address', () => {
    const { action, data } = encodeAction({ kind: 'claim', recipient: B });
    expect(action).toBe(1);
    expect(data).toBe(abi.encode(['address'], [B]));
  });

  it('transfer: action 2, pulls the amount through the hub allowance', () => {
    const { action, data, hubPullWei } = encodeAction({ kind: 'transfer', to: B, amountWei: BigInt(5) });
    expect(action).toBe(2);
    expect(hubPullWei).toBe(BigInt(5));
    expect(data).toBe(abi.encode(['address', 'uint256'], [B, 5]));
  });

  it('delegatePrediction: action 3', () => {
    const { action, data } = encodeAction({ kind: 'delegatePrediction', delegate: B });
    expect(action).toBe(3);
    expect(data).toBe(abi.encode(['address'], [B]));
  });

  it('setAllowedDelegator: action 4', () => {
    const { action, data } = encodeAction({ kind: 'setAllowedDelegator', allowed: A });
    expect(action).toBe(4);
    expect(data).toBe(abi.encode(['address'], [A]));
  });

  it('setPredictorFee: action 5, uint16', () => {
    const { action, data } = encodeAction({ kind: 'setPredictorFee', bps: 500 });
    expect(action).toBe(5);
    expect(data).toBe(abi.encode(['uint16'], [500]));
  });

  it('vote: action 6, pulls the burn amount through the hub allowance', () => {
    const wei = ethers.parseEther('10');
    const { action, data, hubPullWei } = encodeAction({ kind: 'vote', gameId: 3, amountWei: wei });
    expect(action).toBe(6);
    expect(hubPullWei).toBe(wei);
    expect(data).toBe(abi.encode(['uint32', 'uint256'], [3, wei]));
  });
});

describe('chooseGasRoute', () => {
  const base = { always: false, willing: false, hasEth: true as boolean | null };

  it('override on: always relays, ETH or not', () => {
    expect(chooseGasRoute({ ...base, always: true, hasEth: true })).toBe('relay');
    expect(chooseGasRoute({ ...base, always: true, hasEth: false })).toBe('relay');
  });

  it('has ETH: normal send', () => {
    expect(chooseGasRoute({ ...base, hasEth: true })).toBe('normal');
    expect(chooseGasRoute({ ...base, willing: true, hasEth: true })).toBe('normal');
  });

  it('no ETH + willing: relays without asking', () => {
    expect(chooseGasRoute({ ...base, willing: true, hasEth: false })).toBe('relay');
  });

  it('no ETH + not willing: prompts — every time, no memory of a prior no', () => {
    expect(chooseGasRoute({ ...base, hasEth: false })).toBe('prompt');
    // Same inputs a second time still prompt: declining is never remembered.
    expect(chooseGasRoute({ ...base, hasEth: false })).toBe('prompt');
  });

  it('unreadable balance: never routes around the wallet', () => {
    expect(chooseGasRoute({ ...base, hasEth: null })).toBe('normal');
    // ...unless the override is explicitly on.
    expect(chooseGasRoute({ ...base, always: true, hasEth: null })).toBe('relay');
  });
});
