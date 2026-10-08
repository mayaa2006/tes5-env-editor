/** Ways a quest can fail: pick them in the plan review; the quest map shows them. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`quest fails if someone dies or time runs out (${size.width}×${size.height})`, async ({ page }) => {
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

    await dlg.getByTestId('plan-tab-story').click();
    const card = dlg.getByTestId('plan-failures');
    await expect(card).toContainText("The quest can't fail");
    await card.getByTestId('add-fail-death').click();
    await expect(card.getByTestId('plan-failure')).toHaveCount(1);
    await expect(card).toContainText('If Brynja dies before the quest is finished, it fails.');
    // A failing stage was added for it.
    await expect(dlg.getByTestId('plan-stages')).toContainText('Fails the quest');

    await card.getByTestId('add-fail-time').click();
    await expect(card.getByTestId('add-fail-time')).toBeDisabled();
    await card.getByTestId('fail-days').fill('2');
    await card.getByTestId('fail-days').blur();
    await expect(card).toContainText("If the quest isn't finished 2 in-game days after stage 0, it fails.");
    if (process.env.SCREENSHOT_DIR) await card.screenshot({ path: `${process.env.SCREENSHOT_DIR}/quest-failures-${size.width}.png` });

    // Remove and bring back.
    await card.getByTestId('remove-failure').first().click();
    await expect(card.getByTestId('plan-failure')).toHaveCount(1);
    await dlg.getByTestId('plan-undo').click();
    await expect(card.getByTestId('plan-failure')).toHaveCount(2);

    await expect(dlg.getByTestId('build-quest')).toBeEnabled();
    await dlg.getByTestId('build-quest').click();
    await expect(dlg.getByTestId('build-result')).toContainText('if Brynja (DemoInnkeeper) dies before');
    await dlg.getByTestId('open-built-quest').click();
    await expect(page.getByTestId('quest-map')).toContainText('Time runs out (2 days)');
    expect(errors).toEqual([]);
  });
}
