import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { useWallet } from './useWallet';
import { getAddresses, getRelayerUrl } from '../contracts/addresses';
import { GaslessSpec, RelayQuote, RelayedTx, chooseGasRoute, encodeAction, getRelayQuote, submitRelay } from '../lib/gasless';

/**
 * Pay-gas-in-SATORI orchestration (docs/design/gasless-relay.md, dapp side).
 *
 * Two per-wallet settings, both surfaced under advanced:
 *
 *  - `satoriWhenNoEth` ("willing"): pay in SATORI when the wallet cannot cover
 *    a transaction's gas. Turned on either from the toggle or by answering YES
 *    to the one-time prompt — and once on, it is on until the user turns it off.
 *  - `alwaysSatori` (override): every supported transaction relays, ETH or not.
 *    MANUAL ONLY — no code path ever sets it; only the toggle does.
 *
 * Answering NO is NOT remembered: it cancels this one transaction and nothing
 * more, so the next out-of-ETH attempt asks again (a user who declined by
 * mistake, or changed their mind, just retries). Only YES is remembered — it
 * turns `satoriWhenNoEth` on. Off by default; the only durable change a prompt
 * can make is turning it on.
 */

const key = (name: string, addr: string) => `satori.gas.${name}.v1.${addr.toLowerCase()}`;

function readFlag(name: string, addr: string | null): boolean {
  if (!addr) return false;
  try { return localStorage.getItem(key(name, addr)) === '1'; } catch { return false; }
}

function writeFlag(name: string, addr: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key(name, addr), '1');
    else localStorage.removeItem(key(name, addr));
  } catch { /* storage unavailable — session-only */ }
}

export const ADD_ETH_MESSAGE = 'Please add some ETH to your wallet to pay for transaction gas.';

// UX-branch gas ceilings (wei of gas, not a safety bound): "can this wallet
// plausibly pay for this action itself?" Predict matches useGasBalance's
// ROUND_GAS; the rest are generous single-call envelopes.
const GAS_BUDGET: Record<GaslessSpec['kind'], bigint> = {
  predict: BigInt(750_000),
  claim: BigInt(400_000),
  transfer: BigInt(80_000),
  delegatePrediction: BigInt(400_000),
  setAllowedDelegator: BigInt(120_000),
  setPredictorFee: BigInt(150_000),
  vote: BigInt(450_000),
};

type PromptState = { feeText: string; resolve: (yes: boolean) => void } | null;

type GaslessContextType = {
  /** Relayer configured for this chain — gates the entire surface. */
  enabled: boolean;
  willing: boolean;
  always: boolean;
  setWilling: (on: boolean) => void;
  setAlways: (on: boolean) => void;
  /**
   * Run a supported action, deciding gasless-vs-normal per the settings.
   * `fallback` is the existing untouched send; the result is tx-shaped either
   * way, so `await afterTx(tx)` at the call site works unchanged.
   */
  sendOrRelay: (spec: GaslessSpec, fallback: () => Promise<any>) => Promise<any>;
  prompt: PromptState;
};

const GaslessContext = createContext<GaslessContextType | null>(null);

export function GaslessProvider({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const { address, signer, provider, chainId } = wallet as any;
  const relayerUrl = useMemo(() => {
    try { return getRelayerUrl(chainId); } catch { return null; }
  }, [chainId]);

  const [willing, setWillingState] = useState(false);
  const [always, setAlwaysState] = useState(false);
  const [prompt, setPrompt] = useState<PromptState>(null);
  // The active prompt's resolver, so an unmount/wallet-switch can cancel it.
  const promptRef = useRef<PromptState>(null);

  useEffect(() => {
    setWillingState(readFlag('satoriWhenNoEth', address));
    setAlwaysState(readFlag('alwaysSatori', address));
    // A wallet switch orphans any open prompt — resolve it as "no" WITHOUT
    // recording a decline against either wallet.
    if (promptRef.current) {
      const p = promptRef.current;
      promptRef.current = null;
      setPrompt(null);
      p.resolve(false);
    }
  }, [address]);

  const setWilling = useCallback((on: boolean) => {
    if (!address) return;
    writeFlag('satoriWhenNoEth', address, on);
    setWillingState(on);
  }, [address]);

  const setAlways = useCallback((on: boolean) => {
    if (!address) return;
    writeFlag('alwaysSatori', address, on);
    setAlwaysState(on);
  }, [address]);

  const askUser = useCallback((feeText: string): Promise<boolean> => {
    return new Promise((resolve) => {
      const state = {
        feeText,
        resolve: (yes: boolean) => {
          promptRef.current = null;
          setPrompt(null);
          resolve(yes);
        },
      };
      promptRef.current = state;
      setPrompt(state);
    });
  }, []);

  const relay = useCallback(async (spec: GaslessSpec, quote: RelayQuote): Promise<RelayedTx> => {
    const addrs = getAddresses(chainId);
    return submitRelay({
      relayerUrl: relayerUrl!, chainId, hubAddress: addrs.hub, tokenAddress: addrs.token,
      reader: provider, signer, user: address, spec, quote,
    });
  }, [relayerUrl, chainId, provider, signer, address]);

  const sendOrRelay = useCallback(async (spec: GaslessSpec, fallback: () => Promise<any>) => {
    if (!relayerUrl || !address || !signer || !provider) return fallback();

    const quoteFor = async () => {
      const { action, data } = encodeAction(spec);
      return getRelayQuote(relayerUrl, address, action, data);
    };

    // "Has ETH" means "can plausibly pay for THIS transaction" — a dust balance
    // that cannot cover the send is functionally empty. null = unreadable.
    let hasEth: boolean | null = null;
    if (!always) {
      try {
        const [balance, feeData] = await Promise.all([
          provider.getBalance(address) as Promise<bigint>,
          provider.getFeeData(),
        ]);
        const gasPrice: bigint = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits('1', 'gwei');
        hasEth = balance >= gasPrice * GAS_BUDGET[spec.kind];
      } catch {
        hasEth = null;
      }
    }

    const route = chooseGasRoute({ always, willing, hasEth });

    if (route === 'normal') return fallback();
    if (route === 'relay') return relay(spec, await quoteFor());

    // route === 'prompt': fetch the real fee so the question shows an actual
    // price, then ask.
    let quote: RelayQuote;
    try {
      quote = await quoteFor();
    } catch {
      // Relayer down/refusing — there is nothing to offer.
      throw new Error(ADD_ETH_MESSAGE);
    }
    const yes = await askUser(`${ethers.formatEther(BigInt(quote.fee))} SATORI`);
    if (!yes) throw new Error(ADD_ETH_MESSAGE); // cancels this tx only; nothing remembered
    setWilling(true); // remembered: from now on, out of ETH = pay in SATORI
    return relay(spec, quote);
  }, [relayerUrl, address, signer, provider, always, willing, relay, askUser, setWilling]);

  const value = useMemo(() => ({
    enabled: !!relayerUrl, willing, always, setWilling, setAlways, sendOrRelay, prompt,
  }), [relayerUrl, willing, always, setWilling, setAlways, sendOrRelay, prompt]);

  return <GaslessContext.Provider value={value}>{children}</GaslessContext.Provider>;
}

export function useGasless(): GaslessContextType {
  const ctx = useContext(GaslessContext);
  if (!ctx) throw new Error('useGasless must be used within GaslessProvider');
  return ctx;
}
