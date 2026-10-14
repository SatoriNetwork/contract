// Full browser e2e for the pay-in-SATORI flow: a dry wallet (SATORI, ~0 ETH)
// attempts a real prediction, meets the prompt, and both branches are driven
// through the actual dapp against a live stack (node + relayer + deployed
// contracts). Run via tests/run_ui_e2e.sh, which stages everything.
//
// Asserts the states only a real relayed transaction produces: the prediction
// lands on-chain under the USER's address, the hub relay nonce advances, and
// the relayer is paid — plus the UX contract (prompt copy, NO blocks and is
// remembered, YES turns the willing setting on).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pkg from '/code/Satori/contract/satori-ui/node_modules/playwright/index.js';
import { ethers } from '/code/Satori/contract/satori-ui/node_modules/ethers/lib.commonjs/index.js';

const { chromium } = pkg;
const here = dirname(fileURLToPath(import.meta.url));
const T = JSON.parse(readFileSync(join(here, 'ui-e2e-target.json'), 'utf8'));
const UI = process.env.UI_URL || 'http://127.0.0.1:3070';

const provider = new ethers.JsonRpcProvider(T.rpc);
const hub = new ethers.Contract(T.hub, [
  'function relayNonces(address) view returns (uint256)',
  'function getCurrentRound() view returns (uint256)',
], provider);
const engine = new ethers.Contract(T.engine, [
  'function predictedStreamsCount(address,uint256) view returns (uint256)',
], provider);
const token = new ethers.Contract(T.token, [
  'function balanceOf(address) view returns (uint256)',
], provider);
const relayerAddr = ethers.computeAddress(T.relayerKey);

const checks = [];
const check = (name, cond, extra = '') => { checks.push({ name, ok: !!cond, extra }); };

async function queueAndReachSubmit(page) {
  await page.waitForSelector('[data-testid="btn-up"]', { timeout: 45000 });
  await page.locator('[data-testid="btn-up"]').first().click();
  await page.waitForSelector('[data-testid="btn-submit"]', { timeout: 20000 });
}

async function run() {
  const browser = await chromium.launch();
  const round = await hub.getCurrentRound();

  // ---- Flow 1: NO cancels this tx only — retry asks AGAIN (no memory) ------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(UI, { waitUntil: 'networkidle', timeout: 60000 });
    await queueAndReachSubmit(page);

    await page.locator('[data-testid="btn-submit"]').click();
    await page.waitForSelector('[data-testid="gas-satori-prompt"]', { timeout: 20000 });
    const feeText = await page.locator('[data-testid="gas-satori-prompt"]').innerText();
    check('prompt appears with a fee', /SATORI/.test(feeText), feeText.replace(/\s+/g, ' ').slice(0, 80));

    await page.locator('[data-testid="gas-satori-no"]').click();
    await page.waitForSelector('[data-testid="submit-error"]', { timeout: 10000 });
    const errText = await page.locator('[data-testid="submit-error"]').innerText();
    check('NO shows add-ETH message', /add some ETH/i.test(errText), errText.slice(0, 80));

    const consumed1 = await engine.predictedStreamsCount(T.devUser, round);
    check('NO did not consume the prediction', consumed1 === 0n, `count=${consumed1}`);

    // Retry: NO is not remembered, so the prompt must appear again — the whole
    // point of the fix. A user who declined by mistake can get back to yes.
    await page.locator('[data-testid="btn-submit"]').click();
    let reprompted = false;
    try { await page.waitForSelector('[data-testid="gas-satori-prompt"]', { timeout: 15000 }); reprompted = true; } catch {}
    check('retry DOES re-prompt (no memory of the no)', reprompted);
    // Dismiss it again to leave a clean state for the assertion below.
    if (reprompted) await page.locator('[data-testid="gas-satori-no"]').click();
    check('no page errors (flow 1)', errs.length === 0, errs.join('; '));
    await ctx.close();
  }

  // ---- Flow 2: YES relays, lands on-chain, and enables the willing setting -
  {
    const ctx = await browser.newContext(); // fresh localStorage → decline reset
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    const relayerBefore = await token.balanceOf(relayerAddr);

    await page.goto(UI, { waitUntil: 'networkidle', timeout: 60000 });
    await queueAndReachSubmit(page);
    await page.locator('[data-testid="btn-submit"]').click();
    await page.waitForSelector('[data-testid="gas-satori-prompt"]', { timeout: 20000 });
    await page.locator('[data-testid="gas-satori-yes"]').click();

    // The relay round-trips through the HTTP service and the chain; poll state.
    let landed = false;
    for (let i = 0; i < 40; i++) {
      if (await engine.predictedStreamsCount(T.devUser, round) === 1n) { landed = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    check('YES: prediction landed on-chain under the USER', landed);
    check('YES: hub relay nonce advanced', await hub.relayNonces(T.devUser) === 1n);
    const relayerAfter = await token.balanceOf(relayerAddr);
    check('YES: relayer was paid the SATORI fee', relayerAfter > relayerBefore,
      `+${ethers.formatEther(relayerAfter - relayerBefore)}`);

    // The willing setting is now on (remembered), visible under advanced.
    await page.goto(`${UI}/?tab=delegation`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('[data-testid="gas-toggle-willing"]', { timeout: 30000 });
    check('YES turned the willing setting ON', await page.locator('[data-testid="gas-toggle-willing"]').isChecked());
    check('no page errors (flow 2)', errs.length === 0, errs.join('; '));
    await ctx.close();
  }

  await browser.close();

  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.extra ? `  [${c.extra}]` : ''}`);
    if (!c.ok) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(2); });
