/** How a quest starts: pick it in the plan review; the quest map shows it. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`quest starts when the player enters a place (${size.width}×${size.height})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize(size);
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
    await page.getByTestId('quest-from-writing').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('use-example').click();

    await dlg.getByTestId('plan-tab-story').click();
    const card = dlg.getByTestId('plan-start');
    await expect(card.locator('select')).toHaveValue('game');
    await card.locator('select').selectOption('arrive');
    await expect(card).toContainText('A hidden marker in the place starts the quest');
    await expect(dlg.getByTestId('plan-issues')).toContainText('doesn’t say what');
    await card.getByTestId('start-target').fill('tavern');
    await card.getByTestId('start-target').press('Enter');
    await expect(dlg.getByTestId('build-quest')).toBeEnabled();
    if (process.env.SCREENSHOT_DIR) await card.screenshot({ path: `${process.env.SCREENSHOT_DIR}/quest-start-${size.width}.png` });

    // Undo goes back to starting with the game.
    await dlg.getByTestId('plan-undo').click();
    await expect(card.locator('select')).toHaveValue('arrive');
    await dlg.getByTestId('plan-undo').click();
    await expect(card.locator('select')).toHaveValue('game');
    await card.locator('select').selectOption('arrive');
    await card.getByTestId('start-target').fill('tavern');
    await card.getByTestId('start-target').press('Enter');

    await dlg.getByTestId('build-quest').click();
    await dlg.getByTestId('open-built-quest').click();
    await expect(page.getByTestId('map-starts')).toContainText('Starts:');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/quest-start-map-${size.width}.png` });
    expect(errors).toEqual([]);
  });
}
