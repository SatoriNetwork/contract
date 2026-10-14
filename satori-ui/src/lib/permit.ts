import { ethers } from 'ethers';

/**
 * ERC-2612 permit signing, with the domain VERIFIED before the user is asked to
 * sign anything.
 *
 * A permit signature is only valid if it was signed over the exact EIP-712 domain
 * the token checks against. Tokens disagree about that domain in ways you cannot
 * see from outside: most use version "1", some use "2", some use a name that is
 * not `name()`. Signing against a guess produces a signature the token rejects,
 * and the user finds out as a failed transaction after having signed.
 *
 * So every function here derives a candidate domain, hashes it, and compares it
 * against the token's own `DOMAIN_SEPARATOR()` before returning. If no candidate
 * matches, it returns `null` and the caller falls back to a plain approval. Never
 * ask for a signature that cannot work.
 *
 * `null` is the normal answer for a token with no permit at all, which bounties
 * accept, so callers must always have the approve path behind this.
 */

export type SignedPermit = {
  value: bigint;
  deadline: bigint;
  /** The raw signature, for SATORI's ERC-1271 `bytes` overload. Any length. */
  raw: string;
  /** Split form, for standard ERC-2612. Null when the signature is not 65 bytes. */
  vrs: { v: number; r: string; s: string } | null;
};

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

const PERMIT_ABI = [
  'function nonces(address) view returns (uint256)',
  'function name() view returns (string)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
];

/** How long a signed permit stays usable. Long enough to survive a slow wallet. */
const VALID_FOR_SECONDS = 3600;

/**
 * The EIP-712 domain the token will actually check against, or null if we cannot
 * establish it.
 *
 * Tries ERC-5267 `eip712Domain()` first, which is authoritative when present
 * (OpenZeppelin 5.x exposes it). Falls back to `name()` with the common versions.
 * Every candidate is confirmed against `DOMAIN_SEPARATOR()`; a candidate that
 * does not reproduce it is discarded rather than used.
 */
export async function resolvePermitDomain(
  token: ethers.Contract,
  chainId: bigint,
  verifyingContract: string,
): Promise<ethers.TypedDataDomain | null> {
  let onChainSeparator: string;
  try {
    onChainSeparator = await token.DOMAIN_SEPARATOR();
  } catch {
    return null; // no permit surface at all
  }

  const candidates: ethers.TypedDataDomain[] = [];

  try {
    const d = await token.eip712Domain();
    candidates.push({ name: d[1], version: d[2], chainId, verifyingContract });
  } catch {
    /* ERC-5267 is optional; fall through to the guesses */
  }

  try {
    const name = await token.name();
    for (const version of ['1', '2']) {
      candidates.push({ name, version, chainId, verifyingContract });
    }
  } catch {
    /* nothing more to try */
  }

  for (const domain of candidates) {
    try {
      if (ethers.TypedDataEncoder.hashDomain(domain) === onChainSeparator) return domain;
    } catch {
      /* malformed candidate, try the next */
    }
  }
  return null;
}

/**
 * Sign an ERC-2612 permit for `spender` to spend `value` of `token`.
 * Returns null when the token cannot support it, or the wallet refuses to sign
 * typed data — in both cases the caller falls back to `approve`.
 *
 * The deadline is taken from CHAIN time, not the browser clock. A local node or a
 * testnet can sit hours away from wall clock, and a permit that is already expired
 * when it is signed fails in a way that looks like a bad signature.
 */
export async function signPermit(opts: {
  tokenAddress: string;
  /** Read-path runner. Reads must not go through the wallet's RPC. */
  reader: ethers.ContractRunner;
  signer: ethers.Signer;
  owner: string;
  spender: string;
  value: bigint;
}): Promise<SignedPermit | null> {
  const { tokenAddress, reader, signer, owner, spender, value } = opts;
  try {
    const token = new ethers.Contract(tokenAddress, PERMIT_ABI, reader);
    const provider = reader as ethers.Provider;

    const [network, block, nonce] = await Promise.all([
      provider.getNetwork(),
      provider.getBlock('latest'),
      token.nonces(owner) as Promise<bigint>,
    ]);
    if (!block) return null;

    const domain = await resolvePermitDomain(token, network.chainId, tokenAddress);
    if (!domain) return null;

    const deadline = BigInt(block.timestamp + VALID_FOR_SECONDS);
    const raw = await signer.signTypedData(domain, PERMIT_TYPES, {
      owner, spender, value, nonce, deadline,
    });

    // Smart-contract accounts return signatures that are not 65 bytes. Those
    // cannot be expressed as (v, r, s) at all — which is exactly why SATORI has a
    // `bytes` overload — so the split form is simply absent for them and callers
    // that need ERC-2612 fall back to approve.
    let vrs: SignedPermit['vrs'] = null;
    try {
      const sig = ethers.Signature.from(raw);
      vrs = { v: sig.v, r: sig.r, s: sig.s };
    } catch {
      vrs = null;
    }

    return { value, deadline, raw, vrs };
  } catch {
    return null;
  }
}

/** The struct `SatoriHub` / `SatoriBounties` expect for a SATORI permit. */
export function satoriPermitArg(p: SignedPermit | null) {
  return p
    ? { value: p.value, deadline: p.deadline, signature: p.raw }
    : { value: BigInt(0), deadline: BigInt(0), signature: '0x' };
}

/** The struct `SatoriBounties` expects for a third-party token permit. */
export function tokenPermitArg(p: SignedPermit | null) {
  return p && p.vrs
    ? { value: p.value, deadline: p.deadline, v: p.vrs.v, r: p.vrs.r, s: p.vrs.s }
    : { value: BigInt(0), deadline: BigInt(0), v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash };
}
