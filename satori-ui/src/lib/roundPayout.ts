/// The per-stream reward share, extracted so it can be pinned by tests.
///
/// This mirrors `SatoriRewards._gameRoundAllocation` exactly:
///
///     govRound   = eligibilityRound(currentRound)      // normally currentRound - 1
///     totalVotes = roundTotals(govRound)
///     gameVotes  = getGameVotesAtRound(gameId, govRound)
///     allocation = budget * gameVotes / totalVotes
///
/// Every input comes from the GOVERNING round. That is the whole point of this
/// file existing: the UI previously computed the same figure from the LIVE
/// vote heap and LIVE gameWeight, which are different numbers that drift apart
/// on every vote cast during the current round.

/// The token's OUTER CONSTITUTIONAL ENVELOPE per round — `ROUND_REWARD_BUDGET =
/// 1440 ether` on the immutable SatoriToken. A round is 24 hours
/// (TIME_UNIT_SECONDS = 86400), so round and day coincide.
///
/// THIS IS NOT THE EMISSION RATE and must never be used as one. The rate lives
/// in `SatoriHub` (`emissionRateNow()`): 846.62 on day 1, then multiplied
/// by the admin-set ratio (default 1 − 846.62/2,900,000) each time another
/// round's worth at the current rate is issued, clamped at this envelope. Sizing a payout from 1440 overstates it by
/// whatever gap there is — the same class of
/// error as using the 12h-era 720 per 24h round, in the other direction.
///
/// Kept only so a caller can say "and this is strictly inside the envelope".
export const ROUND_REWARD_BUDGET = 1440;

/// SATORI `streamId` is on track to earn this round.
///
/// Returns 0 when the stream is absent from the governing snapshot — which is
/// not a missing-data case but the correct answer: a game that became eligible
/// after the snapshot "cannot earn rewards for the round" (ISatoriVoting).
///
/// Upper bound, not a promise: the contract allocates against
/// `_computeRoundBudget(gross)`.
///
/// `budget` is REQUIRED. It used to default to `ROUND_REWARD_BUDGET`, which was
/// a silent way to display the envelope as though it were the round's pool — a
/// default that is wrong whenever the emission rate is below the envelope.
export function payoutForStream(
  streamId: number,
  govVotesByStream: Map<number, bigint>,
  govTotal: bigint,
  budget: number,
): number {
  if (govTotal === BigInt(0)) return 0;
  const votes = govVotesByStream.get(streamId);
  if (!votes || votes === BigInt(0)) return 0;
  // No value-provider cut is deducted: providers are not paid. The feature is gone
  // from the contracts entirely (no StreamMeta field, no getter, no setter), so the
  // whole allocation reaches this stream's predictors.
  return (Number(votes) / Number(govTotal)) * budget;
}
