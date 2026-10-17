import { JsonRpcProvider, Log, formatEther } from 'ethers';
import type Database from 'better-sqlite3';
import { Config } from './config';
import { engineIface, bountiesIface, rewardsIface, registryIface, gamesIface, votingIface, TOPICS } from './abi';
import { deleteFromBlock, getMeta, setMeta } from './db';

// The scan algorithm is a server-side port of the dapp's proven
// eventCache.ts: walk forward in CHUNK_SIZE blocks; on every tick re-scan an
// overlap window of the last REORG_DEPTH blocks (delete-then-refill) so
// reorged-out logs can never persist; if the head moved BACKWARD (rollback /
// dev-chain reset), trim instead of nuking. One eth_getLogs per contract per
// chunk (topic0 OR-lists), so a steady-state tick is 3 small requests, plus
// one each for the registry and the voting contract when configured.

export interface IndexerState {
  startBlock: number;
  lastScannedBlock: number;
  head: number;
  ticks: number;
  lastError: string | null;
  syncing: boolean; // true until the first full walk reaches the head
}

/// Bump whenever the set of indexed events changes, so existing databases
/// rewind and backfill instead of quietly missing the new event's history.
///
/// v2 added the PredictionVoided / PredictionUnrecoverable / PredictionDisplaced
///    TABLES and topic filter, but shipped without their decode branches, so the
///    rescan ran and stored nothing. The tables existed and read 0, which looks
///    exactly like "the event never fired" -- the same ambiguity this whole
///    change exists to remove, one level up.
/// v3 adds the decode branches. Bumped rather than reusing v2 because databases
///    that already recorded v2 would otherwise never re-scan and would keep
///    their empty tables forever.
/// v4 adds the five registry events (stream creation, values, derived streams,
///    name and provider changes). Same reasoning as v3: the new tables are
///    created empty and the cursor is already at head, so without a rewind the
///    entire history of every existing stream is missing and the counts read as
///    "this chain has no streams".
/// v5 added referral_set (ReferralSet).
/// v6 is the rolling-scoring redesign (phase 7), three changes in one bump:
///    stream_value's last column is now the ABSOLUTE HOUR the registry ring
///    keys on (it used to be the pool round — same topic hash, new meaning, so
///    old rows are wrong, not just mislabeled; db.ts drops the old-shape table
///    and this rewind refills it); derived streams were deleted from the
///    registry, taking DerivedStreamCreated and its table with them; and the
///    three voting events (Voted / GameApprovedSet / VotesMoved) are newly
///    indexed, so their empty tables need the full backfill.
/// v7 adds adapter_id to data_stream_created, read from the registry because
///    DataStreamCreated does not carry it. A resync is REQUIRED: db.ts drops
///    the old-shape table and this rewind refills it.
/// v8: DataStreamCreated carries the whole creation record (creator, adapterId,
///    cadence, config), and NamedAdapterSet / NamedStreamCreated are indexed, so
///    the registry is never read; same topic set, new topic hash, and a wipe.
/// v9 adds the game registry (GameCreated / GameNameUpdated /
///    GameAuthorityTransferred); the rewind backfills its three empty tables.
/// v10: BountyFunded carries newPool (new topic hash), and BountyDripped /
///    StrandedPotReclaimed are indexed into bounty_pool_state, so a pair's
///    pool, rate and liveness are folds; bounty_funded is dropped and refilled.
const EVENT_SCHEMA_VERSION = '13';

export class Indexer {
  private db: Database.Database;
  private provider: JsonRpcProvider;
  private cfg: Config;
  state: IndexerState;
  private stopped = false;

  constructor(db: Database.Database, provider: JsonRpcProvider, cfg: Config, startBlock: number) {
    this.db = db;
    this.provider = provider;
    this.cfg = cfg;
    // Adding an event to the indexed set does NOT backfill on its own: the new
    // table is created empty and the cursor is already at head, so history is
    // silently missing and the counts look like the event simply never fires.
    // That is exactly how the void outcomes stayed invisible.
    //
    // So the indexed event set carries a version. When it changes, the cursor is
    // rewound to the start and everything is re-scanned. Every insert is
    // `INSERT OR REPLACE` keyed on (block, log_index), so a full re-scan is
    // idempotent — it costs time, not correctness.
    const persisted = getMeta(db, 'lastScannedBlock');
    const seenVersion = getMeta(db, 'eventSchemaVersion');
    const stale = seenVersion !== EVENT_SCHEMA_VERSION;
    if (stale) {
      // Version and rewound cursor land together: db.ts has already dropped the
      // reshaped tables, so a crash between the two would persist the new
      // version with the old cursor and never backfill them.
      db.transaction(() => {
        setMeta(db, 'eventSchemaVersion', EVENT_SCHEMA_VERSION);
        setMeta(db, 'lastScannedBlock', String(startBlock - 1));
      })();
      if (persisted) {
        // eslint-disable-next-line no-console
        console.log(`[indexer] indexed event set changed (${seenVersion ?? 'none'} -> ` +
          `${EVENT_SCHEMA_VERSION}); rescanning from ${startBlock} to backfill`);
      }
    }
    this.state = {
      startBlock,
      lastScannedBlock: (persisted && !stale) ? Number(persisted) : startBlock - 1,
      head: 0,
      ticks: 0,
      lastError: null,
      syncing: true,
    };
  }

  async start(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (!this.stopped) {
      try {
        await this.tick();
        this.state.lastError = null;
      } catch (e: any) {
        this.state.lastError = String(e?.message ?? e);
        console.error('[indexer] tick failed:', this.state.lastError);
      }
      this.state.ticks++;
      await sleep(this.cfg.pollMs);
    }
  }

  stop(): void { this.stopped = true; }

  /// Whether the voting contract is configured (and its tables therefore
  /// meaningful). Exposed so the server can answer 503 instead of an empty
  /// ledger, the same refusal /streams makes when the registry is unset.
  get votesIndexed(): boolean { return this.cfg.addresses.voting !== ''; }
  /// Lowercased; '' for an optional contract this indexer does not follow.
  get addresses(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.cfg.addresses).map(([k, v]) => [k, String(v).toLowerCase()]));
  }
  get gamesIndexed(): boolean { return this.cfg.addresses.games !== ''; }

  /// Retry a chunk fetch through a transient provider failure.
  ///
  /// Rate limiting is the case this exists for, and it does not arrive looking
  /// like anything in particular: Base returns JSON-RPC -32016 "over rate limit",
  /// others answer HTTP 429, and ethers wraps both in its own error shapes. So
  /// this matches on the text as well as the codes.
  ///
  /// Backoff is exponential BECAUSE the failure is rate limiting: retrying at a
  /// fixed interval is indistinguishable from the load that caused the limit, and
  /// keeps it tripped. A revert or a decode error is not retried at all — those
  /// are answers, and asking again gets the same one.
  private async withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message ?? e);
        const transient =
          e?.code === -32016 || e?.error?.code === -32016 ||
          /rate limit|429|too many requests|timeout|ETIMEDOUT|ECONNRESET|SERVER_ERROR|NETWORK_ERROR/i.test(msg);
        if (!transient || i === attempts - 1) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); // 1s, 2s, 4s, 8s
      }
    }
    throw lastErr;
  }

  private async tick(): Promise<void> {
    const head = await this.provider.getBlockNumber();
    this.state.head = head;
    const { startBlock } = this.state;

    let last = this.state.lastScannedBlock;

    // Head moved backward: rollback/reset. Trim, don't nuke (unless the head
    // is before our start block — a fresh dev chain — then restart clean).
    if (last > head) {
      if (head < startBlock) {
        deleteFromBlock(this.db, 0);
        last = startBlock - 1;
      } else {
        deleteFromBlock(this.db, head + 1);
        last = head;
      }
    }

    // Reorg overlap: always re-scan the trailing window.
    const rescanStart = Math.max(startBlock, Math.min(last + 1, head - this.cfg.reorgDepth + 1));
    if (rescanStart > head) { // nothing to do (fresh chain shorter than start)
      this.state.lastScannedBlock = last;
      return;
    }

    // Clear the rescan window ONCE, then commit each chunk as it lands.
    //
    // This used to accumulate the entire walk in memory and write it in a single
    // transaction at the end, which made a cold sync all-or-nothing: ~17 chunks
    // for a 31k-block catch-up, and one failed request anywhere threw away every
    // chunk before it. On a rate-limited endpoint that is unrecoverable by
    // construction — the retry six seconds later starts from scratch, spends the
    // same budget, fails again, and the retries themselves keep the limit tripped.
    // Observed on the first real deployment: `lastScannedBlock` never moved off
    // its start block, on a chain that was answering perfectly well.
    //
    // Per-chunk commits make progress durable, so a failure costs one chunk and
    // the next tick resumes behind it instead of restarting.
    const clearWindow = this.db.transaction((from: number) => { deleteFromBlock(this.db, from); });
    const commitChunk = this.db.transaction((logsByKind: DecodedBatch, to: number) => {
      this.insertBatch(logsByKind);
      setMeta(this.db, 'lastScannedBlock', String(to));
    });

    clearWindow(rescanStart);

    let logsSeen = 0;
    let cursor = rescanStart;
    while (cursor <= head) {
      const chunkEnd = Math.min(cursor + this.cfg.chunkSize - 1, head);
      const [engineLogs, bountyLogs, rewardLogs, registryLogs, votingLogs, gamesLogs] = await this.withRetry(() => Promise.all([
        this.provider.getLogs({
          address: this.cfg.addresses.engine,
          topics: [[
            TOPICS.predictionMade, TOPICS.predictionScored,
            // Terminal-but-not-scored outcomes. Omitting these is what made a
            // finally-judged prediction look identical to a pending one.
            TOPICS.predictionVoided, TOPICS.predictionUnrecoverable,
            TOPICS.predictionDisplaced,
            TOPICS.streakThresholdSet, TOPICS.curveConfigSet,
          ]],
          fromBlock: cursor, toBlock: chunkEnd,
        }),
        this.provider.getLogs({
          address: this.cfg.addresses.bounties,
          topics: [[
            TOPICS.bountyFunded, TOPICS.bountyTokenCleaned,
            TOPICS.bountyDripped, TOPICS.strandedPotReclaimed,
          ]],
          fromBlock: cursor, toBlock: chunkEnd,
        }),
        this.provider.getLogs({
          address: this.cfg.addresses.rewards,
          topics: [[
            TOPICS.referralPaid, TOPICS.referralSet,
            TOPICS.rewardSplit, TOPICS.delegatorRewardsAccrued, TOPICS.rewardsClaimed,
            TOPICS.roundBudgetFrozen,
            TOPICS.predictionDelegated, TOPICS.predictionUndelegated, TOPICS.delegatePowerSynced,
          ]],
          fromBlock: cursor, toBlock: chunkEnd,
        }),
        // Optional: with no REGISTRY_ADDRESS this resolves to [] and costs no
        // request, so an existing deployment keeps its 3-request steady-state
        // tick until it is configured.
        this.cfg.addresses.registry
          ? this.provider.getLogs({
            address: this.cfg.addresses.registry,
            topics: [[
              TOPICS.dataStreamCreated, TOPICS.streamValueUpdated,
              TOPICS.nameUpdated, TOPICS.providerChanged,
              TOPICS.namedAdapterSet, TOPICS.namedStreamCreated,
            ]],
            fromBlock: cursor, toBlock: chunkEnd,
          })
          : Promise.resolve([] as Log[]),
        // Optional for the same reason the registry is: no VOTING_ADDRESS, no
        // request, and existing deployments keep their tick shape unchanged.
        this.cfg.addresses.voting
          ? this.provider.getLogs({
            address: this.cfg.addresses.voting,
            topics: [[TOPICS.voted, TOPICS.gameApprovedSet, TOPICS.votesMoved]],
            fromBlock: cursor, toBlock: chunkEnd,
          })
          : Promise.resolve([] as Log[]),
        this.cfg.addresses.games
          ? this.provider.getLogs({
            address: this.cfg.addresses.games,
            topics: [[TOPICS.gameCreated, TOPICS.gameNameUpdated, TOPICS.gameAuthorityTransferred]],
            fromBlock: cursor, toBlock: chunkEnd,
          })
          : Promise.resolve([] as Log[]),
      ]));
      const batch: DecodedBatch = emptyBatch();
      decodeInto(batch, engineLogs, bountyLogs, rewardLogs, registryLogs, votingLogs, gamesLogs);
      logsSeen += countBatch(batch);
      commitChunk(batch, chunkEnd);
      this.state.lastScannedBlock = chunkEnd;
      cursor = chunkEnd + 1;
    }

    this.state.lastScannedBlock = head;
    if (this.state.syncing) {
      this.state.syncing = false;
      console.log(`[indexer] synced to head ${head} (${logsSeen} logs in the final walk)`);
    }
  }

  private insertBatch(b: DecodedBatch): void {
    const scored = this.db.prepare(
      'INSERT OR REPLACE INTO prediction_scored (block, log_index, tx, user, game_id, round, correct, streak, scaled_weight) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const r of b.scored) scored.run(...r);
    const made = this.db.prepare(
      'INSERT OR REPLACE INTO prediction_made (block, log_index, tx, predictor, game_id, round, direction, streak, power_wei, power_eth, hour) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const r of b.made) made.run(...r);
    const funded = this.db.prepare(
      'INSERT OR REPLACE INTO bounty_funded (block, log_index, tx, funder, game_id, token, received, proposed_rate, new_rate, new_pool) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of b.funded) funded.run(...r);
    const poolState = this.db.prepare(
      'INSERT OR REPLACE INTO bounty_pool_state (block, log_index, tx, kind, game_id, token, round, amount, new_pool, new_rate) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of b.poolState) poolState.run(...r);
    const cleaned = this.db.prepare(
      'INSERT OR REPLACE INTO bounty_cleaned (block, log_index, tx, game_id, token, caller) VALUES (?,?,?,?,?,?)');
    for (const r of b.cleaned) cleaned.run(...r);
    const referral = this.db.prepare(
      'INSERT OR REPLACE INTO referral_paid (block, log_index, tx, owner, referral, amount_wei, round) VALUES (?,?,?,?,?,?,?)');
    for (const r of b.referral) referral.run(...r);
    // OR IGNORE, not OR REPLACE: `user` is UNIQUE and the slot locks on first
    // set, so a re-scan of the same log must be a no-op rather than a conflict.
    const referralSet = this.db.prepare(
      'INSERT OR IGNORE INTO referral_set (block, log_index, tx, user, referral) VALUES (?,?,?,?,?)');
    for (const r of b.referralSet) referralSet.run(...r);
    const ledger = this.db.prepare(
      'INSERT OR REPLACE INTO unclaimed_ledger (block, log_index, tx, account, kind, game_id, round, amount_wei, new_unclaimed) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const r of b.ledger) ledger.run(...r);
    const roundBudget = this.db.prepare(
      'INSERT OR REPLACE INTO round_budget (block, log_index, tx, round, budget_wei) VALUES (?,?,?,?,?)');
    for (const r of b.roundBudget) roundBudget.run(...r);
    const delegation = this.db.prepare(
      'INSERT OR REPLACE INTO delegation (block, log_index, tx, kind, delegator, delegate, power_wei, activation_round, new_delegate_power) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const r of b.delegation) delegation.run(...r);
    const voided = this.db.prepare(
      'INSERT OR REPLACE INTO prediction_voided (block, log_index, tx, user, game_id, round, direction, stagnant_value) VALUES (?,?,?,?,?,?,?,?)');
    for (const r of b.voided) voided.run(...r);
    const unrec = this.db.prepare(
      'INSERT OR REPLACE INTO prediction_unrecoverable (block, log_index, tx, user, game_id, round, anchor_evicted) VALUES (?,?,?,?,?,?,?)');
    for (const r of b.unrecoverable) unrec.run(...r);
    const displaced = this.db.prepare(
      'INSERT OR REPLACE INTO prediction_displaced (block, log_index, tx, user, game_id, round) VALUES (?,?,?,?,?,?)');
    for (const r of b.displaced) displaced.run(...r);
    const streamCreated = this.db.prepare(
      'INSERT OR REPLACE INTO data_stream_created (block, log_index, tx, stream_id, creator, provider, adapter_id, min_cadence_minutes, config, name) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of b.streamCreated) streamCreated.run(...r);
    const gameCreated = this.db.prepare(
      'INSERT OR REPLACE INTO game_created (block, log_index, tx, game_id, stream_id, authority, game_type_id, target_minutes, name, config) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of b.gameCreated) gameCreated.run(...r);
    const gameName = this.db.prepare(
      'INSERT OR REPLACE INTO game_name_updated (block, log_index, tx, game_id, new_name) VALUES (?,?,?,?,?)');
    for (const r of b.gameNameUpdated) gameName.run(...r);
    const gameAuth = this.db.prepare(
      'INSERT OR REPLACE INTO game_authority_transferred (block, log_index, tx, game_id, old_authority, new_authority) VALUES (?,?,?,?,?,?)');
    for (const r of b.gameAuthorityTransferred) gameAuth.run(...r);
    const threshold = this.db.prepare(
      'INSERT OR REPLACE INTO streak_threshold (block, log_index, tx, game_id, round, threshold) VALUES (?,?,?,?,?,?)');
    for (const r of b.streakThreshold) threshold.run(...r);
    const curve = this.db.prepare(
      'INSERT OR REPLACE INTO curve_config (block, log_index, tx, dust_floor, top_gradient, bottom_gradient, top_shift) VALUES (?,?,?,?,?,?,?)');
    for (const r of b.curveConfig) curve.run(...r);
    const namedAdapter = this.db.prepare(
      'INSERT OR REPLACE INTO named_adapter_set (block, log_index, tx, adapter_id) VALUES (?,?,?,?)');
    for (const r of b.namedAdapterSet) namedAdapter.run(...r);
    const namedStream = this.db.prepare(
      'INSERT OR REPLACE INTO named_stream_created (block, log_index, tx, stream_id, name_key) VALUES (?,?,?,?,?)');
    for (const r of b.namedStreamCreated) namedStream.run(...r);
    const streamValue = this.db.prepare(
      'INSERT OR REPLACE INTO stream_value (block, log_index, tx, stream_id, old_value, new_value, hour) VALUES (?,?,?,?,?,?,?)');
    for (const r of b.streamValue) streamValue.run(...r);
    const nameUpd = this.db.prepare(
      'INSERT OR REPLACE INTO stream_name_updated (block, log_index, tx, stream_id, new_name) VALUES (?,?,?,?,?)');
    for (const r of b.nameUpdated) nameUpd.run(...r);
    const provChg = this.db.prepare(
      'INSERT OR REPLACE INTO stream_provider_changed (block, log_index, tx, stream_id, old_provider, new_provider) VALUES (?,?,?,?,?,?)');
    for (const r of b.providerChanged) provChg.run(...r);
    const vote = this.db.prepare(
      'INSERT OR REPLACE INTO vote (block, log_index, tx, voter, game_id, round, amount, weight_added, new_game_weight) VALUES (?,?,?,?,?,?,?,?,?)');
    for (const r of b.voted) vote.run(...r);
    const gameApproved = this.db.prepare(
      'INSERT OR REPLACE INTO game_approved (block, log_index, tx, game_id, approved) VALUES (?,?,?,?,?)');
    for (const r of b.gameApproved) gameApproved.run(...r);
    const voteMoved = this.db.prepare(
      'INSERT OR REPLACE INTO vote_moved (block, log_index, tx, voter, from_game, to_game, round, amount, new_from_weight, new_to_weight) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const r of b.voteMoved) voteMoved.run(...r);
  }
}

interface DecodedBatch {
  scored: unknown[][];
  made: unknown[][];
  funded: unknown[][];
  poolState: unknown[][];
  cleaned: unknown[][];
  referral: unknown[][];
  voided: unknown[][];
  unrecoverable: unknown[][];
  displaced: unknown[][];
  streamCreated: unknown[][];
  gameCreated: unknown[][];
  gameNameUpdated: unknown[][];
  gameAuthorityTransferred: unknown[][];
  streakThreshold: unknown[][];
  curveConfig: unknown[][];
  namedAdapterSet: unknown[][];
  namedStreamCreated: unknown[][];
  streamValue: unknown[][];
  nameUpdated: unknown[][];
  providerChanged: unknown[][];
  referralSet: unknown[][];
  ledger: unknown[][];
  roundBudget: unknown[][];
  delegation: unknown[][];
  voted: unknown[][];
  gameApproved: unknown[][];
  voteMoved: unknown[][];
}
const emptyBatch = (): DecodedBatch => ({
  scored: [], made: [], funded: [], poolState: [], cleaned: [], referral: [], referralSet: [],
  ledger: [], roundBudget: [], delegation: [],
  voided: [], unrecoverable: [], displaced: [],
  streamCreated: [], namedAdapterSet: [], namedStreamCreated: [],
  gameCreated: [], gameNameUpdated: [], gameAuthorityTransferred: [],
  streakThreshold: [], curveConfig: [],
  streamValue: [], nameUpdated: [], providerChanged: [],
  voted: [], gameApproved: [], voteMoved: [],
});
const countBatch = (b: DecodedBatch) =>
  b.scored.length + b.made.length + b.funded.length + b.poolState.length + b.cleaned.length + b.referral.length +
  b.voided.length + b.unrecoverable.length + b.displaced.length +
  b.streamCreated.length + b.namedAdapterSet.length + b.namedStreamCreated.length + b.streamValue.length +
  b.gameCreated.length + b.gameNameUpdated.length + b.gameAuthorityTransferred.length +
  b.streakThreshold.length + b.curveConfig.length +
  b.nameUpdated.length + b.providerChanged.length + b.referralSet.length +
  b.ledger.length + b.roundBudget.length + b.delegation.length +
  b.voted.length + b.gameApproved.length + b.voteMoved.length;

function decodeInto(
  batch: DecodedBatch,
  engineLogs: Log[],
  bountyLogs: Log[],
  rewardLogs: Log[],
  registryLogs: Log[],
  votingLogs: Log[],
  gamesLogs: Log[],
): void {
  for (const log of engineLogs) {
    const t0 = log.topics[0];
    if (t0 === TOPICS.predictionScored) {
      const a = engineIface.decodeEventLog('PredictionScored', log.data, log.topics);
      batch.scored.push([
        log.blockNumber, log.index, log.transactionHash,
        String(a.user).toLowerCase(), Number(a.gameId), Number(a.round),
        a.correct ? 1 : 0, Number(a.streak), a.scaledWeight.toString(),
      ]);
    } else if (t0 === TOPICS.predictionMade) {
      const a = engineIface.decodeEventLog('PredictionMade', log.data, log.topics);
      batch.made.push([
        log.blockNumber, log.index, log.transactionHash,
        String(a.predictor).toLowerCase(), Number(a.gameId), Number(a.round),
        Number(a.direction), Number(a.streak),
        a.predictionPower.toString(), Number(formatEther(a.predictionPower)),
        Number(a.hour),
      ]);
    } else if (t0 === TOPICS.predictionVoided) {
      const a = engineIface.decodeEventLog('PredictionVoided', log.data, log.topics);
      batch.voided.push([
        log.blockNumber, log.index, log.transactionHash,
        String(a.user).toLowerCase(), Number(a.gameId), Number(a.round),
        Number(a.direction),
        // int232: stringified, never coerced. It is signed and far outside
        // Number's safe range.
        a.stagnantValue.toString(),
      ]);
    } else if (t0 === TOPICS.predictionUnrecoverable) {
      const a = engineIface.decodeEventLog('PredictionUnrecoverable', log.data, log.topics);
      batch.unrecoverable.push([
        log.blockNumber, log.index, log.transactionHash,
        String(a.user).toLowerCase(), Number(a.gameId), Number(a.round),
        a.anchorEvicted ? 1 : 0,
      ]);
    } else if (t0 === TOPICS.predictionDisplaced) {
      const a = engineIface.decodeEventLog('PredictionDisplaced', log.data, log.topics);
      batch.displaced.push([
        log.blockNumber, log.index, log.transactionHash,
        String(a.user).toLowerCase(), Number(a.gameId), Number(a.round),
      ]);
    } else if (t0 === TOPICS.streakThresholdSet) {
      const a = engineIface.decodeEventLog('StreakThresholdSet', log.data, log.topics);
      batch.streakThreshold.push([
        log.blockNumber, log.index, log.transactionHash,
        Number(a.gameId), Number(a.round), Number(a.threshold),
      ]);
    } else if (t0 === TOPICS.curveConfigSet) {
      const a = engineIface.decodeEventLog('CurveConfigSet', log.data, log.topics);
      batch.curveConfig.push([
        log.blockNumber, log.index, log.transactionHash,
        Number(a.dustFloor), Number(a.topGradient), Number(a.bottomGradient), Number(a.topShift),
      ]);
    }
  }
  for (const log of bountyLogs) {
    const t0 = log.topics[0];
    if (t0 === TOPICS.bountyFunded) {
      const a = bountiesIface.decodeEventLog('BountyFunded', log.data, log.topics);
      batch.funded.push([
        log.blockNumber, log.index, log.transactionHash,
        String(a.funder).toLowerCase(), Number(a.gameId), String(a.token).toLowerCase(),
        a.received.toString(), a.proposedRate.toString(), a.newRate.toString(), a.newPool.toString(),
      ]);
      batch.poolState.push([
        log.blockNumber, log.index, log.transactionHash, 'fund',
        Number(a.gameId), String(a.token).toLowerCase(), null,
        a.received.toString(), a.newPool.toString(), a.newRate.toString(),
      ]);
    } else if (t0 === TOPICS.bountyDripped || t0 === TOPICS.strandedPotReclaimed) {
      const drip = t0 === TOPICS.bountyDripped;
      const a = bountiesIface.decodeEventLog(drip ? 'BountyDripped' : 'StrandedPotReclaimed', log.data, log.topics);
      batch.poolState.push([
        log.blockNumber, log.index, log.transactionHash, drip ? 'drip' : 'reclaim',
        Number(a.gameId), String(a.token).toLowerCase(), Number(a.round),
        a.amount.toString(), a.newPool.toString(), a.newRate.toString(),
      ]);
    } else if (t0 === TOPICS.bountyTokenCleaned) {
      const a = bountiesIface.decodeEventLog('BountyTokenCleaned', log.data, log.topics);
      batch.cleaned.push([
        log.blockNumber, log.index, log.transactionHash,
        Number(a.gameId), String(a.token).toLowerCase(), String(a.caller).toLowerCase(),
      ]);
    }
  }
  // Two event types share this address now, so branch on topic0 rather than
  // decoding every log as ReferralPaid — that would throw on a ReferralSet.
  for (const log of rewardLogs) {
    const t0 = log.topics[0];
    const head = [log.blockNumber, log.index, log.transactionHash];
    if (t0 === TOPICS.referralSet) {
      const a = rewardsIface.decodeEventLog('ReferralSet', log.data, log.topics);
      batch.referralSet.push([...head, String(a.user).toLowerCase(), String(a.referral).toLowerCase()]);
    } else if (t0 === TOPICS.referralPaid) {
      const a = rewardsIface.decodeEventLog('ReferralPaid', log.data, log.topics);
      const referral = String(a.referral).toLowerCase();
      batch.referral.push([...head, String(a.owner).toLowerCase(), referral, a.amount.toString(), Number(a.round)]);
      batch.ledger.push([...head, referral, 'referral', null, Number(a.round), a.amount.toString(), a.newUnclaimed.toString()]);
    } else if (t0 === TOPICS.rewardSplit) {
      const a = rewardsIface.decodeEventLog('RewardSplit', log.data, log.topics);
      batch.ledger.push([...head, String(a.predictor).toLowerCase(), 'win', Number(a.gameId), Number(a.round),
        a.predictorAmount.toString(), a.newUnclaimed.toString()]);
    } else if (t0 === TOPICS.delegatorRewardsAccrued) {
      const a = rewardsIface.decodeEventLog('DelegatorRewardsAccrued', log.data, log.topics);
      batch.ledger.push([...head, String(a.delegator).toLowerCase(), 'accrual', null, null,
        a.amount.toString(), a.newUnclaimed.toString()]);
    } else if (t0 === TOPICS.rewardsClaimed) {
      const a = rewardsIface.decodeEventLog('RewardsClaimed', log.data, log.topics);
      batch.ledger.push([...head, String(a.owner).toLowerCase(), 'claim', null, Number(a.round),
        a.totalAmount.toString(), '0']);
    } else if (t0 === TOPICS.roundBudgetFrozen) {
      const a = rewardsIface.decodeEventLog('RoundBudgetFrozen', log.data, log.topics);
      batch.roundBudget.push([...head, Number(a.round), a.budget.toString()]);
    } else if (t0 === TOPICS.predictionDelegated) {
      const a = rewardsIface.decodeEventLog('PredictionDelegated', log.data, log.topics);
      batch.delegation.push([...head, 'delegated', String(a.delegator).toLowerCase(), String(a.delegate).toLowerCase(),
        a.predictionPower.toString(), Number(a.activationRound), a.newDelegatePower.toString()]);
    } else if (t0 === TOPICS.predictionUndelegated) {
      const a = rewardsIface.decodeEventLog('PredictionUndelegated', log.data, log.topics);
      batch.delegation.push([...head, 'undelegated', String(a.delegator).toLowerCase(), String(a.delegate).toLowerCase(),
        a.predictionPower.toString(), null, a.newDelegatePower.toString()]);
    } else if (t0 === TOPICS.delegatePowerSynced) {
      const a = rewardsIface.decodeEventLog('DelegatePowerSynced', log.data, log.topics);
      batch.delegation.push([...head, 'synced', String(a.delegator).toLowerCase(), String(a.delegate).toLowerCase(),
        a.value.toString(), Number(a.activationRound), a.newDelegatePower.toString()]);
    }
  }
  for (const log of registryLogs) {
    const t0 = log.topics[0];
    if (t0 === TOPICS.streamValueUpdated) {
      const a = registryIface.decodeEventLog('StreamValueUpdated', log.data, log.topics);
      batch.streamValue.push([
        log.blockNumber, log.index, log.transactionHash,
        Number(a.streamId),
        // int256, stringified and never coerced: signed, out of Number's safe
        // range, and for tick streams not even a price. `hour` is the absolute
        // hour of the observation (timestamp / 3600), a small integer.
        a.oldValue.toString(), a.newValue.toString(), Number(a.hour),
      ]);
    } else if (t0 === TOPICS.dataStreamCreated) {
      const a = registryIface.decodeEventLog('DataStreamCreated', log.data, log.topics);
      batch.streamCreated.push([
        log.blockNumber, log.index, log.transactionHash,
        Number(a.streamId), String(a.creator).toLowerCase(), String(a.provider).toLowerCase(),
        Number(a.adapterId), Number(a.minCadenceMinutes), String(a.config), String(a.name),
      ]);
    } else if (t0 === TOPICS.namedAdapterSet) {
      const a = registryIface.decodeEventLog('NamedAdapterSet', log.data, log.topics);
      batch.namedAdapterSet.push([
        log.blockNumber, log.index, log.transactionHash, Number(a.adapterId),
      ]);
    } else if (t0 === TOPICS.namedStreamCreated) {
      const a = registryIface.decodeEventLog('NamedStreamCreated', log.data, log.topics);
      batch.namedStreamCreated.push([
        log.blockNumber, log.index, log.transactionHash, Number(a.streamId), String(a.nameKey),
      ]);
    } else if (t0 === TOPICS.nameUpdated) {
      const a = registryIface.decodeEventLog('NameUpdated', log.data, log.topics);
      batch.nameUpdated.push([
        log.blockNumber, log.index, log.transactionHash,
        Number(a.streamId), String(a.newName),
      ]);
    } else if (t0 === TOPICS.providerChanged) {
      const a = registryIface.decodeEventLog('ProviderChanged', log.data, log.topics);
      batch.providerChanged.push([
        log.blockNumber, log.index, log.transactionHash,
        Number(a.streamId), String(a.oldProvider).toLowerCase(),
        String(a.newProvider).toLowerCase(),
      ]);
    }
  }
  for (const log of votingLogs) {
    const t0 = log.topics[0];
    if (t0 === TOPICS.voted) {
      const a = votingIface.decodeEventLog('Voted', log.data, log.topics);
      batch.voted.push([
        log.blockNumber, log.index, log.transactionHash,
        String(a.voter).toLowerCase(), Number(a.gameId), Number(a.round),
        // uint256 token amounts and weights: TEXT wei, never coerced.
        a.amountBurned.toString(), a.weightAdded.toString(), a.newGameWeight.toString(),
      ]);
    } else if (t0 === TOPICS.gameApprovedSet) {
      const a = votingIface.decodeEventLog('GameApprovedSet', log.data, log.topics);
      batch.gameApproved.push([
        log.blockNumber, log.index, log.transactionHash,
        Number(a.gameId), a.approved ? 1 : 0,
      ]);
    } else if (t0 === TOPICS.votesMoved) {
      const a = votingIface.decodeEventLog('VotesMoved', log.data, log.topics);
      batch.voteMoved.push([
        log.blockNumber, log.index, log.transactionHash,
        String(a.voter).toLowerCase(), Number(a.fromGame), Number(a.toGame),
        Number(a.round), a.amount.toString(),
        a.newFromWeight.toString(), a.newToWeight.toString(),
      ]);
    }
  }
  for (const log of gamesLogs) {
    const t0 = log.topics[0];
    if (t0 === TOPICS.gameCreated) {
      const a = gamesIface.decodeEventLog('GameCreated', log.data, log.topics);
      batch.gameCreated.push([
        log.blockNumber, log.index, log.transactionHash,
        Number(a.gameId), Number(a.dataStreamId), String(a.authority).toLowerCase(),
        Number(a.gameTypeId), Number(a.targetMinutes), String(a.name), String(a.gameConfig),
      ]);
    } else if (t0 === TOPICS.gameNameUpdated) {
      const a = gamesIface.decodeEventLog('GameNameUpdated', log.data, log.topics);
      batch.gameNameUpdated.push([
        log.blockNumber, log.index, log.transactionHash, Number(a.gameId), String(a.newName),
      ]);
    } else if (t0 === TOPICS.gameAuthorityTransferred) {
      const a = gamesIface.decodeEventLog('GameAuthorityTransferred', log.data, log.topics);
      batch.gameAuthorityTransferred.push([
        log.blockNumber, log.index, log.transactionHash, Number(a.gameId),
        String(a.oldAuthority).toLowerCase(), String(a.newAuthority).toLowerCase(),
      ]);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
