import { ethers } from 'ethers';

/// SatoriRewardsLens.emissionStatus(), as plain values.
export interface EmissionStatus {
  rateNow: bigint;
  rateNext: bigint;
  rateAfterStep: bigint;
  ratioWad: bigint;
  stepsTaken: number;
  issued: bigint;
  issuedProjected: bigint;
  nextStepAt: bigint;
  stepsActive: boolean;
  holder: string;
  offchainShareBps: number;
  /// What the off-chain share banks next round, in wei.
  offchainNext: bigint;
}

export function toEmissionStatus(r: any): EmissionStatus {
  return {
    rateNow: BigInt(r.rateNow),
    rateNext: BigInt(r.rateNext),
    rateAfterStep: BigInt(r.rateAfterStep),
    ratioWad: BigInt(r.ratioWad),
    stepsTaken: Number(r.stepsTaken),
    issued: BigInt(r.issued),
    issuedProjected: BigInt(r.issuedProjected),
    nextStepAt: BigInt(r.nextStepAt),
    stepsActive: Boolean(r.stepsActive),
    holder: String(r.holder),
    offchainShareBps: Number(r.offchainShareBps),
    offchainNext: BigInt(r.offchainNext),
  };
}

/// SatoriHub.DEFAULT_EMISSION_RATIO — the deploy-time step multiplier.
export const RATIO_DEFAULT = '0.999708061412966511';
export const RATIO_NEVER_CHANGE = '1';
const RATIO_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/// A multiplier typed as a decimal ("0.618", "2") to the hub's 1e18 fixed point,
/// within SatoriHub.setEmissionRatio's bound (0 to uint64 max).
export function parseRatioWad(s: string): bigint | { err: string } {
  const t = s.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t) && !/^\.\d{1,18}$/.test(t)) {
    return { err: 'Enter a multiplier like 0.999708, 1 or 1.0001 (up to 18 decimals)' };
  }
  const wad = ethers.parseUnits(t.startsWith('.') ? `0${t}` : t, 18);
  if (wad === BigInt(0)) return { err: '0 is not allowed: the hub rejects it. Use a tiny multiplier to wind emission down' };
  if (wad > RATIO_MAX) return { err: `The multiplier can be at most ${ethers.formatUnits(RATIO_MAX, 18)}` };
  return wad;
}

/// "0.999708" for the default, "1", "1.0001": six places, trailing zeros dropped.
/// Fewer would show the default as 0.9997, a different decline.
export function formatRatio(wad: bigint): string {
  const s = Number(ethers.formatUnits(wad, 18)).toFixed(6);
  if (wad > BigInt(0) && Number(s) === 0) return ethers.formatUnits(wad, 18);
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
