import { payoutForStream, ROUND_REWARD_BUDGET, payableBudget, scoringSplit } from './roundPayout';

// These pin the three separate mistakes that were live in StreamsTab at once
// (found 2026-08-03). Each `it` below fails against the old implementation.
//
// The old line was:
//     (s.weight / totalEligibleWeight) * 1440
// where `s.weight` was the LIVE gameWeight and `totalEligibleWeight` summed
// LIVE weights over the LIVE eligible heap. (In the 12h era 1440 was also the
// daily figure, not the round one — at 24h rounds that particular mistake is
// no longer expressible: round and day coincide.)

// Written out rather than 10n ** 18n: the production tsconfig targets es5, where
// `**` on a bigint is a compile error, and `react-scripts build` typechecks test
// files even though Jest transpiles them separately. Green tests, red build.
const ONE = BigInt('1000000000000000000');
const wei = (n: number) => BigInt(n) * ONE;

// A stand-in round pool. The old tests ran everything against the 1440 default
// `payoutForStream` used to carry; there is no default any more (the envelope is
// not the pool), so the budget is passed explicitly everywhere below. The exact
// figure does not matter to any of these properties — they are all shares of it.
const POOL = 1440;

describe('ROUND_REWARD_BUDGET', () => {
  it('is 1440 — the token\'s outer ENVELOPE, not the emission rate', () => {
    // TIME_UNIT_SECONDS = 86400, ROUND_REWARD_BUDGET = 1440 ether on the
    // immutable SatoriToken: the constitutional ceiling a round may never
    // exceed. The actual per-round emission is SatoriHub's issuance-indexed
    // schedule, which starts at 846.62 and steps by the emission ratio as
    // SATORI is issued, never above this — so this constant must never be used
    // as a payout base.
    expect(ROUND_REWARD_BUDGET).toBe(1440);
  });
});

describe('payoutForStream', () => {
  it('splits the round budget by share of the GOVERNING round total', () => {
    const votes = new Map([[1, wei(25)], [2, wei(75)]]);
    const total = wei(100);
    expect(payoutForStream(1, votes, total, POOL)).toBeCloseTo(POOL * 0.25);
    expect(payoutForStream(2, votes, total, POOL)).toBeCloseTo(POOL * 0.75);
  });

  it('pays the whole budget to a lone eligible stream', () => {
    // With a single game the frozen and live sets agree and the share is 1.0
    // either way — which is why the live-weight bug was invisible on a
    // one-stream testnet. Only the budget scale showed, and only if you knew
    // what the number should be.
    const votes = new Map([[1, wei(1)]]);
    expect(payoutForStream(1, votes, wei(1), POOL)).toBeCloseTo(POOL);
  });

  it('returns 0 for a stream missing from the governing snapshot', () => {
    // NOT a missing-data fallback. A game that became eligible after the
    // snapshot earns nothing this round (ISatoriVoting: "games that become
    // eligible AFTER this snapshot cannot earn rewards for the round"), so 0
    // is the true answer. Showing it a live-heap share would promise SATORI
    // the contract will not mint.
    const votes = new Map([[1, wei(100)]]);
    expect(payoutForStream(999, votes, wei(100), POOL)).toBe(0);
  });

  it('returns 0 rather than dividing by zero when the round never locked', () => {
    expect(payoutForStream(1, new Map([[1, wei(5)]]), BigInt(0), POOL)).toBe(0);
  });

  it('ignores live weight entirely — only the frozen votes count', () => {
    // The regression that matters most. Votes cast DURING the current round
    // move voting.gameWeight but cannot move getGameVotesAtRound(gid, gov),
    // because the governing round's numerators were frozen at its lock. A
    // payout computed from live weight drifts from the paid amount the moment
    // anyone votes; this function has no way to be given live weight at all.
    const frozen = new Map([[1, wei(50)], [2, wei(50)]]);
    const total = wei(100);
    // Stream 1 could have 10x the live weight by now — the answer is unchanged.
    expect(payoutForStream(1, frozen, total, POOL)).toBeCloseTo(POOL / 2);
    expect(payoutForStream(2, frozen, total, POOL)).toBeCloseTo(POOL / 2);
    // And the two still sum to the full round budget, never above it.
    expect(payoutForStream(1, frozen, total, POOL) + payoutForStream(2, frozen, total, POOL))
      .toBeCloseTo(POOL);
  });

  it('never sums above the round budget across the eligible set', () => {
    // Conservation: Σ allocations ≤ budget is what stops the UI implying more
    // SATORI than a round can mint.
    const votes = new Map([[1, wei(10)], [2, wei(20)], [3, wei(70)]]);
    const total = wei(100);
    const sum = [1, 2, 3].reduce((a, id) => a + payoutForStream(id, votes, total, POOL), 0);
    expect(sum).toBeLessThanOrEqual(POOL + 1e-9);
  });
});

// The emission is a MINT, not a payout: the dev fee and the off-chain dial come
// off before the games see anything. All three terms are read from the chain —
// the emission included, since it is SatoriHub's issuance-indexed schedule and
// not a constant this file can know.
describe('payableBudget', () => {
  it('takes the dev fee and the off-chain dial off the EMISSION, not the envelope', () => {
    // Nothing else is reserved: _computeRoundBudget(gross) returns gross.
    expect(payableBudget(1000, 150, 10)).toBeCloseTo(840, 9);
  });

  it('IS the whole emission when both the fee and the dial are zero', () => {
    // The first-predictor bonus is gone from the contracts, so unlike the 12h
    // era there is no always-on reservation left: gross flows through whole.
    expect(payableBudget(846.62, 0, 0)).toBeCloseTo(846.62, 9);
  });

  it('is driven by the emission, NOT by ROUND_REWARD_BUDGET', () => {
    // The regression this file exists to stop repeating. `payableBudget` used
    // to start from the 1440 constant, so an emission below the envelope would
    // have been displayed at the envelope's size — overstating every payout.
    const stepped = ROUND_REWARD_BUDGET * 0.2;
    expect(payableBudget(stepped, 0, 0)).toBeCloseTo(stepped, 9);
    expect(payableBudget(stepped, 0, 0)).toBeLessThan(ROUND_REWARD_BUDGET);
  });

  it('never goes negative if the dials are cranked past the mint', () => {
    expect(payableBudget(1000, 900, 200)).toBe(0);
  });
});

// The value-provider cut is GONE from the contracts — no StreamMeta field, no getter,
// no setter, nothing paid to providers — so a stream's whole allocation reaches its
// predictors. These pin that there is no deduction left anywhere in the payout math.
describe('payoutForStream pays the full allocation (no provider cut)', () => {
  const ONE_ = BigInt('1000000000000000000');
  it('gives a sole eligible stream the entire budget', () => {
    const votes = new Map([[1, ONE_]]);
    expect(payoutForStream(1, votes, ONE_, 1142)).toBeCloseTo(1142, 6);
  });

  it('splits strictly by vote share with nothing skimmed', () => {
    const votes = new Map([[1, ONE_], [2, ONE_ * BigInt(3)]]);
    const total = ONE_ * BigInt(4);
    expect(payoutForStream(1, votes, total, 1200)).toBeCloseTo(300, 6);
    expect(payoutForStream(2, votes, total, 1200)).toBeCloseTo(900, 6);
  });
});

describe('scoringSplit', () => {
  it('is all on-chain when the dial is zero', () => {
    expect(scoringSplit(wei(846), wei(127), BigInt(0))).toEqual({ onChain: 100, offChain: 0 });
  });

  it('is a share of the residual after the dev fee, not of the emission', () => {
    // Dial at half the residual reads 50/50, though it is only ~42% of emission.
    expect(scoringSplit(wei(846), wei(126), wei(360))).toEqual({ onChain: 50, offChain: 50 });
  });

  it('reads 50/50 for the floored half of an odd-wei residual', () => {
    const residual = wei(719) + BigInt(1);
    expect(scoringSplit(residual + wei(127), wei(127), residual / BigInt(2))).toEqual({ onChain: 50, offChain: 50 });
  });

  it('always sums to 100', () => {
    const s = scoringSplit(wei(900), wei(135), wei(255));
    expect(s.onChain + s.offChain).toBe(100);
  });

  it('a dial left above a stepped-down residual reads as the residual, as the chain yields it', () => {
    // Dial set at the base rate's max (residual - 1), then a step to 523.24.
    const cents = (n: number) => BigInt(Math.round(n * 100)) * ONE / BigInt(100);
    expect(scoringSplit(cents(523.24), cents(78.49), cents(719.63))).toEqual({ onChain: 0, offChain: 100 });
  });

  it('is all on-chain when nothing is left after the fee', () => {
    expect(scoringSplit(wei(100), wei(100), BigInt(0))).toEqual({ onChain: 100, offChain: 0 });
  });
});
