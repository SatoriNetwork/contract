import React, { useState } from 'react';
import { DashboardData } from '../hooks/useDashboard';
import { formatSatori, formatBalance, fullBalance } from '../utils/format';
import { InfoTip } from './InfoTip';
import { directionToDisplay, orientationFor } from '../lib/streamOrientation';
import { InviteLinkCard } from './InviteLinkCard';
import { useDeploymentRound, formatElapsedRound } from '../hooks/useDeploymentRound';
import { useFarmingThreshold } from '../hooks/useFarmingThreshold';
import { STREAK_THRESHOLD_LABEL, streakThresholdFigures } from '../lib/streakThreshold';
import { useGasBalance, gasToneClass } from '../hooks/useGasBalance';
import { ethers } from 'ethers';

// Calm, hour-based settle hint for a pending prediction (review #7). A
// prediction made in the CURRENT round becomes scoreable when the round closes
// (the next 24h boundary — rounds close at midnight UTC); one made in an
// earlier round is already scoreable via the Settle button.
//
// EXPIRY COUNTDOWN: a pending prediction becomes unscoreable once its stream's
// HOUR-keyed 768-slot value ring rolls past its answer key — i.e. SOONEST
// after 768 × cadence MINUTES (a slower-updating stream dies later; one that
// stops updating never evicts, so this estimate only ever warns EARLY, never
// late). Per the maintainer, the countdown stays hidden until the prediction
// is at least halfway through that soonest-death horizon — quiet until it
// matters.
const ROUND_MS = 86_400_000;
const RING_SLOTS = 768;
const MINUTES_PER_DAY = 1440;
function settleHint(
  roundMade: number,
  currentRound: number,
  cadenceMinutes: number,
): { text: string; warn: boolean } {
  if (roundMade >= currentRound) {
    const now = Date.now();
    const msLeft = Math.ceil(now / ROUND_MS) * ROUND_MS - now;
    const hours = Math.max(1, Math.round(msLeft / 3_600_000));
    return { text: `settles in ~${hours}h`, warn: false };
  }
  // Soonest death, in DAYS: 768 ring slots × the cadence in minutes. An hourly
  // stream (60) gives 32 days; the daily default (1440) gives 768 days.
  const horizonDays = (RING_SLOTS * Math.max(60, cadenceMinutes)) / MINUTES_PER_DAY;
  const elapsedDays = currentRound - roundMade; // rounds ARE days now
  if (elapsedDays >= horizonDays / 2) {
    const daysLeft = Math.max(0, Math.ceil(horizonDays - elapsedDays));
    return daysLeft > 0
      ? { text: `~${daysLeft} day${daysLeft === 1 ? '' : 's'} left to settle`, warn: true }
      : { text: 'settle now, this one is expiring', warn: true };
  }
  return { text: 'ready to settle', warn: false };
}

// Hours since the prediction was made. We only know the ROUND it was made in
// (no per-prediction timestamp on-chain), so this measures from that round's
// start (midnight UTC = roundMade × 86400). Round-granular — the caller marks it
// approximate with a leading ~.
function hoursSincePrediction(roundMade: number): number {
  return Math.max(1, Math.floor((Date.now() - roundMade * 86_400_000) / 3_600_000));
}

interface DashboardProps {
  data: DashboardData;
  onClaim: (recipient?: string) => void;
  claiming: boolean;
  claimError: string | null;
  claimSuccess: boolean;
}

export function Dashboard({ data, onClaim, claiming, claimError, claimSuccess }: DashboardProps) {
  const [claimRecipient, setClaimRecipient] = useState('');
  const [showClaimTo, setShowClaimTo] = useState(false);
  const deploymentRound = useDeploymentRound()
  const farming = useFarmingThreshold();

  const claimableNum = parseFloat(data.claimable);
  // Match the transfer-gate semantics on the contract: lockedUntil = N means
  // locked through round N inclusive (SatoriToken._update uses `>=`). The predict
  // gate uses `>`, so at currentRound == lockedUntil the user CAN predict
  // again, but transfers still revert (the token's transfer gate takes the max across lock lanes). Showing
  // "Unlocked" at that boundary mislabels the lock state, so we use `>=` here.
  // First unlocked round is `lockedUntil + 1`, so rounds-remaining is
  // `lockedUntil - currentRound + 1`.
  const isLocked = data.lockedUntil > 0 && data.lockedUntil >= data.currentRound;
  const unlocksIn = isLocked ? data.lockedUntil - data.currentRound + 1 : 0;

  // While prediction-delegated, the controller sets the prediction-lane lock to
  // LOCK_INDEFINITE (type(uint24).max, the undelegation sentinel) via the token. Detect via `hasDelegated`, not the
  // value, so this works regardless of the underlying integer width.
  let lockValue: string;
  let lockSub: string;
  if (!isLocked) {
    lockValue = 'Unlocked';
    lockSub = 'Ready to predict';
  } else if (data.hasPredictionDelegate) {
    lockValue = 'Locked';
    lockSub = 'While delegated';
  } else {
    // Days-first language (review #8): rounds are 24h, so N rounds = N days.
    const daysLeft = unlocksIn;
    lockValue = 'Locked';
    lockSub = `~${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;
  }

  return (
    <div className="space-y-4" data-testid="dashboard">
      {data.delegatorClaimReminder && (
        <div
          className="rounded-lg p-3 text-sm bg-yellow-900/30 border border-yellow-700 text-yellow-200"
          data-testid="delegator-claim-reminder"
        >
          Recommended: delegators claim at least once a year.
        </div>
      )}

      {/* Round + Power + Lock, in one row.
          Claimable used to sit here as a fourth box and was removed (owner,
          2026-08-04): the Claim card below already carries the amount and the
          button, so the box repeated a number the user was about to read again
          six inches lower. Note the consequence — with nothing claimable the
          Claim card does not render, so no claim figure appears anywhere. That
          is intended: nothing to claim, nothing to say. */}
      <div className="grid grid-cols-3 gap-3">
        {/* Round, not Balance. Swapped with the "Today's status" row below
            (owner, 2026-08-03): the round is what you look for on opening the
            app, and the balance is already a tap away in any wallet. The CARDS
            did not move — only what each one says. */}
        <StatCard
          label={
            <>
              <span className="truncate">Current Round</span>
              <InfoTip>
                Satori runs in 24-hour rounds, one per day, closing at midnight UTC,
                and each round mints a fresh batch of rewards for its predictors. This is the round
                currently open.
              </InfoTip>
            </>
          }
          value={formatElapsedRound(data.currentRound, deploymentRound)}
          sub="24h rounds"
          testId="dash-round"
        />
        <StatCard
          label={
            <>
              {/* "Power", not "Prediction Power" (owner, 2026-08-04). The full
                  term stays in the tip below; the box title just has to label
                  the number, and the short word survives a narrow column. */}
              <span className="truncate">Power</span>
              {/* The streak threshold is explained HERE rather than only on the
                  balance, because power is the number it is actually measured
                  against — balance plus unclaimed plus delegated-in. Explaining
                  it on the balance alone invited the reading that topping up the
                  wallet is the only way over the line. */}
              <InfoTip>
                The weight your predictions carry: your own SATORI balance plus any prediction power
                delegated to you, minus any you&apos;ve delegated away. More power means a bigger share of
                each round&apos;s rewards.
                {(() => {
                  const f = streakThresholdFigures(farming.threshold, farming.power);
                  if (!f) return null;
                  return (
                    <>
                      {' '}Power is also what decides whether your streak can grow: it takes{' '}
                      <strong>{f.need} SATORI</strong> to grow one, and the amount needed rises
                      slowly over time so that nobody can build a streak across a fleet of empty
                      wallets. Below it a correct prediction still pays you, and the streak you
                      already have is safe.
                    </>
                  );
                })()}
              </InfoTip>
            </>
          }
          value={formatBalance(data.predictionPower)}
          sub="SATORI"
          testId="dash-power"
        />
        {/* Was "Lock Status" (that moved into the balance card as a row). Now
            claimable earnings, in the same shape as the other stat cards: the
            number over its SATORI unit, bold green with a green ring when there
            is something to claim, a plain white 0 otherwise. */}
        {claimableNum > 0 ? (
          // Something to claim: the whole card IS the claim button — green
          // outline, green bold value — so tapping the amount does the obvious
          // thing (claim to self). The Claim card below still handles claim-to-
          // other and shows the in-flight/success/error state.
          <button
            type="button"
            onClick={() => onClaim()}
            disabled={claiming}
            className="card-themed p-3 min-w-0 w-full text-left border border-green-500/70 hover:border-green-400 disabled:opacity-60 disabled:cursor-wait transition-colors"
            data-testid="dash-claimable"
            title="Claim your rewards"
          >
            <div className="text-xs text-gray-400 mb-1 truncate">Claimable</div>
            <div className="text-lg font-bold break-words text-green-400" data-testid="dash-claimable-value">
              {formatBalance(data.claimable)}
            </div>
            <div className="text-xs text-gray-500 break-words">{claiming ? 'claiming…' : 'SATORI'}</div>
          </button>
        ) : (
          <StatCard
            label={
              <>
                <span className="truncate">Claimable</span>
                <InfoTip>Rewards you&apos;ve earned appear here, ready to claim.</InfoTip>
              </>
            }
            value={formatBalance(data.claimable)}
            sub="SATORI"
            testId="dash-claimable"
          />
        )}
      </div>

      {/* Claim section */}
      {claimableNum > 0 && (
        <div className="card-themed p-4" data-testid="claim-section">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold">Claim Rewards</h3>
            <span className="text-green-400 font-bold">{formatSatori(data.claimable)}</span>
          </div>

          {claimError && (
            <div className="mb-3 p-2 bg-red-900/30 border border-red-700 rounded text-sm text-red-300" data-testid="claim-error">
              {claimError}
            </div>
          )}
          {claimSuccess && (
            <div className="mb-3 p-2 bg-green-900/30 border border-green-700 rounded text-sm text-green-300" data-testid="claim-success">
              Rewards claimed successfully!
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => onClaim()}
              disabled={claiming}
              className="flex-1 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 rounded font-medium transition-colors"
              data-testid="btn-claim-self"
            >
              {claiming ? 'Claiming...' : 'Claim'}
            </button>
            <button
              onClick={() => setShowClaimTo(!showClaimTo)}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm transition-colors"
              data-testid="btn-claim-to-toggle"
            >
              Claim to...
            </button>
          </div>

          {showClaimTo && (
            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={claimRecipient}
                onChange={(e) => setClaimRecipient(e.target.value)}
                placeholder="Recipient address (0x...)"
                className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-2 text-sm"
                data-testid="claim-recipient-input"
              />
              <button
                onClick={() => claimRecipient && onClaim(claimRecipient)}
                disabled={claiming || !claimRecipient}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 rounded text-sm font-medium transition-colors"
                data-testid="btn-claim-to"
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}

      {/* Refer a friend: the same invite link as the Refer tab, surfaced here so
          predict / claim / refer are all reachable without switching tabs.
          Sits directly under the Claim card (owner, 2026-08-04) rather than at
          the foot of the page, where it was below every other section. Note it
          renders unconditionally while the Claim card above it does not, so on
          a zero balance this becomes the first card after the stat row. */}
      <InviteLinkCard />

      {/* Streaks */}
      <div className="card-themed p-4" data-testid="streaks-section">
        <h3 className="font-semibold mb-3 flex items-center justify-between gap-1.5">
          <span>Streaks</span>
          <InfoTip>
            How many predictions in a row you&apos;ve gotten right on this stream. Longer streaks earn a
            bigger reward multiplier; a wrong call resets the streak to zero.
          </InfoTip>
        </h3>
        {data.streaks.length > 0 ? (
          <div className="space-y-2">
            {data.streaks.map((s) => (
              <div key={s.gameId} className="flex items-center justify-between text-sm">
                <span className="text-gray-300">{s.gameName}</span>
                <span className={`font-bold ${s.length >= 10 ? 'text-red-400' : s.length >= 5 ? 'text-orange-400' : 'text-yellow-400'}`}>
                  {s.length} in a row
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No active streaks. Start predicting to build streaks!</p>
        )}
      </div>

      {/* Recent Predictions */}
      <div className="card-themed p-4" data-testid="predictions-section">
        <h3 className="font-semibold mb-3 flex items-center justify-between gap-1.5">
          <span>Recent Predictions</span>
          <InfoTip>
            Your latest call (UP or DOWN) on each stream. &quot;Scored&quot; means the round closed and the
            result counted toward your rewards; &quot;pending&quot; means it hasn&apos;t been settled yet.
            Settle a pending prediction yourself from the History tab.
          </InfoTip>
        </h3>
        {data.recentPredictions.length > 0 ? (
          <div className="space-y-2">
            {data.recentPredictions.map((p) => (
              <div key={`${p.gameId}-${p.roundMade}`}>
               <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-gray-300">{p.gameName}</span>
                  <span className="text-xs text-gray-500">R{formatElapsedRound(p.roundMade, deploymentRound)}</span>
                </div>
                <div className="flex items-center gap-2">
                  {/* Show the direction the user PRESSED. On a Uniswap stream
                      whose readable price runs opposite the tick, the stored
                      direction is the flipped one, so reporting it raw would tell
                      the user they called the opposite of what they did. */}
                  {(() => {
                    const shown = directionToDisplay(p.direction, orientationFor(p.streamId));
                    return (
                      <span className={shown === 1 ? 'text-green-400' : 'text-red-400'}>
                        {shown === 1 ? 'UP' : 'DOWN'}
                      </span>
                    );
                  })()}
                  {p.scored ? (
                    <span className="text-xs bg-blue-900/30 text-blue-300 px-1.5 py-0.5 rounded">scored</span>
                  ) : (
                    <>
                      <span className="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">pending</span>
                      {p.roundMade >= data.currentRound ? (
                        // Round still open — when it becomes settleable.
                        <span className="text-xs text-gray-500">
                          {settleHint(p.roundMade, data.currentRound, p.cadence).text}
                        </span>
                      ) : (
                        // Round closed — no settle link (that's on History); show how
                        // long ago it was made. Round-granular (we only know the round
                        // it was made in), hence the ~.
                        <span className="text-xs text-gray-500" data-testid="dash-pred-age">
                          ~{hoursSincePrediction(p.roundMade)}h ago
                        </span>
                      )}
                    </>
                  )}
                </div>
               </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No predictions yet.</p>
        )}
      </div>

      {/* Delegation summary */}
      {data.hasDelegated && (
        <div className="card-themed p-4" data-testid="delegation-section">
          <h3 className="font-semibold mb-2">Delegation</h3>
          <p className="text-sm text-gray-400">
            Predictions delegated to{' '}
            <span className="text-white font-mono">
              {data.delegateAddress.slice(0, 6)}...{data.delegateAddress.slice(-4)}
            </span>
          </p>
        </div>
      )}

      {/* Balance + whether you've played this round. Was "Current Round" +
          "Predicted this round"; the round moved up into the stat card and the
          balance came down here, which is why the balance sits in a full-width
          row rather than a box. */}
      <div className="card-themed p-4 text-sm text-gray-400" data-testid="round-info">
        <div className="flex justify-between">
          <span className="flex items-center gap-1.5">
            Balance
            <InfoTip>
              The SATORI sitting in your wallet. Claimed rewards land here, and this is
              what your prediction power is based on.
            </InfoTip>
          </span>
          <span className="flex items-baseline gap-2">
            {farming.below ? (
              <InfoTip
                label={STREAK_THRESHOLD_LABEL}
                trigger={
                  <span className="text-red-500 dark:text-red-400 font-medium cursor-help" data-testid="dash-balance" title={`${fullBalance(data.balance)} SATORI`}>
                    {formatBalance(data.balance)} SATORI
                  </span>
                }
              >
                {(() => {
                  const f = streakThresholdFigures(farming.threshold, farming.power);
                  return (
                    <>
                      You need <strong>{f ? `${f.need} SATORI` : "more SATORI"}</strong> to grow your
                      streak{f && <> and you have <strong>{f.have}</strong></>}.
                    </>
                  );
                })()}
              </InfoTip>
            ) : (
              <span className="text-white" data-testid="dash-balance" title={`${fullBalance(data.balance)} SATORI`}>
                {formatBalance(data.balance)} SATORI
              </span>
            )}
          </span>
        </div>
        <GasReadout />
        <div className="flex justify-between mt-1">
          <span className="flex items-center gap-1.5">
            Predicted this round
            <InfoTip>
              Rounds last 24 hours, closing at midnight UTC. You can submit one batch of
              predictions in each, so you can play every day.
            </InfoTip>
          </span>
          <span className={data.hasPredictedToday ? 'text-green-400' : 'text-gray-500'}>
            {data.hasPredictedToday ? 'Yes' : 'No'}
          </span>
        </div>
        <div className="flex justify-between mt-1">
          <span className="flex items-center gap-1.5">
            Lock status
            <InfoTip>
              While your tokens are locked they can&apos;t be transferred. (Vote delegation has its own separate lock.) Tokens lock
              for a short window after revoking a prediction delegation, and stay locked the whole time
              they&apos;re delegated. &quot;Unlocked&quot; means everything is free to move.
            </InfoTip>
          </span>
          <span className={isLocked ? 'text-amber-400' : 'text-green-400'} data-testid="dash-lock">
            {lockValue}{lockSub ? ` · ${lockSub}` : ''}
          </span>
        </div>
      </div>

    </div>
  );
}

function StatCard({ label, value, sub, highlight, testId }: {
  label: React.ReactNode;
  value: string;
  sub: string;
  highlight?: boolean;
  testId: string;
}) {
  return (
    <div
      className={`card-themed p-3 min-w-0 ${highlight ? 'ring-1 ring-green-500/50' : ''}`}
      data-testid={testId}
    >
      <div className="text-xs text-gray-400 mb-1 flex items-center justify-between gap-1 min-w-0">{label}</div>
      <div className={`text-lg font-bold break-words ${highlight ? 'text-green-400' : ''}`}>{value}</div>
      <div className="text-xs text-gray-500 break-words">{sub}</div>
    </div>
  );
}

/// Gas, alongside the SATORI balance.
///
/// Deliberately quieter than the balance it sits next to — smaller, unbolded —
/// because it is a maintenance figure, not the score. It earns attention only
/// by turning colour: gas is the one resource that stops the game dead without
/// ever being the reason anyone opened the app.
///
/// Shows the balance of whichever key actually signs (see useGasBalance), and
/// says nothing at all when there is no wallet or the read failed.
function GasReadout() {
  const { wei, rounds } = useGasBalance();
  if (wei === null) return null;
  const eth = parseFloat(ethers.formatEther(wei));
  return (
    <div className="flex justify-between mt-1" data-testid="dash-gas">
      <span className="flex items-center gap-1.5">
        Gas
        <InfoTip>
          {rounds === null ? (
            <>The ETH that pays for your transactions.</>
          ) : (
            <>
              Enough for roughly <strong>{rounds}</strong> more round{rounds === 1 ? '' : 's'} at
              the current gas price. Predicting stops working when this runs out.
            </>
          )}
        </InfoTip>
      </span>
      {/* Only the FIGURE carries the warning colour. The label stays in the
          row's own colour so the row reads like its neighbours and the colour
          means "this number needs attention", not "this line is special". */}
      <span className={gasToneClass(rounds)}>
        {eth < 0.00001 && eth > 0 ? '<0.00001' : eth.toFixed(5)} ETH
      </span>
    </div>
  );
}

