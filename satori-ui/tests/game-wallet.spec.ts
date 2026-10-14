import { test, expect } from '@playwright/test';

// Game Wallet — the promoted popup-free path (delegate to your own
// device-local key). Full lifecycle against a real local chain:
//   create (encrypt) → backup → fund gas → configure (setAllowedDelegator +
//   setPredictorFee(0), signed silently by the game wallet) → delegate (the
//   one main-wallet signature; silent in dev) → activate → reload → unlock.
//
// Requires CAP_DELEGATE_PREDICTION enabled on the deployed chain:
//   SET=1 node scripts/set-capabilities.js +delegatePrediction
// Without it the delegate step fails with the CapabilityDisabled explainer —
// the spec detects that and fails with a pointer to the command above.
//
// scrypt at the production work factor runs in-browser here, so the encrypt
// and unlock steps genuinely take a few seconds — the timeouts are for that.
const PASS = 'e2e game wallet passphrase';

test.describe('Game Wallet — popup-free delegate setup', () => {
  test('create → fund → configure → delegate → activate → survives reload behind the passphrase', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await page.locator('[data-testid="tab-delegation"]').click();

    const panel = page.locator('[data-testid="game-wallet-panel"]');
    await expect(panel).toBeVisible();

    // A previous run may have left a keystore in this browser profile; the
    // panel then opens on the locked view. Start clean.
    if (await page.locator('[data-testid="gw-forget-start"]').isVisible().catch(() => false)) {
      await page.locator('[data-testid="gw-forget-start"]').click();
      // Removal is passphrase-gated — a second tap only proves the first was
      // not a misclick, so the modal verifies ownership by decrypting.
      await page.locator('[data-testid="gw-forget-pass"]').fill(PASS);
      await page.locator('[data-testid="gw-forget-confirm"]').click();
      await expect(page.locator('[data-testid="gw-forget-modal"]')).toHaveCount(0, { timeout: 60_000 });
    }

    // --- create (encrypts at the real scrypt cost) ---
    await page.locator('[data-testid="gw-start-setup"]').click();
    await page.locator('[data-testid="gw-pass-1"]').fill(PASS);
    await page.locator('[data-testid="gw-pass-2"]').fill(PASS);
    await page.locator('[data-testid="gw-create-confirm"]').click();

    // --- backup: the key must actually be revealable ---
    const reveal = page.locator('[data-testid="gw-reveal-key"]');
    await expect(reveal).toBeVisible({ timeout: 60_000 });
    await reveal.click();
    await expect(panel).toContainText(/0x[0-9a-f]{16}/i);
    await page.locator('[data-testid="gw-backup-saved"]').check();
    await page.locator('[data-testid="gw-backup-continue"]').click();

    // --- setup checklist, in order; each button waits enabled on chain state ---
    await page.locator('[data-testid="gw-fund"]').click();
    await page.locator('[data-testid="gw-configure"]').click({ timeout: 60_000 });
    const delegate = page.locator('[data-testid="gw-delegate"]');
    await delegate.click({ timeout: 60_000 });

    // Finishing setup activates the game wallet ON ITS OWN — there is no
    // extra "start playing" confirmation to click.
    try {
      await expect(page.locator('[data-testid="gw-active-badge"]')).toBeVisible({ timeout: 60_000 });
    } catch (e) {
      if (await panel.textContent().then((t) => /switched off on this deployment/i.test(t ?? ''))) {
        throw new Error(
          'CAP_DELEGATE_PREDICTION is not enabled on this chain. Run: ' +
          'SET=1 node scripts/set-capabilities.js +delegatePrediction'
        );
      }
      throw e;
    }
    // The header states which key is signing.
    await expect(page.locator('[data-testid="gw-header-badge"]')).toBeVisible();

    // --- WHO SIGNS is one choice with two sides, and it round-trips. The old
    //     UI offered "Switch to main wallet" with no statement of the current
    //     state; this asserts both sides select, stick, and are reversible. ---
    const instant = page.locator('[data-testid="gw-mode-instant"]');
    const external = page.locator('[data-testid="gw-mode-external"]');
    await expect(instant).toHaveAttribute('aria-pressed', 'true');
    await expect(external).toHaveAttribute('aria-pressed', 'false');

    await external.click();
    await expect(external).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="gw-header-badge"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="gw-mode-explainer"]')).toContainText(/approve/i);

    await instant.click();
    await expect(instant).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-testid="gw-header-badge"]')).toBeVisible();

    // The dashboard reports the SIGNING key's gas — the balance that actually
    // runs out and stops the game — next to the SATORI balance.
    //
    // SKIPS rather than fails when the dashboard itself has no data, matching
    // the convention in tests/RUNBOOK.md: on a bare deploy the dashboard renders
    // its empty state (the same reason phase0-connection's round-info assertions
    // do not pass without seeding), and a gas readout inside a card that never
    // mounted is not this feature's failure to report.
    await page.locator('[data-testid="tab-dashboard"]').click();
    const dash = page.locator('[data-testid="dashboard"]');
    if (await dash.isVisible({ timeout: 10_000 }).catch(() => false)) {
      const gas = page.locator('[data-testid="dash-gas"]');
      await expect(gas).toBeVisible();
      await expect(gas).toContainText(/Gas .*ETH/);
    }

    // --- A RELOAD MUST NOT SILENTLY HAND THE APP BACK TO THE WALLET EXTENSION.
    //     The key is encrypted at rest so it genuinely cannot survive the
    //     reload, but the user's CHOICE does: the app-level bar says the game
    //     wallet is locked and offers to resume it, on every screen rather than
    //     buried in a settings tab. ---
    await page.reload();
    const bar = page.locator('[data-testid="gw-unlock-bar"]');
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="gw-header-badge"]')).toHaveCount(0);

    const barPass = page.locator('[data-testid="gw-bar-pass"]');
    await barPass.fill('definitely not the passphrase');
    await page.locator('[data-testid="gw-bar-unlock"]').click();
    await expect(bar).toContainText(/wrong passphrase/i, { timeout: 60_000 });

    await barPass.fill(PASS);
    await page.locator('[data-testid="gw-bar-unlock"]').click();
    // Unlocking resumes the game wallet everywhere, and the bar retires itself.
    await expect(page.locator('[data-testid="gw-header-badge"]')).toBeVisible({ timeout: 60_000 });
    await expect(bar).toHaveCount(0);

    // --- TEARDOWN, which is a feature. This key is funded AND delegated, so
    //     removing it must offer to send the leftover gas home first — deleting
    //     it silently would put that balance permanently out of reach — and must
    //     undelegate on the way out so the power is not stranded behind a key
    //     nobody holds any more. ---
    await page.locator('[data-testid="tab-delegation"]').click();
    await page.locator('[data-testid="gw-forget-start"]').click();
    // Every decision is collected BEFORE the passphrase, because verifying it
    // unlocks the key, and that state change remounts this tab — anything
    // waiting on a second click would be destroyed mid-flow.
    await expect(page.locator('[data-testid="gw-sweep-choice"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="gw-sweep-toggle"]')).toBeChecked();
    await page.locator('[data-testid="gw-forget-pass"]').fill(PASS);
    await page.locator('[data-testid="gw-forget-confirm"]').click();

    // Back to the pitch: key gone, and the panel offers to set one up again.
    await expect(page.locator('[data-testid="gw-start-setup"]')).toBeVisible({ timeout: 120_000 });
    // The delegation row agrees the power came back.
    await expect(page.locator('[data-testid="delegation-tab"]')).toContainText(/Not delegated/i);
  });
});

// Removing the key is the one irreversible action in the panel, so it is gated
// on the PASSPHRASE rather than a second tap: a confirm-click proves only that
// the first click was not an accident, while the passphrase proves the person
// at the keyboard owns the key. Verified by actually decrypting the keystore,
// so a wrong one cannot get through.
test.describe('Game Wallet — removing the key', () => {
  test('refuses a wrong passphrase, and only removes with the right one', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/');
    await page.locator('[data-testid="tab-delegation"]').click();

    // Fresh key for this test; no chain setup needed to exercise removal.
    await page.locator('[data-testid="gw-start-setup"]').click();
    await page.locator('[data-testid="gw-pass-1"]').fill(PASS);
    await page.locator('[data-testid="gw-pass-2"]').fill(PASS);
    await page.locator('[data-testid="gw-create-confirm"]').click();
    await expect(page.locator('[data-testid="gw-reveal-key"]')).toBeVisible({ timeout: 60_000 });
    await page.locator('[data-testid="gw-backup-saved"]').check();
    await page.locator('[data-testid="gw-backup-continue"]').click();

    const start = page.locator('[data-testid="gw-forget-start"]');
    await expect(start).toBeVisible();
    await start.click();

    // Wrong passphrase: refused, key still there.
    await page.locator('[data-testid="gw-forget-pass"]').fill('not the passphrase');
    await page.locator('[data-testid="gw-forget-confirm"]').click();
    await expect(page.locator('[data-testid="gw-forget-error"]')).toContainText(/wrong passphrase/i, { timeout: 60_000 });
    await expect(page.locator('[data-testid="gw-forget-modal"]')).toBeVisible();

    // Right passphrase: the key goes, and the panel returns to its pitch.
    await page.locator('[data-testid="gw-forget-pass"]').fill(PASS);
    await page.locator('[data-testid="gw-forget-confirm"]').click();
    await expect(page.locator('[data-testid="gw-start-setup"]')).toBeVisible({ timeout: 60_000 });
  });
});
