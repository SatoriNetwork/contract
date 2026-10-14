import { isTransient, withInFlightDedupe, withConcurrencyLimit } from './rpcProvider';

// What `isTransient` decides is whether a failed call is retried and failed over,
// or handed to the user as a real error. Both mistakes are bad and they are bad
// in opposite ways: miss a transport failure and the dapp wedges on a healthy
// chain; treat a contract revert as transport and every genuine "no" is retried
// three times and then reported as a network problem.
//
// The first half of this file is the bug found against Base Sepolia on
// 2026-08-02 (docs/issues/closed/dapp-wedges-on-rate-limited-rpc.md). The second half is
// the part that must not regress while fixing it.
describe('isTransient', () => {
  describe('transport failures — must retry', () => {
    it('recognises a rate-limited eth_call, which arrives as CALL_EXCEPTION', () => {
      // Verbatim shape of the error a 429 produced: ethers has no body to decode,
      // so getBuiltinCallException raises "missing revert data" with nulls
      // throughout and NOTHING mentioning a rate limit anywhere in it.
      expect(isTransient({
        code: 'CALL_EXCEPTION',
        message: 'missing revert data (action="call", data=null, reason=null, ...)',
        data: null,
        reason: null,
      })).toBe(true);
    });

    it('still recognises the explicitly rate-shaped errors', () => {
      expect(isTransient({ message: 'server responded with 429' })).toBe(true);
      expect(isTransient({ message: 'rate limit exceeded' })).toBe(true);
    });

    it('still recognises plain network failures', () => {
      for (const code of ['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT']) {
        expect(isTransient({ code })).toBe(true);
      }
      expect(isTransient({ message: 'Failed to fetch' })).toBe(true);
      expect(isTransient({ message: 'connect ECONNREFUSED' })).toBe(true);
    });
  });

  describe('contract reverts — must NOT retry', () => {
    it('leaves a revert carrying a decoded reason alone', () => {
      expect(isTransient({
        code: 'CALL_EXCEPTION',
        message: 'execution reverted: NotARecipient',
        data: '0x08c379a0',
        reason: 'NotARecipient',
      })).toBe(false);
    });

    it('leaves a custom-error revert alone (data, no reason)', () => {
      // Custom errors decode to data with no reason string — the common case in
      // this codebase, which uses custom errors throughout.
      expect(isTransient({
        code: 'CALL_EXCEPTION',
        message: 'execution reverted (unknown custom error)',
        data: '0x82b42900',
        reason: null,
      })).toBe(false);
    });

    it('leaves a BARE revert() alone — "0x" is a response, null is not', () => {
      // This is the whole discriminator. A bare `revert()` returns empty data,
      // which is still an answer from the chain; a throttled request returns
      // nothing at all. Conflating them is what would make real reverts retry.
      expect(isTransient({
        code: 'CALL_EXCEPTION',
        message: 'execution reverted',
        data: '0x',
        reason: null,
      })).toBe(false);
    });
  });

  it('is not confused by null or undefined', () => {
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });
});

// Coalescing concurrent reads is only safe while it stays a coalescer and never
// becomes a cache. Every test below either proves it saves a call, or proves it
// has NOT quietly started answering from the past.
describe('withInFlightDedupe', () => {
  /// A send that stays pending until released, so "concurrent" is exact rather
  /// than a matter of timing luck.
  function deferredSend() {
    const calls: string[] = [];
    let release: (v: any) => void = () => {};
    const fn = (method: string, params: any[]) => {
      calls.push(`${method}|${JSON.stringify(params)}`);
      return new Promise((res) => { release = res; });
    };
    return { fn, calls, release: (v: any) => release(v) };
  }

  it('makes ONE request when two callers ask the same thing at once', async () => {
    // The real case: getCurrentRound() wanted by two hooks mounting together.
    const s = deferredSend();
    const send = withInFlightDedupe(s.fn);
    const a = send('eth_call', [{ to: '0xtoken', data: '0xa32bf597' }, 'latest']);
    const b = send('eth_call', [{ to: '0xtoken', data: '0xa32bf597' }, 'latest']);

    expect(s.calls).toHaveLength(1);
    s.release('0x2a');
    expect(await a).toBe('0x2a');
    expect(await b).toBe('0x2a');
  });

  it('does NOT merge different calls to the same contract', async () => {
    const s = deferredSend();
    const send = withInFlightDedupe(s.fn);
    send('eth_call', [{ to: '0xtoken', data: '0xa32bf597' }, 'latest']);
    send('eth_call', [{ to: '0xtoken', data: '0x0c340a24' }, 'latest']);
    expect(s.calls).toHaveLength(2);
    s.release('0x0');
  });

  it('is a coalescer, NOT a cache — a later ask hits the chain again', async () => {
    // The property that keeps this safe. Once an answer lands the entry is gone,
    // so the next caller gets fresh state rather than a previous block's.
    let n = 0;
    const send = withInFlightDedupe(async () => `answer-${++n}`);

    expect(await send('eth_call', [{ to: '0xa' }, 'latest'])).toBe('answer-1');
    expect(await send('eth_call', [{ to: '0xa' }, 'latest'])).toBe('answer-2');
    expect(await send('eth_call', [{ to: '0xa' }, 'latest'])).toBe('answer-3');
  });

  it('never dedupes anything that writes', async () => {
    // Two identical sends are two real transactions and must both go out. If this
    // ever collapses, a user's second action silently does nothing.
    const s = deferredSend();
    const send = withInFlightDedupe(s.fn);
    send('eth_sendRawTransaction', ['0xdeadbeef']);
    send('eth_sendRawTransaction', ['0xdeadbeef']);
    expect(s.calls).toHaveLength(2);
    s.release('0x0');
  });

  it('shares a failure with every caller, and does not stick', async () => {
    let n = 0;
    const send = withInFlightDedupe(() => {
      n++;
      return Promise.reject(new Error('boom'));
    });
    const a = send('eth_call', [{ to: '0xa' }, 'latest']);
    const b = send('eth_call', [{ to: '0xa' }, 'latest']);
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    expect(n).toBe(1);

    // A failed call must not poison the key — the next attempt tries again.
    await expect(send('eth_call', [{ to: '0xa' }, 'latest'])).rejects.toThrow('boom');
    expect(n).toBe(2);
  });
});

// The gate exists because retrying into a stampede does not help: three retries
// all lost while a manual press a second later worked first time, because
// nothing was competing with it. Capping what is in flight is what removes the
// stampede rather than surviving it.
describe('withConcurrencyLimit', () => {
  function controllable() {
    const resolvers: ((v: any) => void)[] = [];
    let started = 0;
    const fn = () => { started++; return new Promise((res) => resolvers.push(res)); };
    return { fn, resolvers, started: () => started };
  }

  it('never has more than the limit outstanding', async () => {
    const c = controllable();
    const send = withConcurrencyLimit(c.fn as any, 2);
    for (let i = 0; i < 6; i++) send('eth_call', [i]);
    expect(c.started()).toBe(2);          // four are waiting, not lost
  });

  it('starts a queued call as soon as one finishes', async () => {
    const c = controllable();
    const send = withConcurrencyLimit(c.fn as any, 2);
    for (let i = 0; i < 4; i++) send('eth_call', [i]);
    expect(c.started()).toBe(2);
    c.resolvers[0]('done');
    await Promise.resolve(); await Promise.resolve();
    expect(c.started()).toBe(3);
  });

  it('a failure still frees its slot — one bad call must not wedge the queue', async () => {
    let started = 0;
    const rejecters: ((e: any) => void)[] = [];
    const send = withConcurrencyLimit(
      (() => { started++; return new Promise((_, rej) => rejecters.push(rej)); }) as any, 1);
    const a = send('eth_call', [1]);
    send('eth_call', [2]);
    expect(started).toBe(1);
    rejecters[0](new Error('boom'));
    await expect(a).rejects.toThrow('boom');
    await Promise.resolve(); await Promise.resolve();
    expect(started).toBe(2);              // the queue moved on
  });

  it('passes results and errors back to the right caller', async () => {
    const send = withConcurrencyLimit((async (_m: string, p: any[]) => `r${p[0]}`) as any, 2);
    const out = await Promise.all([1, 2, 3, 4].map((i) => send('eth_call', [i])));
    expect(out).toEqual(['r1', 'r2', 'r3', 'r4']);
  });
});
