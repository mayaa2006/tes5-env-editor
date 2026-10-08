/** Friendlier screens: plugin picker search, empty screens with next steps, "only mine" lists, named placed objects. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`empty screens say what to do, lists filter to your plugin (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();

    // Plugin picker: search, and unticking a master unticks what needs it.
    await page.getByTestId('plugin-filter').fill('dirty');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await page.getByTestId('plugin-filter').fill('');
    await page.getByRole('button', { name: 'None' }).click();
    await expect(page.getByText('0 selected')).toBeVisible();
    await page.getByRole('button', { name: 'All' }).click();
    await expect(page.getByText('2 selected')).toBeVisible();
    await page.locator('tbody tr').first().locator('input[type=checkbox]').uncheck();
    await expect(page.getByText('0 selected')).toBeVisible();
    await page.getByRole('button', { name: 'All' }).click();
    await page.getByTestId('load-plugins').click();

    // Characters: an empty screen with a New button that opens the dialog.
    await page.locator('.workspace-tab', { hasText: 'Characters' }).click();
    await expect(page.getByTestId('npc-empty')).toContainText('Pick a character to edit');
    await page.getByTestId('npc-empty').getByRole('button', { name: 'New character' }).click();
    await expect(page.locator('.modal')).toContainText('New character');
    await page.keyboard.press('Escape');
    // Only mine: the new plugin has none yet, and says so.
    await page.getByText('Only ones in MyMod.esp').click();
    await expect(page.getByTestId('npc-list')).toContainText('Your plugin has no characters yet');

    // Quests: empty screen offers both ways to start.
    await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
    await expect(page.getByTestId('quest-empty')).toContainText('New quest');
    await expect(page.getByTestId('quest-empty')).toContainText('Describe a quest');

    // Scripts.
    await page.locator('.workspace-tab', { hasText: 'Scripts' }).click();
    await page.getByTestId('script-empty').getByRole('button', { name: 'New script' }).click();
    await expect(page.locator('.modal')).toBeVisible();
    await page.keyboard.press('Escape');

    // Records: placed objects are named after what they place.
    await page.locator('.workspace-tab', { hasText: 'Records' }).click();
    await expect(page.locator('.list-item', { hasText: '(placed)' }).first()).toBeVisible();
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/records-${size.width}.png` });
    expect(errors).toEqual([]);
  });
}
