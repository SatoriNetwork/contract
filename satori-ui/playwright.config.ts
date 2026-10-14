import { defineConfig } from '@playwright/test';

// Port-flexible config so the suite works at either the CRA default (3000)
// or the Tailscale-mapped dev port (3031). The hardhat node is expected on
// PORT + 1, matching the dapp's useWallet.ts auto-discovery.
const PORT = parseInt(process.env.PORT || '3000', 10);

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
  },
  webServer: {
    command: `PORT=${PORT} HOST=0.0.0.0 BROWSER=none npm start`,
    port: PORT,
    timeout: 120000,
    reuseExistingServer: true,
  },
});
