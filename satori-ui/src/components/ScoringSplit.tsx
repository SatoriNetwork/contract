import React, { useEffect, useState } from 'react';
import { useContracts } from '../hooks/useContracts';
import { InfoTip } from './InfoTip';
import { scoringSplit } from '../lib/roundPayout';
import { EmissionStatus, toEmissionStatus } from '../lib/emissionStatus';
import { fmtSatori } from './privilegedRow';

/// Public read of the admin's on-chain/off-chain dial, as percentages of the
/// emission left after the dev fee, and of where the emission schedule stands.
export function ScoringSplit() {
  const { contracts } = useContracts();
  const [split, setSplit] = useState<{ onChain: number; offChain: number } | null>(null);
  const [em, setEm] = useState<EmissionStatus | null>(null);

  useEffect(() => {
    if (!contracts) return;
    let live = true;
    Promise.all([
      contracts.cached.round.satori.emissionRateNow(),
      contracts.cached.round.satori.devRateNow(),
      contracts.cached.round.rewards.offchainBudget(),
    ]).then(([emission, dev, offchain]) => {
      if (live) setSplit(scoringSplit(BigInt(emission), BigInt(dev), BigInt(offchain)));
    }).catch((e) => console.warn('scoring split read failed:', e));
    contracts.cached.live.lens.emissionStatus()
      .then((r: any) => { if (live) setEm(toEmissionStatus(r)); })
      .catch((e: any) => console.warn('emission status read failed:', e));
    return () => { live = false; };
  }, [contracts]);

  const line = (label: React.ReactNode, value: React.ReactNode, testId: string) => (
    <div className="flex justify-between">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="font-mono" data-testid={testId}>{value}</span>
    </div>
  );

  return (
    <div className="text-sm space-y-1" data-testid="scoring-split">
      {line('On-chain scoring', split ? `${split.onChain}%` : '—', 'scoring-split-onchain')}
      {line(
        <>
          Off-chain scoring{' '}
          <InfoTip>Share of each round's rewards, after the dev fee, paid through the off-chain Merkle channel instead of on-chain scoring. Set by the rewards admin; a change applies from the next round.</InfoTip>
        </>,
        split ? `${split.offChain}%` : '—',
        'scoring-split-offchain',
      )}
      {line(
        <>
          Emission this round{' '}
          <InfoTip>SATORI minted per round, before the dev fee: 846.62 per round until 1,460 rounds-worth has been issued, then multiplied by the emission ratio each time another 730 rounds-worth at the new rate is issued, not on a calendar. A step takes effect from the round after the one that crosses it.</InfoTip>
        </>,
        em ? `${fmtSatori(em.rateNow)}/round` : '—',
        'emission-rate-now',
      )}
      {line('Issued so far', em ? (em.issuedProjected > em.issued ? `${fmtSatori(em.issued)} (${fmtSatori(em.issuedProjected)} projected)` : fmtSatori(em.issued)) : '—', 'emission-issued')}
      {line('Next step at', em ? (em.stepsActive ? `${fmtSatori(em.nextStepAt)} issued` : 'none') : '—', 'emission-next-step')}
      {line('Rate after next step', em ? (em.stepsActive ? `${fmtSatori(em.rateAfterStep)}/round` : 'unchanged') : '—', 'emission-rate-after-step')}
    </div>
  );
}
