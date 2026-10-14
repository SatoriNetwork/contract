// record-demo.js — Satori "daily" hype reel v2. Scripted, captioned walkthrough
// captured as a continuous WebM via Playwright's recordVideo.
//
// Storyboard (v2):
//   0. Black open -> fade in "Satori" -> fade in "daily" -> hold -> reveal UI.
//   1. Land on the mature flagship graph (a month of values + red/green
//      prediction sentiment). Let it breathe.
//   2. PREDICT: glide the cursor to UP / DOWN, stack a couple, the Submit button
//      rises, press it. Bottom caption: "Predict".
//   3. CLAIM: scroll to the dashboard claim card (a fat yesterday balance), press
//      claim, watch the balance rise and claimable fall to zero. Bottom caption:
//      "Claim" / "yesterday's rewards".
//   4. REFER: open the Referral tab, copy the invite link. Bottom caption:
//      "Refer and earn".
//   5. Black close -> "Satori daily".
//
// Prereqs (see demo/README.md): hardhat node + deploy + seed-demo + seed-video
// (mature graph; Bob open-to-predict with claimable), dapp dev server. The
// recorder switches the dev account to **Bob** for the whole reel.
//
// Robustness: every sub-action that touches a possibly-missing element is
// guarded so one missing element can NEVER abort the recording.
const { chromium } = require('playwright');

const URL = process.env.DEMO_URL || 'http://localhost:3031';
const OUT_DIR = __dirname + '/recording';
const VW = 1280, VH = 720;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Bottom lower-third caption: a big word + an optional smaller line. ----
async function caption(page, { big, small }) {
  await page.evaluate(({ big, small }) => {
    let host = document.getElementById('__cap__');
    if (!host) { host = document.createElement('div'); host.id = '__cap__'; document.documentElement.appendChild(host); }
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:7%;z-index:2147483647;pointer-events:none;display:flex;justify-content:center;font-family:Inter,system-ui,Arial,sans-serif;transition:opacity .45s ease;opacity:1;';
    host.innerHTML = `
      <div style="background:rgba(8,12,24,0.82);backdrop-filter:blur(3px);padding:18px 46px;border-radius:18px;border:1px solid rgba(120,160,255,0.30);box-shadow:0 14px 64px rgba(0,0,0,0.6);text-align:center;">
        <div style="color:#fff;font-weight:800;font-size:52px;line-height:1.04;text-shadow:0 2px 18px rgba(80,140,255,0.45);">${big || ''}</div>
        ${small ? `<div style="color:#9fc1ff;font-weight:500;font-size:24px;margin-top:6px;">${small}</div>` : ''}
      </div>`;
  }, { big: big || '', small: small || '' });
}
async function clearCaption(page) {
  await page.evaluate(() => { const h = document.getElementById('__cap__'); if (h) h.style.opacity = '0'; });
  await sleep(500);
}

// ---- Smooth absolute scroll (reads well on video). ----
async function smoothScrollTo(page, y, ms = 1400) {
  await page.evaluate(async ({ y, ms }) => {
    const start = window.scrollY, dist = y - start, t0 = performance.now();
    await new Promise((resolve) => {
      function step(now) {
        const p = Math.min(1, (now - t0) / ms);
        window.scrollTo(0, start + dist * (0.5 - 0.5 * Math.cos(Math.PI * p)));
        if (p < 1) requestAnimationFrame(step); else resolve();
      }
      requestAnimationFrame(step);
    });
  }, { y, ms });
}

// ---- Glide the cursor to an element's center (visual cue), no click. ----
async function glideTo(page, locator, steps = 28) {
  try { const box = await locator.first().boundingBox(); if (!box) return null;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps }); return box;
  } catch { return null; }
}
async function safeClick(page, locator, label = '') {
  try {
    if (await locator.count()) {
      await glideTo(page, locator); await sleep(360);
      await locator.first().click({ timeout: 4000 });
      console.log('  click OK   :', label); return true;
    }
    console.log('  click MISS :', label, '(not found)');
  } catch (e) { console.log('  click FAIL :', label, '-', String(e.message).split('\n')[0]); }
  return false;
}
// Smooth-scroll so an element sits `offset` px below the top of the viewport.
async function smoothScrollToEl(page, locator, offset = 210) {
  try {
    const y = await locator.first().evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    await smoothScrollTo(page, Math.max(0, Math.round(y - offset)), 1500);
  } catch (e) { /* element gone — skip */ }
}
async function gotoTab(page, name) { await safeClick(page, page.locator(`[data-testid="tab-${name}"]`), `tab-${name}`); await sleep(1300); }
async function pickAccount(page, label) {
  try { const sel = page.locator('[data-testid="dev-account-select"]'); if (await sel.count()) { await sel.selectOption({ label }); await sleep(3400); } }
  catch (e) { /* keep going */ }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: VW, height: VH },
    recordVideo: { dir: OUT_DIR, size: { width: VW, height: VH } },
    deviceScaleFactor: 1,
  });

  // Open on BLACK from frame 0: paint the document black at document-start, then
  // mount a full-screen black cover with the "Satori / daily" wordmark (hidden),
  // so the dapp loads UNSEEN behind it.
  await ctx.addInitScript(() => {
    try { document.documentElement.style.background = '#000'; } catch (e) {}
    const mount = () => {
      if (document.getElementById('__black__')) return;
      const b = document.createElement('div');
      b.id = '__black__';
      b.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483646;display:flex;flex-direction:column;align-items:center;justify-content:center;transition:opacity 1s ease;opacity:1;font-family:Inter,system-ui,Arial,sans-serif;';
      b.innerHTML =
        '<div id="__it__" style="opacity:0;transition:opacity 1.2s ease;color:#fff;font-weight:800;font-size:120px;letter-spacing:.06em;text-shadow:0 4px 48px rgba(80,140,255,0.55);">Satori</div>' +
        '<div id="__is__" style="opacity:0;transition:opacity 1.2s ease;color:#9fc1ff;font-weight:600;font-size:44px;letter-spacing:.42em;margin-top:14px;text-transform:lowercase;">daily</div>';
      document.documentElement.appendChild(b);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  });

  const page = await ctx.newPage();
  page.on('console', () => {});
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // ---- Beat 0: Black intro (~8s). Dapp loads + switches to Bob behind black. ----
  await sleep(1200);
  await page.evaluate(() => { const e = document.getElementById('__it__'); if (e) e.style.opacity = '1'; }); // "Satori"
  await sleep(1700);
  await page.evaluate(() => { const e = document.getElementById('__is__'); if (e) e.style.opacity = '1'; }); // "daily"
  await sleep(2600);
  // Prepare the reveal behind the curtain: Bob (open-to-predict, has claimable).
  await page.waitForTimeout(4000); // dev signer auto-connect + first data load
  await pickAccount(page, 'Bob');
  await smoothScrollTo(page, 0, 200);
  // Lift the curtain. CRUCIAL: an opacity:0 full-screen overlay still eats every
  // click, so drop pointer-events too or the whole reel can't interact.
  await page.evaluate(() => { const b = document.getElementById('__black__'); if (b) { b.style.opacity = '0'; b.style.pointerEvents = 'none'; } });
  await sleep(1100);

  // ---- Beat 1: The mature graph (~5s). Let it breathe at the top. ----
  await smoothScrollTo(page, 0, 200);
  await sleep(2400);
  await glideTo(page, page.locator('[data-testid="stream-chart"]'));
  await sleep(2600);

  // ---- Beat 2: Predict (top of the Dashboard) (~13s). ----
  await caption(page, { big: 'Predict' });
  await sleep(1200);
  await smoothScrollToEl(page, page.locator('[data-testid="btn-up"]'), 250);
  await sleep(700);
  await safeClick(page, page.locator('[data-testid="btn-up"]'), 'btn-up');     // queue an UP on the eligible stream
  await sleep(2400);
  // Predicting the last eligible stream lands on the "Ready to Submit" review
  // screen (btn-submit); mid-carousel it would be btn-submit-early. Accept both.
  const submit = page.locator('[data-testid="btn-submit"], [data-testid="btn-submit-early"]');
  for (let i = 0; i < 8 && (await submit.count()) === 0; i++) await sleep(500);
  await smoothScrollToEl(page, submit, 280);
  await sleep(700);
  await safeClick(page, submit, 'btn-submit');                                  // submit -> Bob predicts today
  await sleep(3800);                                                            // tx + "all set today" state
  await clearCaption(page);

  // ---- Beat 3: Claim yesterday's rewards — scroll DOWN the SAME page (~14s). ----
  await caption(page, { big: 'Claim', small: "yesterday's rewards" });
  await sleep(1200);
  const claimBtn = page.locator('[data-testid="btn-claim-self"]');
  await smoothScrollToEl(page, claimBtn, 190);   // claim card + claimable balance in frame
  await sleep(2600);
  await safeClick(page, claimBtn, 'btn-claim-self');   // claim -> balance rises, claimable -> 0
  await sleep(4600);
  await clearCaption(page);

  // ---- Beat 4: Refer and earn (~11s). ----
  await smoothScrollTo(page, 0, 900);
  await gotoTab(page, 'referral');
  await caption(page, { big: 'Refer and earn' });
  await sleep(1600);
  const copy = page.locator('[data-testid="referral-link-copy"]');
  await smoothScrollToEl(page, copy, 230);
  await sleep(900);
  await safeClick(page, copy, 'referral-link-copy');   // copy the invite link
  await sleep(3200);
  await clearCaption(page);

  // ---- Beat 5: Black close (~5s): "Satori daily". ----
  await page.evaluate(() => {
    const b = document.getElementById('__black__');
    if (b) { const it = document.getElementById('__it__'); const is = document.getElementById('__is__'); if (it) it.style.opacity = '1'; if (is) is.style.opacity = '1'; b.style.opacity = '1'; }
  });
  await sleep(4200);

  await page.waitForTimeout(600);
  await ctx.close();
  await browser.close();

  const fs = require('fs');
  const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.webm'));
  console.log('Recorded WebM:\n' + files.map((f) => OUT_DIR + '/' + f).join('\n'));
})().catch((e) => { console.error('record-demo failed:', e); process.exit(1); });
