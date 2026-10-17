// Per-chain configuration: contract addresses + RPC URL list.
//
// rpcUrls is an ordered list of fallback RPC endpoints. The dapp's resilient
// provider tries them in order, sticking with the first one that works. A
// single outage at any one provider doesn't take the dapp down; multiple
// outages still degrade gracefully as long as at least one endpoint responds.
export interface ContractAddresses {
  // The core split into three contracts (see lib/satoriFacade.ts):
  //   token  — immutable SatoriToken (ERC20 + round clock + minting)
  //   engine — upgradeable SatoriEngine (prediction state/logic, proxy address)
  //   hub    — SatoriHub, the user-facing facade (vote/claim/create/adapters/fees)
  // The dapp's `contracts.satori` is a routing Proxy assembled from these three.
  token: string;
  /// SatoriAirdrop — the airdrop in its own non-upgradeable contract
  /// (docs/issues/airdrop-own-contract.md). Zero on a stack that predates it.
  airdrop: string;
  engine: string;
  hub: string;
  registry: string;
  voting: string;
  rewards: string;
  // SatoriGames (createGame/gamesByStream/binaryGameByStream) and SatoriBounties
  // (fund/stake/withdraw/pool/ratePerRound) are separate contracts, reachable
  // on-chain via hub.satoriGames()/hub.satoriBounties(). Held here as the sync
  // source of truth so useContracts can instantiate them without an async
  // lookup; keep in sync with the deployed hub's getters.
  games: string;
  bounties: string;
  // SatoriMerkle — the off-chain reward claim channel (a second, isolated core
  // minter). Reachable on-chain via hub.satoriMerkle(); held here so the
  // OwnerTab can call setMerkleRoot without an async lookup.
  merkle: string;
  // SatoriRewardsLens — read-only computed views (predictorFeeBps, per-direction
  // weights, and getTotalClaimableRewards, which moved off SatoriRewards).
  lens: string;
  multicall: string;
}

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export interface ChainConfig extends ContractAddresses {
  rpcUrls: string[];
  chainName: string;
  // EIP-3085 fields — required by most wallets when wallet_addEthereumChain
  // is called for a chain they don't have. Omit them and the add-chain
  // prompt rejects silently or with a vague error.
  nativeCurrency: NativeCurrency;
  blockExplorerUrls: string[];
  // Holder-voting governor (HistoricalBalanceGovernor) + its proof pipeline
  // (see ../../satori-proof-pipeline/). Both optional: a chain without them
  // simply has no Proposals tab. The governor holds authority over nothing —
  // finalize() publishes an outcome, it moves nothing — so shipping its
  // address is shipping a bulletin board, not a lever.
  holderGovernor?: string;
  proofsUrl?: string;
  // Optional satori-indexer base URL (see ../../satori-indexer/). When set,
  // the five history consumers try one HTTP call here first and fall back to
  // the browser-side event scan on any failure — the scan path stays forever
  // (trust-minimized path, dev path). Unset = scan only.
  indexerUrl?: string;
  // Coined's indexer for this chain (coined/indexer). Unset = the named-stream
  // name box suggests from Satori's own streams only.
  coinedIndexerUrl?: string;
  // Optional gasless-relayer base URL (see ../../relayer/ and
  // docs/design/gasless-relay.md). When set, a user whose wallet cannot cover
  // gas can pay a SATORI fee instead and the relayer submits for them. Unset =
  // the whole pay-in-SATORI surface (prompt + advanced toggles) is absent.
  relayerUrl?: string;
  // Dev-fee splitter tree, [top, ...branches] — from
  // satori/deployments/splitters-<network>.json. These contracts are IMMUTABLE
  // (the token's pointer to the top is an immutable too), so baking their
  // addresses is exactly as safe as baking the token's. Only slot HOLDERS
  // rotate, and those are read live (useTabProbes). Unset = no splitter tab.
  splitters?: string[];
  // `SatoriToken.deploymentRound`, constructor-set and immutable. Every round a
  // user sees is relative to it: display = absolute - deploymentRound + 1.
  //
  // Shipped as a build-time constant, alongside the addresses it was deployed
  // with, because it is exactly as fixed as they are. Without it the dapp could
  // only learn the number from an async on-chain read, and on a cold load it
  // rendered the RAW chain round (41373 instead of 1) until that read landed.
  //
  // Optional: a local hardhat chain is redeployed constantly and pinning a round
  // there would be wrong more often than right, so dev omits it and pays the
  // fetch. `chainConfig.test.ts` pins the live chains against
  // `satori/deployments/<network>.json`.
  deploymentRound?: number;
}

// The dapp targets exactly one chain per build. Reads always go to this
// chain's RPCs; on connect we ask the user's wallet to switch to it.
export const DEV_CHAIN_ID = 31337;
export const TESTNET_CHAIN_ID = 84532; // Base Sepolia — the rehearsal chain
export const PROD_CHAIN_ID = 8453; // Base mainnet

// REACT_APP_CHAIN_ID overrides per build, which is how a dev server points at
// the Base Sepolia rehearsal instead of a local hardhat node without editing
// this file. Same pattern as REACT_APP_INDEXER_URL below. Absent, dev means the
// local chain and anything else means mainnet, exactly as before.
export const DEFAULT_CHAIN_ID = process.env.REACT_APP_CHAIN_ID
  ? Number(process.env.REACT_APP_CHAIN_ID)
  : process.env.NODE_ENV === 'development' ? DEV_CHAIN_ID : PROD_CHAIN_ID;

// WalletConnect v2 project id — get a free one from https://cloud.reown.com.
//
// THIS IS WHAT MAKES MOBILE WORK. Without it the only path to a wallet is an
// injected `window.ethereum`, which exists in a desktop extension and inside a
// wallet app's own browser — and NOT in ordinary mobile Chrome or Safari, where
// most people will open this. With it, "connect" deep-links straight into
// whichever wallet app is installed (MetaMask, Rainbow, Trust, Coinbase) and
// shows a QR on desktop instead.
//
// Prefer the env var so a project id never has to be committed; the constant is
// the fallback for a build that hardcodes one.
export const WALLETCONNECT_PROJECT_ID =
  process.env.REACT_APP_WALLETCONNECT_PROJECT_ID || '';

// Hardhat local: hostname-derived URL so the dapp works across Docker port
// mappings and Tailscale (UI on 3032 → RPC on 3033). Falls back to localhost.
function devRpcUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:3033';
  const port = parseInt(window.location.port || '3032') + 1;
  return `http://${window.location.hostname}:${port}`;
}

const CHAINS: Record<number, ChainConfig> = {
  // Hardhat local (deterministic addresses from deploy.js fixed deploy order)
  [DEV_CHAIN_ID]: {
    chainName: 'Hardhat',
    // Deterministic addresses from scripts/deploy.js's fixed deploy order
    // (phase 2): token FIRST, then each child behind a SatoriProxy (impl then
    // proxy, so every child address is its PROXY), then engine impl+proxy, hub
    // impl+proxy, adapters, LENS, then merkle last (merkle only when deploy.js
    // runs with ROOT_PUBLISHER set). The dapp targets the PROXY addresses
    // below — implementations are internal and not listed.
    //
    // `merkle` moved on 2026-08-01: it is now deployed impl-then-proxy like
    // every other child (docs/issues/closed/merkle-behind-a-proxy-decision.md), so the
    // address below is the PROXY. The old value (0xf5059a…) is now its
    // implementation — verified against a real localhost deploy, not derived.
    // The token is the ONE address here that is not nonce-derived: it deploys
    // through the CREATE2 factory so its address is reproducible on every chain
    // (SuperchainERC20 requirement 4). Everything below it still uses plain
    // CREATE and is unchanged — the factory call consumes exactly one deployer
    // nonce, same as the direct deploy it replaced, so nothing downstream shifted.
    // The token is deterministic via the CREATE2 factory ONLY while its bytecode
    // and constructor args are unchanged — change the token source and the
    // address moves, silently. It went stale twice this way: on 2026-08-25, and
    // again on 2026-09-24 when the 3M reward cap moved out of the token into the
    // hub. Because balanceOf / deploymentRound / PLATFORM_FEE_RECIPIENT are all
    // TOKEN calls, a stale address makes every one return "0x" and the whole
    // dashboard reads empty on a fresh local chain — the symptom is a blank
    // dashboard, not an error. Re-read from a clean `deploy.js --network localhost`
    // whenever the token changes. `lens`/`merkle` deploy after the adapters, so
    // re-read them from satori/deployments/localhost.json whenever deploy.js
    // changes what deploys before them.
    token: "0x82E436F31d73BbF6b0BFf190D527679242eDb6af",
    airdrop: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    engine: "0x0DCd1Bf9A1b36cE34237eEaFef220932846BCD82",
    hub: "0x0B306BF915C4d645ff596e518fAf3F9669b97016",
    registry: "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
    voting: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    rewards: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
    games: "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    bounties: "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e",
    lens: "0x8f86403A4DE0BB5791fa46B8e795C547942fE4Cf",
    merkle: "0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00",
    multicall: "0xcA11bde05977b3631167028862bE2a173976CA11",
    rpcUrls: [devRpcUrl()],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: [],
  },

  // Base Sepolia — the rehearsal chain. These are REAL deployed addresses, taken
  // from satori/deployments/baseSepolia.json (2026-09-19 redeploy — cap moved to the hub) rather than typed
  // by hand; every one is checked against that book by the dapp's own test.
  //
  // D4 is a FRESH stack, not an upgrade of D3. The rolling-scoring redesign
  // broke storage lineage (and `gameApproved`'s booleans keep their bytes while
  // inverting meaning, so an in-place upgrade would silently mark every enabled
  // game unapproved). Rounds are now 24h rather than 12h, which is why
  // deploymentRound roughly halves against the D3 value that used to sit here.
  //
  // This is a REHEARSAL deployment: governance is intended to end at a 3-of-5
  // Safe whose owner keys live in the repo's plaintext .wallets.env, so nothing
  // here is secured in any meaningful sense. It exists to exercise the flow.
  // Until scripts/handoff.js runs and the Safe accepts, the governor and rewards
  // admin are still the deployer EOA.
  [TESTNET_CHAIN_ID]: {
    chainName: 'Base Sepolia',
    deploymentRound: 20740, // pinned to satori/deployments/baseSepolia.json (2026-10-14 redeploy from humble, block 48094944)
    // Rehearsal holder-voting governor: 256-block activation window. The
    // VOTING_PERIOD is 604800s (7 days), read off chain; the 2026-09-25 governor
    // was 7 days too, despite an older note here saying 30 minutes. Redeployed 2026-10-14.
    holderGovernor: '0x931105bFe293d46298F5bC91A8D863a3d816e408',
    token: '0x4dee947383d5C9c8E421F55Fe3518a29324aE469',
    // SatoriAirdrop ships with the 2026-10-14 stack; nonzero shows the airdrop panel.
    airdrop: '0xF15CEAec0e29A0B6551180F8617850bc5356938C',
    engine: '0xE8fA688ea29850305216121C0bddfFb9096A1093',
    hub: '0x1eec7E1443C1065ab78180A14326e5Ac8284f143',
    registry: '0x1ED75AB0a66Ba7d23C3E5c84798e90205E76743a',
    voting: '0x5A56279215684A8088234799FfD56f806AcFBb6e',
    rewards: '0xde5d2B4b92c1231EC19cd3877D7C3eb6b44982Ac',
    games: '0xB06e419D24cCbA967c6193e9e374117171B400C3',
    bounties: '0x7FEaA67a4d4D8c9462A0d8d643984227C7710dCF',
    lens: '0x9BF5266F60092F1bFbd5F16d21d0bE9673c0F91F',
    // The 2026-10-14 stack DOES deploy a merkle proxy (0x78C83AE275e9659Bc8490fa33943e22ec7c5A7e7),
    // but the airdrop lane has never been wired or exercised on a rehearsal
    // stack. Left at the ZERO address deliberately, exactly as before: a dapp
    // that reverts is better than one silently reading a root nobody published.
    // Put the proxy address here if and when that lane is actually used.
    merkle: '0x0000000000000000000000000000000000000000',
    multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
    rpcUrls: [
      'https://sepolia.base.org',
      'https://base-sepolia-rpc.publicnode.com',
    ],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://sepolia.basescan.org'],
    // Same-origin with the dapp: on Satori Central both are behind one nginx and
    // one certificate, so the indexer is a path rather than a host. That is why
    // this can be committed at all — the earlier comment here said there was no
    // public indexer to point at, and while that was true the dapp never called
    // one: `indexerUrl` was unset on every chain, so all five history consumers
    // silently took the browser-side event-scan path. The scan path remains the
    // fallback on any failure, so a bad URL degrades rather than breaks.
    indexerUrl: 'https://app.satorinet.io/api',
    // Gasless relayer, same-origin at /relayer (nginx strips the prefix, so the
    // service keeps its own /gasless/* routes). Present = the pay-in-SATORI
    // surface is live on this chain; unset = it's absent. See ../../relayer and
    // docs/design/gasless-relay.md.
    relayerUrl: 'https://app.satorinet.io/relayer',
    // Coined's indexer (coined/indexer) for the named-stream name box: its own
    // host, under /idx (nginx strips the prefix; the service keeps /names,
    // /search, /lookalike). It answers with Access-Control-Allow-Origin: *,
    // and a failure here only drops the coined suggestions.
    coinedIndexerUrl: 'https://coined.satorinet.io/idx',
    // A (top, = the token's immutable platformFeeRecipient), then C and B.
    splitters: [
      '0xcfB35ff791Ab9D7fFB70eD0e934F8298B9b94464',
      '0xb0d5c95C5557BF45409C37429e5275987446D3f3',
      '0x06963bB2c7e17de638AE5262740831f5EC7E1f65',
    ],
  },

  // Base mainnet — public RPCs, no API key required. Order is failover order:
  // first one that answers stays sticky until it doesn't. Add an Alchemy /
  // Infura / QuickNode endpoint at the front later for higher throughput.
  [PROD_CHAIN_ID]: {
    chainName: 'Base',
    // TODO: set all of these from scripts/deploy.js output (deployments/base.json).
    token: '0x0000000000000000000000000000000000000000',
    airdrop: '0x0000000000000000000000000000000000000000',
    engine: '0x0000000000000000000000000000000000000000',
    hub: '0x0000000000000000000000000000000000000000',
    registry: '0x0000000000000000000000000000000000000000',
    voting: '0x0000000000000000000000000000000000000000',
    rewards: '0x0000000000000000000000000000000000000000',
    // TODO: set from deploy output (or read hub.satoriGames()/satoriBounties()).
    games: '0x0000000000000000000000000000000000000000',
    bounties: '0x0000000000000000000000000000000000000000',
    merkle: '0x0000000000000000000000000000000000000000', // TODO: set from deploy (hub.satoriMerkle())
    lens: '0x0000000000000000000000000000000000000000',
    multicall: '0xcA11bde05977b3631167028862bE2a173976CA11', // Multicall3 — same address on every EVM chain
    rpcUrls: [
      'https://mainnet.base.org',
      'https://base.publicnode.com',
      'https://base-rpc.publicnode.com',
      'https://base.llamarpc.com',
    ],
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    blockExplorerUrls: ['https://basescan.org'],
    // TODO: set to the deployed satori-indexer URL alongside the addresses.
  },
};

/// satori-indexer base URL for a chain, or null when none is configured
/// (→ consumers use the event-scan path only). REACT_APP_INDEXER_URL
/// overrides per build — how dev/staging point at a local indexer without
/// committing a URL here.
export function getIndexerUrl(chainId: number): string | null {
  const override = process.env.REACT_APP_INDEXER_URL;
  if (override) return override.replace(/\/+$/, '');

  // REACT_APP_INDEXER_PORT derives the host the same way devRpcUrl() does, and
  // for the same reason: the browser may not be on the machine running the
  // indexer. Over Tailscale or a Docker port map, a baked-in `localhost` points
  // the browser at itself and every request fails. Deriving from
  // window.location.hostname makes one build work from anywhere that can reach
  // the host at all.
  const port = process.env.REACT_APP_INDEXER_PORT;
  if (port && typeof window !== 'undefined') {
    return `http://${window.location.hostname}:${port}`;
  }

  const url = CHAINS[chainId]?.indexerUrl;
  return url ? url.replace(/\/+$/, '') : null;
}

/// Coined's indexer (the list of coined terms, for the named-stream name box).
/// Derived exactly like getIndexerUrl; unset = suggestions from Satori's own
/// streams only.
export function getCoinedIndexerUrl(chainId: number): string | null {
  const override = process.env.REACT_APP_COINED_INDEXER_URL;
  if (override) return override.replace(/\/+$/, '');
  const port = process.env.REACT_APP_COINED_INDEXER_PORT;
  if (port && typeof window !== 'undefined') {
    return `http://${window.location.hostname}:${port}`;
  }
  const url = CHAINS[chainId]?.coinedIndexerUrl;
  return url ? url.replace(/\/+$/, '') : null;
}

/// Holder-voting governor for a chain, or null when none is deployed there.
/// REACT_APP_HOLDER_GOVERNOR overrides per build (dev redeploys constantly, so
/// dev never pins one here — same reasoning as deploymentRound).
export function getHolderGovernor(chainId: number): string | null {
  return process.env.REACT_APP_HOLDER_GOVERNOR || CHAINS[chainId]?.holderGovernor || null;
}

/// Gasless-relayer base URL for a chain, or null when none is configured
/// (→ no pay-in-SATORI surface at all). Same override/port derivation as
/// getIndexerUrl, for the same Tailscale/Docker reason.
export function getRelayerUrl(chainId: number): string | null {
  const override = process.env.REACT_APP_RELAYER_URL;
  if (override) return override.replace(/\/+$/, '');
  const port = process.env.REACT_APP_RELAYER_PORT;
  if (port && typeof window !== 'undefined') {
    return `http://${window.location.hostname}:${port}`;
  }
  const url = CHAINS[chainId]?.relayerUrl;
  return url ? url.replace(/\/+$/, '') : null;
}

/// satori-proof-pipeline base URL for a chain, or null. Same override/port
/// derivation dance as getIndexerUrl above, for the same Tailscale/Docker
/// reason.
export function getProofsUrl(chainId: number): string | null {
  const override = process.env.REACT_APP_PROOFS_URL;
  if (override) return override.replace(/\/+$/, '');
  const port = process.env.REACT_APP_PROOFS_PORT;
  if (port && typeof window !== 'undefined') {
    return `http://${window.location.hostname}:${port}`;
  }
  const url = CHAINS[chainId]?.proofsUrl;
  return url ? url.replace(/\/+$/, '') : null;
}

export function getAddresses(chainId: number): ContractAddresses {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`No addresses for chain ${chainId}`);
  return c;
}

export function getRpcUrls(chainId: number): string[] {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`No RPC URLs for chain ${chainId}`);
  return c.rpcUrls;
}

export function getChainConfig(chainId: number): ChainConfig {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`No config for chain ${chainId}`);
  return c;
}
