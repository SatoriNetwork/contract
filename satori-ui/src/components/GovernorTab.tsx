import React, { useState } from 'react';
import { ethers } from 'ethers';
import { useOwner } from '../hooks/useOwner';
import { Row, DialInput, ActionState, shortAddress } from './privilegedRow';

// Governor panel: the token-governor's economic levers — the streak-curve shape
// dials (SatoriEngine) and the one-time Merkle-channel wiring. Gated on-chain to
// token.rootAuthority(); the tab is only shown to the root holder (App.tsx).
export function GovernorTab() {
  const owner = useOwner();
  const { data } = owner;

  const [floorInput, setFloorInput] = useState('');
  const [floorAction, setFloorAction] = useState<ActionState>(null);
  const [gInput, setGInput] = useState('');
  const [gAction, setGAction] = useState<ActionState>(null);
  const [rInput, setRInput] = useState('');
  const [rAction, setRAction] = useState<ActionState>(null);
  const [bInput, setBInput] = useState('');
  const [bAction, setBAction] = useState<ActionState>(null);
  const [targetInput, setTargetInput] = useState('');
  const [targetAction, setTargetAction] = useState<ActionState>(null);
  const [wireMerkleInput, setWireMerkleInput] = useState('');
  const [wireMerkleAction, setWireMerkleAction] = useState<ActionState>(null);

  const [busy, setBusy] = useState<string | null>(null);

  if (owner.loading) {
    return <div className="card-themed p-6 text-center text-gray-500 text-sm">Loading governor data…</div>;
  }
  if (!data) {
    return <div className="card-themed p-6 text-center text-gray-500 text-sm">Could not load governor data.</div>;
  }

  const wrap = async (
    key: string,
    setter: (s: ActionState) => void,
    fn: () => Promise<{ ok: true } | { ok: false; error: string }>,
    successMsg: string,
    clearInput?: () => void,
  ) => {
    setBusy(key);
    setter(null);
    const res = await fn();
    if (res.ok) { setter({ kind: 'success', msg: successMsg }); clearInput?.(); }
    else setter({ kind: 'error', msg: res.error });
    setBusy(null);
  };

  const { curveFloor: f, curveTopGrad: g, curveBotGrad: r, curveTopShift: b, dustTarget } = data;
  // Illustrative curve values when the adaptive bar sits at its floor (h = f).
  const entry = f / (g + 1) + b;                       // W(h) = h/(g+1) + b
  const asymptote = (f * (g * g + g + 1)) / (g + 1) + b; // saturating top

  const notGov = !owner.isGovernor;

  return (
    <div className="space-y-4" data-testid="governor-tab">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Token-governor levers. These reshape the streak-reward curve for every game, globally,
        without a redeploy. Each action is gated on-chain to one of the token's authority slots;
        they freeze permanently once the governor renounces. Changes affect all users. Handle with care.
      </p>

      {/* Role (read-only) */}
      <div className="card-themed p-3 text-xs space-y-1" data-testid="governor-role">
        <div className="flex justify-between">
          <span className="text-gray-500">Token governor (curve dials, pointers, upgrades)</span>
          <span className="font-mono">
            {shortAddress(data.governor)}{owner.isGovernor && <span className="text-green-500"> · you</span>}
            {data.pendingGovernor !== ethers.ZeroAddress && <span className="text-amber-500"> · handoff pending to {shortAddress(data.pendingGovernor)}</span>}
          </span>
        </div>
        {notGov && (
          <div className="text-amber-600 dark:text-amber-400">
            Your wallet is not the governor, so inputs are read-only. (In local testing, pick the “Owner” account.)
          </div>
        )}
      </div>

      {/* Live curve snapshot */}
      <div className="card-themed p-3 text-xs space-y-1" data-testid="governor-curve-snapshot">
        <div className="font-medium text-sm mb-1">Live curve: W(streak, h, g, r, b)</div>
        <div className="grid grid-cols-4 gap-2 font-mono">
          <div>f (floor) = <strong>{f}</strong></div>
          <div>g (top) = <strong>{g}</strong></div>
          <div>r (bottom) = <strong>{r}</strong></div>
          <div>b (shift) = <strong>{b}</strong></div>
        </div>
        <div className="text-gray-500 mt-1">
          At the floor (h = {f}): bar reward W(h) = <strong>{entry.toFixed(2)}</strong>, saturating toward
          asymptote <strong>{asymptote.toFixed(2)}</strong>. The bar h itself adapts per game (≥ f); the top
          rises with g, the below-bar band flattens with r, and b lifts the whole above-bar reward. Guardrail: r ≥ g.
        </div>
      </div>

      <div className="space-y-1.5">
        <Row
          title="Earning Floor (f)"
          subtitle={<>The minimum earning bar. The per-game bar is <span className="font-mono">h = max(f, adaptive threshold)</span>; a streak below h earns only a token amount. Range 1–64.</>}
          summary={<span><strong>{f}</strong></span>}
          input={<DialInput value={floorInput} onChange={setFloorInput} placeholder="New floor (1–64)" disabled={busy !== null || notGov} testId="input-dust-floor" />}
          action={floorAction}
          onSave={() => { if (floorInput.trim()) wrap('floor', setFloorAction, () => owner.setDustFloor(floorInput), `Earning floor set to ${floorInput.trim()}`, () => setFloorInput('')); }}
          saving={busy === 'floor'}
          disabled={!floorInput.trim() || notGov}
          saveLabel="Set floor"
          saveTestId="btn-set-dust-floor"
        />

        <Row
          title="Top Gradient (g)"
          subtitle={<>Above-bar steepness: larger g raises the saturating top (asymptote <span className="font-mono">h·(g²+g+1)/(g+1)+b</span>). Range 1–8, and must be ≤ r ({r}).</>}
          summary={<span><strong>{g}</strong></span>}
          input={<DialInput value={gInput} onChange={setGInput} placeholder={`New top gradient (1–8, ≤ ${r})`} disabled={busy !== null || notGov} testId="input-top-gradient" />}
          action={gAction}
          onSave={() => { if (gInput.trim()) wrap('g', setGAction, () => owner.setTopGradient(gInput), `Top gradient set to ${gInput.trim()}`, () => setGInput('')); }}
          saving={busy === 'g'}
          disabled={!gInput.trim() || notGov}
          saveLabel="Set g"
          saveTestId="btn-set-top-gradient"
        />

        <Row
          title="Bottom Gradient (r)"
          subtitle={<>Below-bar crush: larger r flattens the below-bar band harder. Range 1–64, and must be ≥ g ({g}) so the curve stays monotone.</>}
          summary={<span><strong>{r}</strong></span>}
          input={<DialInput value={rInput} onChange={setRInput} placeholder={`New bottom gradient (≥ ${g}, ≤ 64)`} disabled={busy !== null || notGov} testId="input-bottom-gradient" />}
          action={rAction}
          onSave={() => { if (rInput.trim()) wrap('r', setRAction, () => owner.setBottomGradient(rInput), `Bottom gradient set to ${rInput.trim()}`, () => setRInput('')); }}
          saving={busy === 'r'}
          disabled={!rInput.trim() || notGov}
          saveLabel="Set r"
          saveTestId="btn-set-bottom-gradient"
        />

        <Row
          title="Top Shift (b)"
          subtitle={<>A flat lift added to every above-bar reward (in multiplier units). Higher b starves the below-bar band toward zero after normalization. Range 0–64.</>}
          summary={<span><strong>{b}</strong></span>}
          input={<DialInput value={bInput} onChange={setBInput} placeholder="New top shift (0–64)" disabled={busy !== null || notGov} testId="input-top-shift" />}
          action={bAction}
          onSave={() => { if (bInput.trim()) wrap('b', setBAction, () => owner.setTopShift(bInput), `Top shift set to ${bInput.trim()}`, () => setBInput('')); }}
          saving={busy === 'b'}
          disabled={!bInput.trim() || notGov}
          saveLabel="Set b"
          saveTestId="btn-set-top-shift"
        />

        <Row
          title="Earning Target (controller setpoint)"
          subtitle={<>The share of prediction <strong>power</strong> the controller aims to keep <strong>BELOW</strong> the bar, i.e. the share <em>not</em> earning the real band. Read it that way round: {dustTarget} bps = {(dustTarget / 100).toFixed(2)}% below, so roughly the top {(100 - dustTarget / 100).toFixed(2)}% earn. It is the percentile the bar converges to, not a curve shape. Higher ⇒ a higher, harsher bar. Note it competes with the floor: below roughly 8000 the floor binds every round on a typical field and the controller never actually moves. Range 0–9999 (0 pins the bar at f, switching adaptation off; 9999 is the last value whose equilibrium is finite).</>}
          summary={<span><strong>{dustTarget}</strong> bps ({(dustTarget / 100).toFixed(2)}% below the bar)</span>}
          input={<DialInput value={targetInput} onChange={setTargetInput} placeholder="New target in bps (0–9999)" disabled={busy !== null || notGov} testId="input-dust-target" />}
          action={targetAction}
          onSave={() => { if (targetInput.trim()) wrap('target', setTargetAction, () => owner.setDustTarget(targetInput), `Earning target set to ${targetInput.trim()} bps`, () => setTargetInput('')); }}
          saving={busy === 'target'}
          disabled={!targetInput.trim() || notGov}
          saveLabel="Set target"
          saveTestId="btn-set-dust-target"
        />

        {!data.merkleWired && (
          <Row
            title="Wire Merkle Channel"
            subtitle={<>Governor-only one-time wiring of the off-chain claim channel on the hub. Paste the deployed SatoriMerkle address (reverts if already wired).</>}
            summary={<span className="text-xs text-amber-600 dark:text-amber-400">not wired</span>}
            input={<DialInput value={wireMerkleInput} onChange={setWireMerkleInput} placeholder="0x… (SatoriMerkle address)" disabled={busy !== null || notGov} testId="input-wire-merkle" />}
            action={wireMerkleAction}
            onSave={() => { if (wireMerkleInput.trim()) wrap('wiremerkle', setWireMerkleAction, () => owner.setSatoriMerkle(wireMerkleInput.trim()), `Merkle channel wired to ${shortAddress(wireMerkleInput.trim())}`, () => setWireMerkleInput('')); }}
            saving={busy === 'wiremerkle'}
            disabled={!wireMerkleInput.trim() || notGov}
            saveLabel="Wire Merkle"
            saveTestId="btn-wire-merkle"
          />
        )}
      </div>
    </div>
  );
}
