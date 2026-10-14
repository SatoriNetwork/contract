import { test, expect, Page, Locator } from '@playwright/test';

// C2 (b): A stream's games sub-view rendering with per-game predict controls.
//   - Every stream auto-creates the built-in binary game (type 0). It resolves
//     its options through the IGameUIDescriptor (binary path), rendering two
//     OPTION-INDEX-keyed buttons predict-game-<id>-0 (UP) / -1 (DOWN).
//   - A YesNo adapter game (type >= 1, name ~ /yes\s*\/?\s*no/) likewise renders
//     descriptor option buttons predict-game-<id>-0 (Yes) / -1 (No).
//
// NOTE on navigation: the games list is a SUB-VIEW behind the row's "games"
// pill (btn-games-<id>). The pill only renders when the stream hosts MORE than
// the built-in binary game (gameCount > 1), and the game count lazy-loads on
// the row's first expand — so the flow is: expand row, wait for the pill,
// click it. Only one stream is expanded at a time (single expandedId).
//
// Both cases therefore need the RUNBOOK seed (register YesNoGame + createGame
// on stream 1), which gives stream 1 two games: the binary game AND the YesNo
// game. Without the seed no stream has a games pill and the tests SKIP.

async function gotoStreams(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-testid="dev-account-select"]')).toBeVisible({ timeout: 15000 });
  await page.locator('[data-testid="tab-streams"]').click();
  await expect(page.locator('[data-testid="streams-tab"]')).toBeVisible();
  await expect(page.locator('[data-testid^="stream-row-"]').first()).toBeVisible({ timeout: 15000 });
}

async function streamIds(page: Page): Promise<number[]> {
  const tids = await page.locator('[data-testid^="stream-row-"]').evaluateAll(
    (els) => els.map((e) => e.getAttribute('data-testid') || ''),
  );
  return tids.map((t) => Number(t.replace('stream-row-', ''))).filter((n) => Number.isFinite(n));
}

// Expand a row (triggers the lazy game-count load), then open its games
// sub-view via the pill. Returns the games panel, or null when the stream
// has no pill (hosts only the binary game).
async function openGamesView(page: Page, streamId: number): Promise<Locator | null> {
  const row = page.locator(`[data-testid="stream-row-${streamId}"]`);
  await expect(row).toBeVisible();
  await row.locator('div.cursor-pointer').first().click();
  const pill = page.locator(`[data-testid="btn-games-${streamId}"]`);
  try {
    await pill.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return null; // <= 1 game — no games sub-view for this stream
  }
  await pill.click();
  const panel = page.locator(`[data-testid="stream-games-${streamId}"]`);
  await expect(panel).toBeVisible({ timeout: 10000 });
  return panel;
}

// Within an open panel, find the game card (data-testid stream-<s>-game-<g>)
// whose predict button label matches `labelRe`. Returns { gameId } or null.
async function findGameByButtonLabel(
  panel: Locator,
  streamId: number,
  labelRe: RegExp,
): Promise<{ gameId: number } | null> {
  const cardTids = await panel
    .locator(`[data-testid^="stream-${streamId}-game-"]`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') || ''));
  for (const tid of cardTids) {
    const card = panel.locator(`[data-testid="${tid}"]`);
    const btn = card.getByRole('button', { name: labelRe });
    if ((await btn.count()) > 0) {
      const gameId = Number(tid.split('-game-')[1]);
      if (Number.isFinite(gameId)) return { gameId };
    }
  }
  return null;
}

// Open the first stream that HAS a games sub-view and return it, or null.
async function firstGamesView(page: Page): Promise<{ panel: Locator; streamId: number } | null> {
  const ids = await streamIds(page);
  for (const streamId of ids) {
    const panel = await openGamesView(page, streamId);
    if (panel) return { panel, streamId };
  }
  return null;
}

test.describe('Stream games list — built-in binary game', () => {
  test('the games panel renders and shows the built-in binary game with UP/DOWN', async ({ page }) => {
    await gotoStreams(page);
    const open = await firstGamesView(page);
    test.skip(open === null,
      'No stream with a games pill — run the RUNBOOK seed (register YesNoGame + createGame) so a stream hosts >1 game.');

    const { panel, streamId } = open!;

    // Wait for games to load: at least one game card appears (the built-in
    // binary game always exists).
    const gameCards = panel.locator(`[data-testid^="stream-${streamId}-game-"]`);
    await expect(async () => {
      expect(await gameCards.count()).toBeGreaterThan(0);
    }).toPass({ timeout: 15000 });

    // The binary game card is the one holding an UP button (case-insensitive).
    let found: { gameId: number } | null = null;
    await expect(async () => {
      found = await findGameByButtonLabel(panel, streamId, /^up$/i);
      expect(found).not.toBeNull();
    }).toPass({ timeout: 10000 });

    const gameId = found!.gameId;
    const card = page.locator(`[data-testid="stream-${streamId}-game-${gameId}"]`);

    // Both directions render as buttons (UP / DOWN), case-insensitive.
    await expect(card.getByRole('button', { name: /^up$/i })).toBeVisible();
    await expect(card.getByRole('button', { name: /^down$/i })).toBeVisible();

    // Descriptor/binary option buttons are OPTION-INDEX-keyed: -0 (UP), -1 (DOWN).
    await expect(page.locator(`[data-testid="predict-game-${gameId}-0"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="predict-game-${gameId}-1"]`)).toBeVisible();
  });
});

test.describe('Stream games list — YesNo adapter game (descriptor-driven)', () => {
  test('a YesNo game renders Yes/No predict buttons (descriptor option buttons)', async ({ page }) => {
    await gotoStreams(page);
    const ids = await streamIds(page);

    // Scan each stream with a games sub-view (one open at a time) for a game
    // card whose button label matches Yes. The RUNBOOK seed places one on
    // stream 1.
    let match: { gameId: number; streamId: number } | null = null;
    for (const streamId of ids) {
      const panel = await openGamesView(page, streamId);
      if (!panel) continue;
      // let the lazy game load + descriptor probe settle
      await expect(async () => {
        const cards = await panel.locator(`[data-testid^="stream-${streamId}-game-"]`).count();
        expect(cards).toBeGreaterThan(0);
      }).toPass({ timeout: 10000 }).catch(() => {});
      const found = await findGameByButtonLabel(panel, streamId, /^yes$/i);
      if (found) { match = { ...found, streamId }; break; }
    }

    test.skip(match === null,
      'No YesNo game seeded — run the RUNBOOK seed (register YesNoGame + createGame) to exercise this.');

    const { gameId, streamId } = match!;
    const card = page.locator(`[data-testid="stream-${streamId}-game-${gameId}"]`);
    await expect(card.getByRole('button', { name: /^yes$/i })).toBeVisible();
    await expect(card.getByRole('button', { name: /^no$/i })).toBeVisible();

    // Descriptor option buttons are OPTION-INDEX-keyed: -0 (Yes), -1 (No).
    await expect(page.locator(`[data-testid="predict-game-${gameId}-0"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="predict-game-${gameId}-1"]`)).toBeVisible();
  });
});
