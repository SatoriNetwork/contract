import {
  supportsAtomicBatch, sendCalls, waitForCalls, tryAtomicBatch, isUserRejection, Send,
} from './walletBatch';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const CHAIN = 8453;               // Base
const CHAIN_HEX = '0x2105';
const CALLS = [
  { to: '0x2222222222222222222222222222222222222222', data: '0xaaaa' },
  { to: '0x3333333333333333333333333333333333333333', data: '0xbbbb' },
];

/** A wallet stub. `handlers` maps an RPC method to a response or an Error. */
function wallet(handlers: Record<string, any>, log: string[] = []): Send {
  return async (method, params) => {
    log.push(method);
    const h = handlers[method];
    if (h === undefined) throw Object.assign(new Error(`unsupported: ${method}`), { code: -32601 });
    const v = typeof h === 'function' ? h(params) : h;
    if (v instanceof Error) throw v;
    return v;
  };
}

describe('supportsAtomicBatch', () => {
  it('accepts the current shape', async () => {
    const send = wallet({ wallet_getCapabilities: { [CHAIN_HEX]: { atomic: { status: 'supported' } } } });
    expect(await supportsAtomicBatch(send, ACCOUNT, CHAIN)).toBe(true);
  });

  it('accepts "ready", which still ends in an atomic batch', async () => {
    const send = wallet({ wallet_getCapabilities: { [CHAIN_HEX]: { atomic: { status: 'ready' } } } });
    expect(await supportsAtomicBatch(send, ACCOUNT, CHAIN)).toBe(true);
  });

  it('accepts the older draft shape, which shipped in real wallets', async () => {
    const send = wallet({ wallet_getCapabilities: { [CHAIN_HEX]: { atomicBatch: { supported: true } } } });
    expect(await supportsAtomicBatch(send, ACCOUNT, CHAIN)).toBe(true);
  });

  it('REFUSES a wallet that only executes sequentially', async () => {
    // The important negative. A non-atomic batch can land the approve and fail
    // the action, which reads as one thing that half-happened. Two honest
    // presses beat that, so this must not report support.
    const send = wallet({ wallet_getCapabilities: { [CHAIN_HEX]: { atomic: { status: 'unsupported' } } } });
    expect(await supportsAtomicBatch(send, ACCOUNT, CHAIN)).toBe(false);
  });

  it('returns false when the method does not exist, rather than throwing', async () => {
    expect(await supportsAtomicBatch(wallet({}), ACCOUNT, CHAIN)).toBe(false);
  });

  it('returns false when the wallet answers for a DIFFERENT chain', async () => {
    const send = wallet({ wallet_getCapabilities: { '0x1': { atomic: { status: 'supported' } } } });
    expect(await supportsAtomicBatch(send, ACCOUNT, CHAIN)).toBe(false);
  });

  it('retries the older single-argument param shape', async () => {
    const log: string[] = [];
    const send = wallet({
      wallet_getCapabilities: (params: any[]) => {
        if (params.length === 2) throw new Error('this wallet wants one arg');
        return { [CHAIN_HEX]: { atomicBatch: { supported: true } } };
      },
    }, log);
    expect(await supportsAtomicBatch(send, ACCOUNT, CHAIN)).toBe(true);
    expect(log.filter((m) => m === 'wallet_getCapabilities')).toHaveLength(2);
  });
});

describe('sendCalls', () => {
  it('sends version 2.0.0 with atomicRequired, and reads the id off the object', async () => {
    let seen: any;
    const send = wallet({
      wallet_sendCalls: (p: any[]) => { seen = p[0]; return { id: '0xbatch' }; },
    });
    expect(await sendCalls(send, { from: ACCOUNT, chainId: CHAIN, calls: CALLS })).toBe('0xbatch');
    expect(seen.version).toBe('2.0.0');
    expect(seen.atomicRequired).toBe(true);
    expect(seen.chainId).toBe(CHAIN_HEX);
    expect(seen.calls[0].value).toBe('0x0');
  });

  it('falls back to version 1.0, which returns a bare string', async () => {
    const send = wallet({
      wallet_sendCalls: (p: any[]) => {
        if (p[0].version === '2.0.0') throw new Error('unknown version');
        return '0xlegacybatch';
      },
    });
    expect(await sendCalls(send, { from: ACCOUNT, chainId: CHAIN, calls: CALLS })).toBe('0xlegacybatch');
  });

  it('returns null when the wallet cannot batch at all', async () => {
    expect(await sendCalls(wallet({}), { from: ACCOUNT, chainId: CHAIN, calls: CALLS })).toBeNull();
  });

  it('RETHROWS a user rejection instead of reporting "unsupported"', async () => {
    // If a cancelled confirmation were swallowed as "unsupported", the user would
    // be dropped into the three-press fallback for saying no once.
    const rejection = Object.assign(new Error('User rejected the request'), { code: 4001 });
    const send = wallet({ wallet_sendCalls: rejection });
    await expect(sendCalls(send, { from: ACCOUNT, chainId: CHAIN, calls: CALLS })).rejects.toThrow();
  });
});

describe('waitForCalls', () => {
  const opts = { pollMs: 1, timeoutMs: 200 };

  it('resolves ok on numeric status 200', async () => {
    expect(await waitForCalls(wallet({ wallet_getCallsStatus: { status: 200 } }), 'x', opts))
      .toEqual({ ok: true, reverted: false });
  });

  it('reports a revert on numeric status 500', async () => {
    expect(await waitForCalls(wallet({ wallet_getCallsStatus: { status: 500 } }), 'x', opts))
      .toEqual({ ok: false, reverted: true });
  });

  it('reads receipts on the draft shape, which says CONFIRMED even when a call reverted', async () => {
    const send = wallet({
      wallet_getCallsStatus: { status: 'CONFIRMED', receipts: [{ status: '0x1' }, { status: '0x0' }] },
    });
    expect(await waitForCalls(send, 'x', opts)).toEqual({ ok: false, reverted: true });
  });

  it('resolves ok on the draft shape when every receipt succeeded', async () => {
    const send = wallet({
      wallet_getCallsStatus: { status: 'CONFIRMED', receipts: [{ status: '0x1' }, { status: '0x1' }] },
    });
    expect(await waitForCalls(send, 'x', opts)).toEqual({ ok: true, reverted: false });
  });

  it('gives up rather than spinning forever when the batch never settles', async () => {
    const send = wallet({ wallet_getCallsStatus: { status: 100 } });
    expect(await waitForCalls(send, 'x', opts)).toEqual({ ok: false, reverted: false });
  });

  it('keeps polling through transient errors', async () => {
    let n = 0;
    const send = wallet({
      wallet_getCallsStatus: () => { n++; if (n < 3) throw new Error('rate limited'); return { status: 200 }; },
    });
    expect(await waitForCalls(send, 'x', opts)).toEqual({ ok: true, reverted: false });
  });
});

describe('tryAtomicBatch', () => {
  it('returns null without sending anything when the wallet cannot batch atomically', async () => {
    const log: string[] = [];
    const send = wallet({ wallet_getCapabilities: { [CHAIN_HEX]: { atomic: { status: 'unsupported' } } } }, log);
    expect(await tryAtomicBatch(send, { from: ACCOUNT, chainId: CHAIN, calls: CALLS })).toBeNull();
    expect(log).not.toContain('wallet_sendCalls');
  });

  it('runs the whole path when the wallet supports it', async () => {
    const send = wallet({
      wallet_getCapabilities: { [CHAIN_HEX]: { atomic: { status: 'supported' } } },
      wallet_sendCalls: { id: '0xb' },
      wallet_getCallsStatus: { status: 200 },
    });
    expect(await tryAtomicBatch(send, { from: ACCOUNT, chainId: CHAIN, calls: CALLS }))
      .toEqual({ ok: true, reverted: false });
  });
});

describe('isUserRejection', () => {
  it('recognises the shapes wallets actually send', () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
    expect(isUserRejection({ code: 'ACTION_REJECTED' })).toBe(true);
    expect(isUserRejection({ info: { error: { code: 4001 } } })).toBe(true);
    expect(isUserRejection({ message: 'User rejected the request' })).toBe(true);
    expect(isUserRejection({ message: 'user denied transaction signature' })).toBe(true);
  });

  it('does not mistake an ordinary failure for a rejection', () => {
    expect(isUserRejection({ code: -32601, message: 'method not found' })).toBe(false);
    expect(isUserRejection(new Error('insufficient funds'))).toBe(false);
  });
});
