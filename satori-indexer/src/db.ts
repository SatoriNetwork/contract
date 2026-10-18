import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// One row per log; (block, logIndex) is the chain-global identity of a log,
// so it's the primary key everywhere — inserts are idempotent (INSERT OR
// REPLACE) and the reorg overlap re-scan can safely delete-and-refill.
//
// uint256 money amounts are stored as TEXT (decimal wei) for fidelity; where
// a view needs aggregation (sentiment power), a REAL ether-denominated column
// sits alongside — matching the precision the dapp itself displays.

export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // -- Wipe-and-resync migration (rolling-scoring redesign, phase 7) --------
  // stream_value's last column changed MEANING, not just name: the registry
  // ring is hour-keyed now, so StreamValueUpdated's final arg is the absolute
  // hour (timestamp / 3600) where it used to be the pool round. CREATE TABLE
  // IF NOT EXISTS cannot rename a column, and rewriting rounds into hours in
  // place is impossible anyway (a round held many observations; the hour is
  // not recoverable from the row). So the migration path is the one this
  // indexer already owns end to end: drop the old-shape table here and let the
  // EVENT_SCHEMA_VERSION bump in indexer.ts rewind the cursor and refill
  // everything from the chain — wipe-and-resync, deliberately, instead of an
  // ALTER dance that would leave stale round values wearing an hour label.
  // derived_stream_created is dropped the same way but permanently: the
  // redesign deleted derived streams and their machinery from the registry.
  const staleStreamValue = db.prepare(
    "SELECT COUNT(*) AS n FROM pragma_table_info('stream_value') WHERE name = 'round'"
  ).get() as { n: number };
  if (staleStreamValue.n > 0) db.exec('DROP TABLE stream_value');
  db.exec('DROP TABLE IF EXISTS derived_stream_created');
  // Same path for data_stream_created becoming the full creation record (v8):
  // drop the old-shape table and let the version rewind refill it.
  const staleStreamCreated = db.prepare(
    "SELECT COUNT(*) AS n FROM pragma_table_info('data_stream_created') WHERE name = 'creator'"
  ).get() as { n: number };
  if (staleStreamCreated.n === 0) db.exec('DROP TABLE IF EXISTS data_stream_created');
  // And for bounty_funded gaining new_pool (v10).
  const staleFunded = db.prepare(
    "SELECT COUNT(*) AS n FROM pragma_table_info('bounty_funded') WHERE name = 'new_pool'"
  ).get() as { n: number };
  if (staleFunded.n === 0) db.exec('DROP TABLE IF EXISTS bounty_funded');
  // And for prediction_made gaining hour (v13).
  const staleMade = db.prepare(
    "SELECT COUNT(*) AS n FROM pragma_table_info('prediction_made') WHERE name = 'hour'"
  ).get() as { n: number };
  if (staleMade.n === 0) db.exec('DROP TABLE IF EXISTS prediction_made');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prediction_scored (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      user      TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      round     INTEGER NOT NULL,
      correct   INTEGER NOT NULL,
      streak    INTEGER NOT NULL,
      scaled_weight TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_scored_pair ON prediction_scored (user, game_id, block DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_scored_game ON prediction_scored (game_id);

    CREATE TABLE IF NOT EXISTS prediction_made (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      predictor TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      round     INTEGER NOT NULL,
      direction INTEGER NOT NULL,
      streak    INTEGER NOT NULL,
      power_wei TEXT NOT NULL,
      power_eth REAL NOT NULL,
      hour      INTEGER NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_made_game_round ON prediction_made (game_id, round);
    CREATE INDEX IF NOT EXISTS idx_made_predictor_game ON prediction_made (predictor, game_id, hour DESC);

    -- Terminal outcomes that are NOT a win or a loss. A prediction reaching any
    -- of these is finished; without them the dapp cannot tell "finally judged,
    -- no result" from "still waiting", and shows both as pending forever.
    CREATE TABLE IF NOT EXISTS prediction_voided (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      user      TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      round     INTEGER NOT NULL,
      direction INTEGER NOT NULL,
      -- int232 on chain; kept as TEXT because it does not fit a JS number and
      -- can be negative, so neither INTEGER nor a naive parse is safe.
      stagnant_value TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_voided_pair ON prediction_voided (user, game_id, block DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_voided_round ON prediction_voided (game_id, round);

    CREATE TABLE IF NOT EXISTS prediction_unrecoverable (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      user      TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      round     INTEGER NOT NULL,
      anchor_evicted INTEGER NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_unrec_pair ON prediction_unrecoverable (user, game_id, block DESC, log_index DESC);

    CREATE TABLE IF NOT EXISTS prediction_displaced (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      user      TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      round     INTEGER NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_displaced_pair ON prediction_displaced (user, game_id, block DESC, log_index DESC);

    CREATE TABLE IF NOT EXISTS bounty_funded (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      funder    TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      token     TEXT NOT NULL,
      received  TEXT NOT NULL,
      proposed_rate TEXT NOT NULL,
      new_rate  TEXT NOT NULL,
      new_pool  TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_funded_token ON bounty_funded (token);
    CREATE INDEX IF NOT EXISTS idx_funded_pair ON bounty_funded (game_id, token);

    -- Every pool write (fund, drip, reclaim) with the (pool, rate) it left.
    -- A pair's current state is its latest row; live = new_rate != '0'.
    CREATE TABLE IF NOT EXISTS bounty_pool_state (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      kind      TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      token     TEXT NOT NULL,
      round     INTEGER,
      amount    TEXT NOT NULL,
      new_pool  TEXT NOT NULL,
      new_rate  TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_pool_state_pair ON bounty_pool_state (game_id, token, block DESC, log_index DESC);

    CREATE TABLE IF NOT EXISTS bounty_cleaned (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      token     TEXT NOT NULL,
      caller    TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_cleaned_pair ON bounty_cleaned (game_id, token);

    CREATE TABLE IF NOT EXISTS referral_paid (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      owner     TEXT NOT NULL,
      referral  TEXT NOT NULL,
      amount_wei TEXT NOT NULL,
      round     INTEGER NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_referral_ref ON referral_paid (referral);

    -- kind: win, accrual, referral, claim. new_unclaimed is the account's
    -- unclaimedRewards after the write ("0" for a claim).
    CREATE TABLE IF NOT EXISTS unclaimed_ledger (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      account   TEXT NOT NULL,
      kind      TEXT NOT NULL,
      game_id   INTEGER,
      round     INTEGER,
      amount_wei TEXT NOT NULL,
      new_unclaimed TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_unclaimed_account ON unclaimed_ledger (account, block DESC, log_index DESC);

    CREATE TABLE IF NOT EXISTS round_budget (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      round     INTEGER NOT NULL,
      budget_wei TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_round_budget_round ON round_budget (round);

    CREATE TABLE IF NOT EXISTS offchain_budget (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      round_set INTEGER NOT NULL,
      budget_wei TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );

    -- kind: delegated, undelegated, synced.
    CREATE TABLE IF NOT EXISTS delegation (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      kind      TEXT NOT NULL,
      delegator TEXT NOT NULL,
      delegate  TEXT NOT NULL,
      power_wei TEXT NOT NULL,
      activation_round INTEGER,
      new_delegate_power TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_delegation_delegator ON delegation (delegator, block DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_delegation_delegate ON delegation (delegate, block DESC, log_index DESC);

    -- Who designated whom, which referral_paid cannot answer: that only fires
    -- when a referee EARNS, so someone who registered and has not been paid yet
    -- is invisible in it. The user column is UNIQUE rather than part of the
    -- composite key because the contract locks the slot on first set, so a
    -- second row for the same user would mean the chain contradicted itself.
    -- (No backticks in this comment: the whole schema is a TS template literal.)
    CREATE TABLE IF NOT EXISTS referral_set (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      user      TEXT NOT NULL UNIQUE,
      referral  TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_referral_set_ref ON referral_set (referral);

    -- ── The stream registry ────────────────────────────────────────────────
    -- Serves two unrelated consumers: the dapp's "my streams" view, which
    -- cannot list adapter streams without knowing who created them, and the
    -- Nostr bridge, which mirrors creations and observations onto our relays.

    -- The whole creation record, straight from DataStreamCreated. adapter_id 0
    -- is a Simple stream; config is the adapter's bytes as a hex string.
    CREATE TABLE IF NOT EXISTS data_stream_created (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      stream_id INTEGER NOT NULL,
      creator   TEXT NOT NULL,
      provider  TEXT NOT NULL,
      adapter_id INTEGER NOT NULL,
      min_cadence_minutes INTEGER NOT NULL,
      config    TEXT NOT NULL,
      name      TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_stream_created_id ON data_stream_created (stream_id);
    CREATE INDEX IF NOT EXISTS idx_stream_created_creator ON data_stream_created (creator);

    -- The game registry: the whole GameMeta at creation (target already
    -- resolved), plus the two things that change afterwards, folded by the
    -- views the same way a stream's name and provider are.
    CREATE TABLE IF NOT EXISTS game_created (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      stream_id INTEGER NOT NULL,
      authority TEXT NOT NULL,
      game_type_id INTEGER NOT NULL,
      target_minutes INTEGER NOT NULL,
      name      TEXT NOT NULL,
      config    TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_game_created_id ON game_created (game_id);
    CREATE INDEX IF NOT EXISTS idx_game_created_stream ON game_created (stream_id);
    CREATE INDEX IF NOT EXISTS idx_game_created_authority ON game_created (authority);

    CREATE TABLE IF NOT EXISTS streak_threshold (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      round     INTEGER NOT NULL,
      threshold INTEGER NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_streak_threshold_id ON streak_threshold (game_id, block DESC, log_index DESC);

    CREATE TABLE IF NOT EXISTS curve_config (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      dust_floor      INTEGER NOT NULL,
      top_gradient    INTEGER NOT NULL,
      bottom_gradient INTEGER NOT NULL,
      top_shift       INTEGER NOT NULL,
      PRIMARY KEY (block, log_index)
    );

    CREATE TABLE IF NOT EXISTS game_name_updated (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      new_name  TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_game_name_id ON game_name_updated (game_id, block DESC, log_index DESC);

    CREATE TABLE IF NOT EXISTS game_authority_transferred (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      old_authority TEXT NOT NULL,
      new_authority TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_game_auth_id ON game_authority_transferred (game_id, block DESC, log_index DESC);

    -- One-shot wiring of the named adapter; the views fold the latest row.
    CREATE TABLE IF NOT EXISTS named_adapter_set (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      adapter_id INTEGER NOT NULL,
      PRIMARY KEY (block, log_index)
    );

    CREATE TABLE IF NOT EXISTS named_stream_created (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      stream_id INTEGER NOT NULL,
      name_key  TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_named_stream_id ON named_stream_created (stream_id);

    -- One row per observation. Values are int256 and kept as TEXT: they are
    -- SIGNED and far outside Number's safe range, and the Uniswap adapter
    -- stores a raw tick rather than a price, so any numeric coercion here
    -- would be both lossy and misleading. Converting is the consumer's job.
    -- The hour column is the ABSOLUTE hour of the observation (timestamp /
    -- 3600) as the hour-keyed registry ring emits it; the views derive a
    -- compatibility round from it as hour / 24.
    CREATE TABLE IF NOT EXISTS stream_value (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      stream_id INTEGER NOT NULL,
      old_value TEXT NOT NULL,
      new_value TEXT NOT NULL,
      hour      INTEGER NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_stream_value_id ON stream_value (stream_id, block DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_stream_value_hour ON stream_value (stream_id, hour);

    -- Name and provider both change after creation, so a consumer reading only
    -- DataStreamCreated drifts. The views fold the latest of each.
    CREATE TABLE IF NOT EXISTS stream_name_updated (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      stream_id INTEGER NOT NULL,
      new_name  TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_name_upd_id ON stream_name_updated (stream_id, block DESC, log_index DESC);

    CREATE TABLE IF NOT EXISTS stream_provider_changed (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      stream_id INTEGER NOT NULL,
      old_provider TEXT NOT NULL,
      new_provider TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_prov_chg_id ON stream_provider_changed (stream_id, block DESC, log_index DESC);

    -- -- The voting ledger --------------------------------------------------
    -- Voted fires on EVERY burn and carries the game's running total;
    -- GameApprovedSet and VotesMoved are the only other weight-moving events.
    -- SatoriVoting.sol's own docs: an indexer folding all three rebuilds every
    -- vote ledger exactly, with no contract reads and no silent drift. Burn
    -- amounts and weights are uint256 and stored as TEXT (decimal wei), same
    -- as every other money column here.
    CREATE TABLE IF NOT EXISTS vote (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      voter     TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      round     INTEGER NOT NULL,
      amount    TEXT NOT NULL,
      weight_added TEXT NOT NULL,
      new_game_weight TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_vote_game ON vote (game_id, block DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_vote_voter ON vote (voter, game_id);
    CREATE INDEX IF NOT EXISTS idx_vote_round ON vote (game_id, round);

    -- Latest row per game wins; a game with no row was never touched by the
    -- rewards admin, which is a different fact from "explicitly unapproved".
    CREATE TABLE IF NOT EXISTS game_approved (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      game_id   INTEGER NOT NULL,
      approved  INTEGER NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_game_approved_id ON game_approved (game_id, block DESC, log_index DESC);

    -- A burner re-pointing their own weight off an unapproved game. The
    -- new_from_weight / new_to_weight running totals are carried so the fold
    -- stays self-checking, exactly like vote.new_game_weight.
    CREATE TABLE IF NOT EXISTS vote_moved (
      block     INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx        TEXT NOT NULL,
      voter     TEXT NOT NULL,
      from_game INTEGER NOT NULL,
      to_game   INTEGER NOT NULL,
      round     INTEGER NOT NULL,
      amount    TEXT NOT NULL,
      new_from_weight TEXT NOT NULL,
      new_to_weight   TEXT NOT NULL,
      PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_vote_moved_from  ON vote_moved (from_game, block DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_vote_moved_to    ON vote_moved (to_game, block DESC, log_index DESC);
    CREATE INDEX IF NOT EXISTS idx_vote_moved_voter ON vote_moved (voter);
  `);
  return db;
}

export const EVENT_TABLES = [
  'prediction_scored',
  'prediction_made',
  'prediction_voided',
  'prediction_unrecoverable',
  'prediction_displaced',
  'bounty_funded',
  'bounty_pool_state',
  'bounty_cleaned',
  'referral_paid',
  'referral_set',
  'unclaimed_ledger',
  'round_budget',
  'offchain_budget',
  'delegation',
  'data_stream_created',
  'game_created',
  'game_name_updated',
  'game_authority_transferred',
  'streak_threshold',
  'curve_config',
  'named_adapter_set',
  'named_stream_created',
  'stream_value',
  'stream_name_updated',
  'stream_provider_changed',
  'vote',
  'game_approved',
  'vote_moved',
] as const;

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

/// Delete every event row with block >= fromBlock (the reorg overlap window /
/// rollback trim). Idempotent with the follow-loop's refill.
export function deleteFromBlock(db: Database.Database, fromBlock: number): void {
  for (const t of EVENT_TABLES) {
    db.prepare(`DELETE FROM ${t} WHERE block >= ?`).run(fromBlock);
  }
}
