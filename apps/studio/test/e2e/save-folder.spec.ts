/** Saving into a folder you choose, whichever way the game was opened. */
import { expect, test } from '@playwright/test';

test('save everything into a new folder', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');

  // Off by default: the usual place.
  const card = page.getByTestId('save-folder-card');
  await expect(card).toContainText('Using the usual place');

  await card.getByLabel('Save into a new folder').check();
  const folder = card.getByPlaceholder(/Folder to save into/);
  await folder.fill('/Modding/MyNewMod');
  await folder.blur();

  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await expect(page.getByTestId('save-location')).toContainText('/Modding/MyNewMod');

  await page.getByTestId('load-plugins').click();
  await page.keyboard.press('Control+s');
  await expect(page.locator('.toast').filter({ hasText: /Saved MyMod.esp/ })).toBeVisible();
  expect(errors).toEqual([]);

  // The choice is remembered for next time.
  await page.reload();
  await expect(page.getByTestId('save-folder-card').getByPlaceholder(/Folder to save into/)).toHaveValue('/Modding/MyNewMod');
});

test('without the option, files are saved where they always were', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await expect(page.getByTestId('save-location')).not.toContainText('Modding');
});
