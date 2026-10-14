import { renderHook, act } from '@testing-library/react';

// The hook subscribes through this, so the mock IS the chain-health signal:
// capture the listener and drive it directly. Mocking the transport instead
// would test ethers, not the debounce.
let emit: ((reachable: boolean) => void) | null = null;
jest.mock('../utils/rpcProvider', () => ({
  onChainHealth: (fn: (r: boolean) => void) => {
    emit = fn;
    fn(true); // real implementation pushes current state on subscribe
    return () => { emit = null; };
  },
}));

// eslint-disable-next-line import/first
import { useChainHealth, UNREACHABLE_GRACE_MS } from './useChainHealth';

// The banner this drives is a block element in normal flow, so a false positive
// does not just flash red — it pushes the whole page down and releases it. The
// underlying signal goes false when ONE call exhausts the RPC failover list and
// true again on the next call that succeeds, and the dapp runs many calls
// concurrently, so brief false blips are routine against a throttled endpoint.
describe('useChainHealth', () => {
  beforeEach(() => { jest.useFakeTimers(); emit = null; });
  afterEach(() => { jest.useRealTimers(); });

  it('starts reachable', () => {
    const { result } = renderHook(() => useChainHealth());
    expect(result.current.reachable).toBe(true);
  });

  it('ignores a blip shorter than the grace period', () => {
    const { result } = renderHook(() => useChainHealth());
    act(() => { emit!(false); });
    // Still true: nothing has been claimed yet.
    expect(result.current.reachable).toBe(true);
    act(() => { jest.advanceTimersByTime(UNREACHABLE_GRACE_MS - 1); emit!(true); });
    act(() => { jest.advanceTimersByTime(UNREACHABLE_GRACE_MS * 2); });
    // The pending timer must have been cancelled, not merely outrun.
    expect(result.current.reachable).toBe(true);
  });

  it('reports unreachable once it persists past the grace period', () => {
    const { result } = renderHook(() => useChainHealth());
    act(() => { emit!(false); });
    act(() => { jest.advanceTimersByTime(UNREACHABLE_GRACE_MS); });
    expect(result.current.reachable).toBe(false);
  });

  it('recovers immediately, without waiting out a timer', () => {
    const { result } = renderHook(() => useChainHealth());
    act(() => { emit!(false); jest.advanceTimersByTime(UNREACHABLE_GRACE_MS); });
    expect(result.current.reachable).toBe(false);
    act(() => { emit!(true); });
    // No timer advance: a recovery delayed is a banner outliving its outage.
    expect(result.current.reachable).toBe(true);
  });

  it('does not let a stream of failures postpone the banner forever', () => {
    const { result } = renderHook(() => useChainHealth());
    // Repeated `false` must not restart the countdown — that is the case where
    // the chain really is down and every call is failing.
    act(() => { emit!(false); });
    for (let i = 0; i < 4; i++) {
      act(() => { jest.advanceTimersByTime(UNREACHABLE_GRACE_MS / 4); emit!(false); });
    }
    expect(result.current.reachable).toBe(false);
  });

  it('clears its timer on unmount', () => {
    const { result, unmount } = renderHook(() => useChainHealth());
    act(() => { emit!(false); });
    unmount();
    // Firing the timer after unmount would set state on a dead component.
    expect(() => act(() => { jest.advanceTimersByTime(UNREACHABLE_GRACE_MS * 2); })).not.toThrow();
    expect(result.current.reachable).toBe(true);
  });
});
