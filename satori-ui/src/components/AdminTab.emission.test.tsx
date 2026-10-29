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
      currentRound: 3, offchainShareBps: 5000, onChainRewardCeiling: BigInt(0), merkleReserveCeiling: BigInt(0), registrationFee: BigInt(1000000000000000),
      defaultStreamInitialized: true, airdropLoadedTotal: BigInt(0), airdropCap: E(1100000), airdropLoadingFinalized: false,
      airdropPointsHere: true, freezeAuthority: ADMIN,
      emission: {
        rateNow: E(846.62), rateNext: E(846.62), rateAfterStep: E(846.37),
        ratioWad: BigInt('999708061412966511'), stepsTaken: 0,
        issued: E(900000), issuedProjected: E(900000), nextStepAt: E(900846.62),
        stepsActive: true, holder: ADMIN, offchainShareBps: 5000, offchainNext: BigInt(0),
      },
    },
  });
});

it('reads out the schedule and says 0 is not allowed', () => {
  render(<AdminTab />);
  expect(screen.getByTestId('emission-ratio-current').textContent).toBe('×0.999708');
  const st = screen.getByTestId('emission-schedule-status').textContent!;
  expect(st).toMatch(/Issued so far: 900,000/);
  expect(st).toMatch(/Next step at: 900,846.62 issued/);
  expect(st).toMatch(/Rate after next step: 846.37\/round/);
  expect(screen.getByTestId('emission-ratio-zero-note').textContent).toMatch(/0 is not allowed/);
});

it('the default quick button sends exactly the default ratio', async () => {
  render(<AdminTab />);
  fireEvent.click(screen.getByTestId('btn-ratio-default'));
  fireEvent.click(screen.getByTestId('btn-set-emission-ratio'));
  await waitFor(() => expect(mockSetRatio).toHaveBeenCalledWith('0.999708061412966511'));
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

describe('airdrop: load (claimable at once), then finalize to close loading', () => {
  const btn = (id: string) => screen.getByTestId(id) as HTMLButtonElement;
  const typeBatch = () => fireEvent.change(screen.getByTestId('input-load-airdrop'), { target: { value: '0x00000000000000000000000000000000000000bb, 5' } });
  beforeEach(() => {
    mockOwner.data.airdropHolder = ADMIN;
    mockOwner.data.airdropLoadedTotal = E(1000);
    Object.assign(mockOwner, { isAirdropHolder: true, isFreezeAuthority: true });
  });

  it('the loader can load while the table is open', () => {
    render(<AdminTab />);
    typeBatch();
    expect((screen.getByTestId('input-load-airdrop') as HTMLTextAreaElement).disabled).toBe(false);
    expect(btn('btn-load-airdrop').disabled).toBe(false);
    expect(screen.queryByTestId('airdrop-load-closed')).toBeNull();
  });

  it('there is no freeze step anywhere on the page', () => {
    render(<AdminTab />);
    expect(screen.queryByTestId('btn-freeze-airdrop')).toBeNull();
    expect(screen.queryByTestId('input-freeze-total')).toBeNull();
    expect(screen.queryByTestId('airdrop-freeze-state')).toBeNull();
    expect(screen.queryByText(/Freeze Airdrop Door/)).toBeNull();
  });

  it('says rows are claimable as soon as they land', () => {
    render(<AdminTab />);
    expect(screen.getByText(/claim their whole allocation from the moment its batch lands/)).toBeTruthy();
  });

  it('after finalize Load is shut, with the reason', () => {
    mockOwner.data.airdropLoadingFinalized = true;
    render(<AdminTab />);
    typeBatch();
    expect((screen.getByTestId('input-load-airdrop') as HTMLTextAreaElement).disabled).toBe(true);
    expect(btn('btn-load-airdrop').disabled).toBe(true);
    expect(screen.getByTestId('airdrop-load-closed').textContent).toMatch(/table is closed \(finalized\).*nothing more can be loaded/);
  });

  it('a door pointing at another contract shuts Load and says why', () => {
    mockOwner.data.airdropPointsHere = false;
    render(<AdminTab />);
    typeBatch();
    expect(btn('btn-load-airdrop').disabled).toBe(true);
    expect(screen.getByTestId('airdrop-load-elsewhere')).toBeTruthy();
  });

  it('a refused batch stays in the box, with the reason', async () => {
    mockOwner.loadAirdropBatch = jest.fn().mockResolvedValue({ ok: false, error: 'Over the cap: test' });
    render(<AdminTab />);
    typeBatch();
    fireEvent.click(btn('btn-load-airdrop'));
    expect(await screen.findByText('Over the cap: test')).toBeTruthy();
    expect((screen.getByTestId('input-load-airdrop') as HTMLTextAreaElement).value).toMatch(/0x0+bb, 5/);
  });

  it('a loaded batch clears the box', async () => {
    mockOwner.loadAirdropBatch = jest.fn().mockResolvedValue({ ok: true });
    render(<AdminTab />);
    typeBatch();
    fireEvent.click(btn('btn-load-airdrop'));
    expect(await screen.findByText(/Loaded 1 airdrop allocation/)).toBeTruthy();
    expect(mockOwner.loadAirdropBatch).toHaveBeenCalledWith([{ address: '0x00000000000000000000000000000000000000bb', amountSatori: '5' }]);
    expect((screen.getByTestId('input-load-airdrop') as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the loaded total against the 1,100,000 ceiling', () => {
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-load-loaded').textContent).toBe('Loaded 1,000 of 1,100,000 SATORI.');
    expect(screen.getByTestId('airdrop-finalize-loaded').textContent).toBe('Loaded 1,000 of 1,100,000 SATORI.');
  });

  it('finalize is open to the loader before it runs, whatever the door', () => {
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-finalize-state').textContent).toBe('loading open');
    expect(btn('btn-finalize-airdrop').disabled).toBe(false);
  });

  it('only the loader can finalize', () => {
    mockOwner.isAirdropHolder = false;
    render(<AdminTab />);
    expect(btn('btn-finalize-airdrop').disabled).toBe(true);
  });

  it('after finalize: loading closed and the button stays shut', () => {
    mockOwner.data.airdropLoadingFinalized = true;
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-finalize-state').textContent).toBe('loading closed');
    expect(btn('btn-finalize-airdrop').disabled).toBe(true);
  });

  it('the finalize button calls finalizeAirdropLoading and reports loading closed', async () => {
    mockOwner.finalizeAirdropLoading = jest.fn().mockResolvedValue({ ok: true });
    render(<AdminTab />);
    fireEvent.click(btn('btn-finalize-airdrop'));
    expect(await screen.findByText(/Airdrop finalized\. Loading is closed\./)).toBeTruthy();
    expect(mockOwner.finalizeAirdropLoading).toHaveBeenCalled();
  });
});
