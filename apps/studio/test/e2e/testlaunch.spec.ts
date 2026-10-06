/** Test launch: pick a place, quest stage and items; get the one console command to type in game. */
import { expect, test } from '@playwright/test';

test('prepare an in-game test from a cell and quest stage', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.getByTestId('test-launch').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Test in game');
  await expect(dlg.getByTestId('test-go')).toBeDisabled();

  const pick = async (label: string, search: string, item: string) => {
    await dlg.locator('.field', { hasText: label }).locator('button.input').first().click();
    await dlg.locator('.searchbox input').fill(search);
    await dlg.locator('.list-item', { hasText: item }).first().click();
  };
  await pick('Start in', 'DemoTavern', 'DemoTavern');
  await pick('Quest', 'DemoTavernQuest', 'DemoTavernQuest');
  await dlg.locator('.field', { hasText: 'Jump to stage' }).locator('select').selectOption({ index: 2 });
  await dlg.getByText('God mode').click();
  await dlg.getByTestId('test-go').click();

  await expect(page.getByTestId('console-command')).toHaveText('bat tes5test');
  const cmds = page.getByTestId('test-commands');
  await expect(cmds).toContainText('tgm');
  await expect(cmds).toContainText('coc DemoTavern');
  await expect(cmds).toContainText('setstage DemoTavernQuest');
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/10-test-launch.png` });
  await page.getByRole('button', { name: 'Done' }).click();
  expect(errors).toEqual([]);
});
