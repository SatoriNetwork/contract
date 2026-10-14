import App from './App';
import { explainError } from './utils/errors';

// Smoke tests only — full UI render tests need a WalletProvider + RPC mock,
// which isn't wired up in this repo. This module's goal is just to confirm
// that the build graph imports cleanly (catches any TS/runtime-level export
// regression at test time) and that pure-function utilities behave.

test('App exports a function component', () => {
  expect(typeof App).toBe('function');
});

test('explainError maps a known custom error name', () => {
  expect(explainError({ revert: { name: 'Locked' } }))
    .toMatch(/Your tokens are locked/);
});

test('explainError falls back to message when no name is known', () => {
  expect(explainError({ message: 'something unexpected' }))
    .toBe('something unexpected');
});

test('explainError catches user-rejection patterns', () => {
  expect(explainError({ message: 'user rejected transaction' }))
    .toMatch(/rejected the transaction/);
});
