import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const E = (n: number) => BigInt(Math.round(n * 1e6)) * BigInt(1e12);
const ADMIN = '0x00000000000000000000000000000000000000aa';
const mockSetRatio = jest.fn();
const mockOwner: any = {};
jest.mock('../hooks/useOwner', () => ({
  useOwner: () => ({ setEmissionRatio: mockSetRatio, ...mockOwner }),
}));
jest.mock('../hooks/useStreamList', () => ({ useStreamList: () => ({ streams: [], reload: () => {} }) }));
jest.mock('../hooks/useGames', () => ({ useGames: () => ({ resolveGameId: async () => null }) }));
jest.mock('../hooks/useDeploymentRound', () => ({
  useDeploymentRound: () => 0,
  formatElapsedRound: (r: number) => String(r),
}));

// eslint-disable-next-line import/first
import { AdminTab } from './AdminTab';

const ZERO = '0x0000000000000000000000000000000000000000';

beforeEach(() => {
  mockSetRatio.mockReset();
  mockSetRatio.mockResolvedValue({ ok: true });
  Object.keys(mockOwner).forEach((k) => delete mockOwner[k]);
  Object.assign(mockOwner, {
    loading: false,
    isOwner: true,
    isEmissionHolder: true,
    data: {
      admin: ADMIN, emissionSplitHolder: ADMIN, emissionHolder: ADMIN, airdropHolder: ZERO,
      rootPublisher: ZERO, offchainReporter: ZERO, merkleWired: false,
      devFeeBpsMin: 500, devFeeBpsMax: 2500, pendingDevFeeBps: 0, platformFeeBps: 1500,
      protocolFeePerRound: E(127), platformFeeRecipient: ADMIN, emissionRatePerRound: E(846.62),
      currentRound: 3, offchainBudget: BigInt(0), onChainRewardCeiling: BigInt(0), merkleReserveCeiling: BigInt(0),
      defaultStreamInitialized: true, airdropLoadedTotal: BigInt(0), airdropClaimsOpenAt: BigInt(0),
      emission: {
        rateNow: E(846.62), rateNext: E(846.62), rateAfterStep: E(523.24),
        ratioWad: BigInt('618033988749894848'), stepsTaken: 0,
        issued: E(900000), issuedProjected: E(900000), nextStepAt: E(1236067.98),
        stepsActive: true, holder: ADMIN, dial: BigInt(0), dialEffective: BigInt(0),
      },
    },
  });
});

it('reads out the schedule and says 0 is not allowed', () => {
  render(<AdminTab />);
  expect(screen.getByTestId('emission-ratio-current').textContent).toBe('×0.618');
  const st = screen.getByTestId('emission-schedule-status').textContent!;
  expect(st).toMatch(/Issued so far: 900,000/);
  expect(st).toMatch(/Next step at: 1,236,067.98 issued/);
  expect(st).toMatch(/Rate after next step: 523.24\/round/);
  expect(screen.getByTestId('emission-ratio-zero-note').textContent).toMatch(/0 is not allowed/);
});

it('the default quick button sends exactly phi - 1', async () => {
  render(<AdminTab />);
  fireEvent.click(screen.getByTestId('btn-ratio-default'));
  fireEvent.click(screen.getByTestId('btn-set-emission-ratio'));
  await waitFor(() => expect(mockSetRatio).toHaveBeenCalledWith('0.618033988749894848'));
});

it('the never-change button sends 1; typing 0 disables the save', async () => {
  render(<AdminTab />);
  fireEvent.click(screen.getByTestId('btn-ratio-never-change'));
  expect((screen.getByTestId('btn-set-emission-ratio')).textContent).toBe('Set multiplier to 1');
  fireEvent.change(screen.getByTestId('input-emission-ratio'), { target: { value: '0' } });
  expect((screen.getByTestId('btn-set-emission-ratio') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/0 is not allowed: the hub rejects it/)).toBeTruthy();
});

it('is disabled for a wallet that is not the holder', () => {
  mockOwner.isEmissionHolder = false;
  render(<AdminTab />);
  expect((screen.getByTestId('input-emission-ratio') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByTestId('btn-ratio-default') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId('btn-ratio-never-change') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId('btn-set-emission-ratio') as HTMLButtonElement).disabled).toBe(true);
});
