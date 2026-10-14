import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import NameSuggest, { submitNameOf, nameBlocker, useNamedNameTaken, type NamedNameRegistry } from './NameSuggest';
import type { StreamBasic } from '../hooks/useStreamList';
import { localIdOf } from '../lib/coinedName';

/// The name box for a NAMED stream: lowercase by default (a phone's capital is
/// not a decision), what already exists shown while typing so a near-duplicate
/// is a choice and not an accident, and the chain's refusals said before the
/// send.

const realFetch = (global as any).fetch;

const stream = (id: number, name: string, isNamed = true): StreamBasic =>
  ({ id, name, isNamed, provider: '', streamType: 1, currentValue: 0, valueHour: 0, weight: 0,
     approved: true, minCadenceMinutes: 60, adapterId: 9, isCommunityAdapter: false, config: '0x' });

type Term = { id: string; text: string; hashed: boolean; pile: string };
const term = (text: string, pile = '420000000000000000'): Term =>
  ({ id: localIdOf(text), text, hashed: false, pile });

/// The real indexer's shape: `/search` never carries the exact typed text,
/// and `/names?ids=` answers only for the ids asked.
type Routes = { names?: Term[]; coined?: Term[]; search?: Term[]; lookalike?: Term[]; down?: boolean };
function mockCoined(r: Routes) {
  (global as any).fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (r.down) throw new Error('connection refused');
    const ids = url.match(/[?&]ids=([^&]*)/);
    const body = ids ? (r.coined ?? []).filter((t) => decodeURIComponent(ids[1]).split(',').includes(t.id))
      : url.includes('/names') ? r.names ?? []
      : url.includes('/search') ? r.search ?? []
      : url.includes('/lookalike') ? r.lookalike ?? []
      : null;
    return { ok: body !== null, status: body !== null ? 200 : 404, json: async () => body };
  });
}

let last: { value: string; keepCase: boolean } = { value: '', keepCase: false };
function Harness({ streams = [] as StreamBasic[], registry = undefined as NamedNameRegistry | undefined }) {
  const [value, setValue] = useState('');
  const [keepCase, setKeepCase] = useState(false);
  const chainTaken = useNamedNameTaken(registry, submitNameOf(value, keepCase));
  last = { value, keepCase };
  return (
    <NameSuggest
      value={value}
      keepCase={keepCase}
      chainTaken={chainTaken}
      onChange={(v, k) => { setValue(v); setKeepCase(k); }}
      streams={streams}
    />
  );
}

/// render, then let the one-time names fetch settle inside act
async function mount(ui: React.ReactElement) {
  render(ui);
  await act(async () => { await Promise.resolve(); });
}

const box = () => screen.getByTestId('input-stream-name') as HTMLInputElement;
function type(text: string) {
  fireEvent.focus(box());
  fireEvent.change(box(), { target: { value: text } });
}
const coinedRows = () => screen.getAllByRole('button').filter((b) => b.textContent?.includes('coined ·'));
const rowText = (b: HTMLElement) => b.querySelector('.font-mono')?.textContent;

beforeEach(() => {
  process.env.REACT_APP_COINED_INDEXER_URL = 'http://coined.test';
  mockCoined({});
});
afterAll(() => { (global as any).fetch = realFetch; });

describe('the lowercase rule', () => {
  it('submits the lowercase form unless the capitals were kept on purpose', () => {
    expect(submitNameOf('Bitcoin', false)).toBe('bitcoin');
    expect(submitNameOf('  Bitcoin ', true)).toBe('Bitcoin');
    expect(submitNameOf('東京', false)).toBe('東京');
  });

  it('says what will be created and offers to keep the capitals', async () => {
    await mount(<Harness />);
    type('Ether');
    expect(screen.getByText('Will be created as "ether"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'keep "Ether" as typed' }));
    expect(last.keepCase).toBe(true);
    expect(screen.getByText('Creating "Ether" — capitals kept')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'use "ether"' }));
    expect(last.keepCase).toBe(false);
    expect(screen.getByText('Will be created as "ether"')).toBeInTheDocument();
  });

  it('forgets the decision when the word changes, not when only its case does', async () => {
    await mount(<Harness />);
    type('Ether');
    fireEvent.click(screen.getByRole('button', { name: 'keep "Ether" as typed' }));
    type('EtheR');
    expect(last.keepCase).toBe(true);
    type('Ethereum');
    expect(last.keepCase).toBe(false);
  });

  it('shows nothing about case for a name without capitals', async () => {
    await mount(<Harness />);
    type('ether');
    expect(screen.queryByText(/Will be created as/)).toBeNull();
    expect(screen.queryByText(/capitals kept/)).toBeNull();
  });
});

describe('suggestions', () => {
  it('picking a term fills the box with its exact text and keeps that case', async () => {
    mockCoined({ search: [term('Bitcoin')] });
    await mount(<Harness />);
    type('bit');
    const row = await screen.findByRole('button', { name: /^Bitcoin/ });
    expect(row).toHaveTextContent('coined · 0.42 ETH');
    fireEvent.click(row);
    expect(last).toEqual({ value: 'Bitcoin', keepCase: true });
  });

  it('→ with the caret at the end takes the top pickable match', async () => {
    mockCoined({ search: [term('Bitcoin')] });
    await mount(<Harness />);
    type('bit');
    await screen.findByRole('button', { name: /^Bitcoin/ });
    box().setSelectionRange(3, 3);
    fireEvent.keyDown(box(), { key: 'ArrowRight' });
    expect(last).toEqual({ value: 'Bitcoin', keepCase: true });
  });

  it('shows a named stream as already taken — not pickable, still focusable — and blocks the name that would be sent', async () => {
    const streams = [stream(2, 'Bitcoin'), stream(3, 'ethereum', false)];
    await mount(<Harness streams={streams} />);
    type('Bit');
    const row = screen.getByRole('button', { name: /^Bitcoin/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row).not.toBeDisabled();
    expect(row).toHaveTextContent('already a stream · #2');
    fireEvent.click(row);
    expect(last.value).toBe('Bit');
    expect(nameBlocker(streams, 'Bit', false)).toBeNull();

    // "bitcoin" is what would be sent, and that id is free — the twin is a row, not a block
    type('Bitcoin');
    expect(screen.queryByTestId('name-blocker')).toBeNull();
    expect(screen.getByRole('button', { name: /^Bitcoin/ })).toHaveTextContent('already a stream · #2');
    expect(nameBlocker(streams, 'Bitcoin', false)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'keep "Bitcoin" as typed' }));
    expect(screen.getByTestId('name-blocker')).toHaveTextContent('"Bitcoin" is already a named stream (#2).');
    expect(nameBlocker(streams, 'Bitcoin', true)).toBe('"Bitcoin" is already a named stream (#2).');
  });

  it('blocks when the lowercase form that would be sent is the taken one', () => {
    const streams = [stream(5, ' bitcoin ')];
    expect(nameBlocker(streams, 'Bitcoin', false)).toBe('"bitcoin" is already a named stream (#5).');
    expect(nameBlocker(streams, 'Bitcoin', true)).toBeNull();
  });

  it("blocks on the registry's word when the list does not hold the stream", async () => {
    const registry: NamedNameRegistry = { namedNameTaken: async (id) => id === localIdOf('bitcoin') };
    await mount(<Harness registry={registry} />);
    type('Bitcoin');
    expect(await screen.findByText('"bitcoin" is already a named stream.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'keep "Bitcoin" as typed' }));
    await waitFor(() => expect(screen.queryByTestId('name-blocker')).toBeNull());
    expect(nameBlocker([], 'bitcoin', false, true)).toBe('"bitcoin" is already a named stream.');
  });

  it('blocks a name the chain would refuse, with the reason as a sentence', async () => {
    await mount(<Harness />);
    type('bitcоin'); // cyrillic о
    expect(screen.getByTestId('name-blocker')).toHaveTextContent(/one alphabet/);
    expect(nameBlocker([], 'bitcоin', false)).toBe('A name keeps to one alphabet — a letter here is from another.');
    expect(nameBlocker([], '', false)).toBeNull();
  });

  it('says when the exact name is already coined, with its backing, even outside the top list', async () => {
    mockCoined({ coined: [term('bitcoin')], search: [term('bitcoins')] });
    await mount(<Harness />);
    type('bitcoin');
    expect(await screen.findByText('Coined already — "bitcoin" (0.42 ETH backing)')).toBeInTheDocument();
    expect(coinedRows().map(rowText)).toEqual(['bitcoins']);
  });

  it('judges coined-ness on the name that would be sent, not the typed case', async () => {
    mockCoined({ coined: [term('bitcoin')], search: [term('bitcoins', '1000000000000000000'), term('bitcoin')] });
    await mount(<Harness />);
    type('Bitcoin');
    expect(await screen.findByText('Coined already — "bitcoin" (0.42 ETH backing)')).toBeInTheDocument();
    expect(coinedRows().map(rowText)).toEqual(['bitcoins']);

    fireEvent.click(screen.getByRole('button', { name: 'keep "Bitcoin" as typed' }));
    expect(await screen.findByText('"bitcoin" exists — pick it, or keep your capitals')).toBeInTheDocument();
    expect(coinedRows().map(rowText)).toEqual(['bitcoin', 'bitcoins']);
  });

  it('offers a coined case-twin of the typed text when the lowercase send would be new', async () => {
    mockCoined({ coined: [term('Bitcoin')] });
    await mount(<Harness />);
    type('Bitcoin');
    expect(await screen.findByText('"Bitcoin" exists — pick it, or create "bitcoin"')).toBeInTheDocument();
    const row = coinedRows()[0];
    expect(rowText(row)).toBe('Bitcoin');
    fireEvent.click(row);
    expect(last).toEqual({ value: 'Bitcoin', keepCase: true });
    expect(await screen.findByText('Coined already — "Bitcoin" (0.42 ETH backing)')).toBeInTheDocument();
  });

  it('treats any other case-variant as a plain row, not as the twin', async () => {
    mockCoined({ search: [term('BitCoin')] });
    await mount(<Harness />);
    type('Bitcoin');
    expect(await screen.findByText('New — will be coined with the stream.')).toBeInTheDocument();
    expect(coinedRows().map(rowText)).toEqual(['BitCoin']);
  });

  it('calls a name new only once the indexer has answered for it', async () => {
    mockCoined({ search: [] });
    await mount(<Harness />);
    type('ether');
    expect(screen.queryByText(/New — will be coined/)).toBeNull();
    expect(await screen.findByText('New — will be coined with the stream.')).toBeInTheDocument();
  });

  it('falls back to Satori rows alone, and says nothing about coined-ness, when the indexer is down', async () => {
    mockCoined({ down: true });
    await mount(<Harness streams={[stream(2, 'Bitcoin')]} />);
    type('bit');
    expect(screen.getByRole('button', { name: /^Bitcoin/ })).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); });
    expect(screen.queryByText(/New — will be coined/)).toBeNull();
    expect(screen.queryByText(/Coined already/)).toBeNull();
  });

  it('warns about a lookalike without blocking', async () => {
    mockCoined({ lookalike: [term('bitcoın')] }); // dotless i
    await mount(<Harness />);
    type('bitcoin');
    expect(await screen.findByText('Looks like "bitcoın", which exists — a different alphabet or a styled letter.')).toBeInTheDocument();
    expect(screen.queryByTestId('name-blocker')).toBeNull();
  });

  it('shows the list only while the box has focus', async () => {
    await mount(<Harness streams={[stream(2, 'Bitcoin')]} />);
    type('bit');
    expect(screen.getByRole('button', { name: /^Bitcoin/ })).toBeInTheDocument();
    fireEvent.blur(box());
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Bitcoin/ })).toBeNull());
  });
});
