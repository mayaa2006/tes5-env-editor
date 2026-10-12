/** Stage cards list the dialogue tied to them, and a quest can say when all its dialogue is available. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`stages show their dialogue and the quest sets when its dialogue is available (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
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

    // Stages tab: stage 10 has a line only said there; a stage with no dialogue says what to do next.
    await page.getByRole('tab', { name: /Stages/ }).click();
    const s10 = page.getByTestId('stage-dialogue-10');
    await expect(s10).toContainText('Only said at this stage');
    await expect(s10.getByTestId('stage-dialogue-line').first()).toBeVisible();
    await page.getByTestId('add-stage').click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.locator('[data-testid^="stage-dialogue-"]').filter({ hasText: 'No dialogue is tied to this stage yet' })).toHaveCount(1);

    // Clicking a line opens it in the Dialogue tab, selected.
    await s10.getByTestId('stage-dialogue-line').first().click();
    await expect(page.getByRole('tab', { name: /Dialogue/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('info-when')).toBeVisible();

    // Dialogue availability from the toolbar: starts at the quest running, then from a stage, stopping at completion.
    await page.getByTestId('dlg-availability').click();
    const modal = page.getByRole('dialog').getByTestId('dialogue-availability');
    await expect(modal.locator('select').first()).toHaveValue('running');
    await modal.locator('select').first().selectOption('from');
    await expect(modal.locator('select').nth(1)).toBeVisible();
    await modal.getByLabel('Stop offering it once the quest is completed').check();
    await page.getByRole('button', { name: 'Done' }).click();

    // The same settings show on the Overview tab (and survive switching tabs).
    await page.getByRole('tab', { name: 'Overview' }).click();
    const overview = page.getByTestId('dialogue-availability');
    await expect(overview.locator('select').first()).toHaveValue('from');
    await expect(overview.getByLabel('Stop offering it once the quest is completed')).toBeChecked();

    // Back to "whenever the quest is running" and untick: no conditions left.
    await overview.locator('select').first().selectOption('running');
    await overview.getByLabel('Stop offering it once the quest is completed').uncheck();
    await expect(overview.locator('select')).toHaveCount(1);
    await expect(overview.getByLabel('Stop offering it once the quest is completed')).not.toBeChecked();
    expect(errors).toEqual([]);
  });
}
