import { test as base, expect, Page } from '@playwright/test';

// Hardhat dev accounts (matches useWallet.ts dropdown)
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // index 1
const BOB   = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // index 2
const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // index 0

const PORT = parseInt(process.env.PORT || '3000', 10);
const RPC_URL = `http://localhost:${PORT + 1}`;

async function rpc(method: string, params: any[] = []): Promise<any> {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json: any = await r.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// Snapshot/revert fixture so tests don't have to share a referral pointer
// (which is set-once on chain). Each test runs in an isolated chain state.
const test = base.extend<{}>({
  page: async ({ page }, use) => {
    const snapshotId = await rpc('evm_snapshot', []);
    await use(page);
    await rpc('evm_revert', [snapshotId]);
  },
});

async function gotoReferral(page: Page, query = '') {
  await page.goto(`/${query}`);
  // Wait for wallet auto-connect
  await expect(page.locator('[data-testid="dev-account-select"]')).toBeVisible({ timeout: 15000 });
  await page.locator('[data-testid="tab-referral"]').click();
  await expect(page.locator('[data-testid="referral-tab"]')).toBeVisible();
}

async function selectAccount(page: Page, index: number) {
  await page.locator('[data-testid="dev-account-select"]').selectOption(String(index));
  // Give the React state a moment to propagate (address change re-runs effects)
  await page.waitForTimeout(500);
}

/// The manual "set my referral" control was removed on 2026-08-02 (owner
/// decision). `SatoriRewards.setReferral` is untouched on chain — this is about
/// not putting a set-once, immutable, irreversible choice one tap away in the UI.
///
/// These assert the control is ABSENT rather than merely unused, so quietly
/// reintroducing it fails a test instead of shipping. Same reasoning as the
/// splitter's absent-function post-conditions.
async function expectNoReferralSetter(page: Page) {
  await expect(page.locator('[data-testid="referral-input"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="referral-set-button"]')).toHaveCount(0);
  // Nothing anywhere on the tab should offer to set one.
  await expect(page.locator('[data-testid="referral-tab"]')).not.toContainText('Set Referral');
}

test.describe('Referral — initial state', () => {
  test('no referral set: status says so, and there is no way to set one', async ({ page }) => {
    await gotoReferral(page);
    await expectNoReferralSetter(page);
    // Refuse/opt-out is gone too: the 1% is skimmed at credit time for everyone,
    // and self-referral (the old opt-out mechanism) reverts on chain.
    await expect(page.locator('[data-testid="referral-refuse-button"]')).toHaveCount(0);
    // The tab still REPORTS state — it just cannot change it.
    await expect(page.locator('[data-testid="referral-status-card"]')).toContainText('Not set');
  });

  test('shows correct referral link for connected user', async ({ page }) => {
    await gotoReferral(page);
    const link = page.locator('[data-testid="referral-tab"] input[readonly]');
    const value = await link.inputValue();
    expect(value).toContain(`?ref=${ALICE}`); // dev default account is Alice (index 1)
  });

  test('earnings card shows 0 with empty-state copy', async ({ page }) => {
    await gotoReferral(page);
    // The earnings cell renders value + unit ("0" / "SATORI"); the empty-state
    // copy sits beside it in the same card.
    const earnings = page.locator('[data-testid="referral-earnings"]');
    await expect(earnings).toContainText('SATORI');
    // Value + unit render as adjacent elements ("0" / "SATORI"), so the
    // concatenated text is "0SATORI" with no separator.
    const text = ((await earnings.textContent()) ?? '').replace(/\s+/g, '');
    expect(/^0(\.0+)?SATORI$/.test(text)).toBe(true);
    await expect(page.locator('[data-testid="referral-tab"]')).toContainText('No referral cuts received yet');
  });
});

test.describe('Referral — the setter is gone', () => {
  test('no invite link can conjure a set-referral form', async ({ page }) => {
    // ?ref= used to pre-fill the form. There is no form to pre-fill now, and an
    // invite link must not be a route back to one.
    await gotoReferral(page, `?ref=${BOB}`);
    await expectNoReferralSetter(page);
  });

  test('a self-referring link changes nothing either', async ({ page }) => {
    await gotoReferral(page, `?ref=${ALICE}`); // Alice IS the connected user
    await expectNoReferralSetter(page);
  });

  test('an unknown-address link changes nothing either', async ({ page }) => {
    await gotoReferral(page, `?ref=${OWNER}`);
    await expectNoReferralSetter(page);
    await expect(page.locator('[data-testid="referral-status-card"]')).toContainText('Not set');
  });
});

test.describe('Referral — Account isolation', () => {
  test('switching dev accounts re-reads referral state and still offers no setter', async ({ page }) => {
    await gotoReferral(page);
    await expect(page.locator('[data-testid="referral-status-card"]')).toContainText('Not set');
    await expectNoReferralSetter(page);

    await selectAccount(page, 2);
    // A different account is a different referral row — still read-only.
    await expect(page.locator('[data-testid="referral-status-card"]')).toBeVisible({ timeout: 5000 });
    await expectNoReferralSetter(page);
  });
});
