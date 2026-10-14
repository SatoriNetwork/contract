import { ethers } from 'ethers';
import { signPermit } from './permit';

/**
 * Client for the gasless relayer (../../relayer/, docs/design/gasless-relay.md).
 *
 * One EIP-712 signature authorizes an action AND a SATORI fee to the relayer,
 * which pays the ETH gas and calls `SatoriHub.relay()`. The quote's typed data
 * is NEVER signed as received: the message is rebuilt here from the inputs we
 * sent plus only the quote's fee/nonce/deadline/relayer, and the domain is
 * built locally — the mirror of the server not trusting client typed data.
 */

export type GaslessSpec =
  | { kind: 'predict'; referrer: string; requests: { gameId: number; payload: string }[] }
  | { kind: 'claim'; recipient: string }
  | { kind: 'transfer'; to: string; amountWei: bigint }
  | { kind: 'delegatePrediction'; delegate: string }
  | { kind: 'setAllowedDelegator'; allowed: string }
  | { kind: 'setPredictorFee'; bps: number }
  | { kind: 'vote'; gameId: number; amountWei: bigint };

// SatoriHub.RelayAction
const ACTION: Record<GaslessSpec['kind'], number> = {
  predict: 0, claim: 1, transfer: 2, delegatePrediction: 3,
  setAllowedDelegator: 4, setPredictorFee: 5, vote: 6,
};

const RELAY_TYPES = {
  RelayRequest: [
    { name: 'user', type: 'address' },
    { name: 'action', type: 'uint8' },
    { name: 'data', type: 'bytes' },
    { name: 'fee', type: 'uint256' },
    { name: 'relayer', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

const abi = ethers.AbiCoder.defaultAbiCoder();

export function encodeAction(spec: GaslessSpec): { action: number; data: string; hubPullWei: bigint } {
  switch (spec.kind) {
    case 'predict':
      return {
        action: ACTION[spec.kind],
        data: abi.encode(['address', 'tuple(uint32 gameId, bytes payload)[]'],
          [spec.referrer, spec.requests.map((r) => [r.gameId, r.payload])]),
        hubPullWei: BigInt(0),
      };
    case 'claim':
      return { action: ACTION[spec.kind], data: abi.encode(['address'], [spec.recipient]), hubPullWei: BigInt(0) };
    case 'transfer':
      return { action: ACTION[spec.kind], data: abi.encode(['address', 'uint256'], [spec.to, spec.amountWei]), hubPullWei: spec.amountWei };
    case 'delegatePrediction':
      return { action: ACTION[spec.kind], data: abi.encode(['address'], [spec.delegate]), hubPullWei: BigInt(0) };
    case 'setAllowedDelegator':
      return { action: ACTION[spec.kind], data: abi.encode(['address'], [spec.allowed]), hubPullWei: BigInt(0) };
    case 'setPredictorFee':
      return { action: ACTION[spec.kind], data: abi.encode(['uint16'], [spec.bps]), hubPullWei: BigInt(0) };
    case 'vote':
      // The hub burns the vote through the user's allowance to it, so the
      // standing allowance must cover the amount as well as the fee.
      return { action: ACTION[spec.kind], data: abi.encode(['uint32', 'uint256'], [spec.gameId, spec.amountWei]), hubPullWei: spec.amountWei };
  }
}

export type RelayQuote = {
  fee: string; relayer: string; nonce: number; deadline: number;
};

/**
 * The pay-in-SATORI routing decision, as a pure function of the wallet's
 * settings and whether it can cover this transaction's gas. Kept out of the
 * React hook so every branch is unit-testable (gasless.test.ts).
 *
 *  - 'normal': send through the wallet's own ETH (has ETH, or override off).
 *  - 'relay':  go gasless without asking (override on, or willing + no ETH).
 *  - 'prompt': out of ETH and no standing preference — ask.
 *
 * There is deliberately NO memory of a previous "no": declining just cancels
 * this one transaction, so the next out-of-ETH attempt asks again. Only "yes"
 * is remembered (it turns the willing setting on). `hasEth === null` means the
 * balance could not be read; we never route around the wallet on a guess, so
 * it falls to 'normal' and the wallet surfaces any real problem itself.
 */
export function chooseGasRoute(s: {
  always: boolean; willing: boolean; hasEth: boolean | null;
}): 'normal' | 'relay' | 'prompt' {
  if (s.always) return 'relay';
  if (s.hasEth === null) return 'normal';
  if (s.hasEth) return 'normal';
  if (s.willing) return 'relay';
  return 'prompt';
}

async function relayFetch(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init && {
    ...init, headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof body?.detail === 'string' ? body.detail : `relayer error ${res.status}`);
  }
  return body;
}

export async function getRelayQuote(
  relayerUrl: string, user: string, action: number, data: string,
): Promise<RelayQuote> {
  return relayFetch(`${relayerUrl}/gasless/quote`, {
    method: 'POST',
    body: JSON.stringify({ user, action, data }),
  });
}

/** Tx-shaped result so call sites can `await afterTx(tx)` unchanged. */
export type RelayedTx = { hash: string; wait: () => Promise<null> };

export async function submitRelay(opts: {
  relayerUrl: string;
  chainId: number;
  hubAddress: string;
  tokenAddress: string;
  /** Resilient read provider — allowance/balance reads and the permit's domain probe. */
  reader: ethers.Provider;
  signer: ethers.Signer;
  user: string;
  spec: GaslessSpec;
  quote: RelayQuote;
}): Promise<RelayedTx> {
  const { relayerUrl, chainId, hubAddress, tokenAddress, reader, signer, user, spec, quote } = opts;
  const { action, data, hubPullWei } = encodeAction(spec);
  const fee = BigInt(quote.fee);
  const needed = fee + hubPullWei;

  const erc20 = new ethers.Contract(tokenAddress, [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
  ], reader);

  if (needed > BigInt(0)) {
    const balance: bigint = await erc20.balanceOf(user);
    if (balance < needed) {
      throw new Error(
        `This needs ${ethers.formatEther(needed)} SATORI in your wallet` +
        (fee > BigInt(0) ? ` (includes the ${ethers.formatEther(fee)} SATORI relay fee)` : '') + '.');
    }
  }

  // Standing allowance to the hub: top up by signature when short, sized for
  // ~20 relays so most transactions need only the one relay signature.
  let permit: { value: string; deadline: number; signature: string } | null = null;
  if (needed > BigInt(0)) {
    const allowance: bigint = await erc20.allowance(user, hubAddress);
    if (allowance < needed) {
      const standing = needed > fee * BigInt(20) ? needed : fee * BigInt(20);
      const signed = await signPermit({
        tokenAddress, reader, signer, owner: user, spender: hubAddress, value: standing,
      });
      if (!signed) {
        throw new Error('Your wallet could not sign the SATORI fee authorization.');
      }
      permit = { value: signed.value.toString(), deadline: Number(signed.deadline), signature: signed.raw };
    }
  }

  // Signed over OUR inputs + only (fee, relayer, nonce, deadline) from the quote.
  const message = {
    user, action, data,
    fee: quote.fee,
    relayer: quote.relayer,
    nonce: quote.nonce,
    deadline: quote.deadline,
  };
  const domain = { name: 'SatoriHub', version: '1', chainId, verifyingContract: hubAddress };
  const signature = await signer.signTypedData(domain, RELAY_TYPES, message);

  const { transactionHash } = await relayFetch(`${relayerUrl}/gasless/submit`, {
    method: 'POST',
    body: JSON.stringify({
      user, action, data,
      fee: quote.fee, nonce: quote.nonce, deadline: quote.deadline,
      signature, permit,
    }),
  });

  return {
    hash: transactionHash,
    wait: async () => {
      for (let i = 0; i < 90; i++) {
        const s = await relayFetch(`${relayerUrl}/gasless/tx/${transactionHash}`);
        if (s.status === 'success') return null;
        if (s.status === 'reverted') throw new Error('The relayed transaction reverted on-chain.');
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error('Timed out waiting for the relayed transaction.');
    },
  };
}
