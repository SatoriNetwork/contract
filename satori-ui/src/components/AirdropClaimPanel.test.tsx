import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { ethers } from 'ethers';
import { AirdropClaimPanel } from './AirdropClaimPanel';

/// An allocation is claimable from the moment it is loaded, so the panel shows
/// the claim at once. A failed read is retried every 30s and must not hide the
/// panel, or a recipient sees nothing until they reload.

const AIRDROP = '0x' + '66'.repeat(20);
const E = (n: number) => ethers.parseEther(String(n));

let mockContracts: any;
let chain: { alloc: bigint; claimable: bigint; claimed: bigint; fail: boolean };

jest.mock('../hooks/useContracts', () => ({ useContracts: () => ({ contracts: mockContracts }) }));
jest.mock('../hooks/useWallet', () => ({ useWallet: () => ({ address: '0x' + '44'.repeat(20) }) }));
jest.mock('../lib/afterTx', () => ({ afterTx: async (tx: unknown) => tx }));

const answer = (v: () => bigint) => jest.fn(async () => {
  if (chain.fail) throw new Error('rpc down');
  return v();
});

beforeEach(() => {
  jest.useFakeTimers();
  chain = { alloc: E(100), claimable: E(100), claimed: BigInt(0), fail: false };
  mockContracts = {
    reads: { airdrop: { target: AIRDROP } },
    cached: { live: {
      airdrop: {
        airdropAllocation: answer(() => chain.alloc),
        claimableAirdrop: answer(() => chain.claimable),
      },
      satori: { airdropMintedTo: answer(() => chain.claimed) },
    } },
    airdrop: { claimAirdrop: jest.fn(async () => ({ hash: '0xc' })) },
  };
});

afterEach(() => { jest.useRealTimers(); });

const reads = () => mockContracts.cached.live.airdrop.airdropAllocation.mock.calls.length;
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const poll = () => act(async () => { jest.advanceTimersByTime(30000); });

it('a loaded allocation is ready to claim at once, with no finalize wording', async () => {
  render(<AirdropClaimPanel />);
  expect(await screen.findByText('Ready to claim.')).toBeTruthy();
  expect((screen.getByTestId('btn-claim-airdrop') as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByTestId('btn-claim-airdrop').textContent).toMatch(/Claim 100\.00 SATORI/);
  expect(screen.queryByText(/finalized/)).toBeNull();
});

it('no poll while nothing has failed', async () => {
  render(<AirdropClaimPanel />);
  await screen.findByText('Ready to claim.');
  await poll();
  await settle();
  expect(reads()).toBe(1);
});

it('a failed re-read after a claim keeps the panel and polls until it answers', async () => {
  render(<AirdropClaimPanel />);
  await screen.findByText('Ready to claim.');

  chain.fail = true;
  fireEvent.click(screen.getByTestId('btn-claim-airdrop'));
  await waitFor(() => expect(reads()).toBe(2));
  await settle();
  expect(screen.getByTestId('airdrop-claim-panel')).toBeTruthy();

  chain.fail = false;
  chain.claimable = BigInt(0);
  chain.claimed = E(100);
  await poll();
  expect(await screen.findByText('Your airdrop is claimed.')).toBeTruthy();
});

it('owed but not claimable here (the token points elsewhere) says so and shuts the button', async () => {
  chain.claimable = BigInt(0);
  render(<AirdropClaimPanel />);
  expect(await screen.findByText('Not claimable from this airdrop contract.')).toBeTruthy();
  expect((screen.getByTestId('btn-claim-airdrop') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByTestId('btn-claim-airdrop').textContent).toBe('Not claimable');
});

it('a first read that fails is retried, and the panel appears when it answers', async () => {
  chain.fail = true;
  render(<AirdropClaimPanel />);
  await settle();
  expect(screen.queryByTestId('airdrop-claim-panel')).toBeNull();

  chain.fail = false;
  await poll();
  expect(await screen.findByTestId('airdrop-claim-panel')).toBeTruthy();
});

it('a chain with no airdrop contract reads nothing and polls nothing', async () => {
  mockContracts.reads.airdrop.target = ethers.ZeroAddress;
  render(<AirdropClaimPanel />);
  await settle();
  await poll();
  expect(reads()).toBe(0);
  expect(screen.queryByTestId('airdrop-claim-panel')).toBeNull();
});
