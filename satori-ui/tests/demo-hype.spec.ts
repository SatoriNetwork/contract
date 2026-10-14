// demo-hype.spec.ts — self-contained captioned walkthrough used to produce the
// internal HYPE/DEMO reel. It is a recording vehicle, NOT an assertion suite:
// every interactive step is best-effort so a missing element can never abort the
// run; the captions + tab shots always play. Mirrors demo/record-demo.js but
// runs under the Playwright test runner (which can auto-start the dev server via
// playwright.config.ts webServer + record video per the config).
//
// Why both this spec AND demo/record-demo.js exist:
//   * demo/record-demo.js is the canonical reel producer — a standalone node
//     script with full control over recordVideo dir/size + pacing. It is what
//     build-video.sh consumes. USE THAT to (re)build the MP4.
//   * This spec lets the same walkthrough run through `npx playwright test`
//     for teammates who prefer the test runner. To capture video here, run with
//     `--video=on` (Playwright writes it under test-results/).
//
// Run (stack must be up — see demo/README.md):
//   PORT=8544 npx playwright test demo-hype --video=on --workers=1
import { test, expect } from '@playwright/test';

const VW = 1280, VH = 720;

test.use({ viewport: { width: VW, height: VH } });
// Long single test: pacing waits add up to ~2 minutes.
test.setTimeout(5 * 60 * 1000);

async function caption(page: any, opts: { title?: string; sub?: string; center?: boolean }) {
  await page.evaluate(({ title, sub, center }: any) => {
    let host = document.getElementById('__demo_caption__');
    if (!host) { host = document.createElement('div'); host.id = '__demo_caption__'; document.body.appendChild(host); }
    const pos = center
      ? 'top:0;left:0;right:0;bottom:0;'
      : 'left:0;right:0;bottom:7%;';
    host.style.cssText = `position:fixed;${pos}display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:2147483647;pointer-events:none;font-family:Inter,system-ui,Arial,sans-serif;transition:opacity .4s ease;opacity:1;`;
    const big = center ? 'font-size:104px;letter-spacing:.06em;' : 'font-size:44px;';
    const subSize = center ? 'font-size:34px;' : 'font-size:25px;';
    host.innerHTML = `<div style="background:rgba(8,12,24,0.80);padding:${center ? '40px 72px' : '20px 38px'};border-radius:18px;border:1px solid rgba(120,160,255,0.28);box-shadow:0 14px 64px rgba(0,0,0,0.6);text-align:center;max-width:88%;">
      ${title ? `<div style="color:#fff;font-weight:800;${big}line-height:1.06;">${title}</div>` : ''}
      ${sub ? `<div style="color:#9fc1ff;font-weight:500;${subSize}margin-top:${center ? '18px' : '8px'};">${sub}</div>` : ''}
    </div>`;
  }, { title: opts.title || '', sub: opts.sub || '', center: !!opts.center });
}

async function clearCaption(page: any) {
  await page.evaluate(() => { const h = document.getElementById('__demo_caption__'); if (h) h.style.opacity = '0'; });
  await page.waitForTimeout(450);
}

async function smoothScrollTo(page: any, y: number, ms = 1600) {
  await page.evaluate(async ({ y, ms }: any) => {
    const start = window.scrollY, dist = y - start, t0 = performance.now();
    await new Promise<void>((resolve) => {
      function step(now: number) {
        const p = Math.min(1, (now - t0) / ms);
        const ease = 0.5 - 0.5 * Math.cos(Math.PI * p);
        window.scrollTo(0, start + dist * ease);
        if (p < 1) requestAnimationFrame(step); else resolve();
      }
      requestAnimationFrame(step);
    });
  }, { y, ms });
}

async function safeClick(page: any, sel: string) {
  try {
    const loc = page.locator(sel);
    if (await loc.count()) { await loc.first().click({ timeout: 4000 }); return true; }
  } catch { /* recording must continue */ }
  return false;
}

async function pickAccount(page: any, label: string) {
  try {
    const sel = page.locator('[data-testid="dev-account-select"]');
    if (await sel.count()) { await sel.selectOption({ label }); await page.waitForTimeout(3200); }
  } catch { /* keep going */ }
}

test('satori hype reel walkthrough', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(9000); // dev signer auto-connect + first data load
  // Sanity (non-fatal): the app shell loaded.
  await expect(page.locator('[data-testid="dev-account-select"]')).toBeVisible({ timeout: 15000 }).catch(() => {});

  // 1. Title
  await caption(page, { title: 'SATORI', sub: 'a prediction market that mints every round', center: true });
  await page.waitForTimeout(7000); await clearCaption(page);

  // 2. Concept
  await caption(page, { title: 'Streams → Games → Predict → Earn', center: true });
  await page.waitForTimeout(6000); await clearCaption(page);

  // 3. Streams
  await safeClick(page, '[data-testid="tab-streams"]'); await page.waitForTimeout(1300);
  await caption(page, { title: 'Browse prediction streams.', sub: 'Vote one eligible.' });
  await page.waitForTimeout(2200);
  await smoothScrollTo(page, 560); await page.waitForTimeout(2600);
  await smoothScrollTo(page, 980); await page.waitForTimeout(3000);
  await smoothScrollTo(page, 1240); await page.waitForTimeout(3000);
  await clearCaption(page);

  // 4. Predict (fresh account so UP/DOWN shows)
  await pickAccount(page, 'Bob');
  await caption(page, { title: 'Predict the direction.', sub: 'Stack them. Submit.' });
  await smoothScrollTo(page, 0); await page.waitForTimeout(2800);
  await safeClick(page, '[data-testid="btn-up"]'); await page.waitForTimeout(4500);
  await page.waitForTimeout(2000); await clearCaption(page);

  // 5. Earn (account that has predicted -> claimable rewards)
  await pickAccount(page, 'Alice');
  await safeClick(page, '[data-testid="tab-dashboard"]'); await page.waitForTimeout(1300);
  await caption(page, { title: 'Win → streaks, rewards,', sub: 'claim anytime.' });
  await page.waitForTimeout(2200);
  await smoothScrollTo(page, 360); await page.waitForTimeout(3600);
  await smoothScrollTo(page, 700); await page.waitForTimeout(4200);
  await clearCaption(page);

  // 6. Extensible (flex beat)
  await safeClick(page, '[data-testid="tab-adapters"]'); await page.waitForTimeout(1300);
  await caption(page, { title: 'Add a price feed or a whole new game type —', sub: 'the UI adapts automatically.' });
  await page.waitForTimeout(2400);
  await smoothScrollTo(page, 380); await page.waitForTimeout(3800);
  await smoothScrollTo(page, 900); await page.waitForTimeout(3800);
  await safeClick(page, '[data-testid="tab-streams"]'); await page.waitForTimeout(1300);
  await smoothScrollTo(page, 760); await page.waitForTimeout(1400);
  // Stream 1 hosts a binary game AND a descriptor-driven YesNo game.
  await safeClick(page, '[data-testid="stream-row-1"] > div'); await page.waitForTimeout(2400);
  await smoothScrollTo(page, 1180); await page.waitForTimeout(5000);
  await clearCaption(page);

  // 7. Close
  await caption(page, { title: 'SATORI', sub: 'predict everything.', center: true });
  await page.waitForTimeout(7000); await clearCaption(page);
});
