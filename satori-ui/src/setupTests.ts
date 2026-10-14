// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// Under jest, ethers' node build backs its crypto primitives with Node's
// `crypto` module, whose outputs are Node-realm Buffers — and jsdom-realm code
// then fails the cross-realm `instanceof Uint8Array` check with
// INVALID_ARGUMENT the first time anything touches key generation or keystore
// encryption. ethers v6 exposes `.register` on each primitive exactly so an
// environment can supply its own implementation: re-wrap every node-crypto
// output in THIS realm's Uint8Array. (keccak256/ripemd160 are pure-JS noble
// implementations that already allocate in this realm — no wrap needed.)
/* eslint-disable @typescript-eslint/no-var-requires */
{
  const eth = require('ethers');
  const nodeCrypto = require('crypto');
  const U8 = (b: any) => Uint8Array.from(b);
  const B = (b: any) => Buffer.from(b);
  eth.randomBytes.register((length: number) => U8(nodeCrypto.randomBytes(length)));
  eth.sha256.register((data: Uint8Array) => U8(nodeCrypto.createHash('sha256').update(B(data)).digest()));
  eth.sha512.register((data: Uint8Array) => U8(nodeCrypto.createHash('sha512').update(B(data)).digest()));
  eth.computeHmac.register((algo: string, key: Uint8Array, data: Uint8Array) =>
    U8(nodeCrypto.createHmac(algo, B(key)).update(B(data)).digest()));
  eth.pbkdf2.register((passwd: Uint8Array, salt: Uint8Array, iterations: number, keylen: number, algo: string) =>
    U8(nodeCrypto.pbkdf2Sync(B(passwd), B(salt), iterations, keylen, algo)));
  const scryptOpts = (N: number, r: number, p: number) => ({ N, r, p, maxmem: 128 * N * r * 2 });
  eth.scrypt.register(async (passwd: Uint8Array, salt: Uint8Array, N: number, r: number, p: number, dkLen: number, progress?: (pct: number) => void) => {
    const out = U8(nodeCrypto.scryptSync(B(passwd), B(salt), dkLen, scryptOpts(N, r, p)));
    progress?.(1);
    return out;
  });
  eth.scryptSync.register((passwd: Uint8Array, salt: Uint8Array, N: number, r: number, p: number, dkLen: number) =>
    U8(nodeCrypto.scryptSync(B(passwd), B(salt), dkLen, scryptOpts(N, r, p))));
}
/* eslint-enable @typescript-eslint/no-var-requires */
