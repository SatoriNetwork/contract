import { planBountyFunding, planBountyStake, AllowanceReaders } from './bountyAllowances';

const SATORI = '0x1111111111111111111111111111111111111111';
const BOUNTIES = '0x2222222222222222222222222222222222222222';
const HUB = '0x3333333333333333333333333333333333333333';
const USDC = '0x4444444444444444444444444444444444444444';

const ONE = BigInt('1000000000000000000');
const FEE = BigInt(12) * ONE;
const AMOUNT = BigInt(100) * ONE;

function readers(over: Partial<AllowanceReaders> = {}): AllowanceReaders {
  return {
    allowance: async () => BigInt(0),
    postingFeeApplies: async () => true,
    postingFee: async () => FEE,
    ...over,
  };
}

const base = {
  gameId: 7,
  token: USDC,
  amount: AMOUNT,
  symbol: 'USDC',
  decimals: 18,
  satoriAddress: SATORI,
  bountiesAddress: BOUNTIES,
  hubAddress: HUB,
};

describe('planBountyFunding', () => {
  it('asks for BOTH allowances on a first non-SATORI post — the case that used to revert', async () => {
    const steps = await planBountyFunding(base, readers());
    expect(steps.map((s) => s.kind)).toEqual(['token', 'satori']);

    const [tok, sat] = steps;
    expect(tok.spender).toBe(BOUNTIES);
    expect(tok.amount).toBe(AMOUNT);

    // The fee is approved on SATORI to the HUB — a different token AND a
    // different spender from the bounty amount. Getting either wrong reverts.
    expect(sat.token).toBe(SATORI);
    expect(sat.spender).toBe(HUB);
    expect(sat.amount).toBe(FEE);
  });

  it('skips the fee for a top-up, because the contract says it does not apply', async () => {
    const steps = await planBountyFunding(base, readers({ postingFeeApplies: async () => false }));
    expect(steps.map((s) => s.kind)).toEqual(['token']);
  });

  it('never asks for the fee when funding IN SATORI, without even querying', async () => {
    let queried = false;
    const steps = await planBountyFunding(
      { ...base, token: SATORI, symbol: 'SATORI' },
      readers({ postingFeeApplies: async () => { queried = true; return true; } }),
    );
    expect(steps.map((s) => s.kind)).toEqual(['token']);
    expect(queried).toBe(false);
  });

  it('assumes the fee applies when the contract cannot tell', async () => {
    // An older deployment without `postingFeeApplies`, or a failed read. An
    // unnecessary approval leaves a small spare allowance; a missing one is a
    // revert with no explanation, so over-asking is the safe direction.
    const steps = await planBountyFunding(base, readers({ postingFeeApplies: async () => null }));
    expect(steps.map((s) => s.kind)).toEqual(['token', 'satori']);
  });

  it('omits an allowance that is already sufficient', async () => {
    const steps = await planBountyFunding(
      base,
      readers({
        allowance: async (token) => (token === USDC ? AMOUNT : BigInt(0)),
      }),
    );
    expect(steps.map((s) => s.kind)).toEqual(['satori']);
  });

  it('returns nothing to do when both allowances are already in place', async () => {
    const steps = await planBountyFunding(base, readers({ allowance: async () => AMOUNT * BigInt(10) }));
    expect(steps).toEqual([]);
  });

  it('treats an EXACT allowance as sufficient, not as needing a top-up', async () => {
    const steps = await planBountyFunding(
      base,
      readers({ allowance: async (t) => (t === USDC ? AMOUNT : FEE) }),
    );
    expect(steps).toEqual([]);
  });

  it('skips the fee step when the hub quotes zero', async () => {
    const steps = await planBountyFunding(base, readers({ postingFee: async () => BigInt(0) }));
    expect(steps.map((s) => s.kind)).toEqual(['token']);
  });

  it('matches the funding token case-insensitively against SATORI', async () => {
    const steps = await planBountyFunding(
      { ...base, token: SATORI.toUpperCase().replace('0X', '0x') },
      readers(),
    );
    expect(steps.map((s) => s.kind)).toEqual(['token']);
  });

  it('labels each step with what the user is about to sign', async () => {
    const steps = await planBountyFunding(base, readers());
    expect(steps[0].label).toBe('Approve 100 USDC');
    expect(steps[1].label).toBe('Approve 12 SATORI posting fee');
  });
});

describe('planBountyStake', () => {
  it('asks for one approval when the allowance is short', async () => {
    const steps = await planBountyStake(
      { token: USDC, amount: AMOUNT, symbol: 'USDC', decimals: 18, bountiesAddress: BOUNTIES },
      { allowance: async () => BigInt(0) },
    );
    expect(steps).toHaveLength(1);
    expect(steps[0].spender).toBe(BOUNTIES);
  });

  it('asks for nothing when the allowance already covers it', async () => {
    const steps = await planBountyStake(
      { token: USDC, amount: AMOUNT, bountiesAddress: BOUNTIES },
      { allowance: async () => AMOUNT },
    );
    expect(steps).toEqual([]);
  });
});
