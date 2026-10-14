import { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useGames, gameDisplayName } from './useGames';
import { useWallet } from './useWallet';
import { multicallRead } from '../utils/multicall';
import { loadEventsCached } from '../utils/eventCache';
import { indexerBountyPairs } from '../utils/indexerClient';
import { explainError } from '../utils/errors';
import { publishDappEvent, onDappEvent } from '../utils/events';
import { getCurrentRound, getDeploymentBlock } from '../lib/chainValues';
import { afterTx } from '../lib/afterTx';
import { planBountyStake } from '../lib/bountyAllowances';
import { makeAllowanceReaders, stakeBountyBatched, walletCanBatch } from '../lib/bountyAllowanceReaders';
import { chainCache } from './useChainRead';
import { signPermit, tokenPermitArg, resolvePermitDomain } from '../lib/permit';

// Bounties now live on the dedicated SatoriBounties contract (contracts.bounties),
// keyed by gameId rather than streamId. The on-chain MAX_STAKED_TOKENS_PER_USER
// cap was removed — the stake list is user-controlled and fully reversible
// (unstake to shrink). The dapp probes the list via `userStakedTokenCount` to
// size its indexed reads instead of relying on a fixed compile-time cap.
//
// The separate "subscribe / opt-in" subsystem no longer exists on-chain:
// staking the token IS the opt-in. The unstake lock is now the round-gate
// `stakeLockedUntil(user, token)` (a uint64 round) compared against
// `satori.getCurrentRound()` — there is no per-prediction pending counter.

export interface StakeEntry {
  token: string;        // lowercase address
  symbol: string;
  decimals: number;
  stake: bigint;        // bountyStake[user][token], base units
  lockedUntil: bigint;  // stakeLockedUntil[user][token], a round number (uint64)
  locked: boolean;      // lockedUntil > currentRound
  unlocksInRounds: number; // rounds until the stake unlocks (0 when unlocked)
}

export interface TokenMetadata {
  symbol: string;
  decimals: number;
}

/// One (game, token) bounty that the user could earn from by predicting on the
/// game's stream. Derived by scanning `BountyFunded` events filtered by each
/// staked token, deduping game ids, and live-checking the pool + rate so
/// drained pools don't show up as opportunities. The gameId is mapped back to
/// its stream (1:1) for display via the useGames bridge.
export interface BoostOpportunity {
  gameId: number;
  streamId: number;
  streamName: string;
  token: string;        // lowercase
  symbol: string;
  decimals: number;
  pool: bigint;         // base units
  ratePerRound: bigint; // scaled by RATE_SCALE (1e18); per 24h round now that rounds are daily
}

type ActionResult = { ok: true } | { ok: false; error: string };

const erc20Iface = new ethers.Interface([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function approve(address,uint256) returns (bool)',
]);

function shortSymbol(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}


/// Can this token produce a permit signature the contract will accept? Reads
/// only — no signing prompt — so it is safe to call before deciding which flow
/// to show the user.
async function canPermit(contracts: any, token: string): Promise<boolean> {
  try {
    const erc20 = new ethers.Contract(token, [
      'function DOMAIN_SEPARATOR() view returns (bytes32)',
      'function nonces(address) view returns (uint256)',
      'function name() view returns (string)',
      'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
    ], contracts.reads.token.runner);
    const net = await (contracts.reads.token.runner as ethers.Provider).getNetwork();
    return (await resolvePermitDomain(erc20, net.chainId, token)) !== null;
  } catch {
    return false;
  }
}

export function useBountyStakes() {
  const { contracts } = useContracts();
  const { getGameMetas } = useGames();
  const { address } = useWallet();
  const [entries, setEntries] = useState<StakeEntry[]>([]);
  const [opportunities, setOpportunities] = useState<BoostOpportunity[]>([]);
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!contracts || !address) {
      setEntries([]); setLoading(false); return;
    }
    setLoading(true);
    try {
      // Read the stake list length first, then fetch exactly that many tokens.
      // The on-chain cap was removed, so we can't probe a fixed range — but the
      // count view gives us the exact size.
      const [stakedCountRaw, currentRoundRaw] = await Promise.all([
        contracts.cached.live.bounties.userStakedTokenCount(address),
        getCurrentRound(),
      ]);
      const stakedCount = Number(stakedCountRaw);
      const currentRound = BigInt(currentRoundRaw);
      const stakeIdxReqs = Array.from({ length: stakedCount }, (_, i) => ({
        contract: contracts.bounties, fn: 'userStakedTokens', args: [address, i],
      }));
      const stakeIdxResults = stakeIdxReqs.length > 0
        ? await multicallRead(contracts.reads.multicall, stakeIdxReqs)
        : [];
      const stakedTokens = stakeIdxResults.map((r) => (r as string).toLowerCase());

      if (stakedTokens.length === 0) {
        setEntries([]); setLoading(false); return;
      }

      // For each token: bountyStake / stakeLockedUntil.
      const stateReqs = stakedTokens.flatMap((t) => [
        { contract: contracts.bounties, fn: 'bountyStake',       args: [address, t] },
        { contract: contracts.bounties, fn: 'stakeLockedUntil',  args: [address, t] },
      ]);
      const stateResults = await multicallRead(contracts.reads.multicall, stateReqs);

      // ERC20 metadata (symbol + decimals) via the raw Multicall3 path.
      const metaCalls = stakedTokens.flatMap((t) => [
        { target: t, allowFailure: true, callData: erc20Iface.encodeFunctionData('symbol', []) },
        { target: t, allowFailure: true, callData: erc20Iface.encodeFunctionData('decimals', []) },
      ]);
      const metaResults = await contracts.multicall.aggregate3.staticCall(metaCalls);

      const stakeNext: StakeEntry[] = [];
      stakedTokens.forEach((token, i) => {
        const stake       = BigInt(stateResults[i * 2].toString());
        const lockedUntil = BigInt(stateResults[i * 2 + 1].toString());
        let symbol = shortSymbol(token);
        let decimals = 18;
        const symRes = metaResults[i * 2];
        const decRes = metaResults[i * 2 + 1];
        if (symRes?.success) {
          try { symbol = String(erc20Iface.decodeFunctionResult('symbol', symRes.returnData)[0]); }
          catch { /* keep short */ }
        }
        if (decRes?.success) {
          try { decimals = Number(erc20Iface.decodeFunctionResult('decimals', decRes.returnData)[0]); }
          catch { /* keep 18 */ }
        }
        const locked = lockedUntil > currentRound;
        stakeNext.push({
          token, symbol, decimals, stake, lockedUntil,
          locked,
          unlocksInRounds: locked ? Number(lockedUntil - currentRound) : 0,
        });
      });
      setEntries(stakeNext);
    } catch (e) {
      console.error('useBountyStakes load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [contracts, address]);

  useEffect(() => { load(); }, [load]);

  // Refetch when another tab/component signals that bounty state changed.
  // Catches the "I funded a bounty on the Streams tab; come back to see it
  // as an opportunity" cross-tab gap.
  useEffect(() => {
    const off1 = onDappEvent('bounty-funded', () => load());
    const off2 = onDappEvent('bounty-token-cleaned', () => load());
    return () => { off1(); off2(); };
  }, [load]);

  /// Cross-reference each staked token against every game that has ever
  /// received a `fundBounty` call in that token. Live-checks `pool > 0 &&
  /// ratePerRound > 0` so drained pools don't surface as opportunities.
  /// Event-driven: `BountyFunded(funder, gameId, token, ...)` is indexed on
  /// `token`, so per-token filters are cheap. gameIds are mapped back to their
  /// 1:1 streams for display via the useGames bridge.
  useEffect(() => {
    if (!contracts || entries.length === 0) { setOpportunities([]); return; }
    let cancelled = false;
    (async () => {
      setOpportunitiesLoading(true);
      try {
        // Gather candidate (gameId, token) pairs across every staked token.
        type Pair = { gameId: number; token: string; pool?: bigint; rateScaled?: bigint };
        const pairSet = new Map<string, Pair>(); // dedupe via composite key
        for (const entry of entries) {
          // Indexer fast path: per-token funded-pair list, already deduped
          // server-side. Null → the per-token event scan.
          const indexed = await indexerBountyPairs(entry.token);
          if (indexed) {
            for (const p of indexed) {
              if (p.gameId === 0) continue;
              const key = `${p.gameId}-${entry.token}`;
              if (!pairSet.has(key)) pairSet.set(key, { gameId: p.gameId, token: entry.token, pool: p.pool, rateScaled: p.rateScaled });
            }
            continue;
          }
          const fromBlock = Number(await getDeploymentBlock(contracts.reads));
          const events = await loadEventsCached({
            contract: contracts.bounties,
            eventName: 'BountyFunded',
            // BountyFunded(funder, gameId, token, received, proposedRate, newRate)
            // — gameId is indexed topic 2, token is indexed topic 3. Filter on
            // token only.
            filterArgs: [null, null, entry.token],
            fromBlock,
          });
          for (const ev of events) {
            const gameId = Number(ev.args?.gameId ?? 0);
            if (gameId === 0) continue;
            const key = `${gameId}-${entry.token}`;
            if (!pairSet.has(key)) pairSet.set(key, { gameId, token: entry.token });
          }
        }
        const pairs = Array.from(pairSet.values());
        if (cancelled || pairs.length === 0) { setOpportunities([]); return; }

        // Live-check pool + rate for each candidate pair: from the indexer's
        // post-state when it has it, otherwise on chain. Surviving game ids
        // (pool > 0 && rate > 0) resolve to their stream for display.
        const liveGameIds = new Set<number>();
        const unread = pairs.filter((p) => p.pool == null || p.rateScaled == null);
        for (const p of pairs) {
          if (p.pool != null && p.rateScaled != null && p.pool > BigInt(0) && p.rateScaled > BigInt(0)) liveGameIds.add(p.gameId);
        }
        if (unread.length) {
          const reqs = unread.flatMap((p) => [
            { contract: contracts.bounties, fn: 'pool',         args: [p.gameId, p.token] },
            { contract: contracts.bounties, fn: 'ratePerRound', args: [p.gameId, p.token] },
          ]);
          const results = await multicallRead(contracts.reads.multicall, reqs);
          if (cancelled) return;
          unread.forEach((p, i) => {
            p.pool = BigInt(results[i * 2].toString());
            p.rateScaled = BigInt(results[i * 2 + 1].toString());
            if (p.pool > BigInt(0) && p.rateScaled > BigInt(0)) liveGameIds.add(p.gameId);
          });
        }
        // gameId -> GameMeta (name + dataStreamId) in one batched multicall.
        const metaById = await getGameMetas(Array.from(liveGameIds));
        if (cancelled) return;

        // Fetch the stream display name for every surviving game's stream id.
        const streamIdByGame = new Map<number, number>();
        const liveStreamIds = new Set<number>();
        Array.from(liveGameIds).forEach((gid) => {
          const sid = metaById.get(gid)?.dataStreamId ?? 0;
          streamIdByGame.set(gid, sid);
          if (sid > 0) liveStreamIds.add(sid);
        });
        const streamIdList = Array.from(liveStreamIds);
        const nameReqs = streamIdList.map((sid) => ({
          // getDataStreamInfo moved to the registry (removed from the core).
          contract: contracts.registry, fn: 'getDataStreamInfo', args: [sid], allowFailure: true,
        }));
        const nameResults = nameReqs.length > 0
          ? await multicallRead(contracts.reads.multicall, nameReqs)
          : [];
        if (cancelled) return;
        const streamNameById = new Map<number, string>();
        streamIdList.forEach((sid, i) => {
          const info = nameResults[i];
          // getDataStreamInfo returns (name, provider, type, value, valueHour,
          // exists) — the 5th return is the absolute HOUR of the newest value
          // (hour-keyed ring). Only the name is used here.
          const name = info?.[0] ?? '';
          streamNameById.set(sid, String(name));
        });

        const next: BoostOpportunity[] = [];
        const entryByToken = new Map(entries.map((e) => [e.token, e]));
        pairs.forEach((p) => {
          const pool = p.pool ?? BigInt(0);
          const ratePerRound = p.rateScaled ?? BigInt(0);
          if (pool === BigInt(0) || ratePerRound === BigInt(0)) return;
          const entry = entryByToken.get(p.token);
          if (!entry) return; // user unstaked between effect runs
          const streamId = streamIdByGame.get(p.gameId) ?? 0;
          const gameName = metaById.get(p.gameId)?.name;
          const streamName = streamNameById.get(streamId) ?? '';
          next.push({
            gameId: p.gameId,
            streamId,
            // Binary games have an empty name, so the display name derives from
            // the stream; a non-empty game name wins if present.
            streamName: gameDisplayName(gameName, streamName) || `Game #${p.gameId}`,
            token: p.token,
            symbol: entry.symbol,
            decimals: entry.decimals,
            pool,
            ratePerRound,
          });
        });
        // Sort by pool descending so the biggest boost lands top of list.
        next.sort((a, b) => (b.pool > a.pool ? 1 : b.pool < a.pool ? -1 : 0));
        setOpportunities(next);
      } catch (e) {
        console.warn('Boost-opportunities scan failed:', e);
        setOpportunities([]);
      } finally {
        if (!cancelled) setOpportunitiesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [contracts, entries, getGameMetas]);

  /// Fetch symbol + decimals for an arbitrary token. The Add-a-stake form
  /// uses this to validate / format input before the two-tx stake flow.
  const fetchTokenMetadata = useCallback(async (tokenAddr: string): Promise<TokenMetadata | null> => {
    if (!contracts || !ethers.isAddress(tokenAddr)) return null;
    try {
      const calls = [
        { target: tokenAddr, allowFailure: true, callData: erc20Iface.encodeFunctionData('symbol', []) },
        { target: tokenAddr, allowFailure: true, callData: erc20Iface.encodeFunctionData('decimals', []) },
      ];
      const res = await contracts.multicall.aggregate3.staticCall(calls);
      let symbol = shortSymbol(tokenAddr.toLowerCase());
      let decimals = 18;
      if (res[0]?.success) {
        try { symbol = String(erc20Iface.decodeFunctionResult('symbol', res[0].returnData)[0]); }
        catch { /* keep short */ }
      }
      if (res[1]?.success) {
        try { decimals = Number(erc20Iface.decodeFunctionResult('decimals', res[1].returnData)[0]); }
        catch { /* keep 18 */ }
      }
      return { symbol, decimals };
    } catch (e) {
      return null;
    }
  }, [contracts]);

  /// Whether `stake` still needs an approval press first. Callers check this and
  /// call `approveForStake` as its own user action if so.
  ///
  /// This used to be one function that approved AND staked. Two signatures in one
  /// press cannot work on mobile: the wallet request unloads the page, so the
  /// code queued after it never runs — the blank-page bug fixed for stream
  /// creation in `563a9539` and reintroduced here by copy.
  const stakeNeedsApproval = useCallback(async (token: string, amount: bigint): Promise<boolean> => {
    if (!contracts || !address) return true;
    const bountiesAddress = await contracts.bounties.getAddress();
    const steps = await planBountyStake({ token, amount, bountiesAddress }, makeAllowanceReaders(contracts, address));
    if (steps.length === 0) return false;
    // An allowance is short — but `stake` can still be one press if the token can
    // be permitted (it signs inside its own transaction) or the wallet can batch
    // the approval with it. Both probes are reads with no user interaction;
    // asking for a press that is not needed costs a wallet round trip.
    if (await canPermit(contracts, token)) return false;
    return !(await walletCanBatch(contracts, address));
  }, [contracts, address]);

  /// ONE transaction: approve the bounty contract to take `amount` of `token`.
  const approveForStake = useCallback(async (token: string, amount: bigint): Promise<ActionResult> => {
    if (!contracts) return { ok: false, error: 'Not connected' };
    setActing('stake');
    try {
      const bountiesAddr = await contracts.bounties.getAddress();
      const erc20 = new ethers.Contract(
        token,
        ['function approve(address,uint256) returns (bool)'],
        (contracts.satori as any).runner,
      );
      await afterTx(await erc20.approve(bountiesAddr, amount));
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: explainError(e) };
    } finally {
      setActing(null);
    }
  }, [contracts]);

  /// ONE transaction. Signs the allowance when the token supports ERC-2612, which
  /// makes this the whole flow; otherwise the allowance must already be in place
  /// (`stakeNeedsApproval` / `approveForStake` as its own press). Staking the
  /// token IS the opt-in; there is no separate subscribe.
  const stake = useCallback(async (token: string, amount: bigint): Promise<ActionResult> => {
    if (!contracts || !address) return { ok: false, error: 'Not connected' };
    setActing('stake');
    try {
      const reader = contracts.reads.token.runner;
      const permit = reader ? await signPermit({
        tokenAddress: token,
        reader,
        signer: (contracts.satori as any).runner,
        owner: address,
        spender: await contracts.bounties.getAddress(),
        value: amount,
      }) : null;
      // `vrs` is absent for a smart-account signature, which ERC-2612 cannot
      // express.
      if (permit?.vrs) {
        await afterTx(await contracts.bounties.stakeBountyTokenWithPermit(token, amount, tokenPermitArg(permit)));
      } else {
        // Route B: no usable permit, so ask the WALLET to batch the approval and
        // the stake atomically. Only reached for tokens permit cannot serve.
        const bountiesAddress = await contracts.bounties.getAddress();
        const steps = await planBountyStake({ token, amount, bountiesAddress }, makeAllowanceReaders(contracts, address));
        const batched = steps.length > 0
          ? await stakeBountyBatched(contracts, address, { token, amount }, steps)
          : null;
        if (batched) {
          if (!batched.ok) {
            return { ok: false, error: batched.reverted
              ? 'The batched transaction reverted. Nothing was staked.'
              : 'The batched transaction did not confirm in time.' };
          }
          chainCache.invalidateAll();
        } else {
          // Allowance already in place (steps empty), or the wallet cannot batch
          // — in which case approveForStake was the earlier press.
          await afterTx(await contracts.bounties.stakeBountyToken(token, amount));
        }
      }
      await load();
      publishDappEvent('bounty-token-staked', { token });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: explainError(e) };
    } finally {
      setActing(null);
    }
  }, [contracts, address, load]);

  const unstake = useCallback(async (
    token: string, amount: bigint, recipient: string,
  ): Promise<ActionResult> => {
    if (!contracts) return { ok: false, error: 'Not connected' };
    setActing('unstake');
    try {
      const tx = await contracts.bounties.unstakeBountyToken(token, amount, recipient);
      await afterTx(tx);
      await load();
      publishDappEvent('bounty-token-staked', { token });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: explainError(e) };
    } finally {
      setActing(null);
    }
  }, [contracts, load]);

  // (withdraw / withdrawFor removed — the dead unclaimedBounty withdraw path is
  // gone; bounty winnings compound into bountyStake and are cashed out via
  // unstake — review A4.)

  return {
    entries,
    opportunities,
    opportunitiesLoading,
    // The on-chain cap was removed. UI field kept on the return value so
    // consumers don't break; reports the current list length and a sentinel
    // "unbounded" capacity (Number.POSITIVE_INFINITY) for components that
    // previously rendered "X / Y" capacity displays.
    capacityUsed: entries.length,
    capacity: Number.POSITIVE_INFINITY,
    loading,
    acting,
    reload: load,
    fetchTokenMetadata,
    stakeNeedsApproval,
    approveForStake,
    stake,
    unstake,
  };
}
