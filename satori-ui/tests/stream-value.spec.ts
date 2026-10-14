import { test, expect, Page } from '@playwright/test';

// C2 (d): Stream value rendering via formatStreamValue.
//   - Every stream row renders a value cell: stream-value-<id> (always present).
//   - When a stream's adapter advertises an IStreamAdapterUIDescriptor with a
//     valueDisplay (decimals/unit/label) — Chainlink shows feed decimals +
//     description; Uniswap shows (0,"tick",...) — the raw value is run through
//     formatStreamValue and a label/unit is shown alongside the number.
//
// The unconditional value-cell assertion needs only the canonical deploy. The
// descriptor label/unit assertion needs an ADAPTER stream (adapterId>=1) whose
// adapter implements the descriptor (Chainlink/Uniswap). The default
// seed-dev-data.js only creates Simple streams (setValue), so that part SKIPS
// unless such a stream is seeded — see RUNBOOK.md.

async function gotoStreams(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-testid="dev-account-select"]')).toBeVisible({ timeout: 15000 });
  await page.locator('[data-testid="tab-streams"]').click();
  await expect(page.locator('[data-testid="streams-tab"]')).toBeVisible();
}

test.describe('Stream value rendering', () => {
  test('every stream row renders a value cell', async ({ page }) => {
    await gotoStreams(page);

    const firstRow = page.locator('[data-testid^="stream-row-"]').first();
    await expect(firstRow).toBeVisible({ timeout: 15000 });
    const tid = await firstRow.getAttribute('data-testid');
    const id = Number((tid ?? '').replace('stream-row-', ''));

    const value = page.locator(`[data-testid="stream-value-${id}"]`);
    await expect(value).toBeVisible();
    // It renders SOME non-empty text (a number, possibly with a unit suffix).
    await expect(value).not.toHaveText('');
  });

  test('an adapter stream with a descriptor shows a formatStreamValue label/unit', async ({ page }) => {
    await gotoStreams(page);

    // Scan all stream rows for one whose value cell is immediately followed by
    // the descriptor LABEL div. In StreamsTab the value column renders, in order:
    //   <div data-testid="stream-value-{id}">{value}</div>
    //   {valueDisplay?.label && <div title={label}>{label}</div>}   <-- only here
    //   <div>… weight</div>
    // The label div is distinguished from the always-present weight div by its
    // title attribute (set to valueDisplay.label). So match the immediate next
    // div that ALSO carries a title — that only exists when a descriptor resolved
    // a non-empty label.
    const rows = page.locator('[data-testid^="stream-row-"]');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    // The descriptor label is populated ASYNCHRONOUSLY: StreamsTab probes each
    // adapter stream's impl via resolveStreamAdapterUI after first paint, then
    // re-renders the label. Poll for a row whose value cell has an immediate
    // sibling div carrying a title attribute (== the descriptor label), allowing
    // time for that probe to land before we decide to skip.
    const findLabelled = async (): Promise<number | null> => {
      const tids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') || ''));
      for (const tid of tids) {
        const id = Number(tid.replace('stream-row-', ''));
        const valueCell = page.locator(`[data-testid="stream-value-${id}"]`);
        const labelSibling = valueCell.locator('xpath=following-sibling::div[1][@title]');
        if ((await labelSibling.count()) > 0) {
          const text = (await labelSibling.first().textContent())?.trim() ?? '';
          if (text.length > 0) return id;
        }
      }
      return null;
    };

    let foundLabelStreamId: number | null = null;
    await expect(async () => {
      foundLabelStreamId = await findLabelled();
      expect(foundLabelStreamId).not.toBeNull();
    }).toPass({ timeout: 12000 }).catch(() => { /* leave null -> skip below */ });

    test.skip(foundLabelStreamId === null,
      'No descriptor-backed adapter stream seeded — create a Custom/Chainlink/Uniswap stream (RUNBOOK) to exercise the formatStreamValue label/unit.');

    const id = foundLabelStreamId!;
    const valueCell = page.locator(`[data-testid="stream-value-${id}"]`);
    await expect(valueCell).toBeVisible();
    // The value text itself is produced by formatStreamValue. For a Uniswap-style
    // adapter the unit is "tick" (decimals 0); for Chainlink the value is scaled
    // by feed decimals and may carry a unit. We assert the value text is
    // non-empty and the descriptor label carries a human description.
    await expect(valueCell).not.toHaveText('');
    const labelSibling = valueCell.locator('xpath=following-sibling::div[1][@title]');
    await expect(labelSibling.first()).not.toHaveText('');
  });
});
