import React, { useEffect, useMemo, useState } from 'react';

// Rounds tick every 24 hours at UTC midnight
// (`block.timestamp / 86400`). The countdown is derived purely from the
// browser clock — no RPC traffic, no contract reads.
//
// The interval pauses when the tab is hidden (Page Visibility API) so a backgrounded
// tab on a phone doesn't drain battery for a counter no one is looking at.
// On re-show the counter snaps to the current value, no drift.

const ROUND_MS = 86_400_000;

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'next round any moment';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

interface Props {
  prefix?: string;
  className?: string;
}

export function RoundCountdown({ prefix = 'Next round in', className }: Props) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;
    const tick = () => setNow(Date.now());

    const start = () => {
      if (id !== null) return;
      tick();
      id = setInterval(tick, 1000);
    };
    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };

    if (typeof document !== 'undefined' && document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const remaining = useMemo(() => {
    const nextRoundStart = Math.ceil(now / ROUND_MS) * ROUND_MS;
    return nextRoundStart - now;
  }, [now]);

  return (
    <span className={className} data-testid="round-countdown">
      {prefix} {formatRemaining(remaining)}
    </span>
  );
}
