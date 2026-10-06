/** Dialogue check: problems found while writing a script and in a quest's dialogue. */
import { expect, test } from '@playwright/test';

test('dialogue is checked as you write it and on the Dialogue tab', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
  await page.getByTestId('quest-from-writing').click();
  const dlg = page.getByRole('dialog');
  await dlg.getByTestId('use-example').click();
  await dlg.getByTestId('build-quest').click();
  await dlg.getByTestId('open-built-quest').click();
  await page.getByRole('tab', { name: /Dialogue/ }).click();
  await expect(page.getByTestId('dlg-check')).toHaveText('✓ Dialogue OK');

  // A typo in a tag would silently lose the stage change: it's caught before import.
  await page.getByTestId('dlg-script').click();
  const text = page.getByTestId('dlg-script-text');
  await text.fill('PLAYER: Any news?\nDemoInnkeeper: The cellar is open again. [stge 20]');
  await expect(page.getByTestId('dlg-script-lint')).toContainText('Line 2: Unknown tag [stge 20]');
  await expect(page.getByTestId('dlg-import')).toBeDisabled();
  await text.fill('PLAYER: Any news?\nDemoInnkeeper: The cellar is open again. [stage 20]');
  await expect(page.getByTestId('dlg-script-lint')).toContainText('can still be chosen after it moved the quest on');
  await expect(page.getByTestId('dlg-import')).toBeEnabled();
  await page.getByTestId('dlg-import').click();

  // The Dialogue tab's check lists it and takes you to the line.
  await expect(page.getByTestId('dlg-check')).toHaveText('⚠ 1 to check');
  await page.getByTestId('dlg-check').click();
  const lint = page.getByTestId('dlg-lint');
  await expect(lint).toContainText('“Any news?” can still be chosen after it moved the quest on');
  await lint.getByText('“Any news?” can still be chosen').click();
  await expect(page.locator('.panel-header', { hasText: 'Player line' })).toBeVisible();
  await expect(page.getByTestId('dialogue-graph').locator('textarea')).toHaveValue('Any news?');
  expect(errors).toEqual([]);
});
