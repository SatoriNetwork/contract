import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { WalletProvider } from './hooks/useWallet';
import { GaslessProvider } from './hooks/useGasless';
import reportWebVitals from './reportWebVitals';
import { signalReadyToFarcaster } from './lib/farcaster';

// Suppress uncaught RPC fetch errors (transient network issues).
// The resilient provider retries silently; this prevents the error
// overlay from showing on intermittent failures.
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || '';
  if (msg.includes('Failed to fetch') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED')) {
    e.preventDefault();
  }
});

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <WalletProvider>
      <GaslessProvider>
        <App />
      </GaslessProvider>
    </WalletProvider>
  </React.StrictMode>
);

reportWebVitals();

// Tell a Farcaster client the app has rendered, so it drops its splash screen.
// No-op everywhere else, including the Base App. See lib/farcaster.ts.
signalReadyToFarcaster();

// Service worker — production only, registered post-load so it doesn't
// compete for resources with the initial paint. The relative path
// (`./service-worker.js`) means it works under any URL root, including
// IPFS subpaths, without rebuild-time configuration. Dev skips registration
// to avoid getting in the way of webpack HMR.
if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {
      // Best-effort — a registration failure (e.g., serving from `file://`,
      // or a browser without SW support) shouldn't break the dapp.
    });
  });
}
