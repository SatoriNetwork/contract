import { useMemo } from 'react';
import { ethers } from 'ethers';
import { useWallet } from './useWallet';
import { getAddresses } from '../contracts/addresses';
import TokenABI from '../contracts/SatoriToken.json';
import EngineABI from '../contracts/SatoriEngine.json';
import HubABI from '../contracts/SatoriHub.json';
import RegistryABI from '../contracts/SatoriRegistry.json';
import VotingABI from '../contracts/SatoriVoting.json';
import RewardsABI from '../contracts/SatoriRewards.json';
import GamesABI from '../contracts/SatoriGames.json';
import BountiesABI from '../contracts/SatoriBounties.json';
import MerkleABI from '../contracts/SatoriMerkle.json';
import LensABI from '../contracts/SatoriRewardsLens.json';
import AirdropABI from '../contracts/SatoriAirdrop.json';
import MulticallABI from '../contracts/Multicall.json';
import { makeSatoriFacade } from '../lib/satoriFacade';
import { makeCachedReads } from '../lib/cachedContract';

export function useContracts() {
  const { provider, signer, chainId, isConnected } = useWallet();

  const contracts = useMemo(() => {
    if (!provider) return null;
    try {
      const addrs = getAddresses(chainId);
      // Reads use the resilient JsonRpcProvider; writes use the signer when
      // connected. Calling a state-changing method without a signer throws —
      // the prediction/claim/vote buttons are gated on `isConnected` already.
      const signerOrProvider = signer ?? provider;

      // The protocol split into three contracts: immutable SatoriToken (ERC20 +
      // round clock), upgradeable SatoriEngine (prediction state/logic, behind a
      // proxy) and SatoriHub (the user-facing facade). `satori` re-assembles the
      // old single-object surface via a method-routing Proxy, so every existing
      // call site keeps working unchanged (see lib/satoriFacade.ts).
      const token = new ethers.Contract(addrs.token, TokenABI.abi, signerOrProvider);
      const engine = new ethers.Contract(addrs.engine, EngineABI.abi, signerOrProvider);
      const hub = new ethers.Contract(addrs.hub, HubABI.abi, signerOrProvider);
      // Views migrated off the hub in audit LA-4 resolve here (routed last).
      const lens = new ethers.Contract(addrs.lens, LensABI.abi, signerOrProvider);

      // The same four, on the resilient read provider (see `reads` below).
      const rToken = new ethers.Contract(addrs.token, TokenABI.abi, provider);
      const rEngine = new ethers.Contract(addrs.engine, EngineABI.abi, provider);
      const rHub = new ethers.Contract(addrs.hub, HubABI.abi, provider);
      const rLens = new ethers.Contract(addrs.lens, LensABI.abi, provider);

      const base = {
        satori: makeSatoriFacade(token, engine, hub, lens),
        token,
        engine,
        hub,
        registry: new ethers.Contract(addrs.registry, RegistryABI.abi, signerOrProvider),
        voting: new ethers.Contract(addrs.voting, VotingABI.abi, signerOrProvider),
        rewards: new ethers.Contract(addrs.rewards, RewardsABI.abi, signerOrProvider),
        games: new ethers.Contract(addrs.games, GamesABI.abi, signerOrProvider),
        bounties: new ethers.Contract(addrs.bounties, BountiesABI.abi, signerOrProvider),
        merkle: new ethers.Contract(addrs.merkle, MerkleABI.abi, signerOrProvider),
        airdrop: new ethers.Contract(addrs.airdrop, AirdropABI.abi, signerOrProvider),
        // Read-only computed views (getTotalClaimableRewards, plus everything
        // migrated off the hub in audit LA-4).
        lens,
        multicall: new ethers.Contract(addrs.multicall, MulticallABI.abi, signerOrProvider),

        // READ-ONLY twins, bound to the resilient provider rather than the
        // wallet. The comment above describes the intent; `signerOrProvider`
        // does not deliver it, because a Contract whose runner is a signer reads
        // through the SIGNER's provider — the wallet's RPC. So once connected,
        // every read silently lost the dedupe, the concurrency gate, the retry
        // and the failover, which is exactly when a user is generating load.
        //
        // Hooks doing reads should use these. `contracts.*` above stays
        // signer-bound so every existing write keeps working untouched.
        // See docs/issues/closed/dapp-reads-bypass-resilient-provider.md.
        reads: {
          satori: makeSatoriFacade(rToken, rEngine, rHub, rLens),
          token: rToken,
          engine: rEngine,
          hub: rHub,
          lens: rLens,
          registry: new ethers.Contract(addrs.registry, RegistryABI.abi, provider),
          voting: new ethers.Contract(addrs.voting, VotingABI.abi, provider),
          rewards: new ethers.Contract(addrs.rewards, RewardsABI.abi, provider),
          games: new ethers.Contract(addrs.games, GamesABI.abi, provider),
          bounties: new ethers.Contract(addrs.bounties, BountiesABI.abi, provider),
          merkle: new ethers.Contract(addrs.merkle, MerkleABI.abi, provider),
          airdrop: new ethers.Contract(addrs.airdrop, AirdropABI.abi, provider),
          multicall: new ethers.Contract(addrs.multicall, MulticallABI.abi, provider),
        },
      };

      // Cached views of the same reads, one handle per staleness class. Which
      // handle a call site reaches through IS the policy, so the freshness rule
      // is visible in the code rather than in a lookup table somewhere else.
      //
      //   cached.round — Class 2/5: frozen per-round snapshots, per-round
      //                  ceilings, governance values. One read per 12h,
      //                  expiring exactly at the boundary.
      //   cached.live  — Class 4: anything another person can move. 30s, and an
      //                  explicit user refresh bypasses it.
      //
      // Class 1 goes through lib/chainValues.ts instead, which also persists.
      // See docs/design/dapp-cache-invalidation-map.md.
      return { ...base, cached: makeCachedReads(base.reads) };
    } catch (e) {
      console.error("Failed to create contracts:", e);
      return null;
    }
  }, [provider, signer, chainId]);

  return { contracts, isConnected };
}
