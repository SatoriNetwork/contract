import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

// SatoriBounties.fundBounty reverts NamedGame on a named stream's game, so the
// create form must not offer it. The hooks are the seam (no RPC mock here).
jest.mock('../hooks/useContracts', () => ({ useContracts: () => ({ contracts: null, isConnected: false }) }));
jest.mock('../hooks/useWallet', () => ({ useWallet: () => ({ address: null }) }));
jest.mock('../hooks/useGames', () => ({ useGames: () => ({ resolveGameId: async () => 0 }) }));
jest.mock('../hooks/useAllBounties', () => ({
  ...jest.requireActual('../hooks/useAllBounties'),
  useAllBounties: () => ({ bounties: [], loading: false, reload: async () => {} }),
}));
jest.mock('../hooks/useBountyStakes', () => ({
  useBountyStakes: () => ({ entries: [], loading: false, acting: null, reload: async () => {}, fetchTokenMetadata: async () => null }),
}));
jest.mock('../hooks/useKnownTokens', () => ({ useKnownTokens: () => ({ tokens: [] }) }));

// eslint-disable-next-line import/first
import { BountiesTab } from './BountiesTab';
// eslint-disable-next-line import/first
import { NAMED_NO_BOUNTY } from '../lib/namedStream';

const STREAMS = [{ id: 2, name: 'ETH/USD' }, { id: 7, name: 'bitcoin', isNamed: true }];
const pick = (id: number) =>
  fireEvent.change(screen.getByTestId('create-bounty-stream'), { target: { value: String(id) } });

it('offers no bounty on a named stream, and says why', () => {
  render(<BountiesTab streams={STREAMS} onPredictStream={() => {}} />);
  pick(7);
  expect(screen.getByTestId('create-bounty-named')).toHaveTextContent(NAMED_NO_BOUNTY);
  expect(screen.getByTestId('create-bounty-review')).toBeDisabled();
});

it('leaves any other stream fundable', () => {
  render(<BountiesTab streams={STREAMS} onPredictStream={() => {}} />);
  pick(2);
  expect(screen.queryByTestId('create-bounty-named')).toBeNull();
  expect(screen.getByTestId('create-bounty-review')).not.toBeDisabled();
});
