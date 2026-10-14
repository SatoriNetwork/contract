import { test, expect } from '@playwright/test';

test.describe('Phase 0: Connection & Contract Reading', () => {

  test('page loads with Satori header', async ({ page }) => {
    await page.goto('/');
    // The brand header is "Satori" plus a cadence word (e.g. "daily"), so
    // match containment, not exact text.
    await expect(page.locator('h1')).toContainText('Satori');
  });

  test('dev mode auto-connects wallet', async ({ page }) => {
    await page.goto('/');
    const walletInfo = page.locator('[data-testid="wallet-info"]');
    await expect(walletInfo).toBeVisible({ timeout: 10000 });
  });

  test('displays SATORI balance', async ({ page }) => {
    await page.goto('/');
    // The header balance renders as a bare number (the SATORI unit is implied
    // by context), so assert a numeric value rather than a unit suffix.
    const balance = page.locator('[data-testid="balance"]');
    await expect(balance).toBeVisible({ timeout: 10000 });
    const text = (await balance.textContent()) ?? '';
    expect(Number.isFinite(Number(text))).toBe(true);
  });

  test('reads current round from contract', async ({ page }) => {
    await page.goto('/');
    // The round lives in its own stat card (`dash-round`), NOT in `round-info`.
    // This asserted `round-info` contained "Current Round" until 2026-08-25,
    // which stopped being true when the round moved up into the stat row and the
    // balance came down into that card — see the comment on it in Dashboard.tsx.
    // It shows the ELAPSED round (rounds since deployment — a small number),
    // not the epoch round.
    const round = page.locator('[data-testid="dash-round"]');
    await expect(round).toBeVisible({ timeout: 10000 });
    await expect(round).toContainText('Current Round');
    const text = (await round.textContent()) ?? '';
    expect(/\d/.test(text)).toBe(true);
  });

  test('reads streams from contract', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-testid="dev-account-select"]')).toBeVisible({ timeout: 10000 });
    // The Vote tab lists the streams; at least the default stream (ID 1)
    // exists straight from deploy.js.
    await page.locator('[data-testid="tab-streams"]').click();
    await expect(page.locator('[data-testid="streams-tab"]')).toBeVisible();
    await expect(page.locator('[data-testid^="stream-row-"]').first()).toBeVisible({ timeout: 15000 });
  });

  test('dev account switcher is visible', async ({ page }) => {
    await page.goto('/');
    const select = page.locator('[data-testid="dev-account-select"]');
    await expect(select).toBeVisible({ timeout: 10000 });
  });

  test('switching dev account changes address', async ({ page }) => {
    await page.goto('/');
    const walletInfo = page.locator('[data-testid="wallet-info"]');
    await expect(walletInfo).toBeVisible({ timeout: 10000 });
    const addr1 = await walletInfo.textContent();

    // Switch to Owner (index 0)
    await page.locator('[data-testid="dev-account-select"]').selectOption('0');
    await page.waitForTimeout(1000);

    const addr2 = await walletInfo.textContent();
    expect(addr2).not.toEqual(addr1);
  });
});
