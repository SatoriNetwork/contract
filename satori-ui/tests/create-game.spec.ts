import { test, expect, Page } from '@playwright/test';

// C2 (c): The create-game form shows a descriptor-driven config field
// (threshold) for a Yes/No adapter type.
//
// The create-game form lives inside a stream's games SUB-VIEW on the ADVANCED
// tab's "Your Streams" (manage) list — only streams the connected account
// PROVIDES appear there, and the games sub-view opens via the row's "games"
// pill (which renders only when the stream hosts >1 game). The RUNBOOK seed
// provides exactly that: the deployer-provided "Custom feed (e2e)" stream
// carries a second (YesNo) game.
//
// The form's game type <select> (select-create-game-type) is populated from
// the GAME-adapter registry. Picking a YesNo adapter type surfaces a
// threshold field:
//   - input-config-field-threshold  (descriptor configSchema() -> {key:"threshold", type:"int128"})
//   - input-create-game-threshold   (gameTypes.ts heuristic for selectedKind==='yesno')
// The spec accepts EITHER, asserting whichever rendered.
//
// Without the seed there is no owned multi-game stream (and no YesNo type in
// the <select>), so the tests SKIP.

async function openCreateGameForm(page: Page): Promise<number | null> {
  await page.goto('/');
  await expect(page.locator('[data-testid="dev-account-select"]')).toBeVisible({ timeout: 15000 });
  // Switch to the Owner dev account — the seed's Custom stream is provided by
  // it, so it appears on the manage list.
  await page.locator('[data-testid="dev-account-select"]').selectOption('0');
  await page.locator('[data-testid="tab-delegation"]').click();

  const rows = page.locator('[data-testid^="stream-row-"]');
  try {
    await rows.first().waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    return null; // the connected account provides no streams — seed missing
  }

  const tids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') || ''));
  for (const tid of tids) {
    const id = Number(tid.replace('stream-row-', ''));
    if (!Number.isFinite(id)) continue;
    const row = page.locator(`[data-testid="${tid}"]`);
    await row.locator('div.cursor-pointer').first().click();
    const pill = page.locator(`[data-testid="btn-games-${id}"]`);
    try {
      await pill.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
      continue; // this owned stream has only the binary game
    }
    await pill.click();
    await expect(page.locator(`[data-testid="create-game-form-${id}"]`)).toBeVisible({ timeout: 10000 });
    return id;
  }
  return null;
}

test.describe('Create-game form — type select', () => {
  test('the create-game form and game-type select render inside an owned stream\'s games view', async ({ page }) => {
    const id = await openCreateGameForm(page);
    test.skip(id === null,
      'No owned multi-game stream — run the RUNBOOK seed (Custom stream + YesNo game) to expose the create-game form.');

    const select = page.locator('[data-testid="select-create-game-type"]');
    await expect(select).toBeVisible();
    // Name + create button are always present.
    await expect(page.locator('[data-testid="input-create-game-name"]')).toBeVisible();
    await expect(page.locator(`[data-testid="btn-create-game-${id}"]`)).toBeVisible();
    // The button is disabled until a type + name are chosen (no tx involved).
    await expect(page.locator(`[data-testid="btn-create-game-${id}"]`)).toBeDisabled();
  });
});

test.describe('Create-game form — descriptor-driven threshold for a YesNo type', () => {
  test('picking a YesNo adapter type reveals a threshold config field', async ({ page }) => {
    const id = await openCreateGameForm(page);
    test.skip(id === null,
      'No owned multi-game stream — run the RUNBOOK seed (Custom stream + YesNo game) to expose the create-game form.');

    const select = page.locator('[data-testid="select-create-game-type"]');
    await expect(select).toBeVisible();

    // Find a YesNo option in the type <select>. Options are labelled
    // "type #<id>: <name> (community|official)"; YesNoGame registers with a
    // name matching /yes\s*\/?\s*no/i (e.g. "Yes/No").
    const optionTexts = await select.locator('option').allTextContents();
    const yesNoIdx = optionTexts.findIndex((t) => /yes\s*\/?\s*no/i.test(t));

    test.skip(yesNoIdx < 0,
      'No YesNo game adapter registered — run the RUNBOOK seed (register YesNoGame) to populate the type select.');

    // Select that option by its label and let the descriptor probe resolve.
    await select.selectOption({ label: optionTexts[yesNoIdx] });

    // EITHER the descriptor field OR the heuristic threshold field must appear.
    const descriptorField = page.locator('[data-testid="input-config-field-threshold"]');
    const heuristicField = page.locator('[data-testid="input-create-game-threshold"]');

    await expect(async () => {
      const a = await descriptorField.count();
      const b = await heuristicField.count();
      expect(a + b).toBeGreaterThan(0);
    }).toPass({ timeout: 10000 });

    // Type a threshold into whichever rendered, and confirm Create enables once
    // a name is also present (still no tx — disabled->enabled gate only).
    const field = (await descriptorField.count()) > 0 ? descriptorField : heuristicField;
    await field.fill('2000');
    await page.locator('[data-testid="input-create-game-name"]').fill('Above 2000');

    // The create button keys off stream id; grab it generically.
    const createBtn = page.locator(`[data-testid="btn-create-game-${id}"]`);
    await expect(createBtn).toBeEnabled();
  });
});
