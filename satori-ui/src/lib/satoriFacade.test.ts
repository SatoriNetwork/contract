import { ethers } from 'ethers';
import { makeSatoriFacade } from './satoriFacade';

// The facade used to return `method.bind(contract)`. That looks harmless and is
// not: `Function.prototype.bind` returns a NEW function and copies none of the
// original's own properties. An ethers contract method carries `staticCall`,
// `estimateGas`, `populateTransaction` and `fragment` as properties, so binding
// deleted all of them — for every method, on every contract behind the facade.
//
// Nothing noticed until code reached for one, which took until 2026-08-05,
// where it surfaced as "staticCall is not a function" AFTER the user had
// already signed an approval. These tests fail against the bound version.

const SIGS: Record<string, string> = {
  alpha: 'function alpha(uint256 x) view returns (uint256)',
  beta:  'function beta(address a) returns (bool)',
};

/// A contract-shaped stand-in whose methods carry the same helper properties
/// ethers attaches, so the facade is exercised the way it is used.
///
/// Each stand-in declares ONLY the methods it actually has. The facade routes by
/// asking each contract's interface `hasFunction`, so a fixture that declares
/// everything everywhere routes to a contract without the method and returns
/// undefined — which is a bug in the fixture, not the facade.
function fake(names: string[]) {
  const iface = new ethers.Interface(names.map((n) => SIGS[n]));
  const c: any = { interface: iface, target: '0xcontract' };
  for (const n of names) {
    const fn: any = (...args: unknown[]) => Promise.resolve(`${n}:sent:${args.join(',')}`);
    fn.staticCall = (...args: unknown[]) => Promise.resolve(`${n}:static:${args.join(',')}`);
    fn.estimateGas = () => Promise.resolve(BigInt(21000));
    fn.populateTransaction = () => Promise.resolve({ to: '0xcontract' });
    fn.fragment = { name: n };
    c[n] = fn;
  }
  c.getAddress = async () => '0xcontract';
  return c as ethers.Contract;
}

describe('makeSatoriFacade method routing', () => {
  const build = () => {
    const token = fake(['alpha']);
    const engine = fake([]);
    const hub = fake(['beta']);
    const lens = fake([]);
    return makeSatoriFacade(token, engine, hub, lens);
  };

  it('keeps staticCall on a routed method', async () => {
    // The one that broke. A send has a fallback path that simulates to recover a
    // revert reason, and it can only do that if staticCall survived routing.
    const f = build() as any;
    expect(typeof f.alpha.staticCall).toBe('function');
    await expect(f.alpha.staticCall(7)).resolves.toBe('alpha:static:7');
  });

  it('keeps estimateGas and populateTransaction too', async () => {
    const f = build() as any;
    expect(typeof f.beta.estimateGas).toBe('function');
    expect(typeof f.beta.populateTransaction).toBe('function');
    await expect(f.beta.estimateGas()).resolves.toBe(BigInt(21000));
  });

  it('still calls through normally', async () => {
    const f = build() as any;
    await expect(f.alpha(1)).resolves.toBe('alpha:sent:1');
    await expect(f.beta('0xabc')).resolves.toBe('beta:sent:0xabc');
  });

  it('keeps the fragment metadata', () => {
    const f = build() as any;
    expect(f.alpha.fragment?.name).toBe('alpha');
  });

  it('routes to the contract that declares the method', async () => {
    // alpha lives on token, beta on hub. Routing must not collapse them.
    const f = build() as any;
    await expect(f.alpha(2)).resolves.toContain('alpha');
    await expect(f.beta('0x0')).resolves.toContain('beta');
  });
});
