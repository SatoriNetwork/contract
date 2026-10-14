import { test, expect, Page } from '@playwright/test';

// C2 (a): The adapter surfaces — stream-adapter list + community register form
// present, and the game-adapter section present.
//
// These are read-only / presence assertions: they exercise the descriptor-aware
// surfaces the dapp renders, NOT on-chain writes. They need a node serving the
// addresses in addresses.ts[31337] (so useAdapters/useGameAdapters can read the
// registries), but they do NOT require any extra seed beyond the canonical
// deploy.js (which registers the 3 official stream adapters). See RUNBOOK.md.
//
// NOTE on location: the old standalone Adapters tab is gone. The panels now
// live on the ADVANCED tab (internal id "delegation") inside the "Your
// Streams" (manage) section, revealed by "+ Create Stream" and then the
// "+ Create Stream Adapter" / "+ Create Game Adapter" toggles.

async function gotoCreateArea(page: Page) {
  await page.goto('/');
  // Wait for dev wallet auto-connect (same signal the referral suite uses).
  await expect(page.locator('[data-testid="dev-account-select"]')).toBeVisible({ timeout: 15000 });
  await page.locator('[data-testid="tab-delegation"]').click();
  const createBtn = page.locator('[data-testid="btn-create-stream"]');
  await expect(createBtn).toBeVisible({ timeout: 15000 });
  await createBtn.click();
}

async function openStreamAdapters(page: Page) {
  await gotoCreateArea(page);
  await page.locator('[data-testid="btn-create-stream-adapter"]').click();
  await expect(page.locator('[data-testid="stream-adapters-section"]')).toBeVisible();
}

async function openGameAdapters(page: Page) {
  await gotoCreateArea(page);
  await page.locator('[data-testid="btn-create-game-adapter"]').click();
  await expect(page.locator('[data-testid="game-adapters-section"]')).toBeVisible();
}

test.describe('Stream adapters (Advanced tab create area)', () => {
  test('stream-adapter list and community register form are present', async ({ page }) => {
    await openStreamAdapters(page);

    // The registered stream-adapter list container always renders (it may be
    // loading / empty / populated, but the testid is unconditional).
    const list = page.locator('[data-testid="adapters-list"]');
    await expect(list).toBeVisible();

    // The permissionless community-register form is always shown to everyone.
    const form = page.locator('[data-testid="register-community-form"]');
    await expect(form).toBeVisible();
    await expect(page.locator('[data-testid="input-adapter-impl"]')).toBeVisible();
    await expect(page.locator('[data-testid="input-adapter-name"]')).toBeVisible();

    // The register button is disabled until a valid impl + name are entered —
    // a cheap proof the form is wired, no tx involved.
    const btn = page.locator('[data-testid="btn-register-adapter"]');
    await expect(btn).toBeDisabled();
  });

  test('community register button enables once a valid impl + name are typed', async ({ page }) => {
    await openStreamAdapters(page);

    await page.locator('[data-testid="input-adapter-impl"]').fill('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    await page.locator('[data-testid="input-adapter-name"]').fill('Pyth ETH/USD');

    await expect(page.locator('[data-testid="btn-register-adapter"]')).toBeEnabled();
  });

  test('canonical deploy shows the official stream adapters in the list', async ({ page }) => {
    // deploy.js registers Chainlink (id 1), Uniswap (id 2), Custom (id 3) as
    // OFFICIAL adapters. After the list settles (no spinner), at least one
    // adapter row should be present. This is tolerant: if the environment seeded
    // differently it asserts only that the list isn't stuck loading.
    await openStreamAdapters(page);
    const list = page.locator('[data-testid="adapters-list"]');
    // Wait for either a row or the explicit empty-state to settle.
    await expect(async () => {
      const rows = await list.locator('[data-testid^="adapter-row-"]').count();
      const empty = await page.locator('[data-testid="adapters-empty"]').count();
      expect(rows + empty).toBeGreaterThan(0);
    }).toPass({ timeout: 15000 });
    // On the canonical deploy, adapter row #1 (Chainlink) exists.
    await expect(page.locator('[data-testid="adapter-row-1"]')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Game adapters (Advanced tab create area)', () => {
  test('game-adapter list and community game-adapter register form are present', async ({ page }) => {
    await openGameAdapters(page);

    // The game-adapter section list container is unconditional.
    const gameList = page.locator('[data-testid="game-adapters-list"]');
    await expect(gameList).toBeVisible();

    // The permissionless community game-adapter form is always shown.
    const form = page.locator('[data-testid="register-community-gameadapter-form"]');
    await expect(form).toBeVisible();
    await expect(page.locator('[data-testid="input-gameadapter-impl"]')).toBeVisible();
    await expect(page.locator('[data-testid="input-gameadapter-name"]')).toBeVisible();

    const btn = page.locator('[data-testid="btn-register-gameadapter"]');
    await expect(btn).toBeDisabled();
  });

  test('community game-adapter button enables once a valid impl + name are typed', async ({ page }) => {
    await openGameAdapters(page);

    await page.locator('[data-testid="input-gameadapter-impl"]').fill('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC');
    await page.locator('[data-testid="input-gameadapter-name"]').fill('YesNo Threshold');

    await expect(page.locator('[data-testid="btn-register-gameadapter"]')).toBeEnabled();
  });

  test('game-adapter section settles (row or explicit empty-state)', async ({ page }) => {
    await openGameAdapters(page);
    const gameList = page.locator('[data-testid="game-adapters-list"]');
    await expect(async () => {
      const rows = await gameList.locator('[data-testid^="game-adapter-row-"]').count();
      const empty = await page.locator('[data-testid="game-adapters-empty"]').count();
      expect(rows + empty).toBeGreaterThan(0);
    }).toPass({ timeout: 15000 });
  });
});
