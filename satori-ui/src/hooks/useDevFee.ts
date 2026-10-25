import { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from './useContracts';
import { useWallet } from './useWallet';
import { getPlatformFeeRecipient } from '../lib/chainValues';

/// The splitter tree that receives the protocol's dev fee.
///
/// NOTHING HERE IS CONFIGURED. The root is `token.PLATFORM_FEE_RECIPIENT()`, an
/// immutable on a token with no upgrade path, and the rest of the tree is walked
/// from it. So this cannot drift from what the chain actually pays: there is no
/// address list to keep in sync, and pointing the dapp at a different deployment
/// discovers that deployment's tree instead.
///
/// Only a `SatoriSplitterImmutable` answers `slotCount()`, which is how a branch
/// is told from a leaf while walking. A plain EOA payee simply fails that call.
const SPLITTER_ABI = [
  'function slotCount() view returns (uint256)',
  'function getSlot(uint256) view returns (address payee, uint256 shares)',
  'function releasable(address token, uint256 slotId) view returns (uint256)',
  'function withdraw(address token, uint256 slotId) returns (uint256)',
  'function withdrawCaller(uint256) view returns (address)',
  'function rotateRecipient(address newPayee)',
  'function setWithdrawCaller(address caller)',
  'function authority() view returns (address)',
  'function rotationThresholdBps() view returns (uint256)',
  'function totalShares() view returns (uint256)',
  'function proposalId(address parent, address newPayee) view returns (bytes32)',
  'function approvedShares(bytes32) view returns (uint256)',
  'function approved(bytes32, uint256) view returns (bool)',
  'function rotationApproved(address parent, address newPayee) view returns (bool)',
  'function approveRotation(address parent, address newPayee)',
  'function revokeRotation(address parent, address newPayee)',
  'function rotateAt(address parent, address newPayee)',
  'function transferAuthority(address newAuthority)',
  'function acceptAuthority()',
  'function pendingAuthority() view returns (address)',
  'function renounceAuthority()',
  'function slotOf(address addr) view returns (uint256)',
  'function isRecipient(address addr) view returns (bool)',
];

const BPS = BigInt(10000);

export interface DevFeeSlot {
  node: string;          // the splitter holding this slot
  nodeLabel: string;     // "top" | "branch"
  slotId: number;
  shares: bigint;        // of its own node, in bps
  effectiveBps: bigint;  // of the whole tree
  claimable: bigint;     // SATORI this slot can take right now
  isMine: boolean;
  /// Who else may trigger this slot's payout. ZeroAddress means anyone can, which
  /// is the default and is safe: a withdraw always pays the PAYEE regardless of
  /// who called it. Setting it narrows the trigger to one address; the payee can
  /// always still withdraw for itself, so a gate cannot lock its owner out.
  withdrawCaller: string;
}

export interface DevFeeUpstream {
  node: string;          // parent holding funds
  slotId: number;        // the slot pointing at MY branch
  pending: bigint;       // sitting upstream, needs pulling before I can claim
  gated: boolean;        // someone has restricted who may trigger it
}

/// A splitter in the tree, with the facts that decide what may be done to it.
export interface SplitterNode {
  address: string;
  label: 'top' | 'branch';
  /// The splitter holding THIS one's slot, and which slot. Null for the top,
  /// which has no parent and therefore nothing to rotate itself into.
  parent: string | null;
  parentSlotId: number | null;
  /// Holder of the unilateral rotation right. ZeroAddress means renounced, and
  /// that door is closed permanently.
  authority: string;
  /// The address the authority has offered the role to; it takes effect when that
  /// address accepts. ZeroAddress when there is no offer.
  pendingAuthority: string;
  /// Share of `totalShares` that must approve before anyone may rotate this
  /// splitter's slot in its parent without the authority.
  rotationThresholdBps: bigint;
  totalShares: bigint;
  iAmAuthority: boolean;
  iAmPendingAuthority: boolean;
  /// My slot on THIS node, if I hold one. Needed to read my own approval.
  mySlotId: number | null;
}

/// The state of one "move this splitter's slot in its parent to X" proposal.
/// Proposals are keyed by hash on chain and are NOT enumerable, so this is
/// always looked up against a candidate address the user supplies rather than
/// listed. Discovering pending ones would mean scanning RotationApproved logs.
export interface RotationProposal {
  node: string;
  parent: string;
  newPayee: string;
  approvedShares: bigint;
  totalShares: bigint;
  thresholdBps: bigint;
  cleared: boolean;
  iApproved: boolean;
}

export interface DevFeeState {
  loading: boolean;
  root: string | null;
  isPayee: boolean;      // gates the tab
  mine: DevFeeSlot[];
  upstream: DevFeeUpstream[];
  /// Every splitter in the tree, whether or not I have any role in it.
  nodes: SplitterNode[];
  /// Nodes where I hold the authority. Gates the admin tab.
  isAuthority: boolean;
  error: string | null;
  /// Which account this state describes, lowercased. Needed because a failed load
  /// keeps the last successful answer rather than erasing it — and without knowing
  /// whose answer it is, switching accounts and then hitting a bad read would show
  /// the PREVIOUS account's slots and claimable amounts.
  forAddress: string | null;
}

const EMPTY: DevFeeState = {
  loading: true, root: null, isPayee: false, mine: [], upstream: [],
  nodes: [], isAuthority: false, error: null, forAddress: null,
};

export function useDevFee(): DevFeeState & {
  refresh: () => Promise<void>;
  claim: (s: DevFeeSlot) => Promise<void>;
  pull: (u: DevFeeUpstream) => Promise<void>;
  rotate: (s: DevFeeSlot, newPayee: string) => Promise<void>;
  setGate: (s: DevFeeSlot, caller: string) => Promise<void>;
  readProposal: (n: SplitterNode, newPayee: string) => Promise<RotationProposal | null>;
  approveRotation: (n: SplitterNode, newPayee: string) => Promise<void>;
  revokeRotation: (n: SplitterNode, newPayee: string) => Promise<void>;
  rotateAt: (n: SplitterNode, newPayee: string) => Promise<void>;
  transferAuthority: (n: SplitterNode, to: string) => Promise<void>;
  acceptAuthority: (n: SplitterNode) => Promise<void>;
  renounceAuthority: (n: SplitterNode) => Promise<void>;
} {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [state, setState] = useState<DevFeeState>(EMPTY);

  const load = useCallback(async () => {
    if (!contracts || !address) { setState({ ...EMPTY, loading: false }); return; }
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      // READ through the resilient provider, never through the wallet.
      //
      // `contracts.token` is signer-bound, so `contracts.token.runner` is the SIGNER
      // once connected and every read below would go out over the wallet's RPC —
      // losing the dedupe, concurrency gate, retry and failover exactly when it
      // matters. useContracts says as much and this hook missed the migration; see
      // docs/issues/closed/dapp-reads-bypass-resilient-provider.md. Writes further down
      // still use the signer, correctly.
      //
      // It was not a slow path, it was an INVISIBLE one: one flaky `slotCount()`
      // made isSplitter answer false, the walk concluded the fee sink was a plain
      // address, and the tab silently disappeared for a real payee.
      const readProvider = contracts.reads.token.runner;
      const tokenAddr = await contracts.token.getAddress();
      const root: string = await getPlatformFeeRecipient(contracts.reads);

      const at = (a: string) => new ethers.Contract(a, SPLITTER_ABI, readProvider as any);

      /// Is this address a splitter? Only a REVERT answers that question.
      ///
      /// The old version was `.then(() => true, () => false)`, which also answered
      /// "no" to a timeout, a rate-limit and a dropped connection. Those are not
      /// evidence about the address — they are evidence that we do not know — and
      /// turning them into "no" is what hid the tab. Transport failures now
      /// propagate to the catch block and become a visible error.
      const isSplitter = async (a: string) => {
        try {
          await at(a).slotCount();
          return true;
        } catch (e: any) {
          const code = e?.code;
          // A plain address returns empty data (BAD_DATA); a contract without the
          // function reverts (CALL_EXCEPTION). Both genuinely mean "not a splitter".
          if (code === 'BAD_DATA' || code === 'CALL_EXCEPTION') return false;
          throw e;
        }
      };

      if (!(await isSplitter(root))) {
        // A plain address as the fee sink: nothing to claim through, no tab.
        setState({ ...EMPTY, loading: false, root });
        return;
      }

      const me = address.toLowerCase();
      const mine: DevFeeSlot[] = [];
      const upstream: DevFeeUpstream[] = [];
      const nodes: SplitterNode[] = [];

      /// Read the facts that decide what may be done to a splitter. `parent` is
      /// null for the top: with nothing above it, it has no slot to rotate.
      const describe = async (
        addr: string, label: 'top' | 'branch',
        parent: string | null, parentSlotId: number | null,
      ): Promise<SplitterNode> => {
        const c = at(addr);
        const [auth, pending, thr, tot, mySlotPlus] = await Promise.all([
          c.authority(),
          c.pendingAuthority().catch(() => ethers.ZeroAddress),
          c.rotationThresholdBps(),
          c.totalShares(),
          c.slotOf(address).then((v: bigint) => Number(v), () => -1),
        ]);
        return {
          address: addr, label, parent, parentSlotId,
          authority: auth,
          pendingAuthority: pending,
          rotationThresholdBps: BigInt(thr),
          totalShares: BigInt(tot),
          iAmAuthority: auth.toLowerCase() === me,
          iAmPendingAuthority: pending.toLowerCase() === me,
          mySlotId: mySlotPlus >= 0 ? mySlotPlus : null,
        };
      };

      nodes.push(await describe(root, 'top', null, null));

      // Walk the top node, then one level down. The tree is two deep by design
      // (A -> C,B -> payees); a deeper one would need real recursion, and the
      // absence of that is deliberate rather than an oversight.
      const rootC = at(root);
      const rootSlots = Number(await rootC.slotCount());

      for (let i = 0; i < rootSlots; i++) {
        const [payee, sharesRaw] = await rootC.getSlot(i);
        const shares = BigInt(sharesRaw);
        const childIsSplitter = await isSplitter(payee);

        if (!childIsSplitter) {
          if (payee.toLowerCase() === me) {
            mine.push({
              node: root, nodeLabel: 'top', slotId: i, shares,
              effectiveBps: shares,
              claimable: BigInt(await rootC.releasable(tokenAddr, i)),
              isMine: true,
              withdrawCaller: await rootC.withdrawCaller(i),
            });
          }
          continue;
        }

        // A branch: a splitter holding a slot in the top. That slot is what
        // `rotateAt` moves, which is why the parent link is recorded here.
        nodes.push(await describe(payee, 'branch', root, i));

        const branch = at(payee);
        const branchSlots = Number(await branch.slotCount());
        for (let j = 0; j < branchSlots; j++) {
          const [leaf, leafSharesRaw] = await branch.getSlot(j);
          const leafShares = BigInt(leafSharesRaw);
          if (leaf.toLowerCase() !== me) continue;

          mine.push({
            node: payee, nodeLabel: 'branch', slotId: j, shares: leafShares,
            effectiveBps: (shares * leafShares) / BPS,
            claimable: BigInt(await branch.releasable(tokenAddr, j)),
            isMine: true,
            withdrawCaller: await branch.withdrawCaller(j),
          });

          // Money can be sitting one level up, un-pulled. Until someone moves it
          // down, `releasable` at the branch reads lower than what is really owed
          // — which looks like "nothing to claim" and is the single most
          // confusing thing about a two-tier tree.
          const pending = BigInt(await rootC.releasable(tokenAddr, i));
          if (pending > BigInt(0)) {
            const gate = await rootC.withdrawCaller(i);
            upstream.push({
              node: root, slotId: i, pending,
              gated: gate !== ethers.ZeroAddress,
            });
          }
        }
      }

      setState({
        loading: false, root, isPayee: mine.length > 0, mine, upstream,
        nodes, isAuthority: nodes.some((n) => n.iAmAuthority || n.iAmPendingAuthority), error: null,
        forAddress: me,
      });
    } catch (e: any) {
      // Keep whatever the last SUCCESSFUL load found. Resetting to EMPTY here meant
      // one bad read revoked a payee's tab mid-session and told them nothing — and
      // the state it fell back to (isPayee: false) is a positive claim we have no
      // grounds for. Hold the last known answer and report the failure instead.
      const msg = e?.shortMessage ?? String(e?.message ?? e);
      setState((prev) => (
        // Only reuse the previous answer if it was about THIS account.
        prev.forAddress === address.toLowerCase()
          ? { ...prev, loading: false, error: msg }
          : { ...EMPTY, loading: false, error: msg }
      ));
    }
  }, [contracts, address]);

  useEffect(() => { load(); }, [load]);

  const claim = useCallback(async (s: DevFeeSlot) => {
    if (!contracts) return;
    const tokenAddr = await contracts.token.getAddress();
    const c = new ethers.Contract(s.node, SPLITTER_ABI, contracts.token.runner as any);
    await (await c.withdraw(tokenAddr, s.slotId)).wait();
    await load();
  }, [contracts, load]);

  const pull = useCallback(async (u: DevFeeUpstream) => {
    if (!contracts) return;
    const tokenAddr = await contracts.token.getAddress();
    const c = new ethers.Contract(u.node, SPLITTER_ABI, contracts.token.runner as any);
    await (await c.withdraw(tokenAddr, u.slotId)).wait();
    await load();
  }, [contracts, load]);

  /// Hand this slot to another address. `SatoriSplitterImmutable.rotateRecipient`
  /// only ever moves the slot the CALLER holds, so there is no slot argument on
  /// the chain side — the caller's identity is the slot.
  ///
  /// ONE-WAY. After this lands the old address is no longer a recipient and
  /// cannot rotate back; only the new address can rotate again. A typo here does
  /// not lose the money already claimed, but it does hand every future payment
  /// to whoever holds that address, permanently.
  ///
  /// The chain refuses the obvious mistakes rather than trusting the UI:
  /// address(0) (ZeroAddress), the splitter itself (PayeeIsSelf, which would
  /// brick the slot forever), and an address that already holds a slot on this
  /// node (AlreadyRecipient). The checks below just say so earlier and in
  /// English.
  const rotate = useCallback(async (s: DevFeeSlot, newPayee: string) => {
    if (!contracts) return;
    const to = newPayee.trim();
    if (!ethers.isAddress(to)) throw new Error('That is not a valid address.');
    if (to.toLowerCase() === s.node.toLowerCase()) {
      throw new Error('That is the splitter itself. The slot would be bricked permanently.');
    }
    const c = new ethers.Contract(s.node, SPLITTER_ABI, contracts.token.runner as any);
    if (await c.isRecipient(to)) {
      throw new Error('That address already holds a slot on this splitter.');
    }
    await (await c.rotateRecipient(to)).wait();
    await load();
  }, [contracts, load]);

  /// Restrict who may TRIGGER this slot's payout, or clear the restriction by
  /// passing an empty string.
  ///
  /// Much softer than rotation, and worth saying so in the UI: it never moves
  /// money or ownership, the payee can always still withdraw for itself
  /// (`withdraw` allows both the gate AND the payee), and it can be changed as
  /// often as you like. The failure mode is a stuck payout, not a lost slot.
  ///
  /// Note it does NOT survive a rotation. The contract clears it deliberately,
  /// so that a gate cannot outlive the address that understood it.
  const setGate = useCallback(async (s: DevFeeSlot, caller: string) => {
    if (!contracts) return;
    const to = caller.trim();
    const target = to === '' ? ethers.ZeroAddress : to;
    if (target !== ethers.ZeroAddress && !ethers.isAddress(target)) {
      throw new Error('That is not a valid address.');
    }
    const c = new ethers.Contract(s.node, SPLITTER_ABI, contracts.token.runner as any);
    await (await c.setWithdrawCaller(target)).wait();
    await load();
  }, [contracts, load]);

  /// Look up one rotation proposal. Proposals are hash-keyed and NOT
  /// enumerable, so the caller supplies the candidate address; there is no list
  /// to read. Finding pending ones would mean scanning RotationApproved logs.
  const readProposal = useCallback(async (n: SplitterNode, newPayee: string) => {
    if (!contracts || !n.parent) return null;
    const to = newPayee.trim();
    if (!ethers.isAddress(to)) return null;
    const c = new ethers.Contract(n.address, SPLITTER_ABI, contracts.token.runner as any);
    const id = await c.proposalId(n.parent, to);
    const [shares, cleared] = await Promise.all([
      c.approvedShares(id),
      c.rotationApproved(n.parent, to),
    ]);
    const iApproved = n.mySlotId === null ? false : await c.approved(id, n.mySlotId);
    return {
      node: n.address, parent: n.parent, newPayee: to,
      approvedShares: BigInt(shares),
      totalShares: n.totalShares,
      thresholdBps: n.rotationThresholdBps,
      cleared: Boolean(cleared),
      iApproved: Boolean(iApproved),
    } as RotationProposal;
  }, [contracts]);

  const wr = useCallback((addr: string) =>
    new ethers.Contract(addr, SPLITTER_ABI, contracts?.token.runner as any), [contracts]);

  /// Cast this slot's shares in favour of moving the splitter's slot in its
  /// parent. Approvals are keyed by (splitter, parent, newPayee, epoch), so a
  /// vote counts for exactly one target and is consumed when a rotation fires.
  const approveRotation = useCallback(async (n: SplitterNode, newPayee: string) => {
    if (!contracts || !n.parent) return;
    const to = newPayee.trim();
    if (!ethers.isAddress(to)) throw new Error('That is not a valid address.');
    await (await wr(n.address).approveRotation(n.parent, to)).wait();
    await load();
  }, [contracts, wr, load]);

  const revokeRotation = useCallback(async (n: SplitterNode, newPayee: string) => {
    if (!contracts || !n.parent) return;
    await (await wr(n.address).revokeRotation(n.parent, newPayee.trim())).wait();
    await load();
  }, [contracts, wr, load]);

  /// Execute the move. Two doors, and the contract decides which one applies:
  /// the authority unilaterally, or anyone once approvals clear the threshold.
  ///
  /// The contract calls this the single most dangerous power it has: it
  /// redirects ALL FUTURE income from the parent. It cannot touch funds already
  /// in the splitter, which stay claimable by the existing slots under the
  /// existing shares, so the blast radius is future inflow only.
  const rotateAt = useCallback(async (n: SplitterNode, newPayee: string) => {
    if (!contracts || !n.parent) return;
    const to = newPayee.trim();
    if (!ethers.isAddress(to)) throw new Error('That is not a valid address.');
    await (await wr(n.address).rotateAt(n.parent, to)).wait();
    await load();
  }, [contracts, wr, load]);

  /// Take the rotation right the authority offered to this address.
  const acceptAuthority = useCallback(async (n: SplitterNode) => {
    if (!contracts) return;
    await (await wr(n.address).acceptAuthority()).wait();
    await load();
  }, [contracts, wr, load]);

  /// Offer the unilateral rotation right to another address; it moves when that
  /// address accepts.
  const transferAuthority = useCallback(async (n: SplitterNode, to: string) => {
    if (!contracts) return;
    const t = to.trim();
    if (!ethers.isAddress(t)) throw new Error('That is not a valid address.');
    await (await wr(n.address).transferAuthority(t)).wait();
    await load();
  }, [contracts, wr, load]);

  /// Give up the unilateral right permanently. Closes that door for good and
  /// leaves consent as the only way this splitter's slot can ever move.
  const renounceAuthority = useCallback(async (n: SplitterNode) => {
    if (!contracts) return;
    await (await wr(n.address).renounceAuthority()).wait();
    await load();
  }, [contracts, wr, load]);

  return {
    ...state, refresh: load, claim, pull, rotate, setGate,
    readProposal, approveRotation, revokeRotation, rotateAt,
    transferAuthority, acceptAuthority, renounceAuthority,
  };
}
