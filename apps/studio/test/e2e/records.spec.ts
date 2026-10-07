/** Items and Magic workspaces: categories in plain words, simple editors, new records from scratch, undo. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`make a spell, a loot list and a recipe in the Items and Magic tabs (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();

    // World → Objects only lists things you place, and points to the new tabs.
    await page.getByRole('tab', { name: 'Objects' }).click();
    const types = await page.getByTestId('object-type').locator('option').allTextContents();
    expect(types.some((t) => /Spell|Perk|Constructible|Leveled/.test(t))).toBe(false);
    await expect(page.locator('.sidebar')).toContainText('Spells, perks, recipes and loot lists are in the');

    // Magic: spells are empty in the demo, and the list says what to do.
    await page.locator('.workspace-tab', { hasText: 'Magic' }).click();
    const magic = page.getByTestId('catalog-magic');
    await magic.getByTestId('category-spells').click();
    await expect(magic.getByTestId('catalog-records')).toContainText('No spells in your load order yet. Click New to make one.');
    await expect(magic.getByTestId('catalog-new')).toHaveAttribute('title', /Create a new spell in .* with sensible starting values/);
    await magic.getByTestId('catalog-new').click();
    const editor = magic.getByTestId('catalog-editor');
    await expect(editor.locator('h2')).toHaveText('New Spell');
    await expect(editor.getByRole('combobox').nth(1)).toHaveValue('1'); // fire and forget
    await expect(editor).toContainText('No effects yet.');
    await editor.getByTestId('add-effect').click();
    await expect(editor.getByTestId('effect-row')).toHaveCount(1);
    await expect(editor).toContainText('strength 10, for 30 s');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/catalog-spell-${size.width}.png` });

    // Undo takes back the effect, then the spell.
    await page.keyboard.press('Control+z');
    await expect(editor.getByTestId('effect-row')).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(magic.getByTestId('catalog-records')).toContainText('No spells in your load order yet');

    // A new power starts as a greater power cast on yourself.
    await magic.getByTestId('category-powers').click();
    await magic.getByTestId('catalog-new').click();
    await expect(editor.locator('h2')).toHaveText('New Power');
    await expect(editor.getByRole('combobox').first()).toHaveValue('2');

    // Every field is still one click away.
    await editor.getByText('Show every field (like the Creation Kit)').click();
    await expect(editor).toContainText('Half-cost Perk');

    // Items: a loot list and a recipe.
    await page.locator('.workspace-tab', { hasText: 'Items' }).click();
    const items = page.getByTestId('catalog-items');
    await items.getByTestId('category-loot').click();
    await items.getByTestId('catalog-new').click();
    const itemEditor = items.getByTestId('catalog-editor');
    await expect(itemEditor).toContainText('Nothing in this list yet.');
    await itemEditor.getByTestId('add-entry').click();
    await expect(itemEditor).toContainText('Entries (1)');

    await items.getByTestId('category-recipes').click();
    await items.getByTestId('catalog-new').click();
    await expect(itemEditor.locator('h2')).toHaveText('New recipe');
    await itemEditor.getByTestId('add-component').click();
    await expect(itemEditor).toContainText('Uses (1)');
    await expect(items.getByTestId('catalog-records')).toContainText('yours');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/catalog-recipe-${size.width}.png` });
    expect(errors).toEqual([]);
  });
}
