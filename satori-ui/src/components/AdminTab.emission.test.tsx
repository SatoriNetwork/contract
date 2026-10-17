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
      defaultStreamInitialized: true, airdropLoadedTotal: BigInt(0), airdropCap: E(1200000), airdropLoadingFinalized: false,
      airdropPointsHere: true, airdropFrozen: false, freezeAuthority: ADMIN, airdropMinted: BigInt(0),
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

describe('airdrop: load, freeze the door, then finalize', () => {
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

  it('the freeze closes the table: Load is shut, with the reason', () => {
    mockOwner.data.airdropFrozen = true;
    render(<AdminTab />);
    typeBatch();
    expect((screen.getByTestId('input-load-airdrop') as HTMLTextAreaElement).disabled).toBe(true);
    expect(btn('btn-load-airdrop').disabled).toBe(true);
    expect(screen.getByTestId('airdrop-load-closed').textContent).toMatch(/table is closed.*nothing more can be loaded/);
  });

  it('a door frozen to another contract closes this table too', () => {
    Object.assign(mockOwner.data, { airdropFrozen: true, airdropPointsHere: false });
    render(<AdminTab />);
    typeBatch();
    expect(btn('btn-load-airdrop').disabled).toBe(true);
  });

  it('after finalize Load stays shut', () => {
    Object.assign(mockOwner.data, { airdropFrozen: true, airdropLoadingFinalized: true });
    render(<AdminTab />);
    typeBatch();
    expect(btn('btn-load-airdrop').disabled).toBe(true);
    expect(screen.getByTestId('airdrop-load-closed').textContent).toMatch(/finalized/);
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

  it('shows the loaded total against the ceiling', () => {
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-freeze-loaded').textContent).toBe('Loaded 1,000 of 1,200,000 SATORI.');
    expect(screen.getByTestId('airdrop-finalize-loaded').textContent).toBe('Loaded 1,000 of 1,200,000 SATORI.');
    expect(screen.queryByTestId('airdrop-freeze-loaded-over')).toBeNull();
  });

  it('warns when the table is over the ceiling', () => {
    mockOwner.data.airdropLoadedTotal = E(1200001);
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-freeze-loaded-over').textContent).toMatch(/last claimers could not claim/);
    expect(screen.getByTestId('airdrop-finalize-loaded-over')).toBeTruthy();
    expect(btn('btn-freeze-airdrop').disabled).toBe(true);
  });

  it('counts airdrop minted outside this table against the ceiling before finalize', () => {
    Object.assign(mockOwner.data, { airdropLoadedTotal: E(1200000), airdropMinted: E(1) });
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-freeze-loaded-over')).toBeTruthy();
    expect(btn('btn-freeze-airdrop').disabled).toBe(true);
  });

  it('freeze is shut with nothing loaded', () => {
    mockOwner.data.airdropLoadedTotal = BigInt(0);
    render(<AdminTab />);
    expect(btn('btn-freeze-airdrop').disabled).toBe(true);
    expect(screen.getByTestId('airdrop-freeze-empty')).toBeTruthy();
  });

  it('finalize is shut, with the reason, until the door is frozen', () => {
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-freeze-state').textContent).toBe('not frozen');
    expect(btn('btn-freeze-airdrop').disabled).toBe(false);
    expect(btn('btn-finalize-airdrop').disabled).toBe(true);
    expect(screen.getByTestId('airdrop-finalize-blocked').textContent).toBe('Freeze the airdrop door first.');
  });

  it('once frozen to this airdrop, freeze is done and finalize opens', () => {
    mockOwner.data.airdropFrozen = true;
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-freeze-state').textContent).toBe('frozen');
    expect(screen.getByTestId('airdrop-finalize-state').textContent).toBe('table closed');
    expect(btn('btn-freeze-airdrop').disabled).toBe(true);
    expect(btn('btn-finalize-airdrop').disabled).toBe(false);
    expect(screen.queryByTestId('airdrop-finalize-blocked')).toBeNull();
  });

  it('a door pointing at another contract blocks both buttons and says to point it here', () => {
    mockOwner.data.airdropPointsHere = false;
    render(<AdminTab />);
    expect(btn('btn-freeze-airdrop').disabled).toBe(true);
    expect(btn('btn-finalize-airdrop').disabled).toBe(true);
    expect(screen.getByTestId('airdrop-finalize-blocked').textContent)
      .toBe('The airdrop door points at a different contract, or at none. If that is a corrected airdrop, update this page\'s address book; otherwise point the door here (setAirdrop) before freezing.');
    expect(btn('btn-load-airdrop').disabled).toBe(true);
    expect(screen.getByTestId('airdrop-load-elsewhere')).toBeTruthy();
  });

  it('a door frozen to another contract: nothing to freeze, and finalize can never open', () => {
    Object.assign(mockOwner.data, { airdropFrozen: true, airdropPointsHere: false });
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-freeze-state').textContent).toBe('frozen elsewhere');
    expect(btn('btn-freeze-airdrop').disabled).toBe(true);
    expect(btn('btn-finalize-airdrop').disabled).toBe(true);
    expect(screen.getByTestId('airdrop-finalize-blocked').textContent).toMatch(/can never be finalized/);
  });

  it('after finalize: claims open and the button stays shut', () => {
    Object.assign(mockOwner.data, { airdropFrozen: true, airdropLoadingFinalized: true });
    render(<AdminTab />);
    expect(screen.getByTestId('airdrop-finalize-state').textContent).toBe('claims open');
    expect(btn('btn-finalize-airdrop').disabled).toBe(true);
  });

  it('only the freeze authority can freeze', () => {
    mockOwner.isFreezeAuthority = false;
    render(<AdminTab />);
    expect(btn('btn-freeze-airdrop').disabled).toBe(true);
  });

  it('the freeze button sends freezeAirdrop', async () => {
    mockOwner.freezeAirdrop = jest.fn().mockResolvedValue({ ok: true });
    render(<AdminTab />);
    fireEvent.click(btn('btn-freeze-airdrop'));
    expect(await screen.findByText(/Airdrop door frozen/)).toBeTruthy();
    expect(mockOwner.freezeAirdrop).toHaveBeenCalledTimes(1);
  });
});
