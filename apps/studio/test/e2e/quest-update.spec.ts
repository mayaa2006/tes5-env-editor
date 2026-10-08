/** Changing an existing quest with a plan: see the changes first, then apply only those. */
import { expect, test } from '@playwright/test';

test('change a built quest through its plan', async ({ page }) => {
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

  await page.getByTestId('change-with-plan').click();
  const dlg = page.getByRole('dialog');
  const review = dlg.getByTestId('plan-review');
  await expect(review).toBeVisible();
  await expect(dlg.getByTestId('not-from-plan')).toHaveCount(0);
  await review.getByTestId('plan-tab-story').click();
  const stage10 = review.getByTestId('plan-stages').locator('textarea').nth(1);
  await stage10.fill('Brynja has lost her ring. I said I would look for it.');
  await stage10.blur();
  await review.getByTestId('build-quest').click();
  const preview = page.getByTestId('update-preview');
  await expect(preview).toHaveText(["Rewrite stage 10's journal entry"]);
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/18-quest-update.png` });
  await page.getByTestId('confirm-update').click();
  await expect(page.getByTestId('build-result')).toContainText('InnkeeperRingQuest is updated');
  await expect(page.getByTestId('update-line')).toHaveText(["Rewrote stage 10's journal entry"]);
  await page.getByTestId('open-built-quest').click();
  await expect(page.getByTestId('stage-node-10')).toContainText('I said I would look for it.');

  // A quest made by hand can be changed the same way; its own dialogue is kept.
  await page.getByTestId('quest-list').getByText('DemoTavernQuest').click();
  await page.getByTestId('change-with-plan').click();
  await expect(page.getByRole('dialog').getByTestId('not-from-plan')).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Back' }).click();
  expect(errors).toEqual([]);
});
