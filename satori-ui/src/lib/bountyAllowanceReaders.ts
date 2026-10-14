import { ethers } from 'ethers';
import { AllowanceReaders, ApprovalStep } from './bountyAllowances';
import { signPermit, satoriPermitArg, tokenPermitArg, resolvePermitDomain } from './permit';
import { tryAtomicBatch, supportsAtomicBatch, BatchCall, BatchOutcome, Send } from './walletBatch';

/**
 * Binds the allowance planner in `bountyAllowances.ts` to the live contracts.
 *
 * Kept apart from the planner so the planner stays a pure function over injected
 * readers and can be unit-tested without a chain. Everything chain-shaped lives
 * here; everything rule-shaped lives there.
 *
 * All reads go through `contracts.reads.*` — the resilient provider — rather than
 * the signer-bound contracts. A contract whose runner is a signer reads through
 * the WALLET's RPC, which is how the dev-fee tab once vanished for a real payee
 * on a flaky wallet connection (`c429a313`,
 * `docs/issues/closed/dapp-reads-bypass-resilient-provider.md`).
 */
export function makeAllowanceReaders(
  contracts: any,
  owner: string | null | undefined,
): AllowanceReaders {
  return {
    allowance: async (token: string, spender: string): Promise<bigint> => {
      if (!owner) return BigInt(0);
      const erc20 = new ethers.Contract(
        token,
        ['function allowance(address,address) view returns (uint256)'],
        contracts.reads.token.runner,
      );
      try {
        return BigInt(await erc20.allowance(owner, spender));
      } catch {
        // Unreadable allowance: report zero so the caller ASKS for the approval.
        // An extra approval is a spare allowance; a skipped one is a revert with
        // no explanation.
        return BigInt(0);
      }
    },

    postingFeeApplies: async (gameId: number, token: string): Promise<boolean | null> => {
      try {
        return Boolean(await contracts.reads.bounties.postingFeeApplies(gameId, token));
      } catch {
        // Older deployment without the view, or a failed read. `null` is
        // "could not tell", which the planner treats as "assume it applies".
        return null;
      }
    },

    postingFee: async (): Promise<bigint> => {
      try {
        return BigInt(await contracts.cached.round.satori.bountyBurn());
      } catch {
        return BigInt(0);
      }
    },
  };
}

/**
 * Send `fundBounty` in ONE transaction, signing whichever allowances can be
 * signed for.
 *
 * Returns `null` when the flow cannot be collapsed — the funding token has no
 * usable permit surface, or the wallet is a smart account whose signature
 * ERC-2612 cannot express. The caller then falls back to the stepped approval
 * path, which is why that path is kept rather than deleted.
 *
 * The two permits go to DIFFERENT spenders: the funding token to
 * `SatoriBounties`, the SATORI posting burn to the HUB, because the hub is what
 * charges it. Getting that pair wrong reverts.
 */
export async function fundBountyOnePress(
  contracts: any,
  owner: string,
  args: { gameId: number; token: string; amount: bigint; proposedRate: bigint },
  outstanding: ApprovalStep[],
): Promise<any | null> {
  const { gameId, token, amount, proposedRate } = args;
  const [satoriAddress, bountiesAddress, hubAddress] = await Promise.all([
    contracts.reads.token.getAddress(),
    contracts.bounties.getAddress(),
    contracts.hub.getAddress(),
  ]);
  const reader = contracts.reads.token.runner;
  const signer = (contracts.satori as any).runner;

  const needsToken = outstanding.some((s) => s.kind === 'token');
  const feeStep = outstanding.find((s) => s.kind === 'satori');

  // The funding token. SATORI funding lands here too and works the same way.
  let tokenPermit = null;
  if (needsToken) {
    tokenPermit = await signPermit({
      tokenAddress: token, reader, signer, owner, spender: bountiesAddress, value: amount,
    });
    // No (v, r, s) means ERC-2612 cannot carry it. Bail to the approval path
    // rather than sending a permit the token is guaranteed to reject.
    if (!tokenPermit?.vrs) return null;
  }

  let feePermit = null;
  if (feeStep) {
    feePermit = await signPermit({
      tokenAddress: satoriAddress, reader, signer, owner, spender: hubAddress, value: feeStep.amount,
    });
    // SATORI takes an arbitrary-length signature, so a smart account is fine
    // here even though it would not be for the funding token above.
    if (!feePermit) return null;
  }

  return contracts.bounties.fundBountyWithPermit(
    gameId, token, amount, proposedRate,
    tokenPermitArg(tokenPermit),
    satoriPermitArg(feePermit),
  );
}

const ERC20_APPROVE = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
const BOUNTIES_IFACE = new ethers.Interface([
  'function fundBounty(uint32,address,uint256,uint256)',
  'function stakeBountyToken(address,uint256)',
]);

/**
 * Route B: ask the WALLET to submit the approvals and the action as one atomic
 * batch, so the user confirms once.
 *
 * This is the rung below Route A, not a replacement for it. Permit removes the
 * approval transaction entirely and costs no gas to sign; batching still pays
 * the approval's gas, it only merges the confirmations. So it is reached exactly
 * when permit cannot be: a bounty token with no ERC-2612 surface, or a smart
 * account whose signature `(v, r, s)` cannot carry.
 *
 * Returns null when the wallet cannot batch atomically, which drops the caller to
 * the stepped approval presses. Throws on a user rejection, so cancelling once
 * does not read as "your wallet cannot do this".
 */
export async function fundBountyBatched(
  contracts: any,
  owner: string,
  args: { gameId: number; token: string; amount: bigint; proposedRate: bigint },
  outstanding: ApprovalStep[],
): Promise<BatchOutcome | null> {
  const send = walletSend(contracts);
  if (!send) return null;
  const chainId = (await (contracts.reads.token.runner as ethers.Provider).getNetwork()).chainId;

  const calls: BatchCall[] = outstanding.map((s) => ({
    to: s.token,
    data: ERC20_APPROVE.encodeFunctionData('approve', [s.spender, s.amount]),
  }));
  calls.push({
    to: await contracts.bounties.getAddress(),
    data: BOUNTIES_IFACE.encodeFunctionData('fundBounty', [
      args.gameId, args.token, args.amount, args.proposedRate,
    ]),
  });

  return tryAtomicBatch(send, { from: owner, chainId, calls });
}

/// Route B for staking. One approval plus the stake, in one confirmation.
export async function stakeBountyBatched(
  contracts: any,
  owner: string,
  args: { token: string; amount: bigint },
  outstanding: ApprovalStep[],
): Promise<BatchOutcome | null> {
  const send = walletSend(contracts);
  if (!send) return null;
  const chainId = (await (contracts.reads.token.runner as ethers.Provider).getNetwork()).chainId;

  const calls: BatchCall[] = outstanding.map((s) => ({
    to: s.token,
    data: ERC20_APPROVE.encodeFunctionData('approve', [s.spender, s.amount]),
  }));
  calls.push({
    to: await contracts.bounties.getAddress(),
    data: BOUNTIES_IFACE.encodeFunctionData('stakeBountyToken', [args.token, args.amount]),
  });

  return tryAtomicBatch(send, { from: owner, chainId, calls });
}

/**
 * The whole one-confirmation policy, in one place so every call site agrees.
 *
 * Tried in cost order, best first:
 *   1. **Permit.** Removes the approval transaction outright. The signature is
 *      free, so this is one confirmation AND less gas.
 *   2. **Wallet batching.** Merges the confirmations but still pays the
 *      approval's gas. Reaches what permit cannot: tokens with no ERC-2612
 *      surface, and smart accounts.
 *   3. **Neither.** Returns null, and the caller asks for the approvals one press
 *      at a time.
 *
 * Returns `{done:true}` when the action was sent and settled, so the caller does
 * not need to know which rung it landed on.
 */
export async function fundBountyOneConfirmation(
  contracts: any,
  owner: string,
  args: { gameId: number; token: string; amount: bigint; proposedRate: bigint },
  outstanding: ApprovalStep[],
): Promise<{ sent: true; tx: any | null; failed?: string } | null> {
  const signed = await fundBountyOnePress(contracts, owner, args, outstanding);
  if (signed) return { sent: true, tx: signed };

  const batched = await fundBountyBatched(contracts, owner, args, outstanding);
  if (!batched) return null;
  if (!batched.ok) {
    return { sent: true, tx: null, failed: batched.reverted
      ? 'The batched transaction reverted. Nothing was funded.'
      : 'The batched transaction did not confirm in time.' };
  }
  return { sent: true, tx: null };
}

/// Reads only, no prompt: will this wallet batch atomically on this chain? Used
/// to decide whether an approval press is needed before offering the action.
export async function walletCanBatch(contracts: any, owner: string | null | undefined): Promise<boolean> {
  if (!owner) return false;
  const send = walletSend(contracts);
  if (!send) return false;
  try {
    const chainId = (await (contracts.reads.token.runner as ethers.Provider).getNetwork()).chainId;
    return await supportsAtomicBatch(send, owner, chainId);
  } catch {
    return false;
  }
}

/// The wallet's raw RPC channel. EIP-5792 is a wallet-level method, so it has to
/// go to the WALLET's provider — unlike every read in this file, which
/// deliberately avoids it. Null when there is no connected wallet to ask.
function walletSend(contracts: any): Send | null {
  const runner = (contracts.satori as any)?.runner;
  const provider = runner?.provider;
  if (!provider || typeof provider.send !== 'function') return null;
  return (method: string, params: any[]) => provider.send(method, params);
}

/// Reads only, no signing prompt: can this token produce a permit signature the
/// contract will accept? Used to decide which flow to offer before asking the
/// user for anything.
export async function tokenCanPermit(contracts: any, token: string): Promise<boolean> {
  try {
    const erc20 = new ethers.Contract(token, [
      'function DOMAIN_SEPARATOR() view returns (bytes32)',
      'function name() view returns (string)',
      'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
    ], contracts.reads.token.runner);
    const net = await (contracts.reads.token.runner as ethers.Provider).getNetwork();
    return (await resolvePermitDomain(erc20, net.chainId, token)) !== null;
  } catch {
    return false;
  }
}
