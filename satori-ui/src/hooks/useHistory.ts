import { useState, useCallback, useEffect, useRef } from 'react';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';
import { loadEventsCached } from '../utils/eventCache';
import { indexerPredictions, PredictionOutcome } from '../utils/indexerClient';
import { getDeploymentBlock } from '../lib/chainValues';
import { FIRST_CHUNKS, windowStart, nextChunks, isComplete } from '../lib/historyWindow';

/// One row of "what this account did", newest first.
///
/// Predictions carry their OUTCOME, which is not a field on any single event —
/// it is whichever terminal event later landed on the same (user, gameId, round).
/// See docs/design/dapp-history-tab.md §2.
export type HistoryKind =
  | 'prediction' | 'reward' | 'delegation' | 'vote' | 'bounty' | 'referral' | 'airdrop';

export interface HistoryRow {
  kind: HistoryKind;
  /// Sort key. Block number, because it totally orders everything on one chain
  /// and is present on every log; `round` is not (rewards/delegation events
  /// carry it inconsistently) and would tie constantly.
  block: number;
  index: number;
  tx?: string;
  round?: number;
  /// Headline, already humanised.
  title: string;
  /// Secondary line: amounts, counterparties, direction.
  detail?: string;
  // Prediction-only
  gameId?: number;
  direction?: string;
  outcome?: PredictionOutcome;
  streak?: number;
  power?: string;
}

const fmt = (v: bigint | undefined, dp = 2): string => {
  if (v == null) return '0';
  const s = Number(v) / 1e18;
  return s >= 1000 ? s.toFixed(0) : s.toFixed(dp);
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function useHistory() {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /// True when the accelerator answered, so the UI can say where this came from.
  const [viaIndexer, setViaIndexer] = useState(false);
  /// How wide the backwards scan currently is, and whether it has reached the
  /// deployment block — at which point there is nothing older to ask for.
  const [chunks, setChunks] = useState(FIRST_CHUNKS);
  const [complete, setComplete] = useState(false);
  /// Set once the chain pass has landed, so a slow indexer response cannot
  /// clobber the complete picture with its predictions-only subset.
  const chainLanded = useRef(false);

  const load = useCallback(async () => {
    if (!contracts || !address) { setRows([]); return; }
    setLoading(true);
    setError(null);
    try {
      const fromBlock = Number(await getDeploymentBlock(contracts.reads));
      const engine = contracts.reads.engine;
      // Read back only as far as the current window. `fromBlock` stays the
      // deployment floor — it is what the cache validates against — and
      // `sinceBlock` is how far back we actually want right now. See
      // lib/historyWindow.ts and design §4: the cold scan is the cost that
      // matters, and it is 18 event streams wide.
      const head = await (engine.runner?.provider as any).getBlockNumber();
      const since = windowStart(chunks, head, fromBlock);
      setComplete(isComplete(since, fromBlock));
      const rewards = contracts.reads.rewards;
      const voting = contracts.reads.voting;
      const bounties = contracts.reads.bounties;
      // ZERO on a stack that predates SatoriAirdrop: `ev` treats a falsy
      // contract as no events, so pass null rather than a contract at zero.
      const airdropC = String(contracts.reads.airdrop?.target).toLowerCase() !== '0x0000000000000000000000000000000000000000'
        ? contracts.reads.airdrop : null;

      // Contracts, NOT the satori facade. The facade's .target/.filters resolve
      // to the hub, which emits none of these — see satoriFacade.ts.
      const ev = (contract: any, eventName: string, filterArgs: any[]) =>
        contract
          ? loadEventsCached({ contract, eventName, filterArgs, fromBlock, sinceBlock: since })
              .catch(() => [])
          : Promise.resolve([]);

      const [
        made, scored, voided, unrec, displaced,
        claimed, delegated, undelegated, claimDel, claimUndel,
        voted, moved, funded, staked, unstaked, bountyPaid, refSet, refPaid, airdrop,
      ] = await Promise.all([
        ev(engine, 'PredictionMade', [address]),
        ev(engine, 'PredictionScored', [address]),
        ev(engine, 'PredictionVoided', [address]),
        ev(engine, 'PredictionUnrecoverable', [address]),
        ev(engine, 'PredictionDisplaced', [address]),
        ev(rewards, 'RewardsClaimed', [address]),
        ev(rewards, 'PredictionDelegated', [address]),
        ev(rewards, 'PredictionUndelegated', [address]),
        ev(rewards, 'ClaimDelegated', [address]),
        ev(rewards, 'ClaimUndelegated', [address]),
        ev(voting, 'Voted', [address]),
        // VotesMoved(voter, fromGame, toGame, round, amount, newFromWeight,
        // newToWeight) — voter is the first indexed topic, same shape as Voted.
        ev(voting, 'VotesMoved', [address]),
        ev(bounties, 'BountyFunded', [address]),
        ev(bounties, 'BountyTokenStaked', [address]),
        ev(bounties, 'BountyTokenUnstaked', [address]),
        ev(bounties, 'BountyPaid', [address]),
        ev(rewards, 'ReferralSet', [address]),
        ev(rewards, 'ReferralPaid', [address]),
        ev(airdropC, 'AirdropClaimed', [address]),
      ]);

      // --- the outcome join (design §2) ---
      const key = (g: any, r: any) => `${Number(g)}:${Number(r)}`;
      const outcomeOf = new Map<string, PredictionOutcome>();
      const streakOf = new Map<string, number>();
      for (const e of displaced) outcomeOf.set(key(e.args.gameId, e.args.round), 'displaced');
      for (const e of unrec) outcomeOf.set(key(e.args.gameId, e.args.round), 'unrecoverable');
      for (const e of voided) outcomeOf.set(key(e.args.gameId, e.args.round), 'void');
      // Scored last: it is the definitive answer where several exist.
      for (const e of scored) {
        const k = key(e.args.gameId, e.args.round);
        outcomeOf.set(k, e.args.correct ? 'won' : 'lost');
        streakOf.set(k, Number(e.args.streak));
      }

      const out: HistoryRow[] = [];

      for (const e of made) {
        const k = key(e.args.gameId, e.args.round);
        const dir = Number(e.args.direction) === 1 ? 'UP' : 'DOWN';
        out.push({
          kind: 'prediction',
          block: e.blockNumber, index: e.index, tx: e.transactionHash,
          round: Number(e.args.round),
          gameId: Number(e.args.gameId),
          direction: dir,
          // Absent from every terminal map => still waiting on the stream's next
          // value. A real state, not a failure (design §2).
          outcome: outcomeOf.get(k) ?? 'pending',
          streak: streakOf.get(k) ?? Number(e.args.streak),
          power: fmt(e.args.predictionPower),
          title: `Predicted ${dir}`,
        });
      }

      const push = (
        list: any[], kind: HistoryKind,
        title: (a: any) => string, detail?: (a: any) => string | undefined,
      ) => {
        for (const e of list) {
          out.push({
            kind,
            block: e.blockNumber, index: e.index, tx: e.transactionHash,
            round: e.args.round != null ? Number(e.args.round) : undefined,
            // Carried so the UI can name the game the same way it names a
            // prediction's — a row reading "Voted on BTC/USD" beats "game #5".
            gameId: e.args.gameId != null ? Number(e.args.gameId) : undefined,
            title: title(e.args),
            detail: detail?.(e.args),
          });
        }
      };

      push(claimed, 'reward', (a) => `Claimed ${fmt(a.totalAmount)} SATORI`,
        (a) => (a.recipient?.toLowerCase() !== address.toLowerCase() ? `to ${short(a.recipient)}` : undefined));
      push(delegated, 'delegation', (a) => `Delegated prediction power to ${short(a.delegate)}`,
        (a) => `${fmt(a.predictionPower)} SATORI`);
      push(undelegated, 'delegation', () => 'Revoked prediction delegation',
        (a) => `${fmt(a.predictionPower)} SATORI returned`);
      push(claimDel, 'delegation', (a) => `Delegated claim authority to ${short(a.delegate)}`);
      push(claimUndel, 'delegation', () => 'Revoked claim delegation');
      push(voted, 'vote', () => 'Voted on',
        (a) => `burned ${fmt(a.amountBurned)} SATORI for ${fmt(a.weightAdded)} weight`);
      // A weight move burns nothing — the SATORI was destroyed at vote time;
      // this re-points weight off an unapproved game. Reuses kind 'vote': it
      // is the same ledger the Voted rows narrate.
      push(moved, 'vote',
        (a) => `Moved ${fmt(a.amount)} weight from game #${Number(a.fromGame)} to game #${Number(a.toGame)}`);
      push(funded, 'bounty', () => 'Funded a bounty on',
        (a) => `${fmt(a.received)} of ${short(a.token)}`);
      push(staked, 'bounty', (a) => `Staked bounty token ${short(a.token)}`, (a) => fmt(a.amount));
      push(unstaked, 'bounty', (a) => `Unstaked bounty token ${short(a.token)}`, (a) => fmt(a.amount));
      // A win, credited straight into stake. Carries gameId and round, so the
      // row names the game like a prediction row does.
      push(bountyPaid, 'bounty', () => 'Won a bounty on',
        (a) => `${fmt(a.share)} of ${short(a.token)}, added to your stake`);
      push(refSet, 'referral', (a) => `Set referral to ${short(a.referral)}`);
      push(refPaid, 'referral', (a) => `Referral paid to ${short(a.referral)}`, (a) => `${fmt(a.amount)} SATORI`);
      push(airdrop, 'airdrop', (a) => `Claimed airdrop`, (a) => `${fmt(a.amount)} SATORI`);

      out.sort((a, b) => (b.block - a.block) || (b.index - a.index));
      chainLanded.current = true;
      setRows(out);
      setViaIndexer(false);
    } catch (e: any) {
      setError(e?.message ?? 'failed to load history');
    } finally {
      setLoading(false);
    }
  }, [contracts, address, chunks]);

  // Best-effort accelerator FIRST, so a configured indexer paints instantly;
  // the chain pass then replaces it with the complete picture (the indexer
  // covers predictions only).
  const loadFast = useCallback(async () => {
    if (!address) return;
    const fast = await indexerPredictions(address, 1000);
    if (!fast || fast.length === 0) return;
    // The chain pass is authoritative and covers every kind, not just
    // predictions. If it got here first, leave it alone.
    if (chainLanded.current) return;
    setViaIndexer(true);
    setRows(fast.map((p) => ({
      kind: 'prediction' as const,
      block: p.block, index: 0, tx: p.tx,
      round: p.round, gameId: p.gameId, direction: p.direction,
      outcome: p.outcome, streak: p.streak, power: p.power,
      title: `Predicted ${p.direction}`,
    })));
  }, [address]);

  // Accelerator: address-scoped, so widening the window never re-hits it.
  useEffect(() => { chainLanded.current = false; loadFast(); }, [loadFast]);
  // Chain: re-runs when the window widens.
  useEffect(() => { load(); }, [load]);
  // A new account starts at the narrow window again.
  useEffect(() => { setChunks(FIRST_CHUNKS); }, [address]);

  /// Reach further back. Only the gap below what is already cached is fetched.
  const loadOlder = useCallback(() => {
    setChunks((c) => nextChunks(c));
  }, []);

  return { rows, loading, error, viaIndexer, complete, loadOlder, reload: load };
}
