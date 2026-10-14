import { Interface } from 'ethers';
import events from './events.json';

// Signatures come from events.json, a copy of satori/test/fixtures/event-topics.json
// that EventTopics.test.js pins to the compiled contracts; regenerate both with
// satori/scripts/gen-event-topics.js. Only the event names are listed here.
const SIGNATURES = events as Record<string, Record<string, { signature: string; topic: string }>>;
function iface(contract: string, names: string[]): Interface {
  return new Interface(names.map((n) => {
    const e = SIGNATURES[contract]?.[n];
    if (!e) throw new Error(`events.json has no ${contract}.${n}`);
    return e.signature;
  }));
}

// The event streams the dapp's history views consume (see
// docs/issues/closed/dapp-event-indexer-before-base-mainnet.md for the matrix), plus
// BountyTokenCleaned for bounty-liveness. Signatures match the deployed
// contracts exactly (prediction events carry gameId — renamed from the
// misleading streamId in review #10; topics unchanged).

export const engineIface = iface('SatoriEngine', [
  'PredictionMade',
  'PredictionScored',
  // The three TERMINAL outcomes that are neither a win nor a loss. Without them,
  // a prediction that has been finally judged is indistinguishable from one
  // still waiting, because PredictionScored never fires for any of these.
  //
  // Voided: judged, and the value did not move between the anchor and post
  // readings the settlement compares (the ABC pairing on mid-cadence streams;
  // plain next-sample on the fast and slow bands), so there is nothing to be
  // right or wrong about. This is the common case on a quiet stream and the one
  // that prompted indexing them: four predictions, two of them finally judged,
  // and `prediction_scored` still 0.
  'PredictionVoided',
  // Unrecoverable: the values needed to judge it aged out of the stream's ring
  // before anyone settled it, so it can never be scored.
  'PredictionUnrecoverable',
  // Displaced: pushed out of the two-slot ring by newer predictions before being
  // settled. The contract argues this is unreachable; indexing it makes that
  // claim checkable rather than assumed.
  'PredictionDisplaced',
  // The dust bar is max(dustFloor, threshold): the latest CurveConfigSet
  // (emitted with the effective defaults at initialize) and the game's latest
  // StreakThresholdSet.
  'StreakThresholdSet',
  'CurveConfigSet',
]);

export const bountiesIface = iface('SatoriBounties', [
  // The three pool writes each carry the (pool, rate) they left behind, so a
  // pair's current state is its latest row of any of them; rates are scaled.
  'BountyFunded',
  'BountyDripped',
  'StrandedPotReclaimed',
  'BountyTokenCleaned',
]);

export const rewardsIface = iface('SatoriRewards', [
  'ReferralPaid',
  // The unclaimed ledger: each credit carries the bucket it left, and a claim
  // zeroes it, so an account's claimable-on-chain is its latest row.
  'RewardSplit',
  'DelegatorRewardsAccrued',
  'RewardsClaimed',
  'RoundBudgetFrozen',
  // A delegate's inbound power is the latest newDelegatePower naming it; a
  // delegator's delegate is its latest Delegated (or none after Undelegated).
  'PredictionDelegated',
  'PredictionUndelegated',
  'DelegatePowerSynced',
  // Who designated whom. ReferralPaid alone cannot answer "who have I
  // referred": it only fires when a referee EARNS, so anyone who registered
  // and has not yet been paid is invisible, and the contract's `referral`
  // mapping only runs referee -> referrer, never the reverse.
  //
  // The slot LOCKS ON FIRST SET (SatoriRewards.setReferral reverts AlreadySet;
  // setReferralFor silently no-ops), so each user emits this exactly once,
  // ever. No folding to a latest-wins view is needed here — unlike stream
  // names, which genuinely do change.
  'ReferralSet',
]);

// The voting ledger. `Voted` fires on EVERY burn and carries the game's
// running total; `GameApprovedSet` and `VotesMoved` are the only other
// weight-moving events, and SatoriVoting.sol's own docs say an indexer folding
// all three rebuilds every vote ledger exactly — no contract reads, no silent
// drift. `newFromWeight` / `newToWeight` keep the self-checking property
// `Voted`'s `newGameWeight` has.
export const votingIface = iface('SatoriVoting', [
  'Voted',
  'GameApprovedSet',
  'VotesMoved',
]);

// The stream registry. Two consumers want this and neither existed when the
// indexer was written: the dapp cannot show "my streams" for adapter streams
// without knowing who created what (LAUNCH_CHECKLIST H5), and the Nostr bridge
// mirrors stream creations and observations onto our relays
// (docs/issues/nostr-datastream-bridge.md).
//
// StreamValueUpdated is the ONLY value event needed. It fires on every write
// path — the Simple push, the batch push, and the adapter pull. (The derived
// child fan-out is GONE: the rolling-scoring redesign deleted derived streams
// and all their machinery from the registry outright.) The batch events
// (StreamValuesBatchUpdated / …BatchSet) carry only counts, and
// SatoriRegistry.sol says so outright: "per-stream StreamValueUpdated events
// say exactly which took." Do not try to read values out of the batch events;
// they are not in there.
export const registryIface = iface('SatoriRegistry', [
  // The whole creation record: `adapterId == 0` is a Simple stream; `creator` is
  // the hub's caller, `provider` the key or source the stream was given.
  'DataStreamCreated',
  // One-shot wiring; `named` on /streams is `adapterId == this`.
  'NamedAdapterSet',
  'NamedStreamCreated',
  // The last arg is the ABSOLUTE HOUR of the observation (block.timestamp /
  // 3600) — the registry ring is hour-keyed now. Renamed from the old `round`;
  // parameter names are not part of an event signature, so the topic hash is
  // unchanged. Old logs from the pre-hour deployment carried pool rounds in
  // this slot, which is why the migration path is wipe-and-resync (db.ts).
  'StreamValueUpdated',
  // Creation is not the last word on either of these, so a consumer that reads
  // only DataStreamCreated will drift.
  'NameUpdated',
  'ProviderChanged',
]);

// The game registry. GameCreated is the whole GameMeta (targetMinutes already
// resolved by the default rule); name and authority change afterwards, so the
// views fold the latest of each, as /streams does.
export const gamesIface = iface('SatoriGames', [
  'GameCreated',
  'GameNameUpdated',
  'GameAuthorityTransferred',
]);

// Minimal read surface for boot-time config.
export const tokenIface = new Interface([
  'function deploymentBlock() view returns (uint256)',
]);

export const TOPICS = {
  predictionMade: engineIface.getEvent('PredictionMade')!.topicHash,
  predictionScored: engineIface.getEvent('PredictionScored')!.topicHash,
  predictionVoided: engineIface.getEvent('PredictionVoided')!.topicHash,
  predictionUnrecoverable: engineIface.getEvent('PredictionUnrecoverable')!.topicHash,
  predictionDisplaced: engineIface.getEvent('PredictionDisplaced')!.topicHash,
  streakThresholdSet: engineIface.getEvent('StreakThresholdSet')!.topicHash,
  curveConfigSet: engineIface.getEvent('CurveConfigSet')!.topicHash,
  bountyFunded: bountiesIface.getEvent('BountyFunded')!.topicHash,
  bountyDripped: bountiesIface.getEvent('BountyDripped')!.topicHash,
  strandedPotReclaimed: bountiesIface.getEvent('StrandedPotReclaimed')!.topicHash,
  bountyTokenCleaned: bountiesIface.getEvent('BountyTokenCleaned')!.topicHash,
  referralPaid: rewardsIface.getEvent('ReferralPaid')!.topicHash,
  referralSet: rewardsIface.getEvent('ReferralSet')!.topicHash,
  rewardSplit: rewardsIface.getEvent('RewardSplit')!.topicHash,
  delegatorRewardsAccrued: rewardsIface.getEvent('DelegatorRewardsAccrued')!.topicHash,
  rewardsClaimed: rewardsIface.getEvent('RewardsClaimed')!.topicHash,
  roundBudgetFrozen: rewardsIface.getEvent('RoundBudgetFrozen')!.topicHash,
  predictionDelegated: rewardsIface.getEvent('PredictionDelegated')!.topicHash,
  predictionUndelegated: rewardsIface.getEvent('PredictionUndelegated')!.topicHash,
  delegatePowerSynced: rewardsIface.getEvent('DelegatePowerSynced')!.topicHash,
  dataStreamCreated: registryIface.getEvent('DataStreamCreated')!.topicHash,
  namedAdapterSet: registryIface.getEvent('NamedAdapterSet')!.topicHash,
  namedStreamCreated: registryIface.getEvent('NamedStreamCreated')!.topicHash,
  streamValueUpdated: registryIface.getEvent('StreamValueUpdated')!.topicHash,
  nameUpdated: registryIface.getEvent('NameUpdated')!.topicHash,
  providerChanged: registryIface.getEvent('ProviderChanged')!.topicHash,
  gameCreated: gamesIface.getEvent('GameCreated')!.topicHash,
  gameNameUpdated: gamesIface.getEvent('GameNameUpdated')!.topicHash,
  gameAuthorityTransferred: gamesIface.getEvent('GameAuthorityTransferred')!.topicHash,
  voted: votingIface.getEvent('Voted')!.topicHash,
  gameApprovedSet: votingIface.getEvent('GameApprovedSet')!.topicHash,
  votesMoved: votingIface.getEvent('VotesMoved')!.topicHash,
};
