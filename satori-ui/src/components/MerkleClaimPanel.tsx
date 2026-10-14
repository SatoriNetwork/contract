import React, { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { useContracts } from '../hooks/useContracts';
import { useWallet } from '../hooks/useWallet';
import { InfoTip } from './InfoTip';
import { afterTx } from '../lib/afterTx';

/// Claim an off-chain reward drop.
///
/// WHY THE USER HAS TO PASTE ANYTHING. The chain stores one 32-byte root and NOT
/// the list of who is owed what — that is the entire point, since one number
/// costs the same whether it covers four people or four hundred thousand. The
/// cost is that the chain cannot look anyone up, so a claimant has to supply the
/// evidence their entry was in the list that produced that root. That evidence is
/// the proof, and it can only come from off-chain.
///
/// Deliberately no bundled proof file and no fetch: where proofs get published is
/// a distribution decision that has not been made, and guessing it means building
/// this twice. Pasting needs no infrastructure and no decision.
const MERKLE_ABI = [
  'function merkleRoot() view returns (bytes32)',
  'function alreadyMintedTo(address) view returns (uint256)',
  'function claimMerkle(uint256 lifetimeEntitlement, bytes32[] proof)',
];
const HUB_ABI = [
  'function merkleReserveCumulative() view returns (uint256)',
  'function merkleMinted() view returns (uint256)',
];

// Named so a failure can say what actually went wrong instead of "reverted".
const SELECTORS: Record<string, string> = {
  '0x09bde339': 'InvalidProof',
  '0x50b2c4e1': 'BudgetExceeded',
  '0x969bf728': 'NothingToClaim',
};

interface Parsed { amountWei: bigint; proof: string[]; }

/// The leaf SatoriMerkle computes for `msg.sender`. Double-hashed to match
/// OpenZeppelin's StandardMerkleTree, which is what the contract verifies against.
export const leafFor = (address: string, amountWei: bigint) => ethers.keccak256(ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [address, amountWei])));

/// Fold a proof to a root. OpenZeppelin hashes pairs commutatively, so the proof
/// carries no left/right information.
export const rootFromProof = (leaf: string, proof: string[]) =>
  proof.reduce((acc, p) => ethers.keccak256(
    ethers.concat(acc.toLowerCase() < p.toLowerCase() ? [acc, p] : [p, acc])), leaf);

/// Would this proof satisfy `onChainRoot` for `address`?
///
/// Checked locally BEFORE sending anything, because the chain's answer for every
/// way of getting this wrong is the same bare `InvalidProof`. The commonest cause
/// by far is being connected as a different account than the drop was made for —
/// the leaf is built from `msg.sender`, so the right proof from the wrong wallet
/// fails identically to a corrupt one. On chain those are indistinguishable;
/// here they are not, and the difference is the whole of the error message.
export function diagnoseProof(
  address: string, amountWei: bigint, proof: string[], onChainRoot: string,
): { ok: true } | { ok: false; reason: string } {
  if (rootFromProof(leafFor(address, amountWei), proof) === onChainRoot) return { ok: true };
  return {
    ok: false,
    reason: `This proof does not match the published drop for ${address}. `
      + `The likeliest cause is being connected as the wrong account. A proof is tied to one `
      + `address, so the right proof from the wrong wallet fails exactly like a wrong one. `
      + `Otherwise the proof may be from an older drop that has since been replaced.`,
  };
}

/// Accepts either the whole proofs file (and finds the connected address in it)
/// or a single entry. Both are things someone plausibly has to hand, and
/// rejecting one of them for being the wrong shape would be gratuitous.
export function parseProofInput(text: string, address: string): Parsed {
  let json: any;
  try { json = JSON.parse(text); }
  catch { throw new Error('That is not valid JSON. Paste the contents of your proofs file, or your own entry from it.'); }

  const recipients = json.recipients ?? null;
  if (recipients) {
    const key = Object.keys(recipients).find((k) => k.toLowerCase() === address.toLowerCase());
    if (!key) {
      throw new Error(`This drop file does not include ${address}. Connect the address the drop was made for.`);
    }
    json = recipients[key];
  }

  const rawAmount = json.amountWei ?? json.amount;
  if (rawAmount === undefined || !Array.isArray(json.proof)) {
    throw new Error('Expected an entry with an "amount" and a "proof". Paste the whole proofs file if unsure.');
  }
  // amountWei is exact; a decimal "amount" is a convenience and gets converted.
  const amountWei = json.amountWei !== undefined
    ? BigInt(json.amountWei)
    : ethers.parseEther(String(json.amount));
  if (amountWei <= BigInt(0)) throw new Error('The amount in that entry is not positive.');

  const proof: string[] = json.proof.map((p: any) => {
    const s = String(p);
    if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error(`Not a 32-byte hash in the proof: ${s.slice(0, 20)}…`);
    return s;
  });
  return { amountWei, proof };
}

export function MerkleClaimPanel() {
  const { contracts } = useContracts();
  const { address } = useWallet();
  const [text, setText] = useState('');
  const [root, setRoot] = useState<string | null>(null);
  const [already, setAlready] = useState<bigint>(BigInt(0));
  const [headroom, setHeadroom] = useState<bigint>(BigInt(0));
  const [status, setStatus] = useState<{ kind: 'ok' | 'warn' | 'err'; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const merkleAddr: string | undefined = (contracts as any)?.merkle?.target;
  const fmt = (v: bigint) => ethers.formatEther(v);

  // What the app has ACTUALLY registered from the box, recomputed as they type.
  // Reported before they press anything, because the failure that prompted this
  // was a paste on mobile that looked pasted and had not reached React — at
  // which point every subsequent error is about the wrong thing entirely.
  let preview: { kind: 'ok' | 'err'; msg: string } | null = null;
  if (text.trim() && address) {
    try {
      const { amountWei, proof } = parseProofInput(text, address);
      if (root && root !== ethers.ZeroHash) {
        const d = diagnoseProof(address, amountWei, proof, root);
        preview = d.ok
          ? { kind: 'ok', msg: `Recognised: ${fmt(amountWei)} SATORI for this address, and it matches the published drop.` }
          : { kind: 'err', msg: d.reason };
      } else {
        preview = { kind: 'ok', msg: `Recognised: ${fmt(amountWei)} SATORI, proof of ${proof.length} node(s).` };
      }
    } catch (e: any) {
      preview = { kind: 'err', msg: e?.message ?? String(e) };
    }
  }

  const pasteFromClipboard = async () => {
    // Mobile paste into a textarea is genuinely awkward, and a paste that does
    // not reach React looks identical to one that did. Reading the clipboard
    // directly removes that whole class of confusion. Needs a secure context,
    // which is one more reason the site is on HTTPS.
    try {
      const t = await navigator.clipboard.readText();
      if (t.trim()) setText(t);
      else setStatus({ kind: 'err', msg: 'The clipboard is empty.' });
    } catch {
      setStatus({ kind: 'err', msg: 'This browser would not let the page read the clipboard. Paste into the box by hand.' });
    }
  };

  const load = useCallback(async () => {
    if (!contracts || !address || !merkleAddr) return;
    try {
      const m = new ethers.Contract(merkleAddr, MERKLE_ABI, contracts.token.runner as any);
      const h = new ethers.Contract(await contracts.hub.getAddress(), HUB_ABI, contracts.token.runner as any);
      const [r, a, cum, used] = await Promise.all([
        m.merkleRoot(), m.alreadyMintedTo(address), h.merkleReserveCumulative(), h.merkleMinted(),
      ]);
      setRoot(r); setAlready(BigInt(a)); setHeadroom(BigInt(cum) - BigInt(used));
    } catch { /* leave the panel in its unknown state rather than shouting */ }
  }, [contracts, address, merkleAddr]);

  useEffect(() => { load(); }, [load]);

  const claim = async () => {
    if (!contracts || !address || !merkleAddr) return;
    setBusy(true); setStatus(null);
    try {
      const { amountWei, proof } = parseProofInput(text, address);

      // Check it locally first. Every wrong-proof cause returns the same bare
      // InvalidProof on chain, so diagnosing here is the only place the user can
      // be told WHICH thing is wrong.
      if (root && root !== ethers.ZeroHash) {
        const d = diagnoseProof(address, amountWei, proof, root);
        if (!d.ok) throw new Error(d.reason);
      }

      const m = new ethers.Contract(merkleAddr, MERKLE_ABI, contracts.token.runner as any);

      // Simulate first. A failed claim costs gas and tells the user nothing
      // useful; a simulation costs nothing and can name the actual reason.
      try {
        await m.claimMerkle.staticCall(amountWei, proof);
      } catch (e: any) {
        const raw = e?.info?.error?.data ?? e?.data;
        const sel = typeof raw === 'string' ? raw.slice(0, 10) : null;
        const name = sel ? SELECTORS[sel] : null;
        if (name === 'InvalidProof') {
          throw new Error('The chain rejected this proof. Check you pasted the entry for THIS address, and that the drop it came from is the one currently published.');
        }
        if (name === 'NothingToClaim') {
          throw new Error(`Nothing left to claim: you have already received ${fmt(already)} SATORI, which is at least this entitlement. Entitlements are lifetime totals, not additions.`);
        }
        if (name === 'BudgetExceeded') {
          throw new Error(`The proof is valid, but the off-chain reserve only has ${fmt(headroom)} SATORI available right now. It grows each round, so try again later.`);
        }
        throw e;
      }

      const tx = await m.claimMerkle(amountWei, proof);
      await afterTx(tx);
      const paid = amountWei - already;
      setStatus({ kind: 'ok', msg: `Claimed ${fmt(paid > BigInt(0) ? paid : BigInt(0))} SATORI.` });
      setText('');
      await load();
    } catch (e: any) {
      setStatus({ kind: 'err', msg: e?.shortMessage ?? e?.message ?? String(e) });
    } finally {
      setBusy(false);
    }
  };

  const noRoot = root === ethers.ZeroHash || root === null;

  return (
    <div className="card-themed p-3 space-y-3" data-testid="merkle-claim-panel">
      <div className="font-medium flex items-center justify-between gap-1.5">
        <span>Off-chain reward drop</span>
        <InfoTip>
          Some rewards are worked out off-chain and published as a single fingerprint
          on-chain. Because the chain does not store the list, you supply the proof
          that your entry was in it. You will have been given that proof wherever the
          drop was announced.
        </InfoTip>
      </div>

      <div className="text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
        <div>published drop: <span className="font-mono">{noRoot ? 'none' : `${root!.slice(0, 10)}…${root!.slice(-6)}`}</span></div>
        <div>claiming as: <span className="font-mono">{address ?? 'not connected'}</span></div>
        <div>you have claimed so far: <strong>{fmt(already)}</strong> SATORI</div>
        <div>available in the drop pool: <strong>{fmt(headroom)}</strong> SATORI</div>
      </div>

      {noRoot ? (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          No drop is published at the moment, so there is nothing to claim against.
        </p>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder={'Paste your proofs file, or just your own entry:\n{ "amount": "1", "proof": ["0x…", "0x…"] }'}
            className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-xs font-mono"
            data-testid="merkle-proof-input"
          />
          <div className="flex gap-2">
            <button
              onClick={pasteFromClipboard}
              disabled={busy}
              className="flex-1 py-2 bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400 !text-white text-sm font-medium rounded transition-colors"
              data-testid="merkle-paste-button"
            >
              Paste from clipboard
            </button>
            {text.trim() && (
              <button
                onClick={() => { setText(''); setStatus(null); }}
                disabled={busy}
                className="px-3 py-2 border border-gray-300 dark:border-gray-600 text-sm rounded"
              >
                Clear
              </button>
            )}
          </div>

          {preview && (
            <div className={`p-2 rounded text-xs ${
              preview.kind === 'ok'
                ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                : 'bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300'
            }`} data-testid="merkle-proof-preview">
              {preview.msg}
            </div>
          )}

          <button
            onClick={claim}
            disabled={busy || !text.trim() || preview?.kind === 'err'}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors"
            data-testid="merkle-claim-button"
          >
            {busy ? 'Claiming…' : 'Claim drop'}
          </button>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Entitlements are <strong>lifetime totals</strong>. If you have claimed before,
            this pays only the difference.
          </p>
        </>
      )}

      {status && (
        <div className={`p-2 rounded text-xs ${
          status.kind === 'ok'
            ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
            : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'
        }`} data-testid="merkle-claim-status">
          {status.msg}
        </div>
      )}
    </div>
  );
}
