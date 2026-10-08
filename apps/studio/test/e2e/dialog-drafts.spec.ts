/** Closing a "new" dialog keeps what was typed; it is cleared once the thing is created. */
import { expect, test } from '@playwright/test';

test('a closed New quest dialog keeps its fields until the quest is created', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();

  await page.getByTestId('new-quest').click();
  const dialog = page.getByRole('dialog');
  const name = dialog.locator('.field', { hasText: /^Name/ }).locator('input');
  await name.fill('The Lost Crate');
  await name.blur();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  // Escape and clicking outside also close it.
  await page.getByTestId('new-quest').click();
  await expect(name).toHaveValue('The Lost Crate');
  await page.keyboard.press('Escape');
  await page.getByTestId('new-quest').click();
  await expect(name).toHaveValue('The Lost Crate');

  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('quest-map')).toBeVisible();

  // After creating, the next New quest starts fresh.
  await page.getByTestId('new-quest').click();
  await expect(name).toHaveValue('My Quest');
});
