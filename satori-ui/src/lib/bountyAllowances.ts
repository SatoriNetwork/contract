/**
 * What a bounty action needs approved before it can go through, in one place.
 *
 * Two defects motivated this, both in
 * `docs/issues/closed/dapp-never-approves-the-bounty-posting-fee.md`:
 *
 * 1. **A missing allowance.** `fundBounty` can need TWO allowances on two
 *    different tokens with two different spenders. The bounty amount goes to
 *    SatoriBounties; the one-off SATORI posting burn is pulled by
 *    `SatoriHub.chargeBountyBurn`, so it is SATORI approved to the HUB. The UI
 *    only ever asked for the first, so posting the first bounty of a pair in a
 *    non-SATORI token reverted — except when leftover allowance from an earlier
 *    stream creation happened to cover it, which is why it worked for whoever
 *    tested it and failed for a fresh account.
 *
 * 2. **Two signatures in one press.** The funding and staking handlers called
 *    `approve(...)` and then the action in the same handler. On mobile the
 *    wallet's signature request unloads the page, so the code that was going to
 *    send the second transaction ceases to exist — the blank-page bug already
 *    fixed for stream creation (`563a9539`). Returning the steps rather than
 *    performing them lets each one be its own press.
 *
 * The rule for WHETHER the posting fee applies is asked of the contract
 * (`SatoriBounties.postingFeeApplies`), never re-derived here. It has two halves
 * — first fund of the pair, non-SATORI token — and a copy in the UI drifts the
 * moment the contract changes. `pool == 0` is not a substitute: a drained pair
 * keeps its flag until cleanup, and re-funding in that window is free.
 */

export type ApprovalStep = {
  /** `token` = the bounty's funding token, `satori` = the SATORI posting fee. */
  kind: 'token' | 'satori';
  /** Contract to call `approve` on. */
  token: string;
  /** Who is approved to spend: SatoriBounties for `token`, SatoriHub for `satori`. */
  spender: string;
  amount: bigint;
  /** Button copy, e.g. "Approve 100 USDC". */
  label: string;
};

export type AllowanceReaders = {
  /** Current allowance of `token` from the user to `spender`. */
  allowance: (token: string, spender: string) => Promise<bigint>;
  /**
   * Whether the SATORI posting burn applies to this pair right now, straight
   * from `SatoriBounties.postingFeeApplies`.
   *
   * Returning `null` means "could not tell" — an older deployment without the
   * view, or an RPC failure. Callers treat that as "assume it applies", see
   * below.
   */
  postingFeeApplies: (gameId: number, token: string) => Promise<boolean | null>;
  /** The hub's own quote for the posting burn. */
  postingFee: () => Promise<bigint>;
};

export type FundingPlanInput = {
  gameId: number;
  token: string;
  amount: bigint;
  /** Display symbol for the funding token; falls back to a short address. */
  symbol?: string;
  decimals?: number;
  satoriAddress: string;
  bountiesAddress: string;
  hubAddress: string;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Human amount for button copy. Deliberately coarse — this is a label, not a receipt. */
function fmt(amount: bigint, decimals: number): string {
  // Built from a string rather than `10n ** d`: the project's tsconfig target
  // predates ES2016, so the exponent operator is rejected on bigint.
  const base = BigInt('1' + '0'.repeat(decimals));
  const whole = amount / base;
  const frac = amount % base;
  if (frac === BigInt(0)) return whole.toString();
  const s = (Number(amount) / Number(base));
  return s >= 1 ? s.toFixed(2).replace(/\.?0+$/, '') : s.toPrecision(3);
}

/**
 * The approvals still outstanding for `fundBounty`, in the order to ask for them.
 * An empty array means the action can be sent immediately.
 *
 * Each entry is ONE user press and ONE signature. Never chain two.
 */
export async function planBountyFunding(
  input: FundingPlanInput,
  read: AllowanceReaders,
): Promise<ApprovalStep[]> {
  const { gameId, token, amount, satoriAddress, bountiesAddress, hubAddress } = input;
  const decimals = input.decimals ?? 18;
  const symbol = input.symbol ?? short(token);
  const steps: ApprovalStep[] = [];

  const tokenAllowance = await read.allowance(token, bountiesAddress);
  if (tokenAllowance < amount) {
    steps.push({
      kind: 'token',
      token,
      spender: bountiesAddress,
      amount,
      label: `Approve ${fmt(amount, decimals)} ${symbol}`,
    });
  }

  // Funding IN SATORI never carries the posting burn, so there is nothing to ask
  // for and no reason to spend an RPC call finding out.
  if (token.toLowerCase() === satoriAddress.toLowerCase()) return steps;

  const applies = await read.postingFeeApplies(gameId, token);

  // `null` is "could not tell". Ask for the allowance anyway: an unnecessary
  // approval is a spare allowance of a small fixed amount, while a missing one
  // is a reverted transaction with no explanation. Over-asking is the safe
  // direction, and it is the direction an older deployment lands in.
  if (applies === false) return steps;

  const fee = await read.postingFee();
  if (fee === BigInt(0)) return steps;

  const satoriAllowance = await read.allowance(satoriAddress, hubAddress);
  if (satoriAllowance < fee) {
    steps.push({
      kind: 'satori',
      token: satoriAddress,
      spender: hubAddress,
      amount: fee,
      label: `Approve ${fmt(fee, 18)} SATORI posting fee`,
    });
  }

  return steps;
}

/**
 * The approvals outstanding for `stakeBountyToken`. Staking moves only the
 * staker's own token and charges no SATORI fee, so there is at most one.
 */
export async function planBountyStake(
  input: { token: string; amount: bigint; symbol?: string; decimals?: number; bountiesAddress: string },
  read: Pick<AllowanceReaders, 'allowance'>,
): Promise<ApprovalStep[]> {
  const allowance = await read.allowance(input.token, input.bountiesAddress);
  if (allowance >= input.amount) return [];
  return [{
    kind: 'token',
    token: input.token,
    spender: input.bountiesAddress,
    amount: input.amount,
    label: `Approve ${fmt(input.amount, input.decimals ?? 18)} ${input.symbol ?? short(input.token)}`,
  }];
}
