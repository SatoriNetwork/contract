import type Database from 'better-sqlite3';

// The computed views, mirroring EXACTLY the reductions the dapp performs
// client-side today (see docs/issues/closed/dapp-event-indexer-before-base-mainnet.md
// consumer matrix) so a hook can swap its scan for one HTTP call without
// changing meaning.

/// Leaderboard: latest PredictionScored per (user, gameId) — later (block,
/// logIndex) wins — keep streak > 0, sort by streak desc.
/// Mirrors LeaderboardTab's Map-reduction.
export function leaderboard(db: Database.Database, limit: number, gameId?: number) {
  const rows = db.prepare(`
    SELECT user, game_id AS gameId, streak, round, block
    FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY user, game_id ORDER BY block DESC, log_index DESC
      ) AS rn
      FROM prediction_scored
      ${gameId != null ? 'WHERE game_id = @gameId' : ''}
    )
    WHERE rn = 1 AND streak > 0
    ORDER BY streak DESC, block ASC
    LIMIT @limit
  `).all({ limit, gameId });
  return rows;
}

/// Sentiment: per-round UP/DOWN power (ether-denominated, matching the dapp's
/// Number(formatEther(...)) display precision) + prediction counts for one
/// game. Mirrors useStreamDetail's bucket loop.
/// Per-round UP/DOWN tallies for a game.
///
/// `fromRound` exists because this response mixes two staleness classes. A
/// CLOSED round is immutable — nobody can add a prediction to a round that has
/// ended, so its tallies are final. The CURRENT round moves continuously. A
/// client can therefore keep every closed round forever and ask only for what it
/// does not already have, instead of re-receiving the whole history to see one
/// live row.
///
/// Omit it and the behaviour is exactly as before, so existing callers and any
/// cached client are unaffected.
export function sentiment(db: Database.Database, gameId: number, fromRound?: number) {
  const gated = Number.isFinite(fromRound as number);
  return db.prepare(`
    SELECT round,
      SUM(CASE WHEN direction = 1 THEN power_eth ELSE 0 END) AS up,
      SUM(CASE WHEN direction = 2 THEN power_eth ELSE 0 END) AS down,
      SUM(CASE WHEN direction = 1 THEN 1 ELSE 0 END)         AS upCount,
      SUM(CASE WHEN direction = 2 THEN 1 ELSE 0 END)         AS downCount
    FROM prediction_made
    WHERE game_id = @gameId
    ${gated ? 'AND round >= @fromRound' : ''}
    GROUP BY round
    ORDER BY round ASC
  `).all(gated ? { gameId, fromRound } : { gameId });
}

/// Bounty discovery: every (gameId, token) pair ever funded, with its last
/// funded block and whether a cleanup happened after that. The dapp keeps its
/// on-chain pool/rate liveness check — this only replaces the log scan.
export function bountyPairs(db: Database.Database, token?: string) {
  // Aggregate first (CTE), THEN the correlated cleaned-after check — an
  // aggregate can't be referenced inside a correlated subquery directly.
  return db.prepare(`
    WITH pairs AS (
      SELECT game_id, token, MAX(block) AS lastFundedBlock, COUNT(*) AS fundedCount
      FROM bounty_funded
      ${token ? 'WHERE token = @token' : ''}
      GROUP BY game_id, token
    ),
    -- A reclaim can re-register a cleaned pair without any BountyFunded, so
    -- "cleaned since" is measured from the later of the last fund or reclaim.
    registered AS (
      SELECT game_id, token, MAX(block) AS lastRegisteredBlock
      FROM bounty_pool_state WHERE kind IN ('fund', 'reclaim')
      GROUP BY game_id, token
    )
    SELECT p.game_id AS gameId, p.token, p.lastFundedBlock, p.fundedCount,
           EXISTS (
             SELECT 1 FROM bounty_cleaned c
             WHERE c.game_id = p.game_id AND c.token = p.token
               AND c.block > COALESCE(r.lastRegisteredBlock, p.lastFundedBlock)
           ) AS cleanedAfter,
           (SELECT s.new_pool FROM bounty_pool_state s
             WHERE s.game_id = p.game_id AND s.token = p.token
             ORDER BY s.block DESC, s.log_index DESC LIMIT 1) AS poolWei,
           (SELECT s.new_rate FROM bounty_pool_state s
             WHERE s.game_id = p.game_id AND s.token = p.token
             ORDER BY s.block DESC, s.log_index DESC LIMIT 1) AS rateScaled
    FROM pairs p
    LEFT JOIN registered r ON r.game_id = p.game_id AND r.token = p.token
    ORDER BY p.lastFundedBlock DESC
  `).all({ token: token?.toLowerCase() }).map((r: any) => ({
    ...r,
    // The contract's own liveness test (pool != 0 && rate != 0), folded from
    // the latest pool write instead of read from storage.
    live: r.poolWei != null && r.poolWei !== '0' && r.rateScaled !== '0',
  }));
}

/// Referral earnings for one referrer: the rows + the exact wei total
/// (summed as BigInt server-side; returned as a decimal string).
export function referrals(db: Database.Database, referrer: string) {
  const rows = db.prepare(`
    SELECT block, log_index AS logIndex, tx, owner, amount_wei AS amountWei, round
    FROM referral_paid
    WHERE referral = ?
    ORDER BY block DESC, log_index DESC
  `).all(referrer.toLowerCase()) as { amountWei: string }[];
  let total = 0n;
  for (const r of rows) total += BigInt(r.amountWei);
  return { totalWei: total.toString(), events: rows };
}

/// Everyone who has this address as their referrer — "who have I referred".
///
/// This is NOT derivable from `referral_paid`: that only fires when a referee
/// earns, so someone who registered and has not been paid yet does not appear
/// in it at all. Nor is it readable from the contract, whose `referral` mapping
/// runs referee -> referrer only and cannot be walked backwards.
///
/// The slot locks on first set, so `referral_set` holds at most one row per
/// user and this needs no latest-wins fold.
///
/// `earnedWei` is a LEFT JOIN: a referee who has registered but never earned
/// shows up with "0", which is the honest answer and the whole reason this view
/// exists separately from `referrals()`.
export function referredBy(db: Database.Database, referrer: string) {
  const rows = db.prepare(`
    SELECT s.user           AS address,
           s.block          AS block,
           s.tx             AS tx,
           COALESCE(SUM(CAST(p.amount_wei AS INTEGER)), 0) AS earnedApprox,
           COUNT(p.block)   AS payouts
    FROM referral_set s
    LEFT JOIN referral_paid p
           ON p.owner = s.user AND p.referral = s.referral
    WHERE s.referral = ?
    GROUP BY s.user, s.block, s.tx
    ORDER BY s.block DESC
  `).all(referrer.toLowerCase()) as { address: string; block: number; tx: string; payouts: number }[];

  // SQLite has no 128-bit integers, so the SUM above is only good for ordering
  // and a "has this one ever paid" flag. The exact figure is summed as BigInt
  // here, the same way `referrals()` does it, and returned as a decimal string.
  const paid = db.prepare(
    'SELECT owner, amount_wei AS amountWei FROM referral_paid WHERE referral = ?'
  ).all(referrer.toLowerCase()) as { owner: string; amountWei: string }[];
  const byOwner = new Map<string, bigint>();
  for (const p of paid) byOwner.set(p.owner, (byOwner.get(p.owner) ?? 0n) + BigInt(p.amountWei));

  return {
    count: rows.length,
    referees: rows.map((r) => ({
      address: r.address,
      block: r.block,
      tx: r.tx,
      payouts: r.payouts,
      earnedWei: (byOwner.get(r.address) ?? 0n).toString(),
    })),
  };
}

/// Every stream ever created, folded to its CURRENT name and provider.
///
/// Creation is not the last word on either: `NameUpdated` and `ProviderChanged`
/// both fire afterwards, so reading `data_stream_created` alone gives a view
/// that is right on the day of creation and drifts from then on. Each is folded
/// by taking the latest event per stream, same (block, log_index) ordering the
/// leaderboard uses.
///
/// `creator` filters on the address that CREATED the stream, which is not
/// necessarily the current provider. That is deliberate: it answers "my
/// streams" (LAUNCH_CHECKLIST H5), and handing a stream to a new provider
/// should not erase it from the creator's list.
export function streams(db: Database.Database, creator?: string) {
  const rows = db.prepare(`
    WITH latest_name AS (
      SELECT stream_id, new_name FROM (
        SELECT stream_id, new_name,
          ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY block DESC, log_index DESC) rn
        FROM stream_name_updated
      ) WHERE rn = 1
    ),
    latest_provider AS (
      SELECT stream_id, new_provider FROM (
        SELECT stream_id, new_provider,
          ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY block DESC, log_index DESC) rn
        FROM stream_provider_changed
      ) WHERE rn = 1
    ),
    latest_value AS (
      SELECT stream_id, new_value, hour, block FROM (
        SELECT stream_id, new_value, hour, block,
          ROW_NUMBER() OVER (PARTITION BY stream_id ORDER BY block DESC, log_index DESC) rn
        FROM stream_value
      ) WHERE rn = 1
    )
    SELECT
      c.stream_id                              AS streamId,
      COALESCE(n.new_name, c.name)             AS name,
      c.name                                   AS originalName,
      CASE WHEN c.adapter_id = 0 THEN 0 ELSE 1 END AS streamType,
      c.adapter_id                             AS adapterId,
      c.min_cadence_minutes                    AS minCadenceMinutes,
      c.config                                 AS config,
      k.name_key                               AS nameKey,
      c.creator                                AS creator,
      COALESCE(p.new_provider, c.provider)     AS provider,
      c.block                                  AS createdBlock,
      c.tx                                     AS createdTx,
      v.new_value                              AS lastValue,
      v.hour                                   AS lastHour,
      (v.hour / 24)                            AS lastRound,
      v.block                                  AS lastValueBlock,
      (SELECT COUNT(*) FROM stream_value s WHERE s.stream_id = c.stream_id) AS valueCount
    FROM data_stream_created c
    LEFT JOIN latest_name     n ON n.stream_id = c.stream_id
    LEFT JOIN latest_provider p ON p.stream_id = c.stream_id
    LEFT JOIN latest_value    v ON v.stream_id = c.stream_id
    LEFT JOIN named_stream_created k ON k.stream_id = c.stream_id
    ${creator ? 'WHERE c.creator = @creator' : ''}
    ORDER BY c.stream_id ASC
  `).all({ creator: creator?.toLowerCase() }) as { nameKey: string | null }[];
  // NamedStreamCreated is emitted exactly when the registry records
  // isNamedStream[id], so its presence IS the stream's named flag.
  return rows.map((r) => ({ ...r, named: r.nameKey != null }));
}

/// Every game ever created, at its CURRENT name and authority (folded from
/// GameNameUpdated / GameAuthorityTransferred, latest wins). `isDefaultBinary`
/// marks the stream's FIRST type-0 game, which is what the contract's
/// `binaryGameByStream` points at. `?stream=` and `?authority=` narrow it;
/// `authority` matches the CREATING authority, so a handed-over game still
/// lists for whoever authored it.
export function games(db: Database.Database, streamId?: number, authority?: string) {
  const floor = curveConfig(db)?.dustFloor;
  const where: string[] = [];
  if (streamId != null) where.push('c.stream_id = @streamId');
  if (authority) where.push('c.authority = @authority');
  return db.prepare(`
    WITH latest_name AS (
      SELECT game_id, new_name FROM (
        SELECT game_id, new_name,
          ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY block DESC, log_index DESC) rn
        FROM game_name_updated
      ) WHERE rn = 1
    ),
    latest_authority AS (
      SELECT game_id, new_authority FROM (
        SELECT game_id, new_authority,
          ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY block DESC, log_index DESC) rn
        FROM game_authority_transferred
      ) WHERE rn = 1
    ),
    first_binary AS (
      SELECT stream_id, MIN(game_id) AS game_id FROM game_created WHERE game_type_id = 0 GROUP BY stream_id
    ),
    latest_threshold AS (
      SELECT game_id, threshold FROM (
        SELECT game_id, threshold,
          ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY block DESC, log_index DESC) rn
        FROM streak_threshold
      ) WHERE rn = 1
    )
    SELECT
      c.game_id                                AS gameId,
      c.stream_id                              AS streamId,
      c.game_type_id                           AS gameTypeId,
      c.target_minutes                         AS targetMinutes,
      c.config                                 AS gameConfig,
      COALESCE(n.new_name, c.name)             AS name,
      c.name                                   AS originalName,
      c.authority                              AS creator,
      COALESCE(a.new_authority, c.authority)   AS authority,
      (fb.game_id = c.game_id)                 AS isDefaultBinary,
      COALESCE(t.threshold, 0)                 AS dustThreshold,
      c.block                                  AS createdBlock,
      c.tx                                     AS createdTx
    FROM game_created c
    LEFT JOIN latest_name      n  ON n.game_id = c.game_id
    LEFT JOIN latest_authority a  ON a.game_id = c.game_id
    LEFT JOIN first_binary     fb ON fb.stream_id = c.stream_id
    LEFT JOIN latest_threshold t  ON t.game_id = c.game_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY c.game_id ASC
  `).all({ streamId, authority: authority?.toLowerCase() }).map((r: any) => ({
    ...r, isDefaultBinary: r.isDefaultBinary === 1,
    // null when the engine has emitted no CurveConfigSet (a deployment from
    // before initialize emitted its defaults): the floor is then unknown.
    dustBar: floor == null ? null : Math.max(floor, r.dustThreshold),
  }));
}

/// The engine's effective S-curve dials, folded from the latest CurveConfigSet.
export function curveConfig(db: Database.Database) {
  const row = db.prepare(
    `SELECT dust_floor AS dustFloor, top_gradient AS topGradient, bottom_gradient AS bottomGradient, top_shift AS topShift
     FROM curve_config ORDER BY block DESC, log_index DESC LIMIT 1`
  ).get() as { dustFloor: number; topGradient: number; bottomGradient: number; topShift: number } | undefined;
  return row ?? null;
}

/// The registry's named adapter, folded from NamedAdapterSet; 0 until wired.
export function namedAdapterId(db: Database.Database): number {
  const row = db.prepare(
    'SELECT adapter_id FROM named_adapter_set ORDER BY block DESC, log_index DESC LIMIT 1'
  ).get() as { adapter_id: number } | undefined;
  return row?.adapter_id ?? 0;
}

/// The observation series for one stream, oldest first.
///
/// Each row carries `hour` — the absolute hour of the observation
/// (timestamp / 3600), which is what the hour-keyed registry ring emits — plus
/// a derived `round` = floor(hour / 24) for round-thinking consumers.
///
/// `fromBlock` exists for the same reason `sentiment`'s `fromRound` does: a
/// follower that already holds the history wants only the tail. It is a BLOCK
/// rather than a round because several observations per round is now the
/// ROUTINE case, not a cadence-1 quirk: a 24-hour round holds up to 24
/// observations at the registry's one-hour cadence floor, so a round cursor
/// cannot express "everything after the last one I saw".
///
/// Values are returned as STRINGS exactly as stored. They are int256, and for a
/// Uniswap adapter stream the number is a raw tick, not a price. Converting is
/// the consumer's job and needs the pool's token decimals; the dapp does it in
/// `satori-ui/src/lib/streamOrientation.ts`.
export function streamValues(
  db: Database.Database,
  streamId: number,
  fromBlock?: number,
  limit = 1000,
) {
  const gated = Number.isFinite(fromBlock as number);
  return db.prepare(`
    SELECT block, log_index AS logIndex, tx,
           old_value AS oldValue, new_value AS newValue,
           hour, (hour / 24) AS round
    FROM stream_value
    WHERE stream_id = @streamId
    ${gated ? 'AND block >= @fromBlock' : ''}
    ORDER BY block ASC, log_index ASC
    LIMIT @limit
  `).all(gated ? { streamId, fromBlock, limit } : { streamId, limit });
}

/// Every prediction an address has made, each with its FINAL outcome.
///
/// The reason this exists: a prediction can end in five ways and only two of
/// them emit PredictionScored. Before the other three were indexed, the dapp
/// could only ask "was it scored?" and got `false` for a prediction that had
/// been conclusively judged — so a finished bet and a pending one looked the
/// same, forever. That is what made four predictions with two settled outcomes
/// read as `prediction_scored: 0`.
///
///   won            scored, correct
///   lost           scored, incorrect
///   void           judged; the value did not move between the two readings
///                  ABC compares, so there was nothing to be right about
///   unrecoverable  the values needed to judge it aged out of the ring first
///   displaced      pushed out of the two-slot ring before being settled
///   pending        none of the above has happened yet
///
/// Resolved by LEFT JOIN from prediction_made, so a prediction with no terminal
/// event is reported as pending rather than omitted.
export function predictionOutcomes(db: Database.Database, user: string, limit = 200) {
  const rows = db.prepare(`
    SELECT
      m.game_id   AS gameId,
      m.round     AS round,
      m.direction AS direction,
      m.block     AS block,
      m.tx        AS tx,
      m.power_eth AS power,
      m.hour      AS hour,
      s.correct   AS correct,
      s.streak    AS streak,
      v.stagnant_value AS stagnantValue,
      u.anchor_evicted AS anchorEvicted,
      d.block     AS displacedBlock
    FROM prediction_made m
    LEFT JOIN prediction_scored        s ON s.user = m.predictor AND s.game_id = m.game_id AND s.round = m.round
    LEFT JOIN prediction_voided        v ON v.user = m.predictor AND v.game_id = m.game_id AND v.round = m.round
    LEFT JOIN prediction_unrecoverable u ON u.user = m.predictor AND u.game_id = m.game_id AND u.round = m.round
    LEFT JOIN prediction_displaced     d ON d.user = m.predictor AND d.game_id = m.game_id AND d.round = m.round
    WHERE m.predictor = @user
    ORDER BY m.round DESC, m.block DESC
    LIMIT @limit
  `).all({ user: user.toLowerCase(), limit }) as any[];

  return rows.map((r) => {
    let outcome: string;
    if (r.correct != null) outcome = r.correct ? 'won' : 'lost';
    else if (r.stagnantValue != null) outcome = 'void';
    else if (r.anchorEvicted != null) outcome = 'unrecoverable';
    else if (r.displacedBlock != null) outcome = 'displaced';
    else outcome = 'pending';
    return {
      gameId: r.gameId,
      round: r.round,
      direction: r.direction === 1 ? 'UP' : r.direction === 2 ? 'DOWN' : String(r.direction),
      power: r.power,
      hour: r.hour,
      block: r.block,
      tx: r.tx,
      outcome,
      streak: r.streak ?? null,
      // Present only for a void: the value that failed to move. Kept as the
      // string the chain gave us, since int232 does not fit a JS number.
      stagnantValue: r.stagnantValue ?? null,
    };
  });
}

/// Each game's latest prediction by an address: the hour its window opened on
/// (PredictionMade.hour). A named game reopens to that address at hour + 24.
export function lastPredictions(db: Database.Database, user: string) {
  return db.prepare(`
    SELECT game_id AS gameId, MAX(hour) AS hour, MAX(round) AS round
    FROM prediction_made WHERE predictor = ? GROUP BY game_id
  `).all(user.toLowerCase());
}

/// The vote ledger for one game, folded from the three weight-moving events
/// exactly as SatoriVoting.sol prescribes: `Voted` adds a voter's bought
/// weight, `VotesMoved` shifts a voter's own weight between games, and the
/// latest `GameApprovedSet` row says where the admin left the approval flag
/// (null = never touched, which is a different fact from "explicitly
/// unapproved").
///
/// Weights and burn amounts are uint256 TEXT columns, so the folding happens
/// in BigInt here (same reasoning as `referrals()`) and comes back as decimal
/// strings.
///
/// `totalWeight` is deliberately NOT the sum of the per-voter rows: it is the
/// running total the LATEST event self-reported (`newGameWeight` /
/// `newFromWeight` / `newToWeight`), which preserves the self-checking
/// property the contract built into the events — if the per-voter sum ever
/// disagrees with it, the indexer missed a log.
export function gameVotes(db: Database.Database, gameId: number) {
  const votes = db.prepare(`
    SELECT voter, amount, weight_added AS weightAdded,
           new_game_weight AS newGameWeight, block, log_index AS logIndex
    FROM vote WHERE game_id = ?
    ORDER BY block ASC, log_index ASC
  `).all(gameId) as any[];
  const moves = db.prepare(`
    SELECT voter, from_game AS fromGame, to_game AS toGame, amount,
           new_from_weight AS newFromWeight, new_to_weight AS newToWeight,
           block, log_index AS logIndex
    FROM vote_moved WHERE from_game = ? OR to_game = ?
    ORDER BY block ASC, log_index ASC
  `).all(gameId, gameId) as any[];
  const appr = db.prepare(`
    SELECT approved FROM game_approved WHERE game_id = ?
    ORDER BY block DESC, log_index DESC LIMIT 1
  `).get(gameId) as { approved: number } | undefined;

  const weight = new Map<string, bigint>();
  const burned = new Map<string, bigint>();
  const count = new Map<string, number>();
  // Latest self-reported running total across both event kinds, compared by
  // (block, log_index) rather than a packed key so no block height overflows.
  let last: { block: number; logIndex: number; total: bigint } | null = null;

  for (const v of votes) {
    weight.set(v.voter, (weight.get(v.voter) ?? 0n) + BigInt(v.weightAdded));
    burned.set(v.voter, (burned.get(v.voter) ?? 0n) + BigInt(v.amount));
    count.set(v.voter, (count.get(v.voter) ?? 0) + 1);
    if (!last || v.block > last.block || (v.block === last.block && v.logIndex > last.logIndex)) {
      last = { block: v.block, logIndex: v.logIndex, total: BigInt(v.newGameWeight) };
    }
  }
  for (const m of moves) {
    if (m.toGame === gameId) weight.set(m.voter, (weight.get(m.voter) ?? 0n) + BigInt(m.amount));
    if (m.fromGame === gameId) weight.set(m.voter, (weight.get(m.voter) ?? 0n) - BigInt(m.amount));
    if (!last || m.block > last.block || (m.block === last.block && m.logIndex > last.logIndex)) {
      last = {
        block: m.block, logIndex: m.logIndex,
        total: BigInt(m.fromGame === gameId ? m.newFromWeight : m.newToWeight),
      };
    }
  }

  const voters = [...weight.entries()]
    .filter(([, w]) => w > 0n)
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] > b[1] ? -1 : 1))
    .map(([address, w]) => ({
      address,
      weight: w.toString(),
      burnedWei: (burned.get(address) ?? 0n).toString(),
      votes: count.get(address) ?? 0,
    }));

  return {
    gameId,
    approved: appr == null ? null : appr.approved === 1,
    totalWeight: (last?.total ?? 0n).toString(),
    voters,
  };
}

/// An account's on-chain unclaimed balance: the latest credit's post-state, or 0
/// after a claim. Excludes a delegator's share not yet accrued (the lens walk).
export function rewardsLedger(db: Database.Database, account: string) {
  const rows = db.prepare(`
    SELECT block, log_index AS logIndex, tx, kind, game_id AS gameId, round, amount_wei AS amountWei, new_unclaimed AS newUnclaimed
    FROM unclaimed_ledger WHERE account = ? ORDER BY block DESC, log_index DESC LIMIT 200
  `).all(account.toLowerCase()) as { newUnclaimed: string }[];
  return { unclaimedWei: rows[0]?.newUnclaimed ?? '0', events: rows };
}

/// The payable budget a round froze on its first touch; null if nothing has touched it.
export function roundBudget(db: Database.Database, round: number) {
  const row = db.prepare(
    'SELECT budget_wei AS budgetWei, block FROM round_budget WHERE round = ? ORDER BY block ASC, log_index ASC LIMIT 1'
  ).get(round) as
    { budgetWei: string; block: number } | undefined;
  return { round, budgetWei: row?.budgetWei ?? null, frozenAtBlock: row?.block ?? null };
}

/// The off-chain (Merkle lane) budget for `round`, in wei. Under the share
/// (OffchainShareSet, set in an earlier round) it is what the hub banked for the
/// round (MerkleReserveBanked); before the share existed, the absolute dial
/// (OffchainBudgetSet) in force for it. `budgetWei` is null while a round under a
/// nonzero share has not been banked yet: nothing can know it before then.
/// `source` says which rule answered; the histories are every change, oldest first.
export function offchainBudget(db: Database.Database, round: number) {
  const banked = db.prepare(
    'SELECT per_round_wei AS perRoundWei, block FROM reserve_banked WHERE from_round <= ? AND through_round > ? ORDER BY block DESC, log_index DESC LIMIT 1'
  ).get(round, round) as { perRoundWei: string; block: number } | undefined;
  const share = db.prepare(
    'SELECT bps, round_set AS roundSet, block FROM offchain_share WHERE round_set < ? ORDER BY round_set DESC, block DESC, log_index DESC LIMIT 1'
  ).get(round) as { bps: number; roundSet: number; block: number } | undefined;
  const dial = db.prepare(
    'SELECT budget_wei AS budgetWei, round_set AS roundSet, block FROM offchain_budget WHERE round_set < ? ORDER BY round_set DESC, block DESC, log_index DESC LIMIT 1'
  ).get(round) as { budgetWei: string; roundSet: number; block: number } | undefined;
  const history = db.prepare(
    'SELECT round_set AS roundSet, budget_wei AS budgetWei, block, tx FROM offchain_budget ORDER BY block ASC, log_index ASC'
  ).all();
  const shareHistory = db.prepare(
    'SELECT round_set AS roundSet, bps, block, tx FROM offchain_share ORDER BY block ASC, log_index ASC'
  ).all();
  let budgetWei: string | null;
  let source: 'banked' | 'share' | 'pending' | 'dial';
  if (banked) { budgetWei = banked.perRoundWei; source = 'banked'; }
  else if (share && share.bps === 0) { budgetWei = '0'; source = 'share'; }
  else if (share) { budgetWei = null; source = 'pending'; }
  else { budgetWei = dial?.budgetWei ?? '0'; source = 'dial'; }
  return {
    round, budgetWei, source,
    shareBps: share?.bps ?? null,
    setInRound: (share ?? dial)?.roundSet ?? null,
    block: banked?.block ?? (share ?? dial)?.block ?? null,
    history, shareHistory,
  };
}

/// Who this account delegates to (null when it does not), and the inbound power
/// it holds as a delegate (latest newDelegatePower naming it).
export function delegation(db: Database.Database, account: string) {
  const a = account.toLowerCase();
  const out = db.prepare(`
    SELECT kind, delegate, activation_round AS activationRound FROM delegation
    WHERE delegator = ? AND kind != 'synced' ORDER BY block DESC, log_index DESC LIMIT 1
  `).get(a) as { kind: string; delegate: string; activationRound: number } | undefined;
  const inbound = db.prepare(`
    SELECT new_delegate_power AS p FROM delegation WHERE delegate = ? ORDER BY block DESC, log_index DESC LIMIT 1
  `).get(a) as { p: string } | undefined;
  return {
    delegate: out?.kind === 'delegated' ? out.delegate : null,
    activationRound: out?.kind === 'delegated' ? out.activationRound : null,
    inboundPowerWei: inbound?.p ?? '0',
  };
}
