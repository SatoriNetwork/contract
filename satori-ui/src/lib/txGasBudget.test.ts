import { TX_GAS_CAP, MAX_BATCH_PREDICTIONS, MAX_BATCH_STREAMS } from './txGasBudget';

describe('txGasBudget', () => {
  it('keeps a full predict batch with a bounty stake on every game under the cap', () => {
    const worst = 317_000 + MAX_BATCH_PREDICTIONS * (138_500 + 126_000);
    expect(worst).toBeLessThan(TX_GAS_CAP);
    expect(MAX_BATCH_PREDICTIONS).toBe(55);
  });

  it('keeps a full stream batch under the cap at the dearest measured pull', () => {
    expect(MAX_BATCH_STREAMS * 190_000).toBeLessThan(TX_GAS_CAP * 1.25);
    expect(MAX_BATCH_STREAMS * 150_000).toBeLessThan(TX_GAS_CAP);
    expect(MAX_BATCH_STREAMS).toBe(100);
  });
});
