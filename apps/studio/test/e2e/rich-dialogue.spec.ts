/** Greetings, scenes and plain-words conditions written as a script. */
import { expect, test } from '@playwright/test';

test('greetings, a scene and conditions from a script', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
  await page.getByTestId('quest-from-writing').click();
  await page.getByRole('dialog').getByTestId('use-example').click();
  await page.getByRole('dialog').getByTestId('build-quest').click();
  await page.getByRole('dialog').getByTestId('open-built-quest').click();
  await page.getByRole('tab', { name: /Dialogue/ }).click();

  await page.getByTestId('dlg-script').click();
  const text = page.getByTestId('dlg-script-text');
  await text.fill(['GREETING: [if stage 10]', 'DemoInnkeeper: Any luck with the ring?', 'SCENE: Bar argument', 'DemoInnkeeper: You still owe me.', 'DemoBlacksmith: Tomorrow, I swear.', 'PLAYER: Lend me some gold? [if gold < 10]', 'DemoInnkeeper: Not a chance.'].join('\n'));
  await expect(page.getByTestId('dlg-script-lint')).toContainText('Scene “Bar argument” never starts');
  await text.fill(['GREETING: [if stage 10]', 'DemoInnkeeper: Any luck with the ring?', 'SCENE: Bar argument [at stage 20]', 'DemoInnkeeper: You still owe me.', 'DemoBlacksmith: Tomorrow, I swear.', 'PLAYER: Lend me some gold? [if gold < 10]', 'DemoInnkeeper: Not a chance.'].join('\n'));
  await expect(page.getByTestId('dlg-script-lint')).toHaveCount(0);
  await page.getByTestId('dlg-import').click();

  await expect(page.getByTestId('dlg-topic').filter({ hasText: 'Greeting' })).toBeVisible();
  await expect(page.getByTestId('dlg-topic').filter({ hasText: 'Scene line' })).toHaveCount(2);
  await expect(page.getByTestId('dlg-topic').filter({ hasText: 'Lend me some gold?' })).toBeVisible();
  // The scene starts at stage 20: the stage's script shows it on the map.
  await page.getByRole('tab', { name: /Map/ }).click();
  await page.getByTestId('stage-node-20').click();
  await expect(page.getByRole('button', { name: /Edit stage script/ })).toBeVisible();
  expect(errors).toEqual([]);
});
