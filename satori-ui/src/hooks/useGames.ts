import { useCallback } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';
import { useGasless } from './useGasless';
import { multicallRead } from '../utils/multicall';
import { explainError, sendPreflighted } from '../utils/errors';
import { afterTx } from '../lib/afterTx';
import { indexerGames } from '../utils/indexerClient';

// STREAM <-> GAME is strictly 1:1 in the current contract model: every stream
// auto-creates exactly one binary game and duplicate binary games are
// forbidden. This hook is the canonical bridge between the two id-spaces.
//
// - resolveGameId(streamId)   -> the single binary gameId for a stream
//   (SatoriGames.binaryGameByStream(streamId); returns 0 if none exists yet).
// - resolveStreamId(gameId)   -> the stream a game is bound to
//   (SatoriGames.gameMeta(gameId).dataStreamId).
// - displayName(gameName, streamName) -> the name to show. The default binary
//   game has an empty name, so the DISPLAY name falls back to the stream name.

// gameMeta(gameId) returns the GameMeta tuple:
//   (authority, gameTypeId, dataStreamId, targetMinutes, name, gameConfig).
export interface GameMeta {
  gameId: number;
  authority: string;
  gameTypeId: number;
  dataStreamId: number; // the stream this game is bound to (1:1)
  // How far ahead the game's question reaches, in minutes (struct index 3).
  // The ADVERTISED duration (1440 = daily); scoring applies its fixed 30-min
  // allowance internally. Also readable via games.targetMinutes(gameId).
  targetMinutes: number;
  name: string;         // empty "" for the default binary game
}

/**
 * Richer game record including the raw gameConfig blob (hex string). Used by the
 * many-games-per-stream views (W7) where adapter config matters; the leaner
 * GameMeta above is kept for the 1:1 binary-game callers.
 */
export interface GameWithId {
  gameId: number;
  authority: string;
  gameTypeId: number;
  dataStreamId: number;
  targetMinutes: number; // advertised question horizon in minutes (see GameMeta)
  name: string;
  gameConfig: string; // raw config bytes as a hex string ("0x" when empty)
}

/**
 * The display name for a game/stream pair. The default binary game carries an
 * empty on-chain name, so the visible name derives from the stream. A non-empty
 * game name (e.g. a future non-binary game) wins when present.
 */
export function gameDisplayName(gameName: string | undefined | null, streamName: string | undefined | null): string {
  const g = (gameName ?? '').trim();
  if (g.length > 0) return g;
  return (streamName ?? '').trim();
}

export function useGames() {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const { sendOrRelay } = useGasless();

  /**
   * Resolve a streamId to its single binary gameId.
   * Returns 0 when the stream has no binary game (shouldn't happen for live
   * streams, but callers should treat 0 as "no game").
   */
  const resolveGameId = useCallback(
    async (streamId: number): Promise<number> => {
      if (!contracts || !streamId) return 0;
      try {
        const gid = await contracts.cached.live.games.binaryGameByStream(streamId);
        return Number(gid);
      } catch (e) {
        console.error('useGames.resolveGameId failed:', e);
        return 0;
      }
    },
    [contracts],
  );

  /**
   * Resolve a gameId back to the streamId it is bound to, via
   * gameMeta(gameId).dataStreamId. Returns 0 on failure / missing game.
   */
  const resolveStreamId = useCallback(
    async (gameId: number): Promise<number> => {
      if (!contracts || !gameId) return 0;
      try {
        const meta = await contracts.cached.live.games.gameMeta(gameId);
        // tuple index 2 == dataStreamId
        return Number(meta?.dataStreamId ?? meta?.[2] ?? 0);
      } catch (e) {
        console.error('useGames.resolveStreamId failed:', e);
        return 0;
      }
    },
    [contracts],
  );

  /**
   * Fetch the full GameMeta for a gameId (authority, gameTypeId, dataStreamId,
   * name). Returns null on failure.
   */
  const getGameMeta = useCallback(
    async (gameId: number): Promise<GameMeta | null> => {
      if (!contracts || !gameId) return null;
      try {
        const m = await contracts.cached.live.games.gameMeta(gameId);
        return {
          gameId,
          authority: String(m?.authority ?? m?.[0] ?? ''),
          gameTypeId: Number(m?.gameTypeId ?? m?.[1] ?? 0),
          dataStreamId: Number(m?.dataStreamId ?? m?.[2] ?? 0),
          targetMinutes: Number(m?.targetMinutes ?? m?.[3] ?? 0),
          name: String(m?.name ?? m?.[4] ?? ''),
        };
      } catch (e) {
        console.error('useGames.getGameMeta failed:', e);
        return null;
      }
    },
    [contracts],
  );

  /**
   * Batch-resolve many streamIds to their binary gameIds in a single eth_call
   * via Multicall. Returns a Map<streamId, gameId> (gameId 0 == no game).
   * Mirrors the multicall batching pattern used by useStreamList.
   */
  const resolveGameIds = useCallback(
    async (streamIds: number[]): Promise<Map<number, number>> => {
      const out = new Map<number, number>();
      if (!contracts || streamIds.length === 0) return out;
      const wanted = Array.from(new Set(streamIds.filter((s) => s > 0)));
      if (wanted.length === 0) return out;
      // A stream's default binary game is created in the same transaction as the
      // stream, so a stream the indexer lacks is lag, not "no game": read it on chain.
      const indexed = await indexerGames();
      for (const g of indexed ?? []) if (g.isDefaultBinary && wanted.includes(g.streamId)) out.set(g.streamId, g.gameId);
      const ids = wanted.filter((sid) => !out.has(sid));
      if (ids.length === 0) return out;
      try {
        const reqs = ids.map((sid) => ({
          contract: contracts.games,
          fn: 'binaryGameByStream',
          args: [sid],
          allowFailure: true,
        }));
        const results = await multicallRead(contracts.reads.multicall, reqs);
        ids.forEach((sid, i) => out.set(sid, Number(results[i] ?? 0)));
      } catch (e) {
        console.error('useGames.resolveGameIds failed:', e);
      }
      return out;
    },
    [contracts],
  );

  /**
   * Batch-fetch GameMeta for many gameIds in a single eth_call via Multicall.
   * Returns a Map<gameId, GameMeta>. Failures are skipped (allowFailure).
   */
  const getGameMetas = useCallback(
    async (gameIds: number[]): Promise<Map<number, GameMeta>> => {
      const out = new Map<number, GameMeta>();
      if (!contracts || gameIds.length === 0) return out;
      const wanted = Array.from(new Set(gameIds.filter((g) => g > 0)));
      if (wanted.length === 0) return out;
      const indexed = await indexerGames();
      for (const g of indexed ?? []) {
        if (!wanted.includes(g.gameId)) continue;
        out.set(g.gameId, {
          gameId: g.gameId, authority: g.authority, gameTypeId: g.gameTypeId,
          dataStreamId: g.streamId, targetMinutes: g.targetMinutes, name: g.name,
        });
      }
      const ids = wanted.filter((gid) => !out.has(gid));
      if (ids.length === 0) return out;
      try {
        const reqs = ids.map((gid) => ({
          contract: contracts.games,
          fn: 'gameMeta',
          args: [gid],
          allowFailure: true,
        }));
        const results = await multicallRead(contracts.reads.multicall, reqs);
        ids.forEach((gid, i) => {
          const m = results[i];
          if (m == null) return;
          out.set(gid, {
            gameId: gid,
            authority: String(m?.authority ?? m?.[0] ?? ''),
            gameTypeId: Number(m?.gameTypeId ?? m?.[1] ?? 0),
            dataStreamId: Number(m?.dataStreamId ?? m?.[2] ?? 0),
            targetMinutes: Number(m?.targetMinutes ?? m?.[3] ?? 0),
            name: String(m?.name ?? m?.[4] ?? ''),
          });
        });
      } catch (e) {
        console.error('useGames.getGameMetas failed:', e);
      }
      return out;
    },
    [contracts],
  );

  /**
   * Fetch ALL games on a stream (many-per-stream): the built-in binary game plus
   * any adapter games. Reads the gameId list via gamesByStream(streamId), then
   * batch-fetches gameMeta(id) for each in a single eth_call via Multicall.
   * Returns GameWithId[] sorted by gameId. Returns [] on empty or error.
   */
  const getGamesByStream = useCallback(
    async (streamId: number): Promise<GameWithId[]> => {
      if (!contracts || !streamId) return [];
      try {
        const raw = await contracts.cached.live.games.gamesByStream(streamId);
        const ids = Array.from(raw ?? [], (g: any) => Number(g)).filter((g) => g > 0);
        if (ids.length === 0) return [];
        const reqs = ids.map((gid) => ({
          contract: contracts.games,
          fn: 'gameMeta',
          args: [gid],
          allowFailure: true,
        }));
        const results = await multicallRead(contracts.reads.multicall, reqs);
        const out: GameWithId[] = [];
        ids.forEach((gid, i) => {
          const m = results[i];
          if (m == null) return;
          out.push({
            gameId: gid,
            authority: String(m?.authority ?? m?.[0] ?? ''),
            gameTypeId: Number(m?.gameTypeId ?? m?.[1] ?? 0),
            dataStreamId: Number(m?.dataStreamId ?? m?.[2] ?? 0),
            targetMinutes: Number(m?.targetMinutes ?? m?.[3] ?? 0),
            name: String(m?.name ?? m?.[4] ?? ''),
            gameConfig: String(m?.gameConfig ?? m?.[5] ?? '0x'),
          });
        });
        out.sort((a, b) => a.gameId - b.gameId);
        return out;
      } catch (e) {
        console.error('useGames.getGamesByStream failed:', e);
        return [];
      }
    },
    [contracts],
  );

  /**
   * Batched sibling of getGamesByStream for MANY streams at once (review #21):
   * one multicall for every stream's gamesByStream list, one multicall for all
   * unique gameMeta reads — 2 eth_calls total instead of 2 per stream. Returns
   * a Map keyed by streamId (missing/failed streams map to []).
   */
  const getGamesByStreams = useCallback(
    async (streamIds: number[]): Promise<Map<number, GameWithId[]>> => {
      const out = new Map<number, GameWithId[]>();
      const wantedStreams = Array.from(new Set(streamIds.filter((s) => s > 0)));
      if (!contracts || wantedStreams.length === 0) return out;
      // Every stream has at least its default binary game, so a stream with no
      // indexed games is lag: those go to the chain below. The result is cached
      // per stream for the session, which is why [] must never come from lag.
      const indexed = await indexerGames();
      for (const g of indexed ?? []) {
        if (!wantedStreams.includes(g.streamId)) continue;
        const list = out.get(g.streamId) ?? [];
        list.push({
          gameId: g.gameId, authority: g.authority, gameTypeId: g.gameTypeId, dataStreamId: g.streamId,
          targetMinutes: g.targetMinutes, name: g.name, gameConfig: g.gameConfig,
        });
        out.set(g.streamId, list);
      }
      out.forEach((list) => list.sort((a, b) => a.gameId - b.gameId));
      const unique = wantedStreams.filter((sid) => !out.has(sid));
      if (unique.length === 0) return out;
      try {
        // Pass 1: every stream's gameId list in one multicall.
        const listRes = await multicallRead(
          contracts.reads.multicall,
          unique.map((sid) => ({
            contract: contracts.games,
            fn: 'gamesByStream',
            args: [sid],
            allowFailure: true,
          })),
        );
        const perStream = new Map<number, number[]>();
        const allIds = new Set<number>();
        unique.forEach((sid, i) => {
          const ids = Array.from(listRes[i] ?? [], (g: any) => Number(g)).filter((g) => g > 0);
          perStream.set(sid, ids);
          ids.forEach((g) => allIds.add(g));
        });
        if (allIds.size === 0) {
          unique.forEach((sid) => out.set(sid, []));
          return out;
        }
        // Pass 2: every unique game's meta in one multicall.
        const idList = Array.from(allIds);
        const metaRes = await multicallRead(
          contracts.reads.multicall,
          idList.map((gid) => ({
            contract: contracts.games,
            fn: 'gameMeta',
            args: [gid],
            allowFailure: true,
          })),
        );
        const metaById = new Map<number, GameWithId>();
        idList.forEach((gid, i) => {
          const m = metaRes[i];
          if (m == null) return;
          metaById.set(gid, {
            gameId: gid,
            authority: String(m?.authority ?? m?.[0] ?? ''),
            gameTypeId: Number(m?.gameTypeId ?? m?.[1] ?? 0),
            dataStreamId: Number(m?.dataStreamId ?? m?.[2] ?? 0),
            targetMinutes: Number(m?.targetMinutes ?? m?.[3] ?? 0),
            name: String(m?.name ?? m?.[4] ?? ''),
            gameConfig: String(m?.gameConfig ?? m?.[5] ?? '0x'),
          });
        });
        unique.forEach((sid) => {
          const games = (perStream.get(sid) ?? [])
            .map((gid) => metaById.get(gid))
            .filter((g): g is GameWithId => !!g)
            .sort((a, b) => a.gameId - b.gameId);
          out.set(sid, games);
        });
        return out;
      } catch (e) {
        console.error('useGames.getGamesByStreams failed:', e);
        return out;
      }
    },
    [contracts],
  );

  /**
   * Create a game on a stream. Goes through the CORE entry point
   * (contracts.satori.createGame); the caller becomes the game authority and is
   * charged gameBurn() SATORI (the heavy tier). The GameCreated event is declared on the
   * SatoriGames ABI (the contract that emits it), NOT the core, so we parse the
   * receipt logs with the games interface, falling back to the satori interface
   * for robustness across deployments. Returns the freshly minted gameId.
   */
  const createGame = useCallback(
    async (streamId: number, gameTypeId: number, configHex: string, name: string): Promise<number> => {
      if (!contracts) throw new Error('Wallet not connected.');
      try {
        const tx = await contracts.satori.createGame(streamId, gameTypeId, configHex || '0x', name);
        const receipt = await afterTx(tx);

        const interfaces = [contracts.games.interface, contracts.satori.interface];
        for (const log of receipt.logs ?? []) {
          for (const iface of interfaces) {
            let parsed: ethers.LogDescription | null = null;
            try {
              parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
            } catch {
              parsed = null;
            }
            if (parsed && parsed.name === 'GameCreated') {
              return Number(parsed.args.gameId);
            }
          }
        }
        // No event found — surface a readable failure rather than a bogus id.
        throw new Error('Game created but the new gameId could not be read from the receipt.');
      } catch (e: any) {
        throw new Error(explainError(e));
      }
    },
    [contracts],
  );

  /**
   * Single-shot prediction for an arbitrary game (binary or adapter), keyed by
   * gameId, via the core's predictMultipleWithPayloads([{ gameId, payload }]).
   * The payload is the raw bytes the game expects (type-0 binary: 1 byte
   * 1=UP/2=DOWN; adapters: whatever the adapter decodes). An empty/'0x' payload
   * reverts on-chain, so we reject it client-side with a readable error.
   */
  const predictGame = useCallback(
    async (gameId: number, payloadHex: string): Promise<void> => {
      if (!contracts) throw new Error('Wallet not connected.');
      const payload = (payloadHex ?? '').trim();
      if (!payload || payload === '0x') {
        throw new Error('Prediction payload is empty. Provide the bytes the game expects (e.g. 0x01 for UP/YES).');
      }
      try {
        // Read-path simulation first — same reason as the main predict flow in
        // App.tsx: without it a revert becomes "invalid BigNumberish value" and the
        // real cause (already predicted, stream not updated this round, power
        // delegated) never reaches explainError.
        const tx = await sendOrRelay(
          { kind: 'predict', referrer: ethers.ZeroAddress, requests: [{ gameId, payload }] },
          () => sendPreflighted(
            contracts.reads.satori, contracts.satori,
            'predictMultipleWithPayloads', [[{ gameId, payload }]], address,
          ),
        );
        await afterTx(tx);
      } catch (e: any) {
        throw new Error(explainError(e));
      }
    },
    [contracts, address, sendOrRelay],
  );

  /**
   * Rename a game. Gated on-chain by `onlyAuthority(gameId)` in SatoriGames, so
   * the current game authority can call it directly on contracts.games (no core
   * forwarder needed). Reverts for non-authority callers.
   */
  const setGameName = useCallback(
    async (gameId: number, newName: string): Promise<void> => {
      if (!contracts) throw new Error('Wallet not connected.');
      try {
        const tx = await contracts.games.setGameName(gameId, newName);
        await afterTx(tx);
      } catch (e: any) {
        throw new Error(explainError(e));
      }
    },
    [contracts],
  );

  /**
   * Transfer a game's authority to a new address. Gated on-chain by
   * `onlyAuthority(gameId)` in SatoriGames — callable directly on contracts.games
   * by the current authority. The contract rejects the zero address; we also
   * validate the address client-side for a friendlier error.
   */
  const setGameAuthority = useCallback(
    async (gameId: number, newAuthority: string): Promise<void> => {
      if (!contracts) throw new Error('Wallet not connected.');
      if (!ethers.isAddress(newAuthority)) throw new Error('Invalid authority address.');
      if (newAuthority === ethers.ZeroAddress) throw new Error('New authority cannot be the zero address.');
      try {
        const tx = await contracts.games.setGameAuthority(gameId, newAuthority);
        await afterTx(tx);
      } catch (e: any) {
        throw new Error(explainError(e));
      }
    },
    [contracts],
  );

  return {
    resolveGameId,
    resolveStreamId,
    getGameMeta,
    resolveGameIds,
    getGameMetas,
    gameDisplayName,
    getGamesByStream,
    getGamesByStreams,
    createGame,
    predictGame,
    setGameName,
    setGameAuthority,
  };
}

