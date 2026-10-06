/** Visual triggers: build one from a template on a placed object, check the generated script. */
import { expect, test } from '@playwright/test';

test('add triggers to a placed object without scripting', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.getByTestId('cell-list').getByText('DemoTavern', { exact: true }).click();
  await page.getByTestId('outliner').getByText('DemoTavernChestRef').click();
  const insp = page.getByTestId('inspector');
  await expect(insp.getByTestId('triggers')).toBeVisible();

  // From a template: teleport when used.
  await insp.getByTestId('add-trigger').click();
  await insp.getByTestId('template-teleport-on-activate').click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Teleport the player to');
  await dlg.locator('.block-row').filter({ hasText: 'Teleport the player to' }).locator('button.input').click();
  await dlg.locator('.searchbox input').fill('DoorRef');
  await dlg.locator('.list-item', { hasText: 'DemoTavernDoorRef' }).click();
  // Add a message after it.
  await dlg.getByTestId('add-action').selectOption('notification');
  await dlg.getByPlaceholder('Text to show').fill('Whoosh!');
  await dlg.getByPlaceholder('Text to show').blur();
  await dlg.getByRole('button', { name: 'Show script' }).click();
  await expect(dlg.locator('pre')).toContainText('Game.GetPlayer().MoveTo(DemoTavernDoorRef)');
  await expect(dlg.locator('pre')).toContainText('Debug.Notification("Whoosh!")');
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/09-trigger.png` });
  await dlg.getByTestId('save-trigger').click();
  await expect(insp.getByTestId('triggers')).toContainText('teleport the player to: DemoTavernDoorRef');

  // The script exists and is attached.
  await expect(insp).toContainText('DemoTavernChestRef_Triggers');
  await page.locator('.workspace-tab', { hasText: 'Scripts' }).click();
  await page.getByTestId('script-list').getByText('DemoTavernChestRef_Triggers').click();
  await expect(page.locator('.viewport-toolbar .chip').filter({ hasText: /No problems/ })).toBeVisible();

  // Undo removes the trigger and its script attachment.
  await page.keyboard.press('Control+z');
  await page.locator('.workspace-tab', { hasText: 'World' }).click();
  await page.getByTestId('outliner').getByText('DemoTavernChestRef').click();
  await expect(insp.getByTestId('triggers')).toContainText('No triggers');
  expect(errors).toEqual([]);
});
