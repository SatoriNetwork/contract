import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const E = (n: number) => BigInt(Math.round(n * 1e6)) * BigInt(1e12);
const mockStatus: any = {};
const mockRound = {
  rewards: { offchainShareBps: () => Promise.resolve(BigInt(2000)) },
};
jest.mock('../hooks/useContracts', () => ({
  useContracts: () => ({
    contracts: {
      cached: {
        round: mockRound,
        live: { lens: { emissionStatus: () => Promise.resolve(mockStatus) } },
      },
    },
  }),
}));

// eslint-disable-next-line import/first
import { ScoringSplit } from './ScoringSplit';

const status = (over: Record<string, unknown> = {}) => Object.assign(mockStatus, {
  rateNow: E(846.62), rateNext: E(846.62), rateAfterStep: E(523.24),
  ratioWad: BigInt('618033988749894848'), stepsTaken: BigInt(0),
  issued: E(900000), issuedProjected: E(900000), nextStepAt: E(1236067.98),
  stepsActive: true, holder: '0x0000000000000000000000000000000000000001',
  offchainShareBps: BigInt(2000), offchainNext: E(143.92), ...over,
});

it('keeps the split lines and adds the emission schedule lines', async () => {
  status();
  render(<ScoringSplit />);
  await waitFor(() => expect(screen.getByTestId('emission-rate-now').textContent).toBe('846.62/round'));
  expect(screen.getByTestId('scoring-split-onchain').textContent).toBe('80%');
  expect(screen.getByTestId('scoring-split-offchain').textContent).toBe('20%');
  expect(screen.getByTestId('emission-issued').textContent).toBe('900,000');
  expect(screen.getByTestId('emission-next-step').textContent).toBe('1,236,067.98 issued');
  expect(screen.getByTestId('emission-rate-after-step').textContent).toBe('523.24/round');
});

it('shows the projected count and no step when the multiplier is 1', async () => {
  status({ issuedProjected: E(900100), stepsActive: false });
  render(<ScoringSplit />);
  await waitFor(() => expect(screen.getByTestId('emission-next-step').textContent).toBe('none'));
  expect(screen.getByTestId('emission-issued').textContent).toBe('900,000 (900,100 projected)');
  expect(screen.getByTestId('emission-rate-after-step').textContent).toBe('unchanged');
});

it('reads a fractional share as it is', async () => {
  mockRound.rewards.offchainShareBps = () => Promise.resolve(BigInt(3333));
  status();
  render(<ScoringSplit />);
  await waitFor(() => expect(screen.getByTestId('scoring-split-offchain').textContent).toBe('33.33%'));
  expect(screen.getByTestId('scoring-split-onchain').textContent).toBe('66.67%');
  mockRound.rewards.offchainShareBps = () => Promise.resolve(BigInt(2000));
});

it('explains the step every round\'s worth from day 1', async () => {
  status();
  render(<ScoringSplit />);
  await waitFor(() => expect(screen.getByTestId('emission-rate-now').textContent).toBe('846.62/round'));
  fireEvent.click(screen.getAllByRole('button', { name: 'More info' })[1]);
  expect(document.body.textContent).toContain('846.62 on day 1, then multiplied by the emission ratio each time another round’s worth');
});
