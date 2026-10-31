import React, { useEffect, useMemo, useState } from 'react';
import type { StreamBasic } from '../hooks/useStreamList';
import { trimName, nameProblem, localIdOf, usd } from '../lib/coinedName';
import { coinedIndexer, type CoinedName } from '../utils/coinedIndexer';

/// The name box for a NAMED stream. Lowercase by default: a capital is sent
/// only when the person pressed "keep", or picked an existing term that has
/// one — never because a phone capitalised the first letter.

export function submitNameOf(raw: string, keepCase: boolean): string {
  const canon = trimName(raw);
  return keepCase ? canon : canon.toLowerCase();
}

function idOf(text: string): string | null {
  try {
    return localIdOf(text);
  } catch {
    return null;
  }
}

/// The named stream whose id the name that would be sent collides with (the
/// registry's NameTaken).
function namedStreamTaken(streams: StreamBasic[], sent: string): StreamBasic | null {
  const id = idOf(sent);
  return id ? streams.find((s) => s.isNamed && idOf(s.name) === id) ?? null : null;
}

/// Why Create must stay disabled, or null. Empty is not a reason — the form
/// already holds the button for an empty box. `chainTaken` is the registry's
/// own answer for the name that would be sent (useNamedNameTaken): the list
/// only holds the streams it has paged in.
export function nameBlocker(streams: StreamBasic[], raw: string, keepCase: boolean, chainTaken = false): string | null {
  const canon = trimName(raw);
  if (!canon) return null;
  const problem = nameProblem(canon);
  if (problem) return problem[0].toUpperCase() + problem.slice(1) + '.';
  const sent = submitNameOf(raw, keepCase);
  const taken = namedStreamTaken(streams, sent);
  if (taken) return `"${trimName(taken.name)}" is already a Sentiment stream (#${taken.id}).`;
  return chainTaken ? `"${sent}" is already a Sentiment stream.` : null;
}

export interface NamedNameRegistry {
  namedNameTaken(id: string): Promise<boolean>;
}

/// `registry.namedNameTaken` for the name that would be sent, a beat after
/// it settles. False until answered and on any failure — the chain's own
/// revert is still mapped by errors.ts.
export function useNamedNameTaken(registry: NamedNameRegistry | undefined, sent: string): boolean {
  const id = idOf(sent);
  const [got, setGot] = useState<{ id: string; taken: boolean }>({ id: '', taken: false });
  useEffect(() => {
    if (!registry || !id) return;
    let dead = false;
    const h = setTimeout(async () => {
      const taken = await registry.namedNameTaken(id).catch(() => false);
      if (!dead) setGot({ id, taken });
    }, 150);
    return () => {
      dead = true;
      clearTimeout(h);
    };
  }, [registry, id]);
  return got.id === id && got.taken;
}

/// Case ignored, prefix matches before inside-the-word ones, the list's own
/// order kept.
function suggestFor<T extends { text: string }>(names: T[] | undefined, q: string, cap = 6): T[] {
  const t = q.trim().toLowerCase();
  if (!t || !names) return [];
  const prefix: T[] = [];
  const inside: T[] = [];
  for (const n of names) {
    const lower = n.text.toLowerCase();
    if (lower.startsWith(t)) prefix.push(n);
    else if (lower.includes(t)) inside.push(n);
    if (prefix.length >= cap) break;
  }
  return [...prefix, ...inside].slice(0, cap);
}

function useCoinedNames(): CoinedName[] | null {
  const [names, setNames] = useState<CoinedName[] | null>(null);
  useEffect(() => {
    let dead = false;
    coinedIndexer.names(100).then((rows) => { if (!dead) setNames(rows); });
    return () => { dead = true; };
  }, []);
  return names;
}

/// Local matches at once, the indexer's a beat later, stale answers dropped.
function useSuggest(names: CoinedName[] | null, q: string, cap = 6): CoinedName[] {
  const local = useMemo(() => suggestFor(names ?? undefined, q, cap), [names, q, cap]);
  const [remote, setRemote] = useState<{ q: string; rows: CoinedName[] | null }>({ q: '', rows: null });
  useEffect(() => {
    const t = q.trim();
    if (!t) return;
    let dead = false;
    const h = setTimeout(async () => {
      const rows = await coinedIndexer.search(t, cap);
      if (!dead) setRemote({ q, rows });
    }, 150);
    return () => {
      dead = true;
      clearTimeout(h);
    };
  }, [q, cap]);
  return useMemo(() => {
    if (remote.q !== q || !remote.rows?.length) return local;
    const seen = new Set(local.map((n) => n.id.toLowerCase()));
    const extra = remote.rows.filter((n) => !seen.has(n.id.toLowerCase()));
    return [...local, ...extra].slice(0, cap);
  }, [local, remote, q, cap]);
}

/// The Coined rows for these ids, a beat after they settle; null until the
/// indexer has answered for THIS set. Coined-ness is asked by id because
/// `/search` leaves the exact typed text out and the names list is only the
/// top hundred.
function useCoinedById(ids: (string | null)[]): CoinedName[] | null {
  const key = ids.filter(Boolean).join(',');
  const [got, setGot] = useState<{ key: string; rows: CoinedName[] | null }>({ key: '', rows: null });
  useEffect(() => {
    if (!key) return;
    let dead = false;
    const h = setTimeout(async () => {
      const rows = await coinedIndexer.byId(key.split(','));
      if (!dead) setGot({ key, rows });
    }, 150);
    return () => {
      dead = true;
      clearTimeout(h);
    };
  }, [key]);
  return got.key === key ? got.rows : null;
}

function useLookalike(q: string): CoinedName[] {
  const [got, setGot] = useState<{ q: string; rows: CoinedName[] }>({ q: '', rows: [] });
  useEffect(() => {
    const t = q.trim();
    if (!t) return;
    let dead = false;
    const h = setTimeout(async () => {
      const rows = (await coinedIndexer.lookalike(t)) ?? [];
      if (!dead) setGot({ q, rows });
    }, 150);
    return () => {
      dead = true;
      clearTimeout(h);
    };
  }, [q]);
  return got.q === q ? got.rows : [];
}

interface Row {
  key: string;
  text: string;
  tag: string;
  /// a Satori stream already — shown so the near-miss is seen, never picked
  taken: boolean;
  rank: number;
}

export default function NameSuggest({
  value,
  keepCase,
  chainTaken = false,
  onChange,
  streams,
}: {
  value: string;
  keepCase: boolean;
  chainTaken?: boolean;
  onChange: (raw: string, keepCase: boolean) => void;
  streams: StreamBasic[];
}) {
  const canon = trimName(value);
  const lower = canon.toLowerCase();
  const hasCaps = canon !== lower;
  const sent = keepCase ? canon : lower;
  const sentId = idOf(sent);
  // The other of the two forms — typed or lowercase — that is NOT being sent.
  const variant = hasCaps ? (keepCase ? lower : canon) : null;
  const variantId = variant ? idOf(variant) : null;
  const [focused, setFocused] = useState(false);

  const names = useCoinedNames();
  const coined = useSuggest(names, canon);
  const known = useCoinedById([sentId, variantId]);
  const lookalikes = useLookalike(canon);

  const blocker = nameBlocker(streams, value, keepCase, chainTaken);

  const named = useMemo(
    () => streams.filter((s) => s.isNamed).map((s) => ({ text: s.name, id: idOf(s.name), stream: s })),
    [streams],
  );
  const satoriIds = useMemo(() => new Set(named.map((n) => n.id)), [named]);

  const find = (id: string | null) =>
    (id && [...(names ?? []), ...coined, ...(known ?? [])].find((n) => n.id.toLowerCase() === id)) || null;
  const coinedExact = find(sentId);
  const coinedVariant = find(variantId);

  const rows = useMemo<Row[]>(() => {
    const rank = (text: string, src: number) =>
      text === variant ? 0 : (text.toLowerCase().startsWith(lower) ? 1 : 3) + src;
    const out: Row[] = [];
    for (const n of suggestFor(named, canon)) {
      out.push({ key: `s${n.stream.id}`, text: n.text, tag: `already a stream · #${n.stream.id}`, taken: true, rank: rank(n.text, 0) });
    }
    const seen = new Set<string>();
    for (const n of [...coined, ...(known ?? [])]) {
      const id = n.id.toLowerCase();
      if (id === sentId || satoriIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      out.push({ key: id, text: n.text, tag: `coined · ${usd(BigInt(n.pile ?? '0'))}`, taken: false, rank: rank(n.text, 1) });
    }
    return out.sort((a, b) => a.rank - b.rank).slice(0, 6);
  }, [named, coined, known, canon, lower, variant, sentId, satoriIds]);

  const top = rows.find((r) => !r.taken) ?? null;
  const lookalike = lookalikes.find((n) => n.id.toLowerCase() !== sentId && n.text.toLowerCase() !== lower) ?? null;

  const pick = (text: string) => onChange(text, true);

  let status: string | null = null;
  if (!blocker && canon) {
    if (coinedExact) status = `Coined already — "${coinedExact.text}" (${usd(BigInt(coinedExact.pile ?? '0'))} backing)`;
    else if (coinedVariant) status = keepCase
      ? `"${coinedVariant.text}" exists — pick it, or keep your capitals`
      : `"${coinedVariant.text}" exists — pick it, or create "${lower}"`;
    else if (known) status = 'New — will be coined with the stream.';
  }

  const open = focused && !!canon && rows.length > 0;

  return (
    <div className="space-y-1">
      <div className="relative">
        <input
          type="text"
          value={value}
          onChange={(e) => {
            const next = e.target.value;
            onChange(next, trimName(next).toLowerCase() === lower ? keepCase : false);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' || !top) return;
            const el = e.currentTarget;
            if (el.selectionStart === el.value.length && el.selectionEnd === el.value.length) {
              e.preventDefault();
              pick(top.text);
            }
          }}
          placeholder="Name (e.g. bitcoin)"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm"
          data-testid="input-stream-name"
        />
        {/* In flow, not an overlay: the case and status lines sit right under
            the box and must stay clickable while the list is open. */}
        {open && (
          <div className="mt-px overflow-hidden rounded-b border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-lg" data-testid="name-suggestions">
            {rows.map((r) => (
              <button
                key={r.key}
                type="button"
                /// aria-disabled, not disabled: a disabled button swallows the
                /// mousedown below, so a tap on a taken row would blur the box
                /// and close the list
                aria-disabled={r.taken || undefined}
                /// keep focus in the box — losing it closes the list
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { if (!r.taken) pick(r.text); }}
                className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs
                  ${r.taken ? 'opacity-60 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}
                  ${r === top ? 'bg-gray-100 dark:bg-gray-700' : ''}`}
              >
                <span className="truncate font-mono">{r.text}</span>
                <span className="shrink-0 text-gray-500 dark:text-gray-400">
                  {r.tag}
                  {r === top && (
                    <kbd aria-label="press → to take this one" className="ml-2 px-1 rounded border border-gray-300 dark:border-gray-600">→</kbd>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {hasCaps && (
        <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300" data-testid="name-case">
          <span>{keepCase ? `Creating "${canon}" — capitals kept` : `Will be created as "${lower}"`}</span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChange(value, !keepCase)}
            className="px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            {keepCase ? `use "${lower}"` : `keep "${canon}" as typed`}
          </button>
        </div>
      )}
      {blocker && (
        <div className="text-xs text-red-500 dark:text-red-400" data-testid="name-blocker">{blocker}</div>
      )}
      {status && (
        <div className="text-xs text-gray-500 dark:text-gray-400" data-testid="name-status">{status}</div>
      )}
      {lookalike && (
        <div className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-lookalike">
          Looks like "{lookalike.text}", which exists — a different alphabet or a styled letter.
        </div>
      )}
    </div>
  );
}
