import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import { ethers } from 'ethers';
import { AirdropClaimPanel } from './AirdropClaimPanel';

/// Claims open on the loader's finalize, which this page only learns about by
/// re-reading every 30s. One failed read must not hide the panel or stop that
/// poll, or a recipient sees nothing until they reload.

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
  chain = { alloc: E(100), claimable: BigInt(0), claimed: BigInt(0), fail: false };
  mockContracts = {
    reads: { airdrop: { target: AIRDROP } },
    cached: { live: {
      airdrop: {
        airdropAllocation: answer(() => chain.alloc),
        claimableAirdrop: answer(() => chain.claimable),
      },
      satori: { airdropMintedTo: answer(() => chain.claimed) },
    } },
    airdrop: { claimAirdrop: jest.fn() },
  };
});

afterEach(() => { jest.useRealTimers(); });

const reads = () => mockContracts.cached.live.airdrop.airdropAllocation.mock.calls.length;
const settle = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });
const poll = () => act(async () => { jest.advanceTimersByTime(30000); });

it('a failed re-read keeps the panel and the poll, and claims show once finalized', async () => {
  render(<AirdropClaimPanel />);
  expect(await screen.findByText(/Claims open when the airdrop is finalized/)).toBeTruthy();

  chain.fail = true;
  await poll();
  await waitFor(() => expect(reads()).toBe(2));
  await settle();
  expect(screen.getByTestId('airdrop-claim-panel')).toBeTruthy();

  chain.fail = false;
  chain.claimable = E(100);
  await poll();
  expect(await screen.findByText('Ready to claim.')).toBeTruthy();
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
