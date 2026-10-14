/**
 * EIP-5792 wallet batching — Route B of
 * `docs/issues/closed/multi-transaction-flows-need-batching.md`.
 *
 * Route A (permit) removes the approval transaction entirely, and is strictly
 * better where it works: signing is free, batching still pays the approve's gas.
 * But permit is an ERC-2612 feature, so it cannot reach a bounty token that does
 * not implement it, and its `(v, r, s)` cannot carry a smart account's signature.
 * This is the path for exactly those cases: ask the WALLET to submit approve and
 * the action together, so the user confirms once.
 *
 * **Only used when the wallet confirms ATOMIC batching.** A non-atomic batch can
 * land the approval and then fail the action, which looks to the user like one
 * thing that half-happened. Two honest presses are better than that, so a wallet
 * that offers only sequential execution falls through to the stepped approvals.
 *
 * The spec changed shape between drafts and wallets shipped against both, so
 * every function here reads either. That is most of the code, and it is the part
 * that would otherwise fail silently on somebody's wallet:
 *
 *   capabilities   { atomicBatch: { supported: true } }   (draft)
 *                  { atomic: { status: 'supported' } }    (current)
 *   sendCalls      version '1.0' -> a bare string id
 *                  version '2.0.0' -> { id }
 *   status         'PENDING' | 'CONFIRMED'                (draft)
 *                  100 | 200 | 400 | 500                  (current)
 */

/// The minimal EIP-1193 surface this needs. `ethers.BrowserProvider.send` fits.
export type Send = (method: string, params: any[]) => Promise<any>;

export type BatchCall = { to: string; data: string; value?: string };

const hexChain = (chainId: bigint | number) => '0x' + BigInt(chainId).toString(16);

/**
 * Will this wallet execute a batch ATOMICALLY on this chain?
 *
 * False for any answer that is missing, malformed, or merely sequential. Never
 * throws: an unsupported method is the common case, not an error condition.
 */
export async function supportsAtomicBatch(
  send: Send, account: string, chainId: bigint | number,
): Promise<boolean> {
  const key = hexChain(chainId);
  for (const params of [[account, [key]], [account]]) {
    try {
      const caps = await send('wallet_getCapabilities', params);
      const forChain = caps?.[key] ?? caps?.[key.toLowerCase()];
      if (!forChain) continue;

      // Current shape. 'ready' means the wallet can upgrade the account on
      // demand, which still ends in an atomic batch, so it counts.
      const status = forChain.atomic?.status;
      if (status === 'supported' || status === 'ready') return true;

      // Draft shape.
      if (forChain.atomicBatch?.supported === true) return true;
    } catch {
      /* method unsupported, or this param shape rejected — try the next */
    }
  }
  return false;
}

/**
 * Submit `calls` as one batch. Returns the batch id, or null if the wallet
 * declined the request in a way that means "I cannot do this" rather than "the
 * user said no".
 *
 * A user rejection THROWS, so a cancelled confirmation is not silently treated
 * as an unsupported wallet and retried as three separate presses.
 */
export async function sendCalls(
  send: Send,
  args: { from: string; chainId: bigint | number; calls: BatchCall[] },
): Promise<string | null> {
  const chain = hexChain(args.chainId);
  const calls = args.calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? '0x0' }));

  // Current version first. `atomicRequired` is the whole point: if the wallet
  // cannot guarantee all-or-nothing it must refuse rather than half-execute.
  try {
    const res = await send('wallet_sendCalls', [{
      version: '2.0.0', from: args.from, chainId: chain, atomicRequired: true, calls,
    }]);
    const id = typeof res === 'string' ? res : res?.id;
    if (id) return id;
  } catch (e) {
    if (isUserRejection(e)) throw e;
  }

  try {
    const res = await send('wallet_sendCalls', [{
      version: '1.0', from: args.from, chainId: chain, calls,
    }]);
    const id = typeof res === 'string' ? res : res?.id;
    if (id) return id;
  } catch (e) {
    if (isUserRejection(e)) throw e;
  }

  return null;
}

/** EIP-1193 rejection, plus the shapes wallets actually send. */
export function isUserRejection(e: any): boolean {
  const code = e?.code ?? e?.error?.code ?? e?.info?.error?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;
  const msg = String(e?.message ?? e?.shortMessage ?? '').toLowerCase();
  return msg.includes('user rejected') || msg.includes('user denied');
}

export type BatchOutcome = { ok: boolean; reverted: boolean };

/**
 * Poll until the batch settles. Resolves `{ok:false}` on a revert or an offchain
 * failure rather than throwing, so callers can report it the same way they report
 * any other failed action.
 *
 * Gives up after `timeoutMs` and reports not-ok: a batch that never resolves must
 * not leave the UI spinning forever, which is the failure the rate-limited-RPC
 * incident was about.
 */
export async function waitForCalls(
  send: Send, id: string, opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<BatchOutcome> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1_500;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await send('wallet_getCallsStatus', [id]);
      const s = res?.status;

      if (typeof s === 'number') {
        if (s === 200) return { ok: true, reverted: false };
        if (s >= 400) return { ok: false, reverted: s >= 500 };
      } else if (typeof s === 'string') {
        const up = s.toUpperCase();
        if (up === 'CONFIRMED') {
          // The draft shape reports CONFIRMED even when a call reverted, so the
          // receipts have to be read to tell success from failure.
          const bad = (res?.receipts ?? []).some(
            (r: any) => r?.status === '0x0' || r?.status === 0 || r?.status === false,
          );
          return { ok: !bad, reverted: bad };
        }
        if (up === 'FAILED' || up === 'REVERTED') return { ok: false, reverted: true };
      }
    } catch {
      /* transient; keep polling until the deadline */
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { ok: false, reverted: false };
}

/**
 * The whole Route B path: check, submit, wait. Returns null when batching is not
 * available, which is the caller's signal to fall back.
 *
 * Throws only on a user rejection, so "they cancelled" never turns into "your
 * wallet cannot do this, here are three buttons instead".
 */
export async function tryAtomicBatch(
  send: Send,
  args: { from: string; chainId: bigint | number; calls: BatchCall[] },
): Promise<BatchOutcome | null> {
  if (!(await supportsAtomicBatch(send, args.from, args.chainId))) return null;
  const id = await sendCalls(send, args);
  if (!id) return null;
  return waitForCalls(send, id);
}
