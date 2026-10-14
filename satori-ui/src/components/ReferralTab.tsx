import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ethers } from 'ethers';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { loadEventsCached } from '../utils/eventCache';
import { indexerReferrals, indexerReferredBy, type IndexerReferee } from '../utils/indexerClient';
import { formatSatoriParts } from '../utils/format';
import { InfoTip } from './InfoTip';
import { InviteLinkCard } from './InviteLinkCard';
import { getDeploymentBlock } from '../lib/chainValues';

const ZERO = '0x0000000000000000000000000000000000000000';

/// The referral cut, as a percentage.
///
/// `SatoriRewards.sol` — `uint16 internal constant REFERRAL_BPS = 500`,
/// applied at `:1107` as `amount * REFERRAL_BPS / 10000`. That is 5%.
///
/// It is INTERNAL, so there is no getter to read it from and this figure cannot
/// be derived at runtime. Hardcoding is therefore forced, not lazy — which is
/// exactly how this page came to claim 1% while the chain paid 5%. Kept as one
/// named constant with the contract line above it so the next change has a
/// single place to land and something to check against.
const REFERRAL_PCT = 5;

export function ReferralTab() {
  const { contracts } = useContracts();
  const { address } = useWallet();

  // Read-only since the setter was removed: this tab reports what the chain says
  // and never writes. The acting/error/success state that used to drive the
  // submit button went with it rather than lingering as scenery nothing sets.
  const [referral, setReferral] = useState('');
  const [earnings, setEarnings] = useState<bigint | null>(null);
  const [earningsCount, setEarningsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  /// Who has ME as their referrer. `null` means "could not load", which is a
  /// different thing from `[]` ("nobody yet") and is shown differently — the
  /// indexer is the ONLY source for this, so a failure must not read as zero.
  const [referees, setReferees] = useState<IndexerReferee[] | null>(null);
  const [refereesLoading, setRefereesLoading] = useState(true);

  const load = useCallback(async () => {
    if (!contracts || !address) return;
    setLoading(true);
    try {
      const ref = await contracts.cached.live.rewards.referral(address);
      setReferral(ref === ZERO ? '' : ref);
    } catch (e) {
      console.error('Referral load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [contracts, address]);

  const loadEarnings = useCallback(async () => {
    if (!contracts || !address) return;
    try {
      // Indexer fast path: exact BigInt wei total + payout count in one
      // call (server sums the same ReferralPaid log). Null → scan.
      const indexed = await indexerReferrals(address);
      if (indexed) {
        setEarnings(indexed.total);
        setEarningsCount(indexed.count);
        return;
      }
      const fromBlock = Number(await getDeploymentBlock(contracts.reads));
      const events = await loadEventsCached({
        contract: contracts.rewards,
        eventName: 'ReferralPaid',
        filterArgs: [null, address],
        fromBlock,
      });
      let total = BigInt(0);
      for (const ev of events) {
        const amt = ev.args?.amount ?? BigInt(0);
        total += amt as bigint;
      }
      setEarnings(total);
      setEarningsCount(events.length);
    } catch (e) {
      console.error('Earnings load failed:', e);
      setEarnings(null);
    }
  }, [contracts, address]);

  /// No client-side scan fallback here, unlike earnings. ReferralSet is only
  /// obtainable from logs, and a browser-side walk of the full deployment
  /// history to build this list would be slow and mostly wasted. If the indexer
  /// is unreachable the UI says so rather than showing an empty list that looks
  /// like an answer.
  const loadReferees = useCallback(async () => {
    if (!address) return;
    setRefereesLoading(true);
    try {
      setReferees(await indexerReferredBy(address));
    } catch (e) {
      console.error('Referee list load failed:', e);
      setReferees(null);
    } finally {
      setRefereesLoading(false);
    }
  }, [address]);

  useEffect(() => { load(); loadEarnings(); loadReferees(); }, [load, loadEarnings, loadReferees]);

  const isLocked = !!referral;

  if (loading) {
    return <div className="card-themed p-6 text-center text-gray-500 text-sm">Loading referral...</div>;
  }

  return (
    <div className="space-y-4" data-testid="referral-tab">
      {/* Page intro, matching Vote and Leaderboard: one short sentence at the
          top saying what the page is for. Everything qualifying it — the rate,
          the duration, the set-once rule — is in "How it works" below.

          The framing rationale that used to live here moved with the sentence it
          described: the cut comes out of a budget the project retains anyway,
          not out of the earner's rewards, which is why the last bullet says
          dodging a referral gains you nothing. True on chain either way —
          `SatoriRewards._creditReward` credits the earner `amount - cut` and
          routes `cut` to `marketingFeeRecipient` when no referral is set, so
          declining to be referred moves the money to the project rather than
          back to the earner. */}
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Share your invite link and earn.
      </p>

      <div className="space-y-1.5">
        {/* Your Link row */}
        <InviteLinkCard />

        {/* Earnings row */}
        <div className="card-themed !p-0 overflow-hidden">
          <div className="px-3 py-3 flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium">Referral Earnings</div>
              <div className="text-xs text-gray-500">
                {earnings === null
                  ? 'Could not load earnings'
                  : earningsCount === 0
                    ? 'No referral cuts received yet, appears as referees earn'
                    : `From ${earningsCount} payout${earningsCount === 1 ? '' : 's'}`}
              </div>
            </div>
            <div className="text-right whitespace-nowrap" data-testid="referral-earnings">
              {earnings === null ? (
                <span className="text-sm text-gray-500">—</span>
              ) : (() => {
                const parts = formatSatoriParts(ethers.formatEther(earnings));
                return (
                  <>
                    <div className="text-lg font-semibold">{parts.value}</div>
                    <div className="text-xs text-gray-500">{parts.unit}</div>
                  </>
                );
              })()}
            </div>
          </div>
        </div>

        {/* People I've referred. The indexer is the only source: the contract's
            `referral` mapping runs referee -> referrer and cannot be reversed,
            and ReferralPaid alone would hide anyone who registered but has not
            earned yet. */}
        <div className="card-themed !p-0 overflow-hidden" data-testid="referees-card">
          <div className="px-3 py-3">
            <div className="font-medium flex items-center justify-between gap-1.5">
              <span>You've Referred</span>
              <InfoTip>
                Everyone who registered you as their referral. They appear here as
                soon as they join &mdash; earning comes later, so a new referee
                showing {formatSatoriParts('0').value} is normal.
              </InfoTip>
            </div>

            {refereesLoading ? (
              <div className="text-xs text-gray-500 mt-1">Loading&hellip;</div>
            ) : referees === null ? (
              // Explicitly NOT "no referrals yet" — we do not know, and saying
              // zero would be a claim the data does not support.
              <div className="text-xs text-gray-500 mt-1" data-testid="referees-unavailable">
                Can&rsquo;t load the list right now.
              </div>
            ) : referees.length === 0 ? (
              <div className="text-xs text-gray-500 mt-1" data-testid="referees-empty">
                Nobody yet. Share your link above.
              </div>
            ) : (
              <>
                <div className="text-xs text-gray-500 mt-1">
                  {referees.length} {referees.length === 1 ? 'person' : 'people'}
                </div>
                {/* FULL addresses, not truncated. A referee list is something
                    you cross-reference against people you know, and the middle
                    of the address is where two of them actually differ — the
                    truncated form can render distinct addresses identically.
                    `break-all` because 42 monospace characters do not fit a
                    phone: it wraps rather than overflowing or being clipped by
                    `truncate`, which would defeat the point. */}
                <ul className="mt-2 space-y-2" data-testid="referees-list">
                  {referees.map((r) => {
                    const parts = formatSatoriParts(ethers.formatEther(r.earnedWei));
                    return (
                      <li key={r.address} className="text-sm">
                        <div className="font-mono text-xs break-all text-gray-600 dark:text-gray-300">
                          {r.address}
                        </div>
                        <div className="text-xs text-gray-500">
                          {parts.value} {parts.unit}
                          {r.payouts > 0 && ` · ${r.payouts} payout${r.payouts === 1 ? '' : 's'}`}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </div>

        {/* Your Referral row */}
        <div className="card-themed !p-0 overflow-hidden" data-testid="referral-status-card">
          <div className="px-3 py-3">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium flex items-center justify-between gap-1.5">
                  <span>Your Referral</span>
                  <InfoTip>
                    Register a referral to credit whoever invited you: {REFERRAL_PCT}% of every reward
                    you earn is credited to them automatically. Set-once and immutable.
                  </InfoTip>
                </div>
                <div className="text-xs text-gray-500 font-mono truncate">
                  {isLocked ? referral.toLowerCase() : 'Not set'}
                </div>
              </div>
            </div>

            {/*
              No "set my referral" control here, deliberately (owner decision,
              2026-08-02). `SatoriRewards.setReferral` still exists on chain and
              is unchanged — this is about not putting a one-way, set-once,
              immutable choice one tap away from someone who has not thought
              about it. A referral still gets attributed when a user arrives
              through an invite link; there is simply no field for typing an
              arbitrary address into.
            */}
          </div>
        </div>
      </div>

      <Collapsible title="How it works:">
        <ul className="space-y-1 text-sm text-blue-800 dark:text-blue-300">
          <li>&#8226; <strong>Set once, immutable</strong>: once you register a referral it can't change</li>
          <li>&#8226; <strong>Share your link to earn {REFERRAL_PCT}%</strong> from everyone who joins through it</li>
          <li>&#8226; <strong>Earn Forever</strong>. You keep earning as long as they are active</li>
          {/* One sentence, and deliberately does NOT enumerate the ways round
              it: naming a workaround to say it fails still tells people the
              workaround exists. Both are closed on chain regardless — with no
              referral the cut routes to `marketingFeeRecipient`, and
              setReferral / setReferralFor reject a self-referral.

              This bullet used to say where the money comes from. Owner replaced
              it 2026-08-22 with the consequence, which is the part a reader is
              actually weighing: there is nothing to gain by dodging a referral
              link. */}
          <li>&#8226; <strong>Avoiding being referred</strong> does not allow you to earn more rewards.</li>
        </ul>
      </Collapsible>
    </div>
  );
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (contentRef.current) setHeight(contentRef.current.scrollHeight);
  }, [children]);

  return (
    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full p-4 flex items-center justify-between text-left"
      >
        <h4 className="font-medium text-blue-900 dark:text-blue-300">{title}</h4>
        <svg
          className={`h-4 w-4 text-blue-600 dark:text-blue-400 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      <div
        style={{
          maxHeight: open ? height : 0,
          opacity: open ? 1 : 0,
          transition: 'max-height 0.25s ease-out, opacity 0.2s ease-out',
          overflow: 'hidden',
        }}
      >
        <div ref={contentRef} className="px-4 pb-4">
          {children}
        </div>
      </div>
    </div>
  );
}

