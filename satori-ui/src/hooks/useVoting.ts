import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';
import { useGasless } from './useGasless';
import { useGames } from './useGames';
import { explainError, preflight, sendPreflighted } from '../utils/errors';
import { getStreamBurn, getCurrentRound, getNamedAdapterId } from '../lib/chainValues';
import { afterTx } from '../lib/afterTx';
import { signPermit, satoriPermitArg, resolvePermitDomain } from '../lib/permit';
import { namedStreamCreateArgs, requireNamedAdapterId } from '../lib/namedStream';

// 'named' takes the name only: adapter id, provider (the engine), config and
// cadence are all derived in createStream. See lib/namedStream.ts.
export type StreamKind = 'simple' | 'custom' | 'chainlink' | 'uniswap' | 'adapter' | 'named';

// Adapter IDs are pinned to the deploy script's `registerAdapter` order.
// If a chain ever ships with a different mapping, this map must be updated.
export const ADAPTER_ID_CHAINLINK = 1;
export const ADAPTER_ID_UNISWAP   = 2;
export const ADAPTER_ID_CUSTOM    = 3;

export interface CreateStreamArgs {
  name: string;
  kind: StreamKind;
  target?: string;            // adapter `provider` address — required for custom/chainlink/uniswap
  minCadenceMinutes?: number; // update cadence in MINUTES. 1440 = daily (the default the hub's
                              // no-cadence overloads stamp); 60 = hourly, the registry's grid floor
                              // (anything below reverts InvalidCadence). No admin-only tier — hourly
                              // streams are the product.
  maxFeedAge?: number;        // Chainlink only — seconds, default 3600 (1 hour)
  adapterId?: number;         // REQUIRED when kind==='adapter' — the registry adapter ID (1 .. nextAdapterId()-1)
  configHex?: string;         // optional raw config bytes for kind==='adapter' (default '0x')
}


export interface VotingData {
  // NOTE ON WHAT IS *NOT* HERE. Burn voting removed a whole model, and with it
  // eight reads this hook used to make:
  //   getEffectiveVote, getVotingPower, delegatedBalance, voteDelegation,
  //   cumulativeEligiblePower, cumulativeTotalPower, maxEligibleGames,
  //   eligibleGamesCount
  // There is no "your vote" to show: you BURN SATORI for a game, the weight is
  // permanent and unrevocable, and you may have burned for any number of games —
  // the contract keeps no per-voter breakdown at all. There is no voting power
  // either (your influence is simply what you burned), no delegation OF votes,
  // and no eligibility cap (eligibility is just "carries weight"). The UI built
  // on those — YourVoteCard, VoterDistributionCard, the Voting Delegation row —
  // is deleted rather than fed placeholder zeros, which would have implied the
  // numbers existed and were nil.
  streamCreationFee: string;  // value of satori.streamBurn(), in ether units
  /// Is stream creation switched on for THIS address right now?
  ///
  /// Capabilities ship OFF and are enabled one at a time (launch checklist E1),
  /// so on a fresh deployment this is false for everyone. Note the admin is
  /// always allowed regardless of the flag, which is why it is read per-address
  /// rather than as a global policy bit.
  canCreateStream: boolean;
  /// Round through which this address's tokens cannot be transferred (0 = free).
  ///
  /// Matters here because creating a stream BURNS SATORI, and the hub takes it
  /// with transferFrom — which the token's transfer gate rejects while locked.
  /// Predicting locks you through the next round (SatoriEngine calls
  /// engineLock(user, round + 1)), so predict-then-create in one round always
  /// fails, and used to fail with a bare `Locked()` after the user had filled in
  /// the whole form.
  tokenLockedUntilRound: number;
  /// Convenience: is that lock in force right now? Mirrors the gate exactly
  /// (`l != 0 && l >= currentRound`, SatoriToken._update).
  tokensLocked: boolean;
  /// The hub cannot yet take the creation fee AND the wallet cannot sign for it,
  /// so a separate approval press is genuinely needed. Drives which button the
  /// form shows. False whenever `canSignPermit` is true: the fee is authorized by
  /// signature inside the create transaction, so there is nothing to approve.
  needsStreamApproval: boolean;
  /// Can this wallet authorize SATORI by signature? When true every SATORI flow
  /// (vote, create a stream) is ONE press, because the authorization travels
  /// inside the transaction instead of ahead of it as its own approval.
  ///
  /// A read-only probe of the token's EIP-712 domain — no signing prompt — so it
  /// is safe to run on load. False for a token whose domain cannot be confirmed,
  /// which is the signal to keep the approve button.
  canSignPermit: boolean;
  /// Spendable SATORI, in ether units. A vote BURNS from this balance, so it is
  /// the ceiling on what can be voted.
  balance: string;
  /// Current ERC-20 allowance to the HUB, in ether units. One allowance serves
  /// both the stream-creation fee and vote burns — same spender — so approving
  /// for one moves the other's state too.
  hubAllowance: string;
}


/**
 * Spend SATORI in ONE transaction wherever the wallet can sign for it.
 *
 * The hub's `...WithPermit` entry points take a signed authorization and consume
 * it inside the same call, so the approval stops being a separate transaction.
 * Signing is free and off-chain, so this removes a wallet confirmation AND a gas
 * payment, not just a click.
 *
 * `signPermit` returns null when it cannot produce a signature the token will
 * accept — no permit surface, an unrecognised EIP-712 domain, a wallet that
 * refuses typed data. In that case we send the plain call and the caller's
 * existing allowance carries it, which is the behaviour that was here before.
 * The permit path is an optimisation, never a requirement.
 *
 * SATORI takes an arbitrary-length signature (its ERC-1271 overload), so this
 * works for Safes and passkey accounts as well as ordinary wallets.
 */
async function signSatoriPermit(contracts: any, owner: string | null | undefined, value: bigint) {
  if (!owner || value <= BigInt(0)) return null;
  const [tokenAddress, spender] = await Promise.all([
    contracts.reads.token.getAddress(),
    contracts.hub.getAddress(),
  ]);
  return signPermit({
    tokenAddress,
    reader: contracts.reads.token.runner,
    signer: (contracts.satori as any).runner,
    owner,
    spender,
    value,
  });
}

/// Read-only probe: can SATORI be authorized by signature on this chain? No
/// wallet interaction, so it is safe to run on every load. Used to decide whether
/// the UI still needs to offer an approve button at all.
async function satoriPermitAvailable(contracts: any): Promise<boolean> {
  try {
    const tokenAddress = await contracts.reads.token.getAddress();
    const erc20 = new ethers.Contract(tokenAddress, [
      'function DOMAIN_SEPARATOR() view returns (bytes32)',
      'function name() view returns (string)',
      'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
    ], contracts.reads.token.runner);
    const net = await (contracts.reads.token.runner as ethers.Provider).getNetwork();
    return (await resolvePermitDomain(erc20, net.chainId, tokenAddress)) !== null;
  } catch {
    return false;
  }
}

async function voteOrPermitVote(contracts: any, address: string | null | undefined, gameId: number, wei: bigint) {
  const permit = await signSatoriPermit(contracts, address, wei);
  if (permit) {
    return contracts.hub.voteWithPermit(gameId, wei, satoriPermitArg(permit));
  }
  return sendPreflighted(contracts.reads.satori, contracts.satori, 'vote', [gameId, wei], address);
}

/// `active` gates the initial data load: App's instance passes the current
/// tab so boot doesn't spend RPC budget on Vote-tab data nobody is looking
/// at. Defaults true for in-tab callers (VotePanel), whose mount IS the
/// signal. Once loaded, leaving the tab keeps the data — only the first
/// fetch is deferred.
export function useVoting(active: boolean = true) {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const { sendOrRelay } = useGasless();
  const { resolveGameId } = useGames();
  const [data, setData] = useState<VotingData | null>(null);
  const [loading, setLoading] = useState(true);

  // Action states
  const [voting, setVoting] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!contracts || !address) return;
    setLoading(true);

    try {
      const canSign = await satoriPermitAvailable(contracts);
      const [fee, canCreate, lockedUntil, allowance, balance] = await Promise.all([
        getStreamBurn(),
        // CAP_CREATE_STREAM = 0 (SatoriHub.sol). Read per-address because
        // capabilityAllowed returns true for the admin whatever the flag says.
        contracts.cached.live.rewards.capabilityAllowed(0, address),
        contracts.cached.live.token.transferLockedUntil(address),
        contracts.cached.live.token.allowance(address, await contracts.hub.getAddress()),
        contracts.cached.live.token.balanceOf(address),
      ]);

      setData({
        streamCreationFee: ethers.formatEther(fee),
        canCreateStream: Boolean(canCreate),
        tokenLockedUntilRound: Number(lockedUntil),
        // The round comes from the clock, not the chain — see lib/round.ts.
        tokensLocked: Number(lockedUntil) !== 0
          && Number(lockedUntil) >= Number(await getCurrentRound()),
        needsStreamApproval: !canSign && (allowance as bigint) < (fee as bigint),
        canSignPermit: canSign,
        balance: ethers.formatEther(balance as bigint),
        hubAllowance: ethers.formatEther(allowance as bigint),
      });
    } catch (e) {
      console.error('Voting data load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [contracts, address]);

  useEffect(() => { if (active) load(); }, [load, active]);

  /// Parse an ether-denominated amount string to wei, rejecting the shapes that
  /// would otherwise reach the contract as a confusing revert.
  const parseVoteAmount = (amount: string): bigint => {
    const trimmed = (amount ?? '').trim();
    if (trimmed === '') throw new Error('Enter how much SATORI to burn');
    let wei: bigint;
    try {
      wei = ethers.parseEther(trimmed);
    } catch {
      throw new Error(`"${trimmed}" is not a valid SATORI amount`);
    }
    if (wei <= BigInt(0)) throw new Error('Amount must be greater than zero');
    return wei;
  };

  /// Approve the hub to take `amount` SATORI for a vote.
  ///
  /// SEPARATE USER ACTION, never chained onto the vote itself — the same rule
  /// approveForStream documents. Requesting a signature deep-links to the wallet
  /// app, which unloads the page; the user signs, comes back to a RELOADED page,
  /// and any JS that was going to send a second transaction no longer exists.
  ///
  /// Approves EXACTLY the amount, unlike the stream fee's `fee * 2`. A vote burns
  /// whatever it is allowed to take, and the amount is user-chosen rather than a
  /// fixed protocol fee, so leaving spare allowance on someone's whole balance is
  /// not a convenience worth offering.
  const approveForVote = useCallback(async (amount: string): Promise<boolean> => {
    if (!contracts || !address) return false;
    setVoting(true);
    setVoteError(null);
    try {
      const wei = parseVoteAmount(amount);
      const hubAddr = await contracts.hub.getAddress();
      await afterTx(await contracts.token.approve(hubAddr, wei));
      await load();
      return true;
    } catch (e: any) {
      setVoteError(explainError(e));
      return false;
    } finally {
      setVoting(false);
    }
  }, [contracts, address, load]);

  // Voting is game-keyed: `satori.vote(uint32 gameId, uint256 amount)`. The UI
  // stays stream-primary (1:1 stream<->game), so callers pass a `streamId` and we
  // resolve it to its binary gameId via the useGames bridge first.
  //
  // `amount` is SATORI to BURN. It is destroyed — no escrow, no refund, and no
  // way to move or revoke the weight afterwards — which is why the UI asks for it
  // explicitly rather than spending a default. The hub takes it with
  // `token.burnFrom`, so the allowance above must already cover it.
  const vote = useCallback(async (streamId: number, amount: string): Promise<boolean> => {
    if (!contracts) return false;
    setVoting(true);
    setVoteError(null);
    try {
      const wei = parseVoteAmount(amount);
      const gameId = await resolveGameId(streamId);
      if (!gameId) throw new Error(`Stream #${streamId} has no game to vote on yet`);
      // Simulate on the READ path so a revert arrives as its reason rather than as
      // "invalid BigNumberish value" — see sendPreflighted. The reverts voting can hit
      // (an unapproved game, an unknown game, a missing allowance) all have
      // copy waiting in explainError; they just never reached it.
      const tx = await sendOrRelay(
        { kind: 'vote', gameId, amountWei: wei },
        () => voteOrPermitVote(contracts, address, gameId, wei),
      );
      await afterTx(tx);
      await load();
      return true;
    } catch (e: any) {
      setVoteError(explainError(e));
      return false;
    } finally {
      setVoting(false);
    }
  }, [contracts, resolveGameId, load, address, sendOrRelay]);

  // clearVote is GONE. A vote BURNS SATORI — the tokens are destroyed and the
  // weight is permanent — so there is nothing to return and no entrypoint to
  // return it with. SatoriVoting's entire vote surface is one function: vote().

  // Game-direct sibling of `vote(streamId, amount)`: the caller already holds the
  // gameId (e.g. a games-per-stream list), so we skip the streamId->gameId
  // resolution step and call the hub directly. Same amount semantics — SATORI
  // burned — and the same busy-state, error handling and post-vote reload.
  const voteGame = useCallback(async (gameId: number, amount: string): Promise<boolean> => {
    if (!contracts) return false;
    setVoting(true);
    setVoteError(null);
    try {
      const wei = parseVoteAmount(amount);
      if (!gameId) throw new Error('No game to vote on');
      const tx = await sendOrRelay(
        { kind: 'vote', gameId, amountWei: wei },
        () => voteOrPermitVote(contracts, address, gameId, wei),
      );
      await afterTx(tx);
      await load();
      return true;
    } catch (e: any) {
      setVoteError(explainError(e));
      return false;
    } finally {
      setVoting(false);
    }
  }, [contracts, load, address, sendOrRelay]);

  /// Re-point the caller's own recorded burns from an UNAPPROVED game onto a
  /// live one. HUBLESS — `moveVotes` lives on the voting contract itself, with
  /// no hub forwarder — and burns nothing: the SATORI was destroyed at vote
  /// time, this only moves the weight it bought. The contract enforces that
  /// `fromGame` is currently unapproved, `toGame` is live, and `amount` is at
  /// most `voterGameWeight(caller, fromGame)`.
  const moveVotes = useCallback(async (fromGame: number, toGame: number, amountWei: bigint): Promise<boolean> => {
    if (!contracts) return false;
    setVoting(true);
    setVoteError(null);
    try {
      if (!fromGame || !toGame) throw new Error('Pick a source and a destination game');
      if (amountWei <= BigInt(0)) throw new Error('Amount must be greater than zero');
      // Read-path simulation first, so a revert (source still approved, more
      // than you burned, frozen this round...) arrives as its reason.
      const tx = await sendPreflighted(
        contracts.reads.voting, contracts.voting,
        'moveVotes', [fromGame, toGame, amountWei], address,
      );
      // afterTx drops every cached read that could have changed (the same
      // blunt `voting.`-touching invalidation a vote gets), and load()
      // refreshes this hook's own snapshot.
      await afterTx(tx);
      await load();
      return true;
    } catch (e: any) {
      setVoteError(explainError(e));
      return false;
    } finally {
      setVoting(false);
    }
  }, [contracts, load, address]);

  /// The caller-facing half of the moveVotes ledger: how much weight `voter`'s
  /// own burns put on `game` (and so the most they could move off it while it
  /// is unapproved). Read-only; 0 on failure or missing args.
  const voterGameWeight = useCallback(async (voter: string, gameId: number): Promise<bigint> => {
    if (!contracts || !voter || !gameId) return BigInt(0);
    try {
      return BigInt(await contracts.cached.live.voting.voterGameWeight(voter, gameId));
    } catch (e) {
      console.warn('voterGameWeight read failed:', e);
      return BigInt(0);
    }
  }, [contracts]);

  /// Approve the hub to take the stream-creation burn. Its OWN transaction and
  /// its own button press, because on mobile a signature request unloads the page
  /// and whatever came after it in the same function never runs.
  ///
  /// Approves TWICE the fee. `streamBurn` grows with rounds elapsed since
  /// deployment, so an exact approval is stale within a round — that happened:
  /// the allowance read back exactly equal to the fee, the fee had already
  /// risen, and a second approval was demanded. 2x absorbs normal drift while
  /// staying bounded, unlike the usual unlimited grant on the token holding the
  /// user's whole balance.
  const approveForStream = useCallback(async () => {
    if (!contracts || !address) return;
    setCreating(true);
    setCreateError(null);
    try {
      const hubAddr = await contracts.hub.getAddress();
      const fee = await contracts.reads.lens.streamBurn();
      await afterTx(await contracts.token.approve(hubAddr, fee * BigInt(2)));
      await load();
    } catch (e: any) {
      setCreateError(explainError(e));
    } finally {
      setCreating(false);
    }
  }, [contracts, address, load]);

  const createStream = useCallback(async (args: CreateStreamArgs) => {
    if (!contracts || !address) return;
    const { name, kind, target, minCadenceMinutes, maxFeedAge } = args;
    setCreating(true);
    setCreateError(null);
    try {
      // DEFAULT IS DAILY: 1440 minutes, exactly what the hub's no-cadence
      // overloads stamp. The registry's only cadence rule is its 60-minute
      // grid floor (InvalidCadence below that) — there is no admin-only tier.
      let cadence = minCadenceMinutes && minCadenceMinutes > 0 ? minCadenceMinutes : 1440;
      let explicit = minCadenceMinutes !== undefined && minCadenceMinutes !== 1440;

      // Creating a stream BURNS SATORI, and the hub takes it with
      // `token.transferFrom(msg.sender, hub, fee)` (SatoriHub._chargeStream).
      // That needs an ERC-20 allowance, which nothing had ever asked for — so
      // the transaction reverted inside transferFrom, the node answered
      // estimateGas with null, and the user got "invalid BigNumberish value".
      //
      // Approve exactly what is needed rather than the usual unlimited: the fee
      // is small, it is a one-off, and an infinite approval on the token that
      // holds someone's whole balance is not worth saving one transaction.
      // NO APPROVAL HERE. It is a separate user action — see approveForStream.
      //
      // This function used to approve and then create in one press, and on
      // mobile that can never work. Requesting a signature deep-links to the
      // wallet app, which UNLOADS the page; the user signs, returns to a
      // RELOADED page, and the JavaScript that was going to send the create no
      // longer exists. It does not fail — it ceases to be. Observed exactly
      // that: one signature, no error anywhere, allowance set, no stream, and
      // the reporter telling me twice that the whole page went blank while I
      // read it as a scroll reset.
      //
      // So: never chain two transactions across a wallet round trip. The form
      // asks for the approval as its own press, and this only ever sends one
      // transaction.
      const hubAddr = await contracts.hub.getAddress();
      // A NAMED stream burns nothing (SatoriHub.createAdapterDataStream skips
      // _chargeStream for the named adapter), so no permit and no allowance.
      const fee = kind === 'named' ? BigInt(0) : await contracts.reads.lens.streamBurn();

      // Resolved BEFORE the fee signature: an unwired chain (adapter id 0) must
      // fail here, not after the user has signed a permit that is then thrown
      // away. A read error propagates as the network error it is — mapping it
      // to 0 would misreport it as "not enabled". The generic 'adapter' kind is
      // refused the same id: its user-typed config can never satisfy the
      // named adapter (StreamIdMismatch/InvalidProvider), and the picker's
      // filter alone depends on an async read landing first.
      const namedAdapterId = kind === 'named' || kind === 'adapter'
        ? await getNamedAdapterId(contracts.reads)
        : 0;
      if (kind === 'named') requireNamedAdapterId(namedAdapterId);
      if (kind === 'adapter' && namedAdapterId && args.adapterId === namedAdapterId) {
        throw new Error('Use the Sentiment stream type for this adapter.');
      }
      const engine = kind === 'named' ? await contracts.engine.getAddress() : '';

      // Sign the fee rather than pre-approving it, so creating a stream is ONE
      // press. Approve twice the fee's worth: `streamBurn` grows with rounds
      // elapsed, and an exact authorization can be stale by the time it lands —
      // the same drift `approveForStream` compensates for.
      const feePermit = fee > BigInt(0)
        ? await signSatoriPermit(contracts, address, fee * BigInt(2))
        : null;

      if (fee > BigInt(0) && !feePermit) {
        // No signature available (a wallet that will not sign typed data, or a
        // token whose domain we could not confirm). Fall back to requiring the
        // allowance, exactly as before.
        const allowance = await contracts.reads.token.allowance(address, hubAddr);
        if (allowance < fee) {
          throw new Error(
            'Approve SATORI first. The button above does it in one transaction. ' +
            'Creating a stream burns SATORI, so the hub needs permission to take the fee.',
          );
        }
      }

      const abi = ethers.AbiCoder.defaultAbiCoder();
      const permitArg = satoriPermitArg(feePermit);
      let tx;

      if (kind === 'simple') {
        // The no-cadence overload is just cadence 1440, which the permit
        // variant takes explicitly — so both branches collapse to one call
        // when signing.
        tx = feePermit
          ? await contracts.hub.createSimpleDataStreamWithPermit(name, address, cadence, permitArg)
          : explicit
            ? await contracts.satori['createSimpleDataStream(string,address,uint24)'](name, address, cadence)
            : await contracts.satori['createSimpleDataStream(string,address)'](name, address);
      } else {
        // Adapter-type stream: pick adapter ID + encode config per kind.
        let adapterId: number;
        let config: string;
        let provider = target ?? '';
        if (kind === 'named') {
          // Cadence 60 is forced and `explicit` set, so the 4-arg (1440)
          // overload below is never reached — it reverts for this adapter.
          const named = namedStreamCreateArgs(namedAdapterId, engine);
          ({ adapterId, config, target: provider, cadence } = named);
          explicit = true;
        } else if (!ethers.isAddress(provider)) {
          throw new Error(`Invalid ${kind} target address`);
        } else if (kind === 'chainlink') {
          adapterId = ADAPTER_ID_CHAINLINK;
          config = abi.encode(['uint64'], [maxFeedAge ?? 3600]); // 1h default
        } else if (kind === 'uniswap') {
          adapterId = ADAPTER_ID_UNISWAP;
          config = '0x';
        } else if (kind === 'custom') {
          adapterId = ADAPTER_ID_CUSTOM;
          config = '0x';
        } else if (kind === 'adapter') {
          // Generic path: target an ARBITRARY registered adapter by its
          // registry ID (e.g. community adapters with ID>3). The caller
          // supplies the raw config bytes the adapter expects (default '0x').
          if (!args.adapterId || args.adapterId <= 0) {
            throw new Error('adapterId is required for kind="adapter" and must be a positive registry ID');
          }
          adapterId = args.adapterId;
          config = args.configHex ?? '0x';
        } else {
          throw new Error('Unknown stream kind');
        }

        // The mid-signature `address` is the adapter `provider` (the feed /
        // pool / authority the adapter reads from). There is NO overload with a
        // trailing address, so we pass `target` as that provider param and drop
        // the old trailing-address arg. Cadence-aware uses the 5-arg overload;
        // default cadence uses the 4-arg one.
        // Simulate on the READ path first, so a create that cannot succeed says
        // why instead of costing a signature. See preflight().
        if (feePermit) {
          // The no-cadence overload is just cadence 1440, which the permit
          // variant takes explicitly — so both plain branches collapse to one call.
          tx = await contracts.hub.createAdapterDataStreamWithPermit(
            name, adapterId, provider, config, cadence, permitArg,
          );
        } else if (explicit) {
          const SIG = 'createAdapterDataStream(string,uint32,address,bytes,uint24)';
          await preflight((contracts.reads.satori as any)[SIG], address, name, adapterId, provider, config, cadence);
          tx = await (contracts.satori as any)[SIG](name, adapterId, provider, config, cadence);
        } else {
          const SIG = 'createAdapterDataStream(string,uint32,address,bytes)';
          await preflight((contracts.reads.satori as any)[SIG], address, name, adapterId, provider, config);
          tx = await (contracts.satori as any)[SIG](name, adapterId, provider, config);
        }
      }

      await afterTx(tx);
      await load();
    } catch (e: any) {
      // TEMPORARY DIAGNOSTIC (2026-08-05). "invalid BigNumberish value" is
      // thrown by ethers while ENCODING, names no argument, and three passes
      // over this code found nothing undefined on the uniswap path. So show the
      // values that were actually passed — the message is the only channel that
      // reaches a phone. Remove once the cause is known.
      setCreateError(explainError(e));
    } finally {
      setCreating(false);
    }
  }, [contracts, address, load]);

  // setVoteDelegation is GONE. Delegation OF VOTES does not exist under burn
  // voting — the hub has only delegateClaimAbility and delegatePredictionPower,
  // both of which are alive and untouched (see DelegationTab).

  return {
    data,
    loading,
    reload: load,
    vote,
    voteGame,
    moveVotes,
    voterGameWeight,
    approveForVote,
    voting,
    voteError,
    createStream,
    approveForStream,
    creating,
    createError,
  };
}
