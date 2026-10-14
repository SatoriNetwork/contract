import { test, expect, Page } from '@playwright/test';

// Governor + Admin tabs: role-gated visibility + the streak-curve dials.
//
// Needs a node serving the addresses in addresses.ts[31337] from the canonical
// deploy.js (so useOwner can read curveConfig()/governor()/admin()). The dev
// "Owner" account (index 0) is the deploy governor AND rewards admin, so it sees
// BOTH tabs; "Alice" (index 1) is neither and sees neither. The dial-write test
// sends a real governor tx, so it is tolerant of environment differences (it only
// asserts the write path when the success banner appears). See RUNBOOK.md.

async function connectAs(page: Page, index: '0' | '1') {
  await page.goto('/');
  // Wait for dev wallet auto-connect (same signal the other suites use).
  await expect(page.locator('[data-testid="dev-account-select"]')).toBeVisible({ timeout: 15000 });
  await page.locator('[data-testid="dev-account-select"]').selectOption(index);
}

test.describe('Governor / Admin tab visibility (role-gated)', () => {
  test('the Owner account (governor + admin) sees both tabs', async ({ page }) => {
    await connectAs(page, '0');
    await expect(page.locator('[data-testid="tab-governor"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="tab-admin"]')).toBeVisible({ timeout: 15000 });
  });

  test('a non-privileged account (Alice) sees neither tab', async ({ page }) => {
    await connectAs(page, '1');
    // Give the role read a beat to resolve, then assert the gated tabs are absent.
    await expect(page.locator('[data-testid="tab-dashboard"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="tab-governor"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="tab-admin"]')).toHaveCount(0);
  });
});

test.describe('Governor tab — streak-curve dials', () => {
  test('renders the live curve snapshot and the four dial forms', async ({ page }) => {
    await connectAs(page, '0');
    await page.locator('[data-testid="tab-governor"]').click();

    await expect(page.locator('[data-testid="governor-tab"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="governor-curve-snapshot"]')).toBeVisible();

    // All four dial inputs + their set buttons are present.
    for (const id of ['dust-floor', 'top-gradient', 'bottom-gradient', 'top-shift']) {
      await expect(page.locator(`[data-testid="input-${id}"]`)).toBeVisible();
    }
    for (const id of ['btn-set-dust-floor', 'btn-set-top-gradient', 'btn-set-bottom-gradient', 'btn-set-top-shift']) {
      await expect(page.locator(`[data-testid="${id}"]`)).toBeVisible();
    }
    // Buttons are disabled until a value is typed.
    await expect(page.locator('[data-testid="btn-set-dust-floor"]')).toBeDisabled();
    await page.locator('[data-testid="input-dust-floor"]').fill('6');
    await expect(page.locator('[data-testid="btn-set-dust-floor"]')).toBeEnabled();
  });

  test('setting the dust floor updates the live curve snapshot (governor tx)', async ({ page }) => {
    await connectAs(page, '0');
    await page.locator('[data-testid="tab-governor"]').click();
    await expect(page.locator('[data-testid="governor-curve-snapshot"]')).toBeVisible({ timeout: 15000 });

    // Pick a valid floor in [1,64] and submit as the governor.
    await page.locator('[data-testid="input-dust-floor"]').fill('7');
    await page.locator('[data-testid="btn-set-dust-floor"]').click();

    // Tolerant: once the tx confirms, the success banner shows and the snapshot
    // reflects f=7. If the environment can't send the tx, this simply times out
    // rather than asserting a false positive.
    await expect(async () => {
      const snap = page.locator('[data-testid="governor-curve-snapshot"]');
      await expect(snap).toContainText('f (floor) = 7');
    }).toPass({ timeout: 30000 });
  });
});

test.describe('Admin tab', () => {
  test('renders the admin panel with its operational rows', async ({ page }) => {
    await connectAs(page, '0');
    await page.locator('[data-testid="tab-admin"]').click();
    await expect(page.locator('[data-testid="admin-tab"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="admin-roles"]')).toBeVisible();
    // A couple of the operational controls are present.
    await expect(page.locator('[data-testid="btn-set-offchain-budget"]')).toBeVisible();
    await expect(page.locator('[data-testid="btn-accrue-protocol-fee"]')).toBeVisible();
  });
});
