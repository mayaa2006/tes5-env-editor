/** Release tab: pre-release check with fixes and navigation, conflicts, packing into a BSA and a ZIP. */
import { expect, test } from '@playwright/test';

test('check a plugin, fix a problem, and pack it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();

  // Give the plugin something of its own to pack: a copy of a static (it brings its mesh and texture).
  await page.getByRole('tab', { name: 'Objects' }).click();
  await page.getByTestId('object-list').getByText('DemoCrate', { exact: true }).click();
  await page.getByTestId('inspector').getByRole('button', { name: /Duplicate/ }).click();
  await expect(page.getByTestId('inspector')).toContainText('DemoCrateCopy');
  // And a quest whose stages nothing leads to yet.
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
  await page.getByRole('button', { name: 'New' }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('quest-map')).toBeVisible();

  // The Release tab checks on open.
  await page.locator('.workspace-tab', { hasText: 'Release' }).click();
  const check = page.getByTestId('release-check');
  await expect(check.getByTestId('count-warning')).toBeVisible();
  await expect(check).toContainText('Nothing leads to stage');
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/14-release.png` });

  // The (?) explains.
  await check.locator('.card-title .help').first().hover();
  await expect(page.getByRole('tooltip')).toContainText('break in game');

  // Show takes you to the quest.
  await check.locator('.release-item', { hasText: 'Nothing leads to stage' }).first().getByRole('button', { name: 'Show' }).click();
  await expect(page.getByTestId('quest-map')).toBeVisible();
  await page.locator('.workspace-tab', { hasText: 'Release' }).click();

  // The moved Automations cards live here now.
  await expect(page.getByTestId('release')).toContainText('Character faces');
  await expect(page.getByTestId('release')).toContainText('Light plugin (ESL)');
  await expect(page.getByTestId('conflicts')).toContainText('No other plugin');

  // Pack: the dropped mesh and its texture are yours, so they're packed.
  const pack = page.getByTestId('package');
  await expect(pack).toContainText(/2 file\(s\) will be packed/);
  await pack.getByTestId('pack-bsa').click();
  await expect(pack.getByTestId('pack-result')).toContainText('MyMod.bsa');
  const download = page.waitForEvent('download');
  await pack.getByTestId('pack-zip').click();
  expect((await download).suggestedFilename()).toBe('MyMod.zip');
  await expect(pack.getByTestId('pack-result')).toContainText('ready to upload');

  // Settings moved to where they're used.
  await page.locator('.workspace-tab', { hasText: 'Automations' }).click();
  await expect(page.getByTestId('on-save')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Papyrus compiler');
  await page.locator('.workspace-tab', { hasText: 'Scripts' }).click();
  await page.getByTestId('script-list').getByText('DemoChestScript').click();
  await page.getByTestId('compiler-settings').click();
  await expect(page.getByRole('dialog')).toContainText('Caprica');
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  expect(errors).toEqual([]);
});
