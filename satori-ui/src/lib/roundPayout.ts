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
/// in `SatoriHub` (`emissionRateNow()`): 846.62 per round until 1460
/// rounds-worth has been issued, then multiplied by the admin-set ratio (default
/// phi - 1) each time another 730 rounds-worth at the current rate is issued,
/// clamped at this envelope. Sizing a payout from 1440 overstates it by
/// whatever gap there is — the same class of
/// error as using the 12h-era 720 per 24h round, in the other direction.
///
/// Kept only so a caller can say "and this is strictly inside the envelope".
export const ROUND_REWARD_BUDGET = 1440;

/// What a round actually has to split between games, mirroring
/// `SatoriRewards._onChainGrossNow` and `_computeRoundBudget`:
///
///     gross  = emissionRateNow() - devRateNow() - offchainBudget
///     budget = gross                            // _computeRoundBudget(gross)
///
/// All THREE terms are read from the chain. `emissionRate` used to be the 1440
/// constant; it is the hub's issuance-indexed schedule now, and baking it in
/// here would have overstated every displayed payout whenever the rate sits
/// below the envelope. The dev fee (a
/// flat 15% of the emission) and the off-chain Merkle dial both come off before
/// anything reaches the games. Nothing else is reserved: the first-predictor
/// bonus and the per-stream value-provider cut are both gone from the contracts
/// (`_computeRoundBudget` returns the gross unchanged), so the whole gross is
/// distributable to predictors.
export function payableBudget(
  emissionRate: number,
  devRate: number,
  offchainBudget: number,
): number {
  return Math.max(0, emissionRate - devRate - offchainBudget);
}

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

/// Whole-percent split of the post-fee residual between on-chain scoring and
/// the off-chain Merkle dial. The residual is the base because that is what the
/// dial divides (`setOffchainBudget` bounds it by `residualNext()`). A dial left
/// above a residual that has since stepped down is read as `residual - 1`,
/// mirroring SatoriHub's reserve yield and SatoriRewards' 1-wei on-chain floor.
export function scoringSplit(
  emissionRateWei: bigint,
  devRateWei: bigint,
  offchainBudgetWei: bigint,
): { onChain: number; offChain: number } {
  const residual = emissionRateWei - devRateWei;
  if (residual <= BigInt(0)) return { onChain: 100, offChain: 0 };
  const cap = residual - BigInt(1);
  const dial = offchainBudgetWei > cap ? cap : offchainBudgetWei;
  const offChain = Number((dial * BigInt(200) + residual) / (residual * BigInt(2)));
  return { onChain: 100 - offChain, offChain };
}
