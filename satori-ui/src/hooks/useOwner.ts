import { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';
import { explainError, EMISSION_RATIO_COPY } from '../utils/errors';
import { getCurrentRound, getPlatformFeeRecipient, getDeploymentRound } from '../lib/chainValues';
import { afterTx } from '../lib/afterTx';
import { EmissionStatus, toEmissionStatus, parseRatioWad } from '../lib/emissionStatus';

const ZERO = '0x0000000000000000000000000000000000000000';

// THE AUTO FEE SCHEDULE IS GONE. There were three constants here mirroring
// SatoriToken's 20% -> 10% -> 5% dev tiers and the rounds they stepped on. The
// fee has no tiers and no clock now, so there is no countdown to display and
// nothing for the UI to anchor.
//
// It is `devFeeBps`, 1500 (15%), a constant nobody can move.
//
// What DOES move is the emission itself, in SatoriHub, and it moves with how
// much SATORI has been issued, not with the date: 846.62 on day 1, then multiplied by
// the admin-set ratio (default 1 − 846.62/2,900,000, i.e. −0.0292%) each time
// another round's worth at the current rate is issued, never above 1440. That is a separate thing from the fee, and the fee is a
// percentage of it throughout.

export interface OwnerData {
  // The protocol "owner" identity. The hub's `owner()` is address(0) (ownerless),
  // so the admin lives on SatoriRewards and gates every privileged action here.
  admin: string;
  defaultStreamInitialized: boolean;
  // The platform fee: a percentage of everything minted (SatoriToken.devFeeBps),
  // 15%, a constant: no setter and no schedule. Its per-round form is computed at the HUB
  // (`devRateNow = emissionRateNow x devFeeBps`) because the token no longer
  // knows the emission rate. The recipient is the immutable
  // PLATFORM_FEE_RECIPIENT and has no setter at all.
  platformFeeBps: number;             // basis points, live
  platformFeeRecipient: string;       // read-only constant, no setter
  protocolFeePerRound: bigint;        // raw token amount (wei) for THIS round
  /// This round's emission under the hub's issuance-indexed schedule (wei). The dial
  /// and the fee are both slices of THIS, not of the token's 1440 envelope.
  emissionRatePerRound: bigint;
  /// Null when the lens predates `emissionStatus()`.
  emission: EmissionStatus | null;
  emissionHolder: string;        // SatoriHub.emissionHolder() — sets the step multiplier
  /// The token's deploymentRound. Was the anchor the dev-fee tiers stepped down
  /// from; there are no tiers any more, so it is just the deploy anchor.
  feeScheduleStartRound: number;
  currentRound: number;
  // Off-chain reward channel — the split + the Merkle claim channel.
  offchainShareBps: number;           // share of each round's residual routed off-chain (0..9999)
  onChainRewardCeiling: bigint;       // cumulative wei the on-chain lane may mint (reported - reserve)
  merkleReserveCeiling: bigint;       // cumulative wei the Merkle lane may mint (accrued share)
  registrationFee: bigint;            // wei burned to register a community stream or game adapter
  merkleWired: boolean;               // satoriMerkle set on the core
  merkleRoot: string;                 // current published root (bytes32)
  rootPublisher: string;              // who may set the root (SatoriMerkle.rootPublisher)
  // The one key allowed to add off-chain predictions to the default stream's
  // running count (SatoriEngine.offchainReporter). Zero = feature off.
  offchainReporter: string;
  // `rewards.admin` was split (2026-09-14): two jobs with real blast radius got
  // their own slots. ZERO means the slot is unset and `admin` still holds the
  // job — so these are reported RESOLVED, as the address that can actually act.
  emissionSplitHolder: string;   // holds setOffchainShareBps (the split)
  airdropHolder: string;         // SatoriAirdrop.airdropAuthority — loadAirdropBatch / finalizeAirdropLoading
  airdropLoadedTotal: bigint;    // SatoriAirdrop.airdropLoadedTotal — sum of every loaded allocation
  // The token's mint ceiling for the airdrop; loading refuses past it.
  airdropCap: bigint;            // SatoriAirdrop.AIRDROP_TOTAL_SUPPLY (read through to the token)
  airdropLoadingFinalized: boolean; // SatoriAirdrop.airdropLoadingFinalized — loading closed
  // The token mints airdrop only through this pointer, so rows loaded into any
  // other airdrop contract never pay.
  airdropPointsHere: boolean;    // token.airdrop() == this SatoriAirdrop
  freezeAuthority: string;       // token.freezeAuthority
  // THE GOVERNOR IS SPLIT (dao-governance.md v2). It used to be one address
  // gating the fee, every upgrade and all three token pointers; it is now one
  // slot per job, so each can be a different Safe. `root` assigns the others.
  //
  // Only `root` and its pending successor are surfaced here — this page is about
  // who holds the keys, and the remaining slots are read where they are used.
  governor: string;          // = token.rootAuthority()
  pendingGovernor: string;   // = token.pendingRootAuthority()
  // Streak-curve dials (SatoriEngine, governor-gated). W(streak, h, g, r, b):
  // h = max(curveFloor, adaptive threshold); g/r the above/below-bar gradients; b a
  // flat above-bar lift. Bounds f∈[1,64], g∈[1,8], r∈[g,64], b∈[0,64]; r≥g enforced.
  curveFloor: number;      // f
  curveTopGrad: number;    // g
  curveBotGrad: number;    // r
  curveTopShift: number;   // b
  // The dust-threshold CONTROLLER's setpoint, in bps: the share of prediction POWER
  // aimed to sit below the bar. Not a curve dial — it never enters W(s,h,g,r,b) — so it
  // is read from its own view, not curveConfig(). Range 0..9999.
  dustTarget: number;
}

export function useOwner() {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [data, setData] = useState<OwnerData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!contracts) return;
    setLoading(true);
    try {
      const [
        admin,
        initd,
        emissionRatePerRound,
        devRatePerRound,
        recipient,
        deploymentRound,
        currentRound,
        governor,
        pendingGovernor,
      ] = await Promise.all([
        contracts.cached.round.rewards.admin(),
        contracts.cached.round.satori.defaultStreamInitialized(),
        // THE REAL FEE, from the HUB. This used to read rewards.feeSlot() and
        // rewards.feeScheduleStartRound() — storage that went dead when the fee
        // moved to the immutable SatoriToken and was kept only to hold proxy
        // slots. Both read 0 forever, so this page showed "0 bps" for a real fee.
        // It then read `token.devRateNow()`, which is gone: the token cannot
        // compute a per-round slice any more because the emission schedule lives
        // in the hub. The hub answers both.
        contracts.cached.round.satori.emissionRateNow(),
        contracts.cached.round.satori.devRateNow(),
        getPlatformFeeRecipient(contracts.reads),
        getDeploymentRound(contracts.reads),
        getCurrentRound(),
        contracts.cached.round.token.rootAuthority(),
        contracts.cached.round.token.pendingRootAuthority(),
      ]);
      // The hub publishes the fee as WEI PER ROUND; bps is the derived view,
      // taken against THIS ROUND'S EMISSION — not against the token's 1440
      // envelope, which would have shown a moving fee percentage every time the
      // emission stepped, for a fee that is a flat 15% forever.
      const emission = BigInt(emissionRatePerRound);
      const perRound = BigInt(devRatePerRound);
      const bps = emission === BigInt(0)
        ? 0
        : Number((perRound * BigInt(10000)) / emission);

      // Off-chain reward channel. The split + lane ceilings are always present on
      // a wired core; the Merkle-contract reads are guarded (it may be unwired).
      let offchainShareBps = 0, onChainRewardCeiling = BigInt(0), merkleReserveCeiling = BigInt(0);
      let registrationFee = BigInt(0);
      let merkleWired = false, merkleRoot = ethers.ZeroHash, rootPublisher = ZERO;
      try {
        let shareRaw: bigint;
        [shareRaw, onChainRewardCeiling, merkleReserveCeiling] = await Promise.all([
          contracts.cached.round.rewards.offchainShareBps(),
          contracts.cached.live.satori.onChainRewardCeiling(),   // moves with every scored win
          contracts.cached.round.satori.merkleReserveCeiling(),
        ]);
        offchainShareBps = Number(shareRaw);
      } catch (e) { console.warn('split reads failed:', e); }
      try { registrationFee = BigInt(await contracts.cached.round.rewards.registrationFee()); }
      catch (e) { console.warn('registration fee read failed:', e); }
      try {
        const wired = await contracts.cached.round.satori.satoriMerkle();
        merkleWired = !!wired && wired !== ZERO;
        if (merkleWired) {
          [merkleRoot, rootPublisher] = await Promise.all([
            contracts.cached.round.merkle.merkleRoot(),
            contracts.cached.round.merkle.rootPublisher(),
          ]);
        }
      } catch (e) { console.warn('merkle reads failed:', e); }

      // The off-chain reporter key. Guarded like the merkle reads: an engine
      // deployed before this feature has no such function, and a failed read
      // must leave the page usable rather than blanking it.
      // Resolve the split-out rewards slot. Guarded like the merkle reads:
      // a rewards implementation deployed before the split has no such getter,
      // and a failed read must leave the page usable rather than blanking it.
      let emissionSplitHolder = admin;
      try {
        const es = await contracts.cached.round.rewards.emissionSplitAuthority();
        if (es && es !== ZERO) emissionSplitHolder = es;
      } catch (e) { console.warn('rewards authority-slot read failed:', e); }

      // The airdrop loader is its own role on SatoriAirdrop, with no admin
      // fallback. ZERO means the dapp has no airdrop contract for this chain
      // (a stack that predates it); the Admin row hides on zero.
      let airdropHolder = ZERO, airdropLoadedTotal = BigInt(0), airdropCap = BigInt(0), airdropLoadingFinalized = false;
      let airdropPointsHere = false, freezeAuthority = ZERO;
      try {
        const [holder, loaded, cap, finalized] = await Promise.all([
          contracts.cached.round.airdrop.airdropAuthority(),
          contracts.cached.live.airdrop.airdropLoadedTotal(),
          contracts.cached.round.airdrop.AIRDROP_TOTAL_SUPPLY(),
          contracts.cached.live.airdrop.airdropLoadingFinalized(),
        ]);
        airdropHolder = holder;
        airdropLoadedTotal = BigInt(loaded);
        airdropCap = BigInt(cap);
        airdropLoadingFinalized = Boolean(finalized);
      } catch (e) { console.warn('airdrop reads failed:', e); }
      try {
        const [pointer, freezer] = await Promise.all([
          contracts.cached.live.token.airdrop(),
          contracts.cached.round.token.freezeAuthority(),
        ]);
        airdropPointsHere = String(pointer).toLowerCase() === String(contracts.reads.airdrop.target).toLowerCase();
        freezeAuthority = freezer;
      } catch (e) { console.warn('token airdrop-door reads failed:', e); }

      let emissionStatus: EmissionStatus | null = null;
      let emissionHolder = ZERO;
      try {
        emissionStatus = toEmissionStatus(await contracts.cached.live.lens.emissionStatus());
        emissionHolder = emissionStatus.holder;
      } catch (e) {
        console.warn('emissionStatus read failed:', e);
        try { emissionHolder = await contracts.cached.round.hub.emissionHolder(); }
        catch (e2) { console.warn('emissionHolder read failed:', e2); }
      }

      let offchainReporter = ZERO;
      try {
        offchainReporter = await contracts.cached.round.engine.offchainReporter();
      } catch (e) { console.warn('offchainReporter read failed:', e); }

      // Streak-curve dials (governor-gated). Effective values (0-storage ⇒ defaults).
      let curveFloor = 2, curveTopGrad = 3, curveBotGrad = 12, curveTopShift = 0;
      try {
        const cfg = await contracts.cached.round.engine.curveConfig();
        curveFloor = Number(cfg[0]); curveTopGrad = Number(cfg[1]);
        curveBotGrad = Number(cfg[2]); curveTopShift = Number(cfg[3]);
      } catch (e) { console.warn('curveConfig read failed:', e); }
      // The controller SETPOINT is deliberately NOT part of curveConfig() — it never
      // enters W(s,h,g,r,b), it only decides where the bar settles — so it has its own
      // view and is read separately. Fallback is the compiled default.
      let dustTarget = 8000;
      try {
        dustTarget = Number(await contracts.cached.round.engine.dustTargetBps());
      } catch (e) { console.warn('dustTargetBps read failed:', e); }

      setData({
        admin,
        defaultStreamInitialized: Boolean(initd),
        platformFeeBps: bps,
        platformFeeRecipient: recipient,
        protocolFeePerRound: perRound,
        emissionRatePerRound: emission,
        emission: emissionStatus,
        emissionHolder,
        feeScheduleStartRound: Number(deploymentRound),
        currentRound: Number(currentRound),
        offchainShareBps, onChainRewardCeiling, merkleReserveCeiling, registrationFee,
        merkleWired, merkleRoot, rootPublisher,
        offchainReporter,
        emissionSplitHolder,
        airdropHolder, airdropLoadedTotal, airdropCap, airdropLoadingFinalized,
        airdropPointsHere, freezeAuthority,
        governor, pendingGovernor,
        curveFloor, curveTopGrad, curveBotGrad, curveTopShift,
        dustTarget,
      });
    } catch (e) {
      console.error('Owner data load failed:', e);
    } finally {
      setLoading(false);
    }
  }, [contracts]);

  useEffect(() => { load(); }, [load]);

  // Roles under the governor model: the rewards ADMIN (fee/airdrop/admin ops),
  // the token GOVERNOR (pointers, upgrades, setChild/setSatoriMerkle), and the
  // merkle ROOT PUBLISHER. The hub's `owner()` is address(0) by design — never
  // used for gating.
  const isOwner = !!(data && address && data.admin.toLowerCase() === address.toLowerCase());
  // Gate the two split-out jobs on their ACTUAL holder, not on `admin`. Before
  // the split those were the same address; now showing an admin a dial they
  // cannot move would be a button that always reverts.
  const isEmissionSplitHolder = !!(data && address &&
    data.emissionSplitHolder.toLowerCase() === address.toLowerCase());
  const isEmissionHolder = !!(data && address && data.emissionHolder !== ZERO &&
    data.emissionHolder.toLowerCase() === address.toLowerCase());
  const isAirdropHolder = !!(data && address &&
    data.airdropHolder.toLowerCase() === address.toLowerCase());
  const isFreezeAuthority = !!(data && address && data.freezeAuthority !== ZERO &&
    data.freezeAuthority.toLowerCase() === address.toLowerCase());
  const isGovernor = !!(data && address && data.governor.toLowerCase() === address.toLowerCase());
  const isRootPublisher = !!(data && address && data.rootPublisher !== ZERO && data.rootPublisher.toLowerCase() === address.toLowerCase());
  /// Holder of the off-chain reporter key. Like isRootPublisher, an UNSET
  /// (zero) key must never match a connected wallet.
  const isOffchainReporter = !!(data && address && data.offchainReporter !== ZERO && data.offchainReporter.toLowerCase() === address.toLowerCase());
  // Any privileged role unlocks the owner tab; each action still gates on its
  // own specific role (the chain enforces regardless).
  const isPrivileged = isOwner || isGovernor || isRootPublisher || isOffchainReporter
    || isEmissionSplitHolder || isAirdropHolder || isEmissionHolder || isFreezeAuthority;

  // Action helpers — each returns { ok: true } | { ok: false, error: string }
  const run = useCallback(async (
    fn: () => Promise<any>,
    copy?: Record<string, string>,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      const tx = await fn();
      await afterTx(tx);
      await load();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: explainError(e, copy) };
    }
  }, [load]);

  // Transfer the admin (owner) role.
  const setAdmin = useCallback(async (newAdmin: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    if (!ethers.isAddress(newAdmin) || newAdmin === ZERO) {
      return { ok: false as const, error: 'Invalid address' };
    }
    return run(() => contracts.rewards.setAdmin(newAdmin));
  }, [contracts, run]);

  const initializeDefaultStream = useCallback(async () => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    return run(() => contracts.satori.initializeDefaultStream());
  }, [contracts, run]);

  /// Permissionless pull: realize the dev fee accrued on the wall clock. Anyone
  /// may call it; funds only ever go to the immutable PLATFORM_FEE_RECIPIENT, so
  /// there is no griefing surface.
  ///
  /// This called `rewards.accrueProtocolFee()` until 2026-08-20, a name that had
  /// not existed on any contract for some time — the button threw in the browser
  /// rather than reverting. It lives on the immutable token as `mintDevFee`.
  const accrueProtocolFee = useCallback(async () => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    return run(() => contracts.token.mintDevFee());
  }, [contracts, run]);

  /// Gated on `rewards.emissionSplitAuthority` (falling back to `admin` while
  /// that slot is unset). Set the off-chain share as a percent of each round's
  /// emission net of the dev fee; below 100, the bound
  /// SatoriRewards.setOffchainShareBps enforces. Takes effect next round.
  const setOffchainShare = useCallback(async (percent: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    const t = percent.trim().replace(/%$/, '');
    const p = Number(t);
    if (!/^\d+(\.\d{1,2})?$/.test(t) || !(p >= 0 && p < 100)) {
      return { ok: false as const, error: 'Enter a percent from 0 to 99.99, e.g. 50' };
    }
    return run(() => contracts.rewards.setOffchainShareBps(Math.round(p * 100)));
  }, [contracts, run]);

  /// Rewards-admin-gated. What registering a community stream or game adapter
  /// burns, in SATORI. Raise it before opening capability bits 2 and 3: each
  /// registration takes one of 65,535 ids. Zero is refused by the contract.
  const setRegistrationFee = useCallback(async (amountSatori: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    let wei: bigint;
    try { wei = ethers.parseEther(amountSatori.trim()); }
    catch { return { ok: false as const, error: 'Enter a SATORI amount, e.g. 1' }; }
    if (wei <= BigInt(0)) return { ok: false as const, error: 'Must be more than 0' };
    return run(() => contracts.rewards.setRegistrationFee(wei));
  }, [contracts, run]);

  /// Gated on `SatoriHub.emissionHolder()`. Sets the multiplier the NEXT
  /// emission step applies; this round's and next round's rates do not move.
  /// 1 stops steps entirely; 0 reverts (a dust multiplier winds emission down).
  const setEmissionRatio = useCallback(async (ratio: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    const wad = parseRatioWad(ratio);
    if (typeof wad !== 'bigint') return { ok: false as const, error: wad.err };
    return run(() => contracts.hub.setEmissionRatio(wad), EMISSION_RATIO_COPY);
  }, [contracts, run]);

  /// Rewards-admin-gated. Approve a game for rewards (true = ON) or revoke the
  /// approval. Games are BORN unapproved and earn nothing until this switch is
  /// thrown; the DEFAULT game is exempt (SatoriVoting.gameLive returns true for
  /// it regardless). An unapproved game's VOTERS KEEP THEIR VOTES, untouched —
  /// and can re-point them to a live game themselves via moveVotes, which is
  /// the whole reason this replaced the old lever that moved people's votes for
  /// them. Reversible: gameWeight is never cleared, so re-approving restores
  /// whatever weight has not been moved away.
  const setGameApproved = useCallback(async (gameId: number, approved: boolean) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    if (!Number.isInteger(gameId) || gameId <= 0) return { ok: false as const, error: 'Pick a game' };
    return run(() => contracts.voting.setGameApproved(gameId, approved));
  }, [contracts, run]);

  /// Wiring-gated (token.wiringAuthority, via the hub). Wire the SatoriMerkle child
  /// on the hub ONCE — reverts AlreadySet if a merkle is already wired (not
  /// re-pointable); closes the "merkle not wired" dead-end.
  const setSatoriMerkle = useCallback(async (addr: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    if (!ethers.isAddress(addr) || addr === ZERO) return { ok: false as const, error: 'Invalid address' };
    return run(() => contracts.satori.setSatoriMerkle(addr));
  }, [contracts, run]);

  /// rootPublisher-gated. Rotate the merkle root-publisher key.
  const setRootPublisher = useCallback(async (addr: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    if (!ethers.isAddress(addr) || addr === ZERO) return { ok: false as const, error: 'Invalid address' };
    return run(() => contracts.merkle.setRootPublisher(addr));
  }, [contracts, run]);

  /// Admin-gated (SatoriRewards.admin). Set, rotate, or revoke the off-chain
  /// reporter key. ZERO is a legal value here — it is how the feature is turned
  /// OFF — so unlike setRootPublisher this must not reject it.
  const setOffchainReporter = useCallback(async (addr: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    if (!ethers.isAddress(addr)) return { ok: false as const, error: 'Invalid address' };
    return run(() => contracts.engine.setOffchainReporter(addr));
  }, [contracts, run]);

  /// Reporter-gated. Add `count` off-chain predictions to the CURRENT round's
  /// running total. Parsed as a whole number of predictors — the contract takes
  /// a uint64, and a decimal or a negative would be rejected at encoding with a
  /// worse message than this one.
  const reportOffchainPredictions = useCallback(async (count: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    const t = count.trim();
    if (!/^\d+$/.test(t)) return { ok: false as const, error: 'Enter a whole number of predictors' };
    const n = BigInt(t);
    if (n === BigInt(0)) return { ok: false as const, error: 'Nothing to report' };
    if (n > BigInt('18446744073709551615')) return { ok: false as const, error: 'Number too large' };
    return run(() => contracts.engine.reportOffchainPredictions(n));
  }, [contracts, run]);

  /// Gated on `SatoriAirdrop.airdropAuthority`. Load a batch of airdrop allocations:
  /// parallel address/amount arrays; amounts in SATORI (parsed to wei here).
  /// The contract does not cap the loaded total, so the cap is checked here on
  /// uncached reads, as scripts/load-airdrop.js does.
  const loadAirdropBatch = useCallback(async (entries: { address: string; amountSatori: string }[]) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    if (entries.length === 0) return { ok: false as const, error: 'No entries' };
    const addrs: string[] = [];
    const amounts: bigint[] = [];
    for (const e of entries) {
      if (!ethers.isAddress(e.address)) return { ok: false as const, error: `Invalid address: ${e.address}` };
      try { amounts.push(ethers.parseEther(e.amountSatori.trim())); }
      catch { return { ok: false as const, error: `Invalid amount for ${e.address}` }; }
      addrs.push(e.address);
    }
    let loaded: bigint, cap: bigint, finalized: boolean, door: string;
    try {
      const [l, c, f, d] = await Promise.all([
        contracts.reads.airdrop.airdropLoadedTotal(),
        contracts.reads.airdrop.AIRDROP_TOTAL_SUPPLY(),
        contracts.reads.airdrop.airdropLoadingFinalized(),
        contracts.reads.token.airdrop(),
      ]);
      loaded = BigInt(l); cap = BigInt(c); finalized = Boolean(f); door = String(d);
    } catch (e) {
      return { ok: false as const, error: explainError(e) };
    }
    if (finalized) {
      return { ok: false as const, error: 'The airdrop table is closed: loading was finalized, so nothing more can be loaded.' };
    }
    if (door.toLowerCase() !== String(contracts.reads.airdrop.target).toLowerCase()) {
      return { ok: false as const, error: 'The token\'s airdrop door does not point at this airdrop, so rows loaded here would not pay. If it points at a corrected airdrop, update this page\'s address book.' };
    }
    const batch = amounts.reduce((a, b) => a + b, BigInt(0));
    if (loaded + batch > cap) {
      return {
        ok: false as const,
        error: `Over the cap: ${ethers.formatEther(loaded)} SATORI already loaded plus ${ethers.formatEther(batch)} in this batch is more than ${ethers.formatEther(cap)}.`,
      };
    }
    return run(() => contracts.airdrop.loadAirdropBatch(addrs, amounts));
  }, [contracts, run]);

  /// Loader-gated, one-shot: closes loading for good. Claims do not wait for it.
  const finalizeAirdropLoading = useCallback(async () => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    return run(() => contracts.airdrop.finalizeAirdropLoading());
  }, [contracts, run]);

  /// rootPublisher-gated (SatoriMerkle.rootPublisher). Publish/replace the
  /// cumulative Merkle root ({user => lifetime entitlement}). Generate the root
  /// off-chain and paste the 0x…32-byte hash here. Roots must be monotonic
  /// non-decreasing per user.
  const setMerkleRoot = useCallback(async (root: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    const r = root.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(r)) return { ok: false as const, error: 'Root must be a 0x-prefixed 32-byte hex' };
    return run(() => contracts.merkle.setMerkleRoot(r));
  }, [contracts, run]);

  // --- Streak-curve dials (SatoriEngine, governor-gated) ---
  // Parse a whole-number dial in [min,max]; returns the number or an error string.
  const parseDial = (s: string, min: number, max: number): number | { err: string } => {
    const t = s.trim();
    if (!/^\d+$/.test(t)) return { err: 'Enter a whole number' };
    const n = Number(t);
    if (n < min || n > max) return { err: `Must be between ${min} and ${max}` };
    return n;
  };

  const setDustFloor = useCallback(async (v: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    const n = parseDial(v, 1, 64);
    if (typeof n !== 'number') return { ok: false as const, error: n.err };
    return run(() => contracts.engine.setDustFloor(n));
  }, [contracts, run]);

  const setTopGradient = useCallback(async (v: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    const n = parseDial(v, 1, 8);
    if (typeof n !== 'number') return { ok: false as const, error: n.err };
    if (data && n > data.curveBotGrad) {
      return { ok: false as const, error: `Top gradient g must be ≤ bottom gradient r (${data.curveBotGrad}). Raise r first.` };
    }
    return run(() => contracts.engine.setTopGradient(n));
  }, [contracts, run, data]);

  const setBottomGradient = useCallback(async (v: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    const n = parseDial(v, 1, 64);
    if (typeof n !== 'number') return { ok: false as const, error: n.err };
    if (data && n < data.curveTopGrad) {
      return { ok: false as const, error: `Bottom gradient r must be ≥ top gradient g (${data.curveTopGrad}).` };
    }
    return run(() => contracts.engine.setBottomGradient(n));
  }, [contracts, run, data]);

  const setTopShift = useCallback(async (v: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    const n = parseDial(v, 0, 64);
    if (typeof n !== 'number') return { ok: false as const, error: n.err };
    return run(() => contracts.engine.setTopShift(n));
  }, [contracts, run]);

  // The controller setpoint: the share of prediction POWER aimed to sit below the bar.
  // 0..9999 bps. 0 pins the bar at the floor (adaptive controller off); 9999 is the last
  // value with a finite equilibrium (at 10000 the bar never settles, it chases the
  // field's leader forever), which is why the contract stops there.
  const setDustTarget = useCallback(async (v: string) => {
    if (!contracts) return { ok: false as const, error: 'Not connected' };
    const n = parseDial(v, 0, 9999);
    if (typeof n !== 'number') return { ok: false as const, error: n.err };
    return run(() => contracts.engine.setDustTarget(n));
  }, [contracts, run]);

  return {
    data,
    loading,
    reload: load,
    isOwner,
    isGovernor,
    isEmissionSplitHolder,
    isEmissionHolder,
    isAirdropHolder,
    isFreezeAuthority,
    isRootPublisher,
    isOffchainReporter,
    isPrivileged,
    setAdmin,
    setDustFloor,
    setTopGradient,
    setBottomGradient,
    setTopShift,
    setDustTarget,
    initializeDefaultStream,
    accrueProtocolFee,
    setOffchainShare,
    setRegistrationFee,
    setEmissionRatio,
    setGameApproved,
    setMerkleRoot,
    setSatoriMerkle,
    setRootPublisher,
    setOffchainReporter,
    reportOffchainPredictions,
    loadAirdropBatch,
    finalizeAirdropLoading,
  };
}
