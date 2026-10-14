import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The page reads its whole world from useOwner, and this repo wires no
// WalletProvider/RPC mock (see App.test.tsx), so the hook is the seam.
// `mock`-prefixed names: jest hoists this factory above the imports and refuses
// to close over anything else.
const mockReport = jest.fn();
const mockReload = jest.fn();
const mockSetRoot = jest.fn();
const mockSetPublisher = jest.fn();
// Mutable so each test can pose a different Merkle world without re-mocking.
const mockOwner: any = {};
jest.mock('../hooks/useOwner', () => ({
  useOwner: () => ({
    reportOffchainPredictions: mockReport,
    reload: mockReload,
    setMerkleRoot: mockSetRoot,
    setRootPublisher: mockSetPublisher,
    ...mockOwner,
  }),
}));

// eslint-disable-next-line import/first
import { OffchainTab } from './OffchainTab';

const type = (v: string) =>
  fireEvent.change(screen.getByTestId('input-offchain-count'), { target: { value: v } });
const btn = () => screen.getByTestId('btn-report-offchain') as HTMLButtonElement;

const ZERO_ROOT = '0x' + '0'.repeat(64);
const PUBLISHER = '0xc0c06055f4Ddc55C81aeA0f86e7620f5a4C87594';

beforeEach(() => {
  mockReport.mockReset();
  mockReload.mockReset();
  mockSetRoot.mockReset();
  mockSetPublisher.mockReset();
  mockSetRoot.mockResolvedValue({ ok: true });
  mockReport.mockResolvedValue({ ok: true });
  // Default: the shape this deployment is actually in — no Merkle contract.
  Object.keys(mockOwner).forEach((k) => delete mockOwner[k]);
  mockOwner.data = { merkleWired: false, merkleRoot: ZERO_ROOT, rootPublisher: ZERO_ROOT.slice(0, 42) };
  mockOwner.isRootPublisher = false;
});

// The Merkle half of the page. It shares a tab with off-chain reporting because
// it is the same operator's job, but it is gated on a DIFFERENT on-chain role
// (rootPublisher, not offchainReporter), so all three states below are reachable
// by someone who can legitimately see this page.
describe('the Merkle channel section', () => {
  it('says the channel is not deployed rather than showing a dead form', () => {
    render(<OffchainTab />);
    // SatoriMerkle is skipped at deploy time when ROOT_PUBLISHER is unset, so
    // there is no contract to publish to. A greyed-out input would read as a
    // permissions problem the operator could fix by switching wallets.
    expect(screen.getByTestId('merkle-not-wired')).toBeInTheDocument();
    expect(screen.queryByTestId('btn-set-merkle-root')).not.toBeInTheDocument();
  });

  it('shows the controls read-only when wired but you are not the publisher', () => {
    mockOwner.data = { merkleWired: true, merkleRoot: ZERO_ROOT, rootPublisher: PUBLISHER };
    mockOwner.isRootPublisher = false;
    render(<OffchainTab />);
    expect(screen.getByTestId('not-root-publisher')).toBeInTheDocument();
    expect(screen.getByTestId('btn-set-merkle-root')).toBeDisabled();
  });

  it('publishes a root when you hold the publisher key', async () => {
    mockOwner.data = { merkleWired: true, merkleRoot: ZERO_ROOT, rootPublisher: PUBLISHER };
    mockOwner.isRootPublisher = true;
    render(<OffchainTab />);
    const root = '0x' + 'ab'.repeat(32);
    fireEvent.change(screen.getByPlaceholderText(/32-byte Merkle root/i), { target: { value: root } });
    fireEvent.click(screen.getByTestId('btn-set-merkle-root'));
    await waitFor(() => expect(mockSetRoot).toHaveBeenCalledWith(root));
    // A published root changes what is claimable, so the page must re-read.
    await waitFor(() => expect(mockReload).toHaveBeenCalled());
  });
});

describe('what the reporter is allowed to submit', () => {
  it('refuses anything that is not a whole positive number', () => {
    render(<OffchainTab />);
    // The contract takes a uint64. A decimal, a negative, or a zero would either
    // fail at encoding with a worse message or waste a transaction on a no-op.
    for (const bad of ['0', '-5', '1.5', 'abc', ' ']) {
      type(bad);
      expect(btn().disabled).toBe(true);
    }
  });

  it('accepts a whole number', () => {
    render(<OffchainTab />);
    type('250');
    expect(btn().disabled).toBe(false);
  });

  it('starts disabled, with nothing typed', () => {
    render(<OffchainTab />);
    expect(btn().disabled).toBe(true);
  });

  it('explains a rejected entry rather than just greying the button out', () => {
    render(<OffchainTab />);
    type('1.5');
    expect(screen.getByTestId('report-invalid')).toBeInTheDocument();
  });

  it('says nothing about validity before anything is typed', () => {
    render(<OffchainTab />);
    expect(screen.queryByTestId('report-invalid')).toBeNull();
  });
});

describe('submitting', () => {
  it('passes the number through untouched', async () => {
    render(<OffchainTab />);
    type('250');
    fireEvent.click(btn());
    await waitFor(() => expect(mockReport).toHaveBeenCalledWith('250'));
  });

  it('confirms what landed, and clears the box so a stray second click cannot double it', async () => {
    render(<OffchainTab />);
    type('250');
    fireEvent.click(btn());
    await waitFor(() => expect(screen.getByTestId('report-result')).toHaveTextContent('Added 250'));
    expect((screen.getByTestId('input-offchain-count') as HTMLInputElement).value).toBe('');
  });

  it('surfaces a failure instead of implying success', async () => {
    mockReport.mockResolvedValue({ ok: false, error: 'NotOffchainReporter' });
    render(<OffchainTab />);
    type('7');
    fireEvent.click(btn());
    await waitFor(() => expect(screen.getByTestId('report-result')).toHaveTextContent('NotOffchainReporter'));
  });

  it('leaves the number in the box when it failed, so it can be retried', async () => {
    mockReport.mockResolvedValue({ ok: false, error: 'nope' });
    render(<OffchainTab />);
    type('7');
    fireEvent.click(btn());
    await waitFor(() => expect(screen.getByTestId('report-result')).toBeInTheDocument());
    expect((screen.getByTestId('input-offchain-count') as HTMLInputElement).value).toBe('7');
  });
});

describe('the two things that bite', () => {
  // Both are consequences of the contract adding to an UNSIGNED counter, and
  // both are irreversible, so they belong above the button rather than in a
  // tooltip someone opens after the fact.
  it('warns that reporting accumulates rather than replaces', () => {
    render(<OffchainTab />);
    expect(screen.getByText(/does not replace a previous figure/i)).toBeInTheDocument();
  });

  it('warns that it cannot be subtracted', () => {
    render(<OffchainTab />);
    expect(screen.getByText(/no way to subtract/i)).toBeInTheDocument();
  });

  it('says plainly that no money moves', () => {
    // The counter is display-only. Someone handed this key should know its
    // blast radius is exactly "the participation figure goes up".
    render(<OffchainTab />);
    expect(screen.getByText(/mints tokens, moves\s+rewards, or changes anyone/i)).toBeInTheDocument();
  });
});
