import { Interface } from 'ethers';
import TokenAbi from '../contracts/SatoriToken.json';
import EngineAbi from '../contracts/SatoriEngine.json';
import HubAbi from '../contracts/SatoriHub.json';
import RewardsAbi from '../contracts/SatoriRewards.json';
import RegistryAbi from '../contracts/SatoriRegistry.json';
import VotingAbi from '../contracts/SatoriVoting.json';
import GamesAbi from '../contracts/SatoriGames.json';
import BountiesAbi from '../contracts/SatoriBounties.json';
import AirdropAbi from '../contracts/SatoriAirdrop.json';
import YesNoGameAbi from '../contracts/YesNoGame.json';
// Stream adapters: their reverts (Stale, ValueOverflow, ...) bubble raw through
// registry.updateValue, so their error fragments must be in the decoder too.
import ChainlinkAdapterAbi from '../contracts/ChainlinkV3Adapter.json';
import UniswapAdapterAbi from '../contracts/UniswapV3Adapter.json';
import CustomAdapterAbi from '../contracts/CustomAdapter.json';
import CoinedAdapterAbi from '../contracts/CoinedAdapter.json';
import NamedAdapterAbi from '../contracts/NamedStreamAdapter.json';

/// Map ABI-decoded custom-error names from the Satori contracts to short
/// human copy. The error may bubble up from ANY contract (a write through the
/// core can revert inside a child), and ethers often can't decode it itself:
/// on an `estimateGas` revert it uses its *generic* ABI coder (which only knows
/// built-in Error/Panic) and reports "unknown custom error" with `revert=null`,
/// even though the 4-byte selector is sitting in `e.data`. So we decode that
/// raw selector ourselves against EVERY contract's error ABI and map the name.
///
/// Anything we can identify but don't have friendly copy for is shown as
/// `Contract error: <Name>(args)` — never a misleading "unknown" — so a user can
/// always tell you exactly what the contract rejected.

const COPY: Record<string, string> = {
  // ---- SatoriToken / SatoriEngine / SatoriHub (split core) ----
  AlreadyInitialized:  'Already initialized.',
  AlreadyPredicted:    'You already predicted in this round. Wait for the next round.',
  AlreadyRenounced:    'This control has already been renounced.',
  BadDirection:        'Direction must be UP or DOWN.',
  BadIndex:            'Invalid prediction index.',
  BadRegistryAddress:  'Bad registry address.',
  BadRewardsAddress:   'Bad rewards address.',
  BadVotingAddress:    'Bad voting address.',
  // Shared by the token's rewardMint and airdropMint.
  BudgetExceeded:      'The mint would exceed its cap: the reward budget, or the airdrop\'s 1,200,000 SATORI ceiling.',
  DelegateActive:      'Your current delegate has already predicted this round. Wait for the next round.',
  Delegated:           'Your prediction power is delegated. Undelegate first to predict yourself.',
  DuplicatePrediction: 'You already predicted on this stream this round, or within the last 24 hours on a named stream.',
  EmptyBatch:          'Batch is empty.',
  EmptyStream:         'Stream has no values yet. Wait for its first update.',
  FeeTooHigh:          'Fee exceeds the cap (1440 SATORI).',
  Locked:              'Your tokens are locked. Wait for the lock window to clear.',
  HookFailedWithoutReason: 'The transfer ran out of gas while updating a delegation. Try again with a higher gas limit.',
  MintIsPaused:        'SATORI mint is paused. Try again after the pause expires.',
  NotChild:            'Only child contracts can call this.',
  NotRewards:          'Only the rewards contract can call this.',
  PauseRenounced:      'Pause control has been renounced. The pause cannot be re-enabled.',
  PauseTooLong:        'Pause duration is out of range (1 second to 14 days).',
  Renounced:           'This control has been renounced.',
  StaleValue:          'Stream value has not updated since your last prediction.',
  UnknownStream:       'Stream does not exist.',
  Unauthorized:        'You are not authorized to do this.',

  // ---- SatoriRegistry.sol ----
  CadenceRoundsNotElapsed:  'This stream has already been updated for this period. Its cadence (in minutes) allows one update per period. Wait for the next round.',
  CoreAlreadyInitialized:   'Core already initialized.',
  InvalidAuthority:         'Invalid authority address.',
  InvalidCoreAddress:       'Invalid core address.',
  InvalidStreamId:          'Invalid stream id.',
  // Shared selector: SatoriGames throws this for a bad game target, and
  // CustomAdapter for a bad data-source address. Both decode to the same
  // 4-byte name; the games meaning is the one reachable from the dapp.
  InvalidTarget:            'Invalid game target. An explicit target must be at least one round (1440 minutes) and no shorter than the stream\'s cadence.',
  CadenceGapNotElapsed:     'This stream was updated too recently. Its cadence gap (in minutes since the last update) has not fully elapsed. Try again shortly.',
  InvalidCadence:           'Cadence must be at least 60 minutes.',
  InvalidProvider:          'Invalid provider address.',
  NotPullStream:            'Stream is not a pull stream.',
  NotSimpleStream:          'Stream is not a simple stream.',
  NotStreamAuthority:       'Only the stream authority can call this.',
  NotStreamProvider:        'Only the stream\'s provider can do this.',
  OnlyDeployer:             'Only the deployer can call this.',
  OnlySatoriCore:           'Only the core contract can call this.',
  AdapterStreamImmutable:   'Adapter streams cannot be renamed or transferred.',
  UnknownAdapter:           'That adapter is not registered.',
  NonMonotonicRound:        'Stream values must be written in increasing round order.',

  // ---- Stream adapters (Chainlink / Uniswap / Custom) ----
  // Thrown inside the adapter during registry.updateValue and bubbled raw.
  ValueOverflow:            'Oracle value out of range.',
  Stale:                    'The oracle feed is stale. Retry after it updates.',
  RoundNotComplete:         'The oracle round is not complete yet. Try again shortly.',
  CarriedForward:           'The oracle answer is not fresh (carried forward). Retry after the feed updates.',
  InvalidFeed:              'Invalid Chainlink feed address.',
  MaxFeedAgeOutOfRange:     'Max feed age is outside the allowed range.',
  // (InvalidTarget — CustomAdapter's bad-data-source error — is already mapped
  // above; custom errors decode by selector, so one entry covers both.)
  InvalidPool:              'Invalid Uniswap pool address.',
  PoolNotReady:             'The Uniswap pool has no price observations yet.',
  BadFeeTier:               'Unsupported Uniswap fee tier.',
  PoolTooYoung:             'The Uniswap pool is too young for a reliable TWAP. Try again later.',
  // CoinedAdapter (ValueOverflow / InvalidTarget above are shared by selector).
  UnknownTerm:              'That Coined term does not exist.',
  // Named streams: NameTaken and NamedStreamConfig are the registry's; the other
  // two are NamedStreamAdapter's (its InvalidProvider shares the registry's selector).
  NameTaken:                'That name is already a named stream.',
  NamedStreamConfig:        'A named stream takes no config; the registry sets it.',
  StreamIdMismatch:         'Another stream was created first — try again.',
  NotWired:                 'Named streams are not enabled on this chain yet.',
  // Coined's errors, carried by NamedStreamAdapter's ICoinedErrors fragment --
  // extend that fragment when Coined adds a text error, or the dapp cannot name it.
  EmptyName:                'Names can\'t be empty.',
  BadName:                  'That name has characters Coined doesn\'t allow (control or invisible characters), or starts or ends with a space.',
  MixedScript:              'A name must use one writing system.',

  // ---- SatoriVoting.sol ----
  CoreAlreadySet:        'Voting core already set.',
  // Vote bounties
  BountyAlreadyActive:   'You already have an active vote bounty. Cancel it before creating a new one.',
  BountyExhausted:       'This vote bounty has no remaining capacity.',
  ZeroPayment:           'Your balance is too small for this bounty to pay anything. A larger lender can accept it instead.',
  AlreadyDelegated:      'You are already delegated to this borrower. Accepting again would pay you for power they already have. Undelegate first.',
  SelfAccept:            'You cannot accept your own bounty. Use cancel to reclaim your escrow.',
  LockstepBroken:        'Voting heap invariant violated.',
  MaxBelowOne:           'maxEligibleStreams must be ≥ 1.',
  NonPositiveHeapWeight: 'Heap weight must be positive.',
  // Game approval and vote-weight rules (gameApproved replaced gameDisabled).
  UnknownGame:            'Game does not exist.',
  GameNotApproved:        'This game is not approved for voting. Burning for an unapproved game would destroy your tokens for nothing.',
  ZeroVote:               'Vote amount must be greater than zero.',
  CannotSetDefaultApproval: 'The default game\'s approval cannot be set — it is the protocol\'s own game and is live by construction.',
  CannotVoteDefault:      'You cannot vote on the default game. Its weight is derived, not bought.',
  GameNotMintEligible:    'Only the built-in binary game earns SATORI from the mint, so a vote on this game type would buy nothing.',
  SourceStillApproved:    'Votes can only be moved off a game whose approval has been revoked. This game is still approved.',
  InsufficientVoterWeight: 'You are trying to move more vote weight than you have burned on this game.',
  SourceFrozenThisRound:  'This game\'s weight is already frozen into the current round. Move votes after the round ends.',
  RoundNotFinal:          'This round has not ended yet. Try again after it closes.',

  // ---- SatoriGames.sol ----
  GameCadenceTooShort:      'Adapter games need a stream cadence of at least two rounds. Only the built-in binary game supports faster streams.',
  DuplicateBinaryGame:      'A binary game with this target already exists on this stream.',

  // ---- SatoriRewards.sol / SatoriBounties.sol (some entries are monolith-legacy) ----
  BadAmount:                 'Amount must be greater than zero.',
  BadInput:                  'Invalid input.',
  BadRecipient:              'Recipient address is invalid.',
  BadToken:                  'Token address is invalid.',
  ClaimDelegatedAway:        'Your claim ability is delegated. The delegate must claim for you.',
  ClaimUndelegationCooldown: 'Claim-delegation cooldown is still active.',
  InsufficientStake:         'Unstake amount exceeds your current stake.',
  NamedGame:                 'Named games take no bounties.',
  NoPendingPrediction:       'No pending prediction to finalize.',
  NotClaimDelegate:          'You are not the claim delegate for this address.',
  NotDrained:                'Bounty pool still has funds or an active rate.',
  RateBelowFloor:            'Proposed per-day rate is below the floor (must be ≥ 10% of the current rate).',
  RateTooHigh:               'Proposed per-day rate exceeds the deposit amount.',
  TokenNotFunded:            'This token has never been funded on this stream (or was already cleaned).',
  UnstakeLockedByPending:    'Stake is locked by pending predictions. Wait for them to finalize.',
  ZeroReceived:              'Token transfer returned zero (fee-on-transfer rejection).',

  // ---- split-core additions (SatoriToken / SatoriEngine / SatoriHub) ----
  AlreadySet:               'This one-time setting has already been configured.',
  AirdropNotSet:            'The token has no airdrop contract set, so there is nothing to freeze.',
  Frozen:                   'This setting is frozen for good and can no longer be changed.',

  // ---- SatoriAirdrop.sol ----
  NothingToClaim:           'Nothing to claim: nothing is owed to this address, or it has already been claimed.',
  DuplicateRecipient:       'One of these addresses already has an allocation. Allocations are written once.',
  LengthMismatch:           'Addresses and amounts do not line up.',
  AirdropLoadingClosed:     'The airdrop table is closed (frozen or finalized): nothing more can be loaded.',
  ClaimsNotOpen:            'Airdrop claims are not open yet. They open when the airdrop is finalized.',
  AirdropNotFrozen:         'The token\'s airdrop door must be frozen to this airdrop before it can be finalized.',
  BountyParamsInvalid:      'Bounty parameters are invalid.',
  ControllerNotSet:         'The token controller is not wired yet. Try again after setup completes.',
  CrosschainLimit:          'That would mint more SATORI on the home chain than has actually been bridged out of it.',
  DefaultStreamNotFirst:    'The default stream must be initialized before this action.',
  MultiplierOverflow:       'Streak multiplier is out of range.',
  NotHomeChain:             'This action only exists on the home chain. Remote deployments hold bridged SATORI and nothing else.',
  Reentrancy:               'Reentrant call blocked. Retry the transaction.',
  TotalPowerOverflow:       'Total prediction power is out of range.',
  VoteLocked:               'Your vote is locked. Wait for the lock window to clear.',
  // ERC20 / ERC-2612 permit (OpenZeppelin) — the user-facing ones.
  ERC20InsufficientBalance:  'You do not have enough SATORI for this.',
  ERC20InsufficientAllowance:'Token allowance is too low. Re-approve and retry.',
  CapabilityDisabled:  'That action is switched off on this deployment. Capabilities are enabled one at a time by the admin; this one is not on yet.',
  ERC20InvalidReceiver:      'Invalid recipient address.',
  ERC20InvalidSpender:       'Invalid spender address.',
  ERC2612ExpiredSignature:   'The permit signature has expired. Sign a new one.',
  ERC2612InvalidSigner:      'The permit signature is invalid.',
};

// One Interface holding every custom-error fragment from every Satori contract,
// so we can decode a 4-byte selector no matter which contract threw it.
const ERROR_IFACE: Interface | null = (() => {
  try {
    const frags: any[] = [];
    for (const mod of [TokenAbi, EngineAbi, HubAbi, RewardsAbi, RegistryAbi, VotingAbi, GamesAbi, BountiesAbi, AirdropAbi, YesNoGameAbi, ChainlinkAdapterAbi, UniswapAdapterAbi, CustomAdapterAbi, CoinedAdapterAbi, NamedAdapterAbi]) {
      const abi = (mod as any).abi ?? mod;
      for (const f of abi) if (f && f.type === 'error') frags.push(f);
    }
    return new Interface(frags);
  } catch {
    return null;
  }
})();

/// Pull the raw revert bytes (4-byte selector + any args) out of whichever
/// field this provider stashed them in, then decode against every contract's
/// errors. Returns the decoded { name, args } or null.
function decodeContractError(e: any): { name: string; args: any[] } | null {
  // ethers managed to decode it itself (read calls / sends usually do).
  const revertName = e?.revert?.name;
  if (typeof revertName === 'string') {
    return { name: revertName, args: e?.revert?.args ? Array.from(e.revert.args) : [] };
  }
  // Otherwise find the raw data and decode it ourselves.
  const data = [e?.data, e?.info?.error?.data, e?.error?.data, e?.error?.error?.data]
    .find((d) => typeof d === 'string' && d.startsWith('0x') && d.length >= 10);
  if (data && ERROR_IFACE) {
    try {
      const parsed = ERROR_IFACE.parseError(data);
      if (parsed) return { name: parsed.name, args: Array.from(parsed.args) };
    } catch {
      // selector isn't one of ours (e.g. a built-in Error/Panic) — fall through.
    }
  }
  return null;
}

/// Per-setter copy for errors whose shared COPY entry is too generic to act on.
export const EMISSION_RATIO_COPY: Record<string, string> = {
  BadInput: 'The multiplier must be between 0 and 18.446744073709551615.',
  Unauthorized: 'Only the emission holder can set the emission multiplier.',
};

/// Turn any thrown error into a short human message. Decodes contract custom
/// errors (from any Satori contract) to friendly copy; identified-but-unmapped
/// errors are shown by name; everything else falls back to the raw reason.
/// `copy` overrides COPY for the call that knows which setter reverted.
export function explainError(e: any, copy: Record<string, string> = {}): string {
  if (!e) return 'Transaction failed';

  const decoded = decodeContractError(e);
  if (decoded) {
    // Always log the precise contract error so it's visible in the console even
    // when the on-screen copy is friendly.
    try { console.warn('[satori] contract reverted:', decoded.name, ...decoded.args); } catch { /* noop */ }
    if (copy[decoded.name]) return copy[decoded.name];
    if (COPY[decoded.name]) return COPY[decoded.name];
    const argStr = decoded.args.length ? ` (${decoded.args.map(String).join(', ')})` : '';
    return `Contract error: ${decoded.name}${argStr}`;
  }

  // Last-ditch: some providers embed the error NAME in the message string.
  const haystacks = [e?.shortMessage, e?.message, e?.reason]
    .filter((s): s is string => typeof s === 'string');
  const merged = { ...COPY, ...copy };
  for (const h of haystacks) {
    for (const name of Object.keys(merged)) {
      const re = new RegExp(`(?:^|[^A-Za-z0-9])${name}(?:[^A-Za-z0-9]|$)`);
      if (re.test(h)) return merged[name];
    }
  }

  // A NULL gas estimate reached us undecoded, which means the transaction WOULD
  // revert but we never got the reason. Saying that plainly is the whole job here:
  // the raw ethers text (invalid BigNumberish value, argument="%response") reads as
  // a type bug in the dapp and sends everyone hunting through argument passing.
  // Handlers that call preflight() get the precise reason; this is the net under
  // the ones that do not.
  if (isNullGasEstimate(e)) {
    return 'The network rejected this transaction before sending it, without saying why. '
      + 'Usually that means it is not allowed right now: already done this round, a '
      + 'cadence window still open, a missing approval, or a capability switched off.';
  }

  // Common non-custom paths that still benefit from a friendly translation.
  const msg = (e?.shortMessage || e?.reason || e?.message || '').toString();
  if (/user rejected|user denied/i.test(msg)) return 'You rejected the transaction in your wallet.';
  if (/insufficient funds/i.test(msg)) return 'Insufficient gas balance in your wallet.';
  if (/insufficient allowance/i.test(msg)) return 'Token allowance is too low. Re-approve and retry.';
  if (/nonce/i.test(msg)) return 'Wallet nonce mismatch. Reset your wallet activity or wait a moment.';

  return msg || 'Transaction failed';
}

/// Did ethers fail because a gas estimate came back NULL?
///
/// This is the single most misleading error the app can produce. When a
/// transaction would revert, some nodes answer `eth_estimateGas` with `null`
/// rather than an error. Ethers then tries to turn that null into a number and
/// throws:
///
///   invalid BigNumberish value (argument="%response", value=null,
///                               code=INVALID_ARGUMENT)
///
/// Nothing in that mentions a revert, a permission, or an allowance. It reads as
/// a type bug in the dapp, and it cost four passes over correct argument-passing
/// code to work out that the real cause was `CapabilityDisabled` (2026-08-05).
///
/// The `%response` argument name is the tell: ethers only uses it for a value
/// that came back from the NODE, never for one the caller supplied.
export function isNullGasEstimate(e: any): boolean {
  return e?.code === 'INVALID_ARGUMENT' && e?.argument === '%response';
}

/// Simulate a call on the READ path before sending it.
///
/// Replaces an earlier attempt that sent first and re-ran the failure as a
/// staticCall to recover the reason. That did not work, and the reason is worth
/// keeping: it re-simulated through the SAME provider whose gas estimate had
/// just come back null — the wallet relay — so the eth_call returned null too,
/// ethers called getBytes(null), and the user got "invalid BytesLike value"
/// instead of "invalid BigNumberish value". A different confusing message for
/// the same missing information.
///
/// Two changes fix it. Simulate on the resilient READ provider, which answers
/// properly and is the one every other read in the app already trusts. And do it
/// BEFORE sending, so a transaction that cannot succeed never costs a signature
/// — which is what actually happened twice while chasing this.
///
/// `from` matters: a provider-bound staticCall has no sender, so msg.sender
/// would be the zero address and every caller-dependent check (capability gates,
/// allowances, ownership) would test the wrong account.
export async function preflight(
  simulate: { staticCall: (...a: any[]) => Promise<unknown> } | undefined,
  from: string,
  ...args: any[]
): Promise<void> {
  if (!simulate?.staticCall) return; // nothing to simulate with; let the send speak
  try {
    await simulate.staticCall(...args, { from });
  } catch (e: any) {
    // A null/garbled response from the read path is not evidence of a revert —
    // do not turn a flaky node into a fake contract error. Let the send proceed
    // and report whatever really happens.
    if (isNullGasEstimate(e) || /BytesLike|could not decode/i.test(String(e?.message ?? ''))) return;
    throw e;
  }
}

/// Simulate on the READ path, then send. The shape every write should use.
///
/// Without the simulation a reverting transaction produces a null gas estimate and
/// ethers throws `invalid BigNumberish value` with no mention of a revert — so the
/// user is told nothing and the developer goes looking in the wrong place. With it,
/// the revert is decoded off the read provider and `explainError` can name it.
///
/// `read` MUST be the read-path contract (`contracts.reads.X`), never the
/// signer-bound one. Simulating through the wallet relay is what broke the first
/// attempt at this: the relay that answered `eth_estimateGas` with null answers
/// `eth_call` with null too, and the recovery attempt died on `getBytes(null)`
/// instead of reporting anything.
///
/// `from` may be null (not connected) — the preflight is skipped and the send
/// speaks for itself, which is the pre-existing behaviour.
export async function sendPreflighted(
  read: any,
  write: any,
  fn: string,
  args: any[],
  from: string | null | undefined,
): Promise<any> {
  if (from) await preflight(read?.[fn], from, ...args);
  return write[fn](...args);
}
