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
  dial: bigint;
  dialEffective: bigint;
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
    dial: BigInt(r.dial),
    dialEffective: BigInt(r.dialEffective),
  };
}

/// SatoriHub.PHI_INV — the deploy-time step multiplier.
export const RATIO_DEFAULT = '0.618033988749894848';
export const RATIO_NEVER_CHANGE = '1';
const RATIO_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);

/// A multiplier typed as a decimal ("0.618", "2") to the hub's 1e18 fixed point,
/// within SatoriHub.setEmissionRatio's bound (0 to uint64 max).
export function parseRatioWad(s: string): bigint | { err: string } {
  const t = s.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t) && !/^\.\d{1,18}$/.test(t)) {
    return { err: 'Enter a multiplier like 0.618, 1 or 2 (up to 18 decimals)' };
  }
  const wad = ethers.parseUnits(t.startsWith('.') ? `0${t}` : t, 18);
  if (wad === BigInt(0)) return { err: '0 is not allowed: the hub rejects it. Use a tiny multiplier to wind emission down' };
  if (wad > RATIO_MAX) return { err: `The multiplier can be at most ${ethers.formatUnits(RATIO_MAX, 18)}` };
  return wad;
}

/// "0.618" for φ−1, "1", "2": four places, trailing zeros dropped.
export function formatRatio(wad: bigint): string {
  const s = Number(ethers.formatUnits(wad, 18)).toFixed(4);
  if (wad > BigInt(0) && Number(s) === 0) return ethers.formatUnits(wad, 18);
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}
