import React from 'react';
import { formatSatori } from '../utils/format';

// Review #7: this banner used to escalate through yellow/red tiers ("Claim now
// or you may lose rewards!") keyed off a streak-based proxy. Both halves were
// wrong: rewards are credited eagerly and NEVER expire (claim just mints the
// bucket, whenever), and the trigger scaled with prediction consistency, not
// time-since-claim. It is now a calm, always-honest "rewards are waiting" card.
interface ClaimBannerProps {
  claimable: string;
  onClaim: () => void;
  claiming: boolean;
}

export function ClaimBanner({ claimable, onClaim, claiming }: ClaimBannerProps) {
  const amount = parseFloat(claimable);
  if (amount <= 0) return null;

  return (
    <div
      // Light-first with dark: overrides, matching the rest of the app. This
      // previously carried ONLY the dark palette (bg-emerald-900/20 +
      // text-emerald-100), so in light mode near-white text sat on a pale tint
      // and was unreadable.
      className="rounded-lg p-3 flex items-center justify-between text-sm bg-green-50 dark:bg-emerald-900/20 border border-green-200 dark:border-emerald-700/50 text-green-900 dark:text-emerald-100"
      data-testid="claim-banner"
    >
      <div>
        <span className="font-medium">Rewards ready to claim</span>
        <span className="ml-2 text-green-800/80 dark:text-emerald-100/75">
          {formatSatori(claimable)} waiting. No rush, rewards never expire.
        </span>
      </div>
      <button
        onClick={onClaim}
        disabled={claiming}
        className="px-3 py-1 rounded font-medium transition-colors bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
        data-testid="btn-claim-banner"
      >
        {claiming ? '...' : 'Claim'}
      </button>
    </div>
  );
}
