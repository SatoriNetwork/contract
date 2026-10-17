// The dapp must not call contract methods that do not exist.
//
// `ethers.Contract` is dynamically dispatched: `contracts.satori.anything(...)`
// type-checks fine and compiles fine, then throws "is not a function" in the
// user's browser. TypeScript cannot catch it and no runtime test did either,
// which is how a whole tab survived calling three hub functions that the
// burn-voting migration had deleted (docs/issues/dapp-ships-a-dead-vote-market-tab.md).
//
// This test closes that gap: it reads the SAME compiled ABIs the dapp binds at
// runtime and asserts every method the source calls actually exists. Regenerate
// the ABIs after a contract change and any dapp call site left behind fails here
// instead of at a click.
import fs from 'fs';
import path from 'path';
import { ENGINE_METHODS, TOKEN_METHODS, LENS_METHODS } from './lib/satoriFacade';

const CONTRACTS_DIR = path.join(__dirname, 'contracts');
const SRC_DIR = __dirname;

function abiNames(file: string): Set<string> {
  const raw = JSON.parse(fs.readFileSync(path.join(CONTRACTS_DIR, `${file}.json`), 'utf8'));
  const abi = Array.isArray(raw) ? raw : raw.abi;
  return new Set<string>(
    abi.filter((e: { type: string; name?: string }) => e.type === 'function' && e.name)
       .map((e: { name: string }) => e.name),
  );
}

const ABI: Record<string, Set<string>> = {
  token: abiNames('SatoriToken'),
  engine: abiNames('SatoriEngine'),
  hub: abiNames('SatoriHub'),
  lens: abiNames('SatoriRewardsLens'),
  registry: abiNames('SatoriRegistry'),
  voting: abiNames('SatoriVoting'),
  rewards: abiNames('SatoriRewards'),
  games: abiNames('SatoriGames'),
  bounties: abiNames('SatoriBounties'),
  merkle: abiNames('SatoriMerkle'),
  airdrop: abiNames('SatoriAirdrop'),
  multicall: abiNames('Multicall'),
};
// `satori` is the split-stack facade: it routes across these four, so a name is
// valid if ANY of them serves it. Mirrors makeSatoriFacade's routeOrder.
// Array.from rather than spread: this project's TS target rejects iterating a
// Set directly, and CRA type-checks test files during a production build.
ABI.satori = new Set<string>(
  ([] as string[]).concat(
    Array.from(ABI.token), Array.from(ABI.engine),
    Array.from(ABI.hub), Array.from(ABI.lens),
  ),
);

// Members ethers puts on every Contract, plus our own facade/helper additions.
// Not ABI methods, so not checked against one.
const ETHERS_MEMBERS = new Set<string>([
  'connect', 'attach', 'getAddress', 'getFunction', 'getEvent', 'waitForDeployment',
  'deploymentTransaction', 'queryFilter', 'queryTransaction', 'listenerCount',
  'on', 'once', 'off', 'removeAllListeners', 'addListener', 'removeListener',
  'interface', 'filters', 'target', 'runner', 'fallback',
  'staticCall', 'estimateGas', 'populateTransaction', 'send', 'call',
]);

// `token` is both a contract key and a common field name for an address string,
// so `p.token.slice(0, 6)` matches the scan pattern. Any name here is a JS
// built-in, never an ABI method, so skipping them costs no coverage: no Solidity
// function in this codebase is called `slice` or `toString`.
const JS_BUILTINS = new Set<string>([
  'slice', 'split', 'trim', 'replace', 'toLowerCase', 'toUpperCase', 'startsWith',
  'endsWith', 'includes', 'indexOf', 'padStart', 'padEnd', 'concat', 'repeat',
  'toString', 'valueOf', 'map', 'filter', 'forEach', 'reduce', 'find', 'some',
  'every', 'sort', 'join', 'push', 'at', 'charAt', 'match', 'substring',
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'contracts' || entry.name === '__mocks__') continue;
      sourceFiles(p, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

describe('the dapp only calls contract methods that exist', () => {
  it('every contracts.<x>.<method>( call site resolves against the real ABI', () => {
    // Matches `contracts.satori.foo(`, `c.hub.foo(`, `reads.engine.foo(` — any
    // receiver, as long as the middle segment names a contract we know.
    const known = Object.keys(ABI).join('|');
    const re = new RegExp(String.raw`\.(${known})\.([A-Za-z_]\w*)\s*\(`, 'g');
    const bad: string[] = [];

    for (const file of sourceFiles(SRC_DIR)) {
      const text = fs.readFileSync(file, 'utf8');
      // exec loop rather than matchAll: same TS target limit as above.
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const contract = m[1];
        const method = m[2];
        if (ETHERS_MEMBERS.has(method) || JS_BUILTINS.has(method)) continue;
        if (ABI[contract].has(method)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        bad.push(`${path.relative(SRC_DIR, file)}:${line} -> ${contract}.${method}()`);
      }
    }

    if (bad.length) {
      throw new Error(
        `${bad.length} call site(s) invoke methods absent from the compiled ABI:\n  ` +
        bad.join('\n  '),
      );
    }
  });

  // The facade's own routing tables are the second half of the same hazard, and
  // satoriFacade.ts says so in a comment: a name listed there that the target no
  // longer has "does not fail loudly". Now it does.
  const ROUTES: Array<[string, Set<string>, string]> = [
    ['ENGINE_METHODS', ENGINE_METHODS, 'engine'],
    ['TOKEN_METHODS', TOKEN_METHODS, 'token'],
    ['LENS_METHODS', LENS_METHODS, 'lens'],
  ];
  for (const [label, methods, key] of ROUTES) {
    it(`${label} all exist on the ${key} ABI`, () => {
      const missing = Array.from(methods).filter((m) => !ABI[key].has(m));
      if (missing.length) {
        throw new Error(`${label} routes to ${key}, but its ABI has no: ${missing.join(', ')}`);
      }
    });
  }

  it('scans a non-trivial number of files (guards against a silent no-op)', () => {
    expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(30);
  });
});
