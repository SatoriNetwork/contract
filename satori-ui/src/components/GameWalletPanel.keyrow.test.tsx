import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { GameWalletPanel } from './GameWalletPanel';

// THE BUG THIS FILE PINS. The backup screen that reveals the signing key is
// reachable exactly once — `setMode('backup')` fires only on the tap that
// GENERATES a key, and every exit from it lands on 'idle', which nothing
// returns from. So after setup the panel showed a truncated address and no key
// at all: no way to fund the address from elsewhere, import the key into
// another browser, or back it up late. Owner hit it on 2026-08-28: "I can't
// find my address anywhere."
//
// The panel reads everything from useWallet, and this repo wires no
// WalletProvider/RPC mock (see App.test.tsx), so that hook is the seam. The
// contract-dependent branches stay null here, which is fine: what is under test
// is that the address and key are REACHABLE on a wallet that already exists.

const ADDRESS = '0x1111111111111111111111111111111111111111';
const KEY = '0x' + 'ab'.repeat(32);

const mockWriteText = jest.fn();
let mockGw: any;

jest.mock('../hooks/useWallet', () => ({
  useWallet: () => ({
    gameWallet: mockGw,
    provider: { getBalance: jest.fn().mockResolvedValue(BigInt(0)), getFeeData: jest.fn() },
    mainSigner: null,
    mainAddress: null,
    lastExternalAddress: null,
    chainId: 84532,
    externalWallet: { name: 'MetaMask' },
  }),
}));
jest.mock('../hooks/useContracts', () => ({ useContracts: () => ({ contracts: null }) }));

const baseGw = {
  exists: true,
  unlocked: true,
  preferred: true,
  active: true,
  kind: 'generated',
  address: ADDRESS,
  privateKey: KEY,
  signer: {},
  resetNonces: jest.fn(),
  create: jest.fn(), importSecret: jest.fn(), unlock: jest.fn(), lock: jest.fn(),
  forget: jest.fn(), setPreferred: jest.fn(),
};

beforeEach(() => {
  mockWriteText.mockReset();
  Object.assign(navigator, { clipboard: { writeText: mockWriteText.mockResolvedValue(undefined) } });
  mockGw = { ...baseGw };
});

describe('an existing wallet can always surrender its address', () => {
  it('shows the address in full, not truncated', () => {
    render(<GameWalletPanel />);
    expect(screen.getByTestId('gw-full-address')).toHaveTextContent(ADDRESS);
  });

  it('offers it for copying — reading 42 hex characters off a screen is not a plan', () => {
    render(<GameWalletPanel />);
    fireEvent.click(screen.getByTestId('gw-copy-address'));
    expect(mockWriteText).toHaveBeenCalledWith(ADDRESS);
  });
});

describe('the key is reachable after setup, not only during it', () => {
  it('hides the key until asked', () => {
    render(<GameWalletPanel />);
    expect(screen.getByTestId('gw-key-value')).not.toHaveTextContent(KEY);
  });

  it('reveals it on tap, and hides it again', () => {
    render(<GameWalletPanel />);
    fireEvent.click(screen.getByTestId('gw-toggle-key'));
    expect(screen.getByTestId('gw-key-value')).toHaveTextContent(KEY);
    fireEvent.click(screen.getByTestId('gw-toggle-key'));
    expect(screen.getByTestId('gw-key-value')).not.toHaveTextContent(KEY);
  });

  it('copies the key without needing it revealed first', () => {
    render(<GameWalletPanel />);
    fireEvent.click(screen.getByTestId('gw-copy-key'));
    expect(mockWriteText).toHaveBeenCalledWith(KEY);
  });

  it('states the blast radius accurately — predictions and gas, not funds', () => {
    render(<GameWalletPanel />);
    expect(screen.getByText(/cannot touch them/i)).toBeInTheDocument();
  });
});

describe('while the keystore is locked', () => {
  beforeEach(() => { mockGw = { ...baseGw, unlocked: false, privateKey: null, signer: null }; });

  it('still gives up the address — that is what you fund', () => {
    render(<GameWalletPanel />);
    expect(screen.getByTestId('gw-full-address')).toHaveTextContent(ADDRESS);
  });

  it('offers no dead reveal button, and says why', () => {
    // The key genuinely is not in memory while locked, so a button here would
    // be a lie rather than a locked door.
    render(<GameWalletPanel />);
    expect(screen.queryByTestId('gw-toggle-key')).toBeNull();
    expect(screen.getByTestId('gw-key-locked')).toBeInTheDocument();
  });
});
