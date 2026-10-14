import { parseProofInput, diagnoseProof } from './MerkleClaimPanel';

// Everything a claimant can get wrong happens in this function, because the
// proof arrives as text they pasted from somewhere. The failure that matters
// most is the quiet one: pasting a file that does not contain YOUR address, or
// an entry belonging to someone else. On-chain that comes back as a bare
// "InvalidProof" with no hint as to why, so it has to be caught here where the
// message can say something useful.
describe('parseProofInput', () => {
  const ME = '0xB56Ae5Ef9242D67959B3260898e77C702a2E8318';
  const OTHER = '0x08caC8E71E5b7386b28A15a2034CA226C5e44927';
  const H1 = '0x' + '11'.repeat(32);
  const H2 = '0x' + '22'.repeat(32);

  const fullFile = JSON.stringify({
    root: '0x' + 'ab'.repeat(32),
    recipients: {
      [ME]: { amount: '1', amountWei: '1000000000000000000', proof: [H1, H2] },
      [OTHER]: { amount: '2', amountWei: '2000000000000000000', proof: [H2, H1] },
    },
  });

  describe('accepts what people actually have to hand', () => {
    it('takes the whole proofs file and finds the connected address', () => {
      const r = parseProofInput(fullFile, ME);
      expect(r.amountWei).toBe(BigInt('1000000000000000000'));
      expect(r.proof).toEqual([H1, H2]);
    });

    it('matches the address case-insensitively', () => {
      // A pasted file may be checksummed differently from what the wallet reports.
      expect(parseProofInput(fullFile, ME.toLowerCase()).amountWei)
        .toBe(BigInt('1000000000000000000'));
    });

    it('takes a single entry on its own', () => {
      const r = parseProofInput(JSON.stringify({ amountWei: '5000000000000000000', proof: [H1] }), ME);
      expect(r.amountWei).toBe(BigInt('5000000000000000000'));
    });

    it('converts a decimal amount when there is no wei value', () => {
      const r = parseProofInput(JSON.stringify({ amount: '2.5', proof: [H1] }), ME);
      expect(r.amountWei).toBe(BigInt('2500000000000000000'));
    });

    it('picks the EXACT wei value over the decimal one when both are present', () => {
      // Rounding a decimal would produce a different leaf and a proof that fails.
      const r = parseProofInput(JSON.stringify({
        amount: '1', amountWei: '1000000000000000001', proof: [H1],
      }), ME);
      expect(r.amountWei).toBe(BigInt('1000000000000000001'));
    });
  });

  describe('refuses, with a reason', () => {
    it('a file that does not contain this address', () => {
      const notMine = JSON.stringify({ recipients: { [OTHER]: { amount: '2', proof: [H1] } } });
      expect(() => parseProofInput(notMine, ME)).toThrow(/does not include/i);
    });

    it('text that is not JSON', () => {
      expect(() => parseProofInput('0xdeadbeef', ME)).toThrow(/valid JSON/i);
    });

    it('an object with no proof', () => {
      expect(() => parseProofInput(JSON.stringify({ amount: '1' }), ME)).toThrow(/proof/i);
    });

    it('an object with no amount', () => {
      expect(() => parseProofInput(JSON.stringify({ proof: [H1] }), ME)).toThrow(/amount/i);
    });

    it('a proof containing something that is not a 32-byte hash', () => {
      expect(() => parseProofInput(JSON.stringify({ amount: '1', proof: [H1, '0x1234'] }), ME))
        .toThrow(/32-byte/i);
    });

    it('a zero entitlement', () => {
      expect(() => parseProofInput(JSON.stringify({ amount: '0', proof: [H1] }), ME))
        .toThrow(/positive/i);
    });
  });

  it('accepts an empty proof — a one-recipient drop is legitimate', () => {
    // In a single-entry tree the root IS the leaf, so the proof is empty. Easy to
    // mistake for missing data and reject.
    expect(parseProofInput(JSON.stringify({ amount: '1', proof: [] }), ME).proof).toEqual([]);
  });
});

// The local diagnosis exists because the chain cannot distinguish these cases:
// a corrupt proof, a proof from a replaced drop, and the right proof from the
// wrong wallet all come back as a bare InvalidProof. The last is by far the most
// common in practice and the only one the user can fix in two seconds — if they
// are told which it is.
describe('diagnoseProof', () => {
  const { ethers } = require('ethers');
  const A = '0xB56Ae5Ef9242D67959B3260898e77C702a2E8318';
  const B = '0x08caC8E71E5b7386b28A15a2034CA226C5e44927';
  const ONE = BigInt('1000000000000000000');

  // A real two-leaf tree, built the way the contract verifies.
  const leaf = (addr: string, amt: bigint) => ethers.keccak256(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [addr, amt])));
  const pair = (x: string, y: string) => ethers.keccak256(
    ethers.concat(x.toLowerCase() < y.toLowerCase() ? [x, y] : [y, x]));

  const lA = leaf(A, ONE), lB = leaf(B, ONE);
  const root = pair(lA, lB);

  it('accepts the right proof from the right address', () => {
    expect(diagnoseProof(A, ONE, [lB], root)).toEqual({ ok: true });
  });

  it('REJECTS the right proof from the wrong address — the common mistake', () => {
    // B pasting A's entry. Identical on chain to a corrupt proof.
    const r = diagnoseProof(B, ONE, [lB], root) as any;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/connected as the wrong account/i);
    expect(r.reason).toContain(B);   // names the address actually connected
  });

  it('rejects a proof against a root that has since been replaced', () => {
    const stale = '0x' + 'cd'.repeat(32);
    expect((diagnoseProof(A, ONE, [lB], stale) as any).ok).toBe(false);
  });

  it('rejects a tampered amount', () => {
    expect((diagnoseProof(A, BigInt('2000000000000000000'), [lB], root) as any).ok).toBe(false);
  });

  it('accepts a single-recipient drop, where the root IS the leaf', () => {
    expect(diagnoseProof(A, ONE, [], lA)).toEqual({ ok: true });
  });
});
