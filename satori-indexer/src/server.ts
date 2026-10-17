import express from 'express';
import type Database from 'better-sqlite3';
import { Indexer } from './indexer';
import { leaderboard, sentiment, bountyPairs, referrals, referredBy, predictionOutcomes, lastPredictions, streams, streamValues, games, gameVotes, namedAdapterId, curveConfig, rewardsLedger, roundBudget, delegation } from './views';
import { EVENT_TABLES } from './db';

// Read-only JSON API. Public data, GET-only, permissive CORS (the dapp is a
// static site on another origin). No keys, no state mutation.

export function makeServer(
  db: Database.Database,
  indexer: Indexer,
  chainId: number,
  streamsIndexed = false,
) {
  const app = express();
  app.disable('x-powered-by');

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=5');
    next();
  });

  app.get('/health', (_req, res) => {
    // Healthy = the follow loop is running and not persistently erroring.
    if (indexer.state.ticks > 0 && indexer.state.lastError == null) res.json({ ok: true });
    else if (indexer.state.ticks === 0) res.json({ ok: true, note: 'starting' });
    else res.status(503).json({ ok: false, error: indexer.state.lastError });
  });

  app.get('/status', (_req, res) => {
    const counts: Record<string, number> = {};
    for (const t of EVENT_TABLES) {
      counts[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    }
    res.json({
      chainId,
      // What this dataset was built from, so a reader can refuse an indexer
      // still following an older deployment of the same chain.
      addresses: indexer.addresses,
      startBlock: indexer.state.startBlock,
      lastScannedBlock: indexer.state.lastScannedBlock,
      head: indexer.state.head,
      syncing: indexer.state.syncing,
      lastError: indexer.state.lastError,
      // False when REGISTRY_ADDRESS is unset. Published so a consumer can tell
      // "no streams on this chain" from "this indexer was never pointed at the
      // registry", which are otherwise the same empty response.
      streamsIndexed,
      // Same idea for VOTING_ADDRESS and the vote tables.
      votesIndexed: indexer.votesIndexed,
      gamesIndexed: indexer.gamesIndexed,
      namedAdapterId: namedAdapterId(db),
      curveConfig: curveConfig(db),
      counts,
    });
  });

  /// Refuse rather than answer `[]` when stream indexing is off. An empty array
  /// is a valid answer to "which streams exist", so returning one here would
  /// quietly tell the Nostr bridge that the chain has no streams and tell the
  /// dapp the user has created none.
  const requireStreams = (res: express.Response): boolean => {
    if (streamsIndexed) return true;
    res.status(503).json({
      error: 'stream indexing is not enabled on this indexer',
      hint: 'set REGISTRY_ADDRESS (or a registry entry in ADDRESS_BOOK) and restart',
    });
    return false;
  };

  /// Every stream ever created, at its CURRENT name and provider.
  /// `?creator=0x…` narrows to the address that created them.
  ///
  /// The latest observation is keyed by `lastHour`, with `lastRound` =
  /// floor(hour / 24) derived for round-thinking consumers. `named` says the
  /// stream's adapter is the registry's named adapter (satori-nostr-bridge
  /// labels those differently; see its README).
  app.get('/streams', (req, res) => {
    if (!requireStreams(res)) return;
    const creator = req.query.creator != null ? String(req.query.creator) : undefined;
    if (creator != null && !/^0x[0-9a-fA-F]{40}$/.test(creator)) {
      res.status(400).json({ error: 'bad creator address' }); return;
    }
    res.json(streams(db, creator));
  });

  /// The observation series for one stream, oldest first.
  /// `?fromBlock=N` returns only observations at or after block N, so a
  /// follower that already holds the history can ask for just the tail.
  ///
  /// Rows carry `hour` (the absolute hour of the observation, timestamp /
  /// 3600 — what the hour-keyed registry ring emits) plus a derived `round` =
  /// floor(hour / 24).
  app.get('/streams/:id/values', (req, res) => {
    if (!requireStreams(res)) return;
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'bad streamId' }); return; }
    const raw = req.query.fromBlock;
    const fromBlock = raw != null ? Number(raw) : NaN;
    const limit = Math.min(Number(req.query.limit ?? 1000) || 1000, 5000);
    res.json(streamValues(db, id, Number.isFinite(fromBlock) ? fromBlock : undefined, limit));
  });

  /// Every game at its current name and authority. `?stream=N` lists one
  /// stream's games (the ladder), `?authority=0x…` one author's. 503 when
  /// GAMES_ADDRESS is unset, for the same reason /streams refuses.
  app.get('/games', (req, res) => {
    if (!indexer.gamesIndexed) {
      res.status(503).json({
        error: 'game indexing is not enabled on this indexer',
        hint: 'set GAMES_ADDRESS (or a games entry in ADDRESS_BOOK) and restart',
      });
      return;
    }
    const stream = req.query.stream != null ? Number(req.query.stream) : undefined;
    if (stream != null && (!Number.isFinite(stream) || stream <= 0)) { res.status(400).json({ error: 'bad stream id' }); return; }
    const authority = req.query.authority != null ? String(req.query.authority) : undefined;
    if (authority != null && !/^0x[0-9a-fA-F]{40}$/.test(authority)) { res.status(400).json({ error: 'bad authority address' }); return; }
    res.json(games(db, stream, authority));
  });

  /// The vote ledger for one game: per-voter weight folded from Voted +
  /// GameApprovedSet + VotesMoved, the game's latest approval flag, and the
  /// self-reported running total. 503 when VOTING_ADDRESS is unset, for the
  /// same reason /streams refuses without a registry: an empty ledger is a
  /// valid answer, so returning one unconfigured would lie.
  app.get('/votes/:gameId', (req, res) => {
    if (!indexer.votesIndexed) {
      res.status(503).json({
        error: 'vote indexing is not enabled on this indexer',
        hint: 'set VOTING_ADDRESS (or a voting entry in ADDRESS_BOOK) and restart',
      });
      return;
    }
    const gameId = Number(req.params.gameId);
    if (!Number.isFinite(gameId) || gameId <= 0) { res.status(400).json({ error: 'bad gameId' }); return; }
    res.json(gameVotes(db, gameId));
  });

  /// Every prediction by an address, each with its FINAL outcome. Lets the dapp
  /// distinguish "judged, no result" from "still waiting", which it could not do
  /// while only PredictionScored was indexed.
  app.get('/predictions/:address', (req, res) => {
    const addr = String(req.params.address ?? '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { res.status(400).json({ error: 'bad address' }); return; }
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    res.json(predictionOutcomes(db, addr, limit));
  });

  app.get('/predictions/:address/last', (req, res) => {
    const addr = String(req.params.address ?? '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { res.status(400).json({ error: 'bad address' }); return; }
    res.json(lastPredictions(db, addr));
  });

  app.get('/leaderboard', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 1000);
    const gameId = req.query.gameId != null ? Number(req.query.gameId) : undefined;
    res.json(leaderboard(db, limit, Number.isFinite(gameId as number) ? gameId : undefined));
  });

  app.get('/sentiment/:gameId', (req, res) => {
    const gameId = Number(req.params.gameId);
    if (!Number.isFinite(gameId) || gameId <= 0) { res.status(400).json({ error: 'bad gameId' }); return; }
    // ?fromRound=N returns only rounds >= N. Closed rounds are immutable, so a
    // client that has kept them can ask for just the live tail. Absent or
    // unparseable means "everything", matching the previous behaviour exactly.
    const fromRaw = req.query.fromRound;
    const fromRound = fromRaw != null ? Number(fromRaw) : NaN;
    res.json(sentiment(db, gameId, Number.isFinite(fromRound) ? fromRound : undefined));
  });

  app.get('/bounties/pairs', (_req, res) => {
    res.json(bountyPairs(db));
  });

  app.get('/bounties/pairs/:token', (req, res) => {
    const t = req.params.token;
    if (!/^0x[0-9a-fA-F]{40}$/.test(t)) { res.status(400).json({ error: 'bad token address' }); return; }
    res.json(bountyPairs(db, t));
  });

  app.get('/rewards/:address', (req, res) => {
    const a = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { res.status(400).json({ error: 'bad address' }); return; }
    res.json(rewardsLedger(db, a));
  });

  app.get('/delegation/:address', (req, res) => {
    const a = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { res.status(400).json({ error: 'bad address' }); return; }
    res.json(delegation(db, a));
  });

  app.get('/rounds/:round/budget', (req, res) => {
    const r = Number(req.params.round);
    if (!Number.isInteger(r) || r < 0) { res.status(400).json({ error: 'bad round' }); return; }
    res.json(roundBudget(db, r));
  });

  app.get('/referrals/:address', (req, res) => {
    const a = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { res.status(400).json({ error: 'bad address' }); return; }
    res.json(referrals(db, a));
  });

  // Who this address has referred. Deliberately a separate route from
  // /referrals/:address rather than a field on it: that one answers "what have
  // I earned", this one answers "who signed up under me", and a referee who has
  // registered but never earned appears only here.
  app.get('/referred-by/:address', (req, res) => {
    const a = req.params.address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) { res.status(400).json({ error: 'bad address' }); return; }
    res.json(referredBy(db, a));
  });

  return app;
}
