/** New records from scratch: spells, leveled lists and recipes get forms with their main list ready to fill. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`create a spell and a leveled list from scratch (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.getByRole('tab', { name: 'Objects' }).click();

    // Spells are listed even though the demo has none, with a hint on what to do.
    await page.getByTestId('object-type').selectOption('SPEL');
    await expect(page.getByTestId('object-list')).toContainText('No Spell records in your load order yet. Click New to make one.');
    const newButton = page.getByTestId('new-object');
    await expect(newButton).toHaveAttribute('title', /Create a new Spell in .* with sensible defaults/);

    await newButton.click();
    const inspector = page.getByTestId('inspector');
    await expect(inspector).toContainText('New Spell');
    await expect(inspector).toContainText('Fire and Forget');
    await expect(inspector).toContainText('Effects (0)');
    await expect(page.getByTestId('object-list')).toContainText('NewSpell');
    await inspector.getByRole('button', { name: /Add Effect/ }).click();
    await expect(inspector).toContainText('Effects (1)');
    await expect(inspector).toContainText('Magic Effect');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/records-spell-${size.width}.png` });

    // Undo takes the edit back, then the spell itself.
    await page.keyboard.press('Control+z');
    await expect(inspector).toContainText('Effects (0)');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('object-list')).toContainText('No Spell records');

    // Leveled items: the entries list is there from the start.
    await page.getByTestId('object-type').selectOption('LVLI');
    await newButton.click();
    await expect(inspector).toContainText('NewLeveledItem');
    await expect(inspector).toContainText('Entries (0)');
    await inspector.getByRole('button', { name: /Add Entry/ }).click();
    await expect(inspector).toContainText('Entries (1)');

    expect(errors).toEqual([]);
  });
}
