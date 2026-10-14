import { ethers } from 'ethers';

export interface MulticallReq {
  contract: ethers.Contract;
  fn: string;
  args: any[];
  allowFailure?: boolean;
}

/// Batch many read-only contract calls into a single eth_call via the Multicall
/// helper contract. Order of `decoded` matches the input order.
export async function multicallRead(
  multicall: ethers.Contract,
  reqs: MulticallReq[],
): Promise<any[]> {
  if (reqs.length === 0) return [];
  const calls = reqs.map((r) => ({
    target: (r.contract as any).target ?? r.contract.getAddress(),
    allowFailure: r.allowFailure ?? false,
    callData: r.contract.interface.encodeFunctionData(r.fn, r.args),
  }));
  // Resolve any pending getAddress() promises
  const resolvedCalls = await Promise.all(
    calls.map(async (c) => ({
      target: typeof c.target === 'string' ? c.target : await c.target,
      allowFailure: c.allowFailure,
      callData: c.callData,
    })),
  );
  const results = await multicall.aggregate3.staticCall(resolvedCalls);
  return results.map((res: any, i: number) => {
    const { success, returnData } = res;
    if (!success) {
      if (reqs[i].allowFailure) return null;
      throw new Error(`multicall ${reqs[i].fn} failed`);
    }
    const decoded = reqs[i].contract.interface.decodeFunctionResult(reqs[i].fn, returnData);
    // Match ethers v6 single-return convention (unwrap one-element results)
    return decoded.length === 1 ? decoded[0] : decoded;
  });
}
