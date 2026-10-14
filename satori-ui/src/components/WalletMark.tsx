import React from 'react';
import { ExternalWalletInfo } from '../hooks/useWallet';

/// The user's wallet, drawn as it draws itself.
///
/// EIP-6963 icons arrive as data URIs from the wallet, so there is nothing to
/// fetch and nothing to ship — which also keeps the page inside its CSP. When a
/// wallet did not announce one (an in-app browser, an older extension) this
/// falls back to a neutral wallet glyph rather than borrowing another brand's
/// mark, since showing a fox to a Rabby user is worse than showing no logo.
export function WalletMark({ wallet, size = 16 }: { wallet: ExternalWalletInfo; size?: number }) {
  if (wallet.icon) {
    return (
      <img
        src={wallet.icon}
        alt=""
        width={size}
        height={size}
        className="rounded-sm shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={2} aria-hidden="true" className="shrink-0 opacity-70"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7a2 2 0 012-2h12a2 2 0 012 2m-16 0v10a2 2 0 002 2h13a2 2 0 002-2v-6a2 2 0 00-2-2H5a2 2 0 01-2-2z" />
      <circle cx="16.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/// The lightning glyph that stands for instant signing throughout the app.
export function InstantMark({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
      aria-hidden="true" className="shrink-0"
    >
      <path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z" />
    </svg>
  );
}
