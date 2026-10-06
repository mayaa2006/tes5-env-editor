/** Character routines (AI packages from templates) in the Characters tab. */
import { expect, test } from '@playwright/test';

test('give a character a daily routine', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Characters' }).click();
  await page.getByTestId('npc-list').getByText('DemoBlacksmith').first().click();
  await page.getByRole('tab', { name: 'Routine' }).click();
  const r = page.getByTestId('npc-routine');
  await expect(r).toContainText("No routine: they stand where they're placed.");

  // Sleep in the tavern at night, then go about their business the rest of the day.
  await r.getByRole('combobox').selectOption('sleep');
  await r.getByRole('button', { name: 'Around where they stand' }).click();
  await r.getByPlaceholder(/Search/).fill('DemoTavern');
  await r.locator('.list-item', { hasText: 'DemoTavern' }).first().click();
  await expect(r.getByRole('checkbox', { name: 'Only at certain hours' })).toBeChecked();
  await r.getByTestId('add-routine').click();
  await expect(r.locator('.list-item').first()).toContainText('sleeps in The Demo Tavern 22:00–06:00');
  await r.getByText('Only at certain hours').click();
  await r.getByRole('combobox').selectOption('sandbox');
  await r.getByTestId('add-routine').click();
  await expect(r.locator('.list-item')).toHaveCount(2);
  await expect(r.locator('.list-item').nth(1)).toContainText('goes about their business in The Demo Tavern');
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/17-routine.png` });

  // Take one away again; undo brings it back.
  await r.locator('.list-item').nth(1).getByTitle(/Remove from their routine/).click();
  await expect(r.locator('.list-item')).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(r.locator('.list-item')).toHaveCount(2);
  expect(errors).toEqual([]);
});
