import { ethers } from 'ethers';
import { resolvePermitDomain, satoriPermitArg, tokenPermitArg, SignedPermit } from './permit';

const TOKEN = '0x1111111111111111111111111111111111111111';
const CHAIN = BigInt(31337);

/** A stand-in for the token contract, exposing only what resolvePermitDomain reads. */
function fakeToken(over: {
  separator?: string | Error;
  name?: string | Error;
  eip712Domain?: any[] | Error;
}) {
  const answer = (v: any) => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v));
  return {
    DOMAIN_SEPARATOR: () => answer(over.separator ?? new Error('no permit')),
    name: () => answer(over.name ?? new Error('no name')),
    eip712Domain: () => answer(over.eip712Domain ?? new Error('not implemented')),
  } as any;
}

const separatorFor = (name: string, version: string) =>
  ethers.TypedDataEncoder.hashDomain({ name, version, chainId: CHAIN, verifyingContract: TOKEN });

describe('resolvePermitDomain', () => {
  it('returns null when the token has no DOMAIN_SEPARATOR — it has no permit', async () => {
    const d = await resolvePermitDomain(fakeToken({}), CHAIN, TOKEN);
    expect(d).toBeNull();
  });

  it('uses ERC-5267 eip712Domain when the token exposes it', async () => {
    const token = fakeToken({
      separator: separatorFor('Satori', '1'),
      eip712Domain: ['0x0f', 'Satori', '1', CHAIN, TOKEN, ethers.ZeroHash, []],
      name: 'SOMETHING ELSE', // must not win over the authoritative answer
    });
    const d = await resolvePermitDomain(token, CHAIN, TOKEN);
    expect(d).toEqual({ name: 'Satori', version: '1', chainId: CHAIN, verifyingContract: TOKEN });
  });

  it('falls back to name() with version 1', async () => {
    const token = fakeToken({ separator: separatorFor('USD Coin', '1'), name: 'USD Coin' });
    const d = await resolvePermitDomain(token, CHAIN, TOKEN);
    expect(d?.version).toBe('1');
  });

  it('finds version 2 tokens, which a version-1 guess would silently get wrong', async () => {
    // This is the case that matters. A signature built against version "1" here
    // is well-formed, costs the user a signing prompt, and is then rejected by the
    // token — a failure that arrives AFTER they signed.
    const token = fakeToken({ separator: separatorFor('USD Coin', '2'), name: 'USD Coin' });
    const d = await resolvePermitDomain(token, CHAIN, TOKEN);
    expect(d?.version).toBe('2');
  });

  it('returns null when no candidate reproduces the separator', async () => {
    const token = fakeToken({ separator: separatorFor('Different Name', '1'), name: 'USD Coin' });
    expect(await resolvePermitDomain(token, CHAIN, TOKEN)).toBeNull();
  });

  it('rejects a LYING eip712Domain rather than trusting it', async () => {
    // The separator is the ground truth. A domain that does not hash to it is
    // discarded even though the token volunteered it.
    const token = fakeToken({
      separator: separatorFor('Real', '1'),
      eip712Domain: ['0x0f', 'Fake', '9', CHAIN, TOKEN, ethers.ZeroHash, []],
      name: 'Real',
    });
    const d = await resolvePermitDomain(token, CHAIN, TOKEN);
    expect(d?.name).toBe('Real');
    expect(d?.version).toBe('1');
  });
});

describe('permit struct arguments', () => {
  const signed: SignedPermit = {
    value: BigInt(100),
    deadline: BigInt(999),
    raw: '0x' + 'ab'.repeat(65),
    vrs: { v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) },
  };

  it('encodes a SATORI permit as the bytes form', () => {
    expect(satoriPermitArg(signed)).toEqual({
      value: BigInt(100), deadline: BigInt(999), signature: signed.raw,
    });
  });

  it('encodes "no permit" as deadline 0, which the contracts treat as skip', () => {
    expect(satoriPermitArg(null).deadline).toBe(BigInt(0));
    expect(tokenPermitArg(null).deadline).toBe(BigInt(0));
  });

  it('encodes a token permit in the (v, r, s) form ERC-2612 defines', () => {
    const arg = tokenPermitArg(signed);
    expect(arg.v).toBe(27);
    expect(arg.deadline).toBe(BigInt(999));
  });

  it('degrades a smart-account signature to "no permit" for ERC-2612 tokens', () => {
    // A Safe or passkey signature is not 65 bytes, so it cannot be expressed as
    // (v, r, s). SATORI takes it through the bytes overload; an arbitrary token
    // cannot, so the caller must fall back to approve rather than send garbage.
    const smartAccount: SignedPermit = { ...signed, raw: '0x' + 'cd'.repeat(200), vrs: null };
    expect(tokenPermitArg(smartAccount).deadline).toBe(BigInt(0));
    expect(satoriPermitArg(smartAccount).signature).toBe(smartAccount.raw);
  });
});
