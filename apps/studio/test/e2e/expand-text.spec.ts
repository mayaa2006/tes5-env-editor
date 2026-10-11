/** Dialogue lines open in a bigger box and save when you click off it. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`edit a dialogue line in the big box (${size.width}×${size.height})`, async ({ page }) => {
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
    await page.getByRole('tab', { name: /Dialogue/ }).click();

    // Select a player line, open it big, type, and click outside the box.
    const topic = page.getByTestId('dlg-topic').first();
    await topic.click();
    await page.getByTestId('expand-text').first().click();
    const big = page.getByTestId('expanded-text');
    await expect(big).toBeFocused();
    await big.fill('A much longer line\nthat spans two rows of text.');
    await page.mouse.click(4, 400); // click off: outside the box
    await expect(big).toHaveCount(0);
    await page.getByTestId('expand-text').first().click();
    await expect(page.getByTestId('expanded-text')).toHaveValue('A much longer line\nthat spans two rows of text.');

    // Escape also keeps what you typed, and it can be undone like any edit.
    await page.getByTestId('expanded-text').fill('Second edit');
    await page.keyboard.press('Escape');
    await page.getByTestId('expand-text').first().click();
    await expect(page.getByTestId('expanded-text')).toHaveValue('Second edit');
    await page.getByRole('button', { name: 'Done' }).click();
    expect(errors).toEqual([]);
  });
}
