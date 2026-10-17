/** Characters → Factions, classes & more: a faction with members, ranks, enemies, crime and a shop; a class; a relationship; undo. */
import { expect, test, type Locator, type Page } from '@playwright/test';

/** Pick a record in a FormPicker by typing part of its name. */
async function pick(page: Page, picker: Locator, text: string) {
  await picker.click();
  await page.getByPlaceholder(/^Search /).last().fill(text);
  await page.locator('.card .list-item', { hasText: text }).first().click();
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`factions, classes and relationships (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();

    // The Characters workspace switches between characters and the groups they belong to.
    await page.locator('.workspace-tab', { hasText: 'Characters' }).click();
    await expect(page.getByTestId('npc-list')).toBeVisible();
    await page.getByRole('tab', { name: /Factions, classes/ }).click();
    const groups = page.getByTestId('catalog-people');
    await expect(groups.getByTestId('catalog-categories')).toContainText('Factions');
    await expect(groups.getByTestId('catalog-categories')).toContainText('Relationships');

    // An existing faction shows who's in it.
    await groups.getByTestId('catalog-records').getByText('Townsfolk').click();
    const editor = groups.getByTestId('catalog-editor');
    await expect(editor.getByTestId('faction-members')).toContainText('Brynja');

    // A new faction: empty sections say what to do.
    await groups.getByTestId('catalog-new').click();
    await expect(editor.locator('h2')).toHaveText('New Faction');
    await expect(editor).toContainText('No one is in this faction yet');
    await expect(editor).toContainText('No ranks: everyone in it is simply a member');

    // A rank title for men is used for women too until it's changed.
    await editor.getByTestId('add-rank').click();
    await editor.getByPlaceholder('e.g. Initiate').fill('Initiate');
    await editor.getByPlaceholder('e.g. Initiate').press('Enter');
    await expect(editor.getByPlaceholder('Same as for men')).toHaveValue('Initiate');

    // Enemies with the Townsfolk.
    await editor.getByTestId('add-relation').click();
    const relationRow = editor.locator('tr', { has: page.locator('select') }).filter({ hasText: /None|Friends/ }).first();
    await pick(page, relationRow.locator('button.input'), 'Townsfolk');
    await relationRow.locator('select').selectOption('1');
    await expect(relationRow.locator('select')).toHaveValue('1');

    // Put Brynja in it; she's listed with her rank and can be taken out again.
    await editor.getByTestId('add-member').click();
    await pick(page, editor.getByTestId('member-picker').locator('button.input'), 'Brynja');
    await expect(editor.getByTestId('faction-members')).toContainText('Brynja');
    await expect(editor.getByTestId('faction-members')).toContainText('yours');

    // Crime starts with the holds' bounties; a shop gets opening hours.
    await editor.getByText("Keeps a bounty, like a hold's crime faction").click();
    await expect(editor.getByText('Murder', { exact: true })).toBeVisible();
    await expect(editor).toContainText('1000 gold');
    await editor.getByText('Members run a shop').click();
    await expect(editor.getByText('Opens at')).toBeVisible();
    await expect(groups.getByTestId('catalog-records')).toContainText('Shop · Tracks crime · 1 rank · 1 enemy');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/people-faction-${size.width}.png` });

    // Undo takes back the shop.
    await page.keyboard.press('Control+z');
    await expect(editor.getByText('Opens at')).toHaveCount(0);

    // A class that trains Smithing starts at level 50.
    await groups.getByTestId('category-classes').click();
    await groups.getByTestId('catalog-new').click();
    await expect(editor.locator('h2')).toHaveText('New Class');
    await expect(editor).toContainText('Pick a skill first');
    await editor.locator('.field', { hasText: 'Trains' }).locator('select').selectOption({ label: 'Smithing' });
    await expect(groups.getByTestId('catalog-records')).toContainText('trains Smithing to 50');
    await expect(editor.getByTestId('class-skills')).toContainText('Enchanting');

    // A relationship between two characters is named after them.
    await groups.getByTestId('category-relationships').click();
    await expect(groups.getByTestId('catalog-records')).toContainText('No relationships in your load order yet');
    await groups.getByTestId('catalog-new').click();
    await expect(editor).toContainText('Pick both characters');
    await pick(page, editor.locator('.field', { hasText: 'Between' }).locator('button.input'), 'Brynja');
    await pick(page, editor.locator('.field', { hasText: '…and' }).locator('button.input'), 'Halvar');
    await editor.locator('.field', { hasText: 'How they feel' }).locator('select').selectOption({ label: 'Rival' });
    await expect(groups.getByTestId('catalog-records')).toContainText('Brynja and Halvar the Smith');
    await expect(editor.locator('h2')).toHaveText('Brynja and Halvar the Smith');
    await expect(groups.getByTestId('catalog-records')).toContainText('rival');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/people-relationship-${size.width}.png` });

    // Back to the characters.
    await page.getByRole('tab', { name: 'Characters' }).click();
    await expect(page.getByTestId('npc-list')).toBeVisible();

    // From Records, a faction opens in its own editor.
    await page.locator('.workspace-tab', { hasText: 'Records' }).click();
    await page.getByPlaceholder('Editor ID, name or FormID…').fill('DemoTownFaction');
    await page.getByTestId('record-list').getByText('DemoTownFaction').click();
    await page.getByTestId('open-in-catalog').first().click();
    await expect(page.getByRole('tab', { name: /Factions, classes/ })).toHaveAttribute('aria-selected', 'true');
    await expect(groups.getByTestId('catalog-editor').locator('h2')).toHaveText('Townsfolk');
    await expect(page.getByTestId('open-in-catalog')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
