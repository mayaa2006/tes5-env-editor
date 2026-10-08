/** Events at quest stages: add, change, remove and undo them in the plan review, then build. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`plan events at stages (${size.width}×${size.height})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize(size);
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.locator('.workspace-tab', { hasText: 'Quests' }).click();
    await page.getByTestId('quest-from-writing').click();
    const dlg = page.getByRole('dialog');
    await dlg.getByTestId('use-example').click();

    // None yet: the card says what to do.
    await dlg.getByTestId('plan-tab-events').click();
    const card = dlg.getByTestId('plan-events');
    await expect(card).toContainText('Add an event for an ambush');
    await expect(dlg.getByTestId('plan-undo')).toBeDisabled();

    // Eirik turns on the player when the ring is found.
    await card.getByTestId('add-event').click();
    const ev = card.getByTestId('plan-event').first();
    await expect(ev).toBeVisible();
    await ev.locator('select').nth(0).selectOption('20');
    await ev.locator('select').nth(1).selectOption('hostile');
    await expect(ev).toContainText('The character attacks the player.');
    await expect(dlg.getByTestId('plan-issues')).toContainText('needs a target');
    await expect(dlg.getByTestId('build-quest')).toBeDisabled();
    await ev.getByTestId('event-targetKey').fill('eirik');
    await ev.getByTestId('event-targetKey').press('Enter');
    await expect(ev).toContainText('Target: Eirik.');
    await expect(dlg.getByTestId('build-quest')).toBeEnabled();
    if (process.env.SCREENSHOT_DIR) await card.screenshot({ path: `${process.env.SCREENSHOT_DIR}/stage-events-${size.width}.png` });

    // Remove it, then undo brings it back.
    await ev.getByTestId('remove-event').click();
    await expect(card.getByTestId('plan-event')).toHaveCount(0);
    await dlg.getByTestId('plan-undo').click();
    await expect(card.getByTestId('plan-event')).toHaveCount(1);
    await expect(card.getByTestId('event-targetKey')).toHaveValue('eirik');

    await dlg.getByTestId('build-quest').click();
    await expect(dlg.getByTestId('open-built-quest')).toBeVisible();
    expect(errors).toEqual([]);
  });
}
