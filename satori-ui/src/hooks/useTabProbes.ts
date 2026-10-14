import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';
import { getChainConfig } from '../contracts/addresses';
import { multicallRead } from '../utils/multicall';

/**
 * Tab-visibility probes: the cheapest possible answer to "does this account get
 * the splitter / admin tabs?", so App never has to run the tabs' full data
 * loads just to decide what to show.
 *
 * The contract these probes keep, all three parts deliberate:
 *  - ONE batched request each (multicall), sent ~3s AFTER first paint so the
 *    home screen owns the connection while it matters.
 *  - SILENT on failure. A probe that cannot answer is not news the user can act
 *    on: it keeps the last answer (or hidden), retries once, and says nothing.
 *    Loud errors belong to the tab bodies, which only mount for people who
 *    have the tab.
 *  - A confirmed-positive answer is remembered per (chain, address), so a
 *    returning payee/admin sees their tab instantly while the probe re-confirms.
 */

const PROBE_DELAY_MS = 3000;
const RETRY_MS = 30000;

const SPLITTER_PROBE_ABI = [
  'function authority() view returns (address)',
  'function isRecipient(address) view returns (bool)',
];
const MERKLE_PROBE_ABI = ['function rootPublisher() view returns (address)'];
const ZERO = ethers.ZeroAddress;

const cacheKey = (kind: string, chainId: number, addr: string) =>
  `satori.probe.${kind}.v1.${chainId}.${addr.toLowerCase()}`;

function readCache(kind: string, chainId: number, addr: string): string {
  try { return localStorage.getItem(cacheKey(kind, chainId, addr)) ?? ''; } catch { return ''; }
}

function writeCache(kind: string, chainId: number, addr: string, roles: string) {
  try {
    if (roles) localStorage.setItem(cacheKey(kind, chainId, addr), roles);
    else localStorage.removeItem(cacheKey(kind, chainId, addr));
  } catch { /* private mode — probe still answers, just no instant restore */ }
}

/// Shared scheduling: defer, run, one silent retry, cancel on account change.
function useProbe(deps: any[], enabled: boolean, run: () => Promise<void>) {
  useEffect(() => {
    if (!enabled) return;
    let dead = false;
    let retryTimer: any;
    const fire = (attempt: number) => run().catch(() => {
      if (!dead && attempt === 0) retryTimer = setTimeout(() => fire(1), RETRY_MS);
    });
    const timer = setTimeout(() => { if (!dead) fire(0); }, PROBE_DELAY_MS);
    return () => { dead = true; clearTimeout(timer); clearTimeout(retryTimer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export type SplitterMembership = { isPayee: boolean; isAuthority: boolean; checked: boolean };

export function useSplitterMembership(): SplitterMembership {
  const { contracts } = useContracts();
  const { address, chainId } = useWallet();
  const [state, setState] = useState<SplitterMembership>({ isPayee: false, isAuthority: false, checked: false });

  // Instant restore from the last confirmed answer (unconfirmed: checked stays false).
  useEffect(() => {
    if (!address) { setState({ isPayee: false, isAuthority: false, checked: true }); return; }
    const hit = readCache('splitter', chainId, address);
    setState({ isPayee: hit.includes('p'), isAuthority: hit.includes('a'), checked: false });
  }, [address, chainId]);

  useProbe([contracts, address, chainId], !!(contracts && address), async () => {
    // The splitter tree's ADDRESSES are immutable and baked into the chain
    // config; only slot holders rotate, and those are what this reads live.
    // No config (dev chain) = no tab; the dev book pins nothing that redeploys.
    let splitters: string[] | undefined;
    try { splitters = getChainConfig(chainId).splitters; } catch { /* unknown chain */ }
    if (!contracts || !address || !splitters?.length) {
      setState((s) => ({ ...s, checked: true }));
      return;
    }
    const runner = contracts.reads.token.runner;
    const reqs = splitters.flatMap((s) => {
      const c = new ethers.Contract(s, SPLITTER_PROBE_ABI, runner);
      return [
        { contract: c, fn: 'authority', args: [], allowFailure: true },
        { contract: c, fn: 'isRecipient', args: [address], allowFailure: true },
      ];
    });
    const res = await multicallRead(contracts.multicall, reqs);
    if (res.every((r: any) => r === null || r === undefined)) throw new Error('probe unreachable');
    const me = address.toLowerCase();
    let isPayee = false, isAuthority = false;
    splitters.forEach((_, i) => {
      const auth = res[i * 2], member = res[i * 2 + 1];
      if (typeof auth === 'string' && auth.toLowerCase() === me) isAuthority = true;
      if (member === true) isPayee = true;
    });
    writeCache('splitter', chainId, address, `${isPayee ? 'p' : ''}${isAuthority ? 'a' : ''}`);
    setState({ isPayee, isAuthority, checked: true });
  });

  return state;
}

export type OwnerRoles = {
  isOwner: boolean; isGovernor: boolean;
  isOffchainReporter: boolean; isRootPublisher: boolean;
  isEmissionHolder: boolean;
  checked: boolean;
};

const NO_ROLES: OwnerRoles = {
  isOwner: false, isGovernor: false, isOffchainReporter: false, isRootPublisher: false,
  isEmissionHolder: false, checked: false,
};

export function useOwnerRoles(): OwnerRoles {
  const { contracts } = useContracts();
  const { address, chainId } = useWallet();
  const [state, setState] = useState<OwnerRoles>(NO_ROLES);

  useEffect(() => {
    if (!address) { setState({ ...NO_ROLES, checked: true }); return; }
    const hit = readCache('roles', chainId, address);
    setState({
      isOwner: hit.includes('o'), isGovernor: hit.includes('g'),
      isOffchainReporter: hit.includes('r'), isRootPublisher: hit.includes('m'),
      isEmissionHolder: hit.includes('e'),
      checked: false,
    });
  }, [address, chainId]);

  useProbe([contracts, address, chainId], !!(contracts && address), async () => {
    if (!contracts || !address) return;
    const res = await multicallRead(contracts.multicall, [
      { contract: contracts.reads.rewards, fn: 'admin', args: [], allowFailure: true },
      { contract: contracts.reads.token, fn: 'rootAuthority', args: [], allowFailure: true },
      { contract: contracts.reads.engine, fn: 'offchainReporter', args: [], allowFailure: true },
      { contract: contracts.reads.hub, fn: 'merkle', args: [], allowFailure: true },
      { contract: contracts.reads.hub, fn: 'emissionHolder', args: [], allowFailure: true },
    ]);
    if (res.every((r: any) => r === null || r === undefined)) throw new Error('probe unreachable');
    const me = address.toLowerCase();
    const is = (v: any) => typeof v === 'string' && v !== ZERO && v.toLowerCase() === me;
    let isRootPublisher = false;
    const merkleAddr = res[3];
    if (typeof merkleAddr === 'string' && merkleAddr !== ZERO) {
      // Only when a merkle contract is actually wired — one extra read, and
      // only for chains that have the airdrop lane at all.
      try {
        const m = new ethers.Contract(merkleAddr, MERKLE_PROBE_ABI, contracts.reads.token.runner);
        isRootPublisher = is(await m.rootPublisher());
      } catch { /* stays false; the retry pass covers a blip */ }
    }
    const roles: OwnerRoles = {
      isOwner: is(res[0]), isGovernor: is(res[1]),
      isOffchainReporter: is(res[2]), isRootPublisher,
      isEmissionHolder: is(res[4]),
      checked: true,
    };
    writeCache('roles', chainId, address,
      `${roles.isOwner ? 'o' : ''}${roles.isGovernor ? 'g' : ''}${roles.isOffchainReporter ? 'r' : ''}${roles.isRootPublisher ? 'm' : ''}${roles.isEmissionHolder ? 'e' : ''}`);
    setState(roles);
  });

  return state;
}
