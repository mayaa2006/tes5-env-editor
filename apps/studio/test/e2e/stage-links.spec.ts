/** Quest stages and dialogue in plain words: when a line is said, what it does to the quest, and chips that show it. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`set when a line is said and which stage it sets (${size.width}×${size.height})`, async ({ page }) => {
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

    const response = page.getByTestId('dlg-info').first();
    await response.click();
    const when = page.getByTestId('info-when');
    const after = page.getByTestId('info-after');
    await expect(when).toContainText('When can this be said?');
    // The example's first response is only said at one stage; the picker reads that from its condition.
    await expect(when.locator('select').first()).toHaveValue('at');
    await expect(response.getByTestId('stage-chip').filter({ hasText: 'only at' })).toBeVisible();

    // "Once the quest has reached stage…" with a stage picked from the quest's own journal text.
    await when.locator('select').first().selectOption('from');
    const stageSelect = when.locator('select').nth(1);
    await expect(stageSelect).toBeVisible();
    const options = await stageSelect.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(1);
    expect(options.some((o) => /^\d+ – \S/.test(o))).toBe(true); // shows the journal text, not only the number
    const stage = (await stageSelect.inputValue()) as string;
    await expect(response).toContainText(`from ${stage}`);

    // Move the quest to a stage after this line; the node shows an arrow chip.
    await expect(after.locator('select')).toHaveValue('-1');
    await after.locator('select').selectOption({ index: options.length }); // the last stage
    await expect(response.getByTestId('stage-chip').filter({ hasText: '→' })).toBeVisible();

    // Back to "any time" removes the stage rule but leaves the stage it sets alone.
    await when.locator('select').first().selectOption('always');
    await expect(response.getByTestId('stage-chip').filter({ hasText: /^(from|only at)/ })).toHaveCount(0);
    await expect(when.locator('select').first()).toHaveValue('always');
    await expect(response.getByTestId('stage-chip').filter({ hasText: '→' })).toBeVisible();

    // Clicking a chip jumps to that stage on the map.
    await response.getByTestId('stage-chip').filter({ hasText: '→' }).click();
    await expect(page.getByRole('tab', { name: /Map/ })).toHaveAttribute('aria-selected', 'true');

    expect(errors).toEqual([]);
  });
}
