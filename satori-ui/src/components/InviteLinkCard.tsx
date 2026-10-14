import React, { useState, useMemo, useCallback } from 'react';
import { useWallet } from '../hooks/useWallet';
import { copyText } from '../lib/clipboard';

/**
 * Your shareable invite link + a copy button. Self-contained (reads the
 * connected address itself) so it can be dropped onto any tab — it lives on
 * both the Refer tab and the bottom of the Dashboard.
 */
export function InviteLinkCard() {
  const { address } = useWallet();
  const [copied, setCopied] = useState(false);

  const myLink = useMemo(() => {
    if (!address || typeof window === 'undefined') return '';
    return `${window.location.origin}/?ref=${address}`;
  }, [address]);

  const onCopy = useCallback(async () => {
    if (!myLink) return;
    // Secure-context and in-app-browser fallbacks live in lib/clipboard.
    if (await copyText(myLink)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [myLink]);

  return (
    <div className="card-themed !p-0 overflow-hidden">
      <div className="px-3 py-3">
        <div className="font-medium mb-2">Your Invite Link</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={myLink}
            readOnly
            className="flex-1 px-3 py-2 font-mono text-xs bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded"
            data-testid="referral-link-input"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <button
            onClick={onCopy}
            disabled={!myLink}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 dark:disabled:bg-gray-600 !text-white text-sm font-medium rounded transition-colors whitespace-nowrap"
            data-testid="referral-link-copy"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
