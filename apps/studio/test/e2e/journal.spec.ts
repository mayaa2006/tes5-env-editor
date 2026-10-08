/** Journal & objective writer: on a plan before it's built, and on a quest on the map. */
import { expect, test } from '@playwright/test';

test('draft journal entries and objectives', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
  await page.getByTestId('quest-from-writing').click();
  const dlg = page.getByRole('dialog');
  await dlg.getByTestId('use-example').click();

  // In the plan: empty a journal entry, and the writer fills it from the steps.
  await dlg.getByTestId('plan-tab-story').click();
  const stage20 = dlg.getByTestId('plan-stages').locator('textarea').nth(2);
  await stage20.fill('');
  await stage20.blur();
  await expect(dlg.getByTestId('plan-issues')).toHaveCount(0);
  await dlg.getByTestId('plan-draft-journal').click();
  await expect(stage20).toHaveValue("I found Brynja's Ring. I should speak to Brynja.");
  await dlg.getByTestId('build-quest').click();
  await dlg.getByTestId('open-built-quest').click();

  // On the map: rewrite one entry.
  await page.getByTestId('map-write-journal').click();
  const w = page.getByTestId('journal-writer');
  await expect(w).toContainText('Every stage that needs one has a journal entry.');
  await page.getByRole('dialog').getByText('Rewrite the ones already written too').click();
  await expect(w.getByRole('checkbox', { name: 'Use the draft for stage 10', exact: true })).toBeVisible();
  for (const n of [20, 100]) await w.getByRole('checkbox', { name: `Use the draft for stage ${n}`, exact: true }).uncheck();
  for (const box of await w.getByRole('checkbox', { name: /Use objective/ }).all()) await box.uncheck();
  await expect(page.getByTestId('journal-apply')).toHaveText('Apply 1');
  await page.getByTestId('journal-apply').click();
  await expect(page.getByTestId('stage-node-10')).toContainText("I spoke with Brynja. I should find Brynja's Ring.");
  await expect(page.getByTestId('stage-node-20')).toContainText("I found Brynja's Ring. I should speak to Brynja.");
  expect(errors).toEqual([]);
});
