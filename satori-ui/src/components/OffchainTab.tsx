import React, { useState } from 'react';
import { ethers } from 'ethers';
import { useOwner } from '../hooks/useOwner';
import { InfoTip } from './InfoTip';
import { Row, ActionState, shortAddress } from './privilegedRow';

/// Everything about activity that happened OFF chain. Two jobs that are one
/// feature: reporting how many predictions settled off-chain, and publishing the
/// Merkle root those settlements are proven against.
///
/// They were split across two tabs before, which was wrong in a way that
/// mattered: reporting sat here (gated on `isOffchainReporter`) while the Merkle
/// root sat on the Admin tab (gated on `isOwner`, i.e. the rewards admin). The
/// reporter key could therefore never reach the root controls at all — different
/// role, different tab, no overlap. They are the same operator's job, so they
/// are now the same page.
///
/// Gated in App.tsx on `isOffchainReporter || isRootPublisher` — either off-chain
/// role opens the tab, and each section is still gated on its own role inside.
///
/// WHAT THIS IS FOR. The default stream's value is "how many predictions the
/// protocol made last round". Once predictors settle off-chain via Merkle, that
/// number falls even though the platform is doing more work, not less — those
/// people are still predicting, they are just trusting the operator rather than
/// the chain. A headline that reads as decline while the platform grows is worse
/// than no headline. This page reports them back in.
///
/// WHY THE PAGE LOOKS LIKE A LEDGER ENTRY AND NOT A SETTING. The contract ADDS
/// to a running counter; it does not store a figure you can revise. Two calls of
/// 40 make 80, and because the counter is unsigned there is no way to take it
/// back. So the copy is deliberately about *adding*, never about *setting* — a
/// page that read "current value: 40" beside a box would invite someone to type
/// 40 again to "confirm" it and silently double the number.
export function OffchainTab() {
  const owner = useOwner();
  const { reportOffchainPredictions, reload, data } = owner;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Merkle channel — moved here from the Admin tab, see the note above.
  const [rootInput, setRootInput] = useState('');
  const [rootAction, setRootAction] = useState<ActionState>(null);
  const [publisherInput, setPublisherInput] = useState('');
  const [publisherAction, setPublisherAction] = useState<ActionState>(null);
  const [merkleBusy, setMerkleBusy] = useState<string | null>(null);

  const runMerkle = async (
    key: string,
    setter: (s: ActionState) => void,
    fn: () => Promise<{ ok: true } | { ok: false; error: string }>,
    successMsg: string,
  ) => {
    setMerkleBusy(key);
    setter(null);
    const res = await fn();
    setMerkleBusy(null);
    setter(res.ok ? { kind: 'success', msg: successMsg } : { kind: 'error', msg: res.error });
    if (res.ok) reload();
  };

  const onSetRoot = () => {
    const r = rootInput.trim();
    if (!r) return;
    runMerkle('root', setRootAction, () => owner.setMerkleRoot(r), 'Merkle root published');
    setRootInput('');
  };

  const onSetPublisher = () => {
    const a = publisherInput.trim();
    if (!a) return;
    runMerkle('publisher', setPublisherAction, () => owner.setRootPublisher(a),
      `Root publisher rotated to ${shortAddress(a)}. You may lose publish access`);
    setPublisherInput('');
  };

  const parsed = input.trim();
  const valid = /^\d+$/.test(parsed) && BigInt(parsed || '0') > BigInt(0);

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setResult(null);
    const r = await reportOffchainPredictions(parsed);
    setBusy(false);
    if (r?.ok) {
      setResult({ ok: true, message: `Added ${parsed} off-chain prediction${parsed === '1' ? '' : 's'} to this round.` });
      setInput('');
      reload();
    } else {
      setResult({ ok: false, message: r?.error ?? 'Failed to report' });
    }
  };

  return (
    <div className="space-y-4" data-testid="offchain-tab">
      <div>
        <h3 className="text-lg font-semibold flex items-center gap-1.5">
          Report off-chain predictions
          <InfoTip>
            The protocol counts on-chain predictions automatically. Predictors settled off-chain
            are invisible to it, so the headline participation number would fall as people move
            off-chain — reading as decline while the platform grows. This adds them back in.
          </InfoTip>
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          You hold the reporter key. What you enter is <strong>added</strong> to the current
          round&apos;s running total, alongside the predictions made on-chain.
        </p>
      </div>

      <div className="card-themed p-4 space-y-3">
        <label className="block text-sm font-medium" htmlFor="offchain-count">
          Off-chain predictions to add
        </label>
        <input
          id="offchain-count"
          type="text"
          inputMode="numeric"
          value={input}
          onChange={(e) => { setInput(e.target.value); setResult(null); }}
          placeholder="e.g. 250"
          disabled={busy}
          className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
          data-testid="input-offchain-count"
        />

        {/* The two things that actually bite, said before the button rather than
            after the mistake: it accumulates, and it cannot be undone. */}
        <p className="text-xs text-amber-600 dark:text-amber-400">
          This <strong>adds</strong> to the round — it does not replace a previous figure. Reporting
          twice counts twice, and there is no way to subtract. Nothing here mints tokens, moves
          rewards, or changes anyone&apos;s score.
        </p>

        <button
          onClick={submit}
          disabled={!valid || busy}
          className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
          data-testid="btn-report-offchain"
        >
          {busy ? 'Reporting…' : 'Add to this round'}
        </button>

        {input.trim() !== '' && !valid && (
          <p className="text-xs text-red-500" data-testid="report-invalid">
            Enter a whole number of predictors greater than zero.
          </p>
        )}

        {result && (
          <p
            className={`text-sm ${result.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}
            data-testid="report-result"
          >
            {result.message}
          </p>
        )}
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400">
        The figure lands in whichever round is current when the transaction mines. One that slips
        past a round boundary is counted in the next published value — never lost.
      </p>

      {/* ── The Merkle channel ────────────────────────────────────────────
          The other half of off-chain settlement: the count above says HOW
          MANY settled off-chain, the root below is what those settlements are
          proven against when someone claims. */}
      <div className="pt-2">
        <h3 className="text-lg font-semibold flex items-center gap-1.5">
          Merkle channel
          <InfoTip>
            The off-chain reward claim channel. Rewards settled off-chain are committed
            as a Merkle root; holders claim against it on chain. Publishing a root is what
            makes a batch of off-chain settlements claimable.
          </InfoTip>
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Gated to the channel&apos;s <strong>rootPublisher</strong>, which is a different key
          from the reporter above — holding one does not imply the other.
        </p>
      </div>

      {!data ? (
        <div className="card-themed p-4 text-sm text-gray-500" data-testid="merkle-loading">
          Loading Merkle state…
        </div>
      ) : !data.merkleWired ? (
        // Not an error, and deliberately not a disabled form pretending to work.
        // On this deployment SatoriMerkle was never deployed (deploy.js skips it
        // when ROOT_PUBLISHER is unset), so there is no contract to publish to.
        // Saying so plainly beats a greyed-out box that looks like a permissions
        // problem the operator could fix by connecting a different wallet.
        <div className="card-themed p-4 space-y-2" data-testid="merkle-not-wired">
          <div className="font-medium text-amber-600 dark:text-amber-400">
            Merkle channel is not deployed on this stack
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            <code>SatoriMerkle</code> is not wired on this stack, so there is no contract to
            publish a root to and nothing to claim against. Wiring it is a governor action
            on the Governor tab, after which these controls become live.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          <Row
            title="Merkle Root"
            subtitle={<>Publish or replace the cumulative off-chain root. Generate it off-chain and paste
              the 0x…32-byte hash. Gated to <strong>rootPublisher</strong>{' '}
              (<span className="font-mono">{shortAddress(data.rootPublisher)}</span>).</>}
            summary={<span className="font-mono text-xs">
              {data.merkleRoot === ethers.ZeroHash ? 'none set' : shortAddress(data.merkleRoot)}
            </span>}
            input={<input
              type="text" value={rootInput}
              onChange={(e) => setRootInput(e.target.value)}
              placeholder="0x… (32-byte Merkle root)"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
              disabled={merkleBusy !== null || !owner.isRootPublisher}
            />}
            action={rootAction} onSave={onSetRoot} saving={merkleBusy === 'root'}
            disabled={!rootInput.trim() || !owner.isRootPublisher}
            saveLabel="Publish root" saveTestId="btn-set-merkle-root"
          />
          <Row
            title="Rotate Root Publisher"
            subtitle={<>Hand the root-publishing key to a different wallet. Gated to the current{' '}
              <strong>rootPublisher</strong>.</>}
            summary={<span className="font-mono text-xs">{shortAddress(data.rootPublisher)}</span>}
            input={<input
              type="text" value={publisherInput}
              onChange={(e) => setPublisherInput(e.target.value)}
              placeholder="0x… (new publisher address)"
              className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-3 py-2 text-sm font-mono"
              disabled={merkleBusy !== null || !owner.isRootPublisher}
            />}
            action={publisherAction} onSave={onSetPublisher} saving={merkleBusy === 'publisher'}
            disabled={!publisherInput.trim() || !owner.isRootPublisher}
            saveLabel="Rotate publisher" saveTestId="btn-set-root-publisher"
          />
          {!owner.isRootPublisher && (
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="not-root-publisher">
              You are not the root publisher, so these are read-only from this wallet.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
