// Values that need no RPC call at all, because the contracts derive them from
// the clock and from constants we already know.
//
// This is the cheapest possible cache: not "fetch it and remember", but "never
// fetch it". See docs/design/dapp-cache-invalidation-map.md, Class 2.

/// Seconds per round. `SatoriToken.TIME_UNIT_SECONDS = 86400` — 24 hours,
/// closing at midnight UTC.
export const TIME_UNIT_SECONDS = 86400;

/// The token's per-round ceiling, `ROUND_REWARD_BUDGET = 1440 ether`. Not the
/// emission rate: that is `SatoriHub.emissionRateNow()`, at or below this.
export const ROUND_REWARD_BUDGET_WEI = BigInt('1440000000000000000000');

/// Flat anti-spam burns, mirroring `SatoriHub.STREAM_BURN` / `GAME_BURN`
/// (owner-set flat 2026-09-18). Keep in LOCKSTEP with those hub constants — and
/// they are verifiable wei-for-wei against `SatoriRewardsLens.streamBurn()` /
/// `gameBurn()` / `bountyBurn()`. These replaced a round-scaling isqrt formula
/// that kept shipping a stale ~1.57 into the create form after the burns went
/// flat; the contract charges these amounts, not that.
export const STREAM_BURN_WEI = BigInt('1000000000000000');   // 0.001 ether
export const GAME_BURN_WEI = BigInt('100000000000000000');   // 0.1 ether

/// The round, from the wall clock.
///
///     SatoriToken.sol
///     function getCurrentRound() public view returns (uint256) {
///         return block.timestamp / TIME_UNIT_SECONDS;
///     }
///
/// There is no counter and no advanceRound(), so this is not an approximation
/// of the chain's answer — it is the same arithmetic on the same input.
///
/// The one caveat is that `block.timestamp` is the block's stamp, not the
/// browser's. A block can lag the wall clock by a few seconds, so within a
/// second or two of a boundary the chain may still be on the previous round.
/// `msUntilNextRound` therefore carries a grace period, and anything that must
/// agree with the chain exactly at a boundary should read `getCurrentRound()`
/// rather than compute it.
export function currentRound(nowMs: number = Date.now()): number {
  return currentRoundRaw(nowMs) + roundOffset;
}

/// The chain's clock hour, `block.timestamp / 3600`, on the same calibration as
/// `currentRound`.
export function currentHour(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 3_600_000) + hourOffset;
}

/// The browser's own round, before any calibration. Only `calibrateRound` and
/// `currentRound` should need this.
export function currentRoundRaw(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TIME_UNIT_SECONDS);
}

/// Chain round MINUS browser round, measured once by `calibrateRound`.
///
/// ZERO on any real chain — `block.timestamp` tracks the wall clock, which is the
/// assumption the arithmetic above rests on. It is NOT zero on a local dev node
/// whose clock has been moved independently, and that is the normal case here:
/// the seeder warps ~60 days of `evm_increaseTime`, and the dev "+1 round" button
/// warps 24 hours a click.
///
/// Without this the dapp computes the BROWSER's round and compares it against
/// round numbers that came from the CHAIN — transfer locks, bounty-stake
/// unlocks, vote-bounty terms — and every one of those comparisons is wrong by
/// the size of the warp. The symptom that surfaced it: a predictor who was not
/// locked at all still saw "your delegation is revoked, power stays locked",
/// because the chain said round 41485 and the browser said 41365.
let roundOffset = 0;
/// The same warp in clock hours: a dev node is rarely warped by whole days.
let hourOffset = 0;
export function setRoundOffset(rounds: number, hours: number = rounds * 24): void {
  roundOffset = rounds;
  hourOffset = hours;
}
export function getRoundOffset(): number { return roundOffset; }

/// When the round next changes, in ms from now. Exact, known in advance, and
/// needing no polling — this is what round-scoped cache entries expire on.
///
/// The grace period is added so an entry refreshed on this timer does not race
/// a block whose timestamp has not yet crossed the boundary and get the OLD
/// round back, then hold it for another 24 hours.
export function msUntilNextRound(nowMs: number = Date.now(), graceMs = 15_000): number {
  const next = (currentRound(nowMs) + 1) * TIME_UNIT_SECONDS * 1000;
  return next - nowMs + graceMs;
}

/// Floor of the square root, matching OpenZeppelin `Math.sqrt` (which rounds
/// down by default). Newton's method on bigint — `Math.sqrt` on a Number would
/// lose precision well below the magnitudes involved here (the operand is
/// ~10^45).
export function isqrt(n: bigint): bigint {
  if (n < BigInt(0)) throw new RangeError('isqrt of negative');
  if (n < BigInt(2)) return n;
  let x = n;
  let y = (x + BigInt(1)) / BigInt(2);
  while (y < x) {
    x = y;
    y = (x + n / x) / BigInt(2);
  }
  return x;
}

/// Cost to create a data stream. `SatoriHub.streamBurn()` (flat).
export function streamBurn(): bigint {
  return STREAM_BURN_WEI;
}

/// Cost to author a game. `SatoriHub.gameBurn()` (flat).
export function gameBurn(): bigint {
  return GAME_BURN_WEI;
}

/// Cost to fund a bounty. `SatoriHub.bountyBurn()` — the same as gameBurn.
export function bountyBurn(): bigint {
  return GAME_BURN_WEI;
}

// DELIBERATELY NOT HERE: onChainRewardCeiling.
//
// It is not arithmetic on constants: SatoriRewardsLens returns everything the
// hub has reported to the token as earned, less the Merkle reserve
// (`token.generalAccrued() - hub.merkleReserveCumulative()`), and that moves
// with every scored win. A first draft here derived a clock formula instead and
// was wrong by 452 SATORI against Base Sepolia.
//
// So it stays a fetched value, not derivable. The line between the
// two is whether the value is arithmetic on constants or encodes a rule. Copying
// a rule into the UI is how the displayed number and the paid number drift
// apart, which is the bug this whole exercise started from.

/// Which games will earn this round — the set the predictable list must be built
/// from.
///
/// `frozen` is `voting.getEligibleGamesAtRound(govRound)`, the snapshot the chain
/// settles against. `live` is the set of games currently carrying weight, derived
/// from the `voting.getGameWeights` walk (eligibility IS non-zero weight — there is
/// no live-heap getter any more). `snapshotWritten` is
/// `voting.roundDenominator(govRound) > 0`.
///
/// Normally the answer is `frozen`: reading the live heap there would promise
/// earnings the contract will not pay.
///
/// But the snapshot is written by the round's FIRST prediction, and
/// `eligibilityRound(r)` only steps back to `r-1` when `r-1` locked. So after a
/// round in which nobody predicted, the governing round is the CURRENT one and its
/// snapshot does not exist yet. Gate the predictable list on the empty frozen set
/// and the dapp offers nothing to predict, so no prediction is ever made, so the
/// snapshot is never written — a permanent deadlock that a refresh cannot clear.
/// One quiet round took the live Base Sepolia dapp out at round 41342.
///
/// The fallback is the LIVE heap and not an older snapshot, because
/// `_ensureDailyTotalsInitialized` copies the live heap via
/// `snapshotEligibleGamesForRound` — the live heap is precisely what the chain will
/// freeze the moment the first prediction lands. An earlier round's snapshot would
/// be a guess that can name a stream since dropped from the heap, or hide one that
/// has entered.
export function earningGames(
  frozen: readonly number[],
  live: readonly number[],
  snapshotWritten: boolean,
): readonly number[] {
  return snapshotWritten ? frozen : live;
}

/// When may this stream be ticked again?
///
/// Mirrors `SatoriRegistry._cadenceGuard` — the shared three-band guard, with
/// cadence now recorded in MINUTES (`streamMinCadenceMinutes`, floor 60) and
/// the registry ring keyed by absolute HOUR (timestamp / 3600):
///
///   cadSec = minCadenceMinutes * 60
///
///   cadSec < 86400 (sub-round): legal when
///       now >= lastUpdateTimestampSec + cadSec
///     No slack — an hourly stream waits its full hour (GUARD_GAP only).
///
///   cadSec >= 86400 (round-length and above): BOTH bands must pass:
///     round band (GUARD_ROUNDS) —
///       floor(now / 86400) >= floor(lastUpdateHour / 24) + ceil(cadSec / 86400)
///       `lastUpdateHour / 24` is the round the entry was written in; the ceil
///       makes a cadence between round multiples wait for the LATER round.
///     gap band (GUARD_GAP) —
///       now >= lastUpdateTimestampSec + cadSec - 1800
///       The 30-minute slack lets a daily ticker drift a little earlier each day.
///
/// Reproducing the rule here is a deliberate exception to "never copy a contract
/// rule into the UI": the alternative is letting someone pay gas to learn it, and a
/// disabled button that explains itself beats any error message. The safety net
/// stays — the button is advice, the preflight and the revert are the authority — so
/// if this ever drifts from the contract the transaction still fails correctly
/// rather than going through wrongly.
///
/// A never-ticked stream (hour 0, timestamp 0) needs no special case: with both
/// inputs zero every band is satisfied by any present-day `now`, so the first
/// tick is always allowed — same as on chain, where the guards only bind once
/// there is history.

/// = TIME_UNIT_SECONDS; named separately because the guard's arithmetic is
/// day arithmetic, not "whatever the round length is".
const DAY_SECONDS = 86400;
/// `SatoriTypes.CADENCE_GAP_SLACK_SECONDS`.
const CADENCE_GAP_SLACK_SECONDS = 1800;

/// Epoch SECONDS at which the next write becomes legal.
///
/// For the round band, `floor(now / 86400) >= r` is exactly `now >= r * 86400`,
/// so both bands reduce to thresholds in seconds and the answer is their max.
export function nextTickTime(
  lastUpdateHour: number,
  minCadenceMinutes: number,
  lastUpdateTimestampSec: number,
): number {
  const cadSec = minCadenceMinutes * 60;
  if (cadSec < DAY_SECONDS) return lastUpdateTimestampSec + cadSec;
  const cadenceRounds = Math.ceil(cadSec / DAY_SECONDS);
  const roundLegal = (Math.floor(lastUpdateHour / 24) + cadenceRounds) * DAY_SECONDS;
  const gapLegal = lastUpdateTimestampSec + cadSec - CADENCE_GAP_SLACK_SECONDS;
  return Math.max(roundLegal, gapLegal);
}

/// Can this stream be ticked right now? True exactly when the contract's
/// `_cadenceGuard` would return GUARD_OK for a write at `nowSec`.
export function canTickNow(
  lastUpdateHour: number,
  minCadenceMinutes: number,
  lastUpdateTimestampSec: number,
  nowSec: number,
): boolean {
  return nowSec >= nextTickTime(lastUpdateHour, minCadenceMinutes, lastUpdateTimestampSec);
}
