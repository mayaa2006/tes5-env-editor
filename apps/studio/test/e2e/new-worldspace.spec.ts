/** Make a new worldspace, step out of it into a cell that doesn't exist yet, add a cell from the list, and undo. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`new worldspace and outdoor cells (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.getByRole('tab', { name: 'Cells' }).click();

    // A new worldspace: 3×3 cells of grass.
    await page.getByTestId('new-worldspace').click();
    const dlg = page.getByRole('dialog');
    await expect(dlg.getByTestId('new-cell-kind-world')).toHaveAttribute('aria-selected', 'true');
    await expect(dlg.getByTestId('new-world-size')).toHaveValue('3');
    await expect(dlg.getByTestId('ground-texture-none')).toHaveClass(/selected/);
    await dlg.getByTestId('ground-texture-list').getByText('DemoLandGrass').click();
    await expect(dlg.getByTestId('new-cell-note')).toContainText('9 cell(s) of flat ground');
    if (process.env.SCREENSHOT_DIR) await dlg.screenshot({ path: `${process.env.SCREENSHOT_DIR}/new-worldspace-${size.width}.png` });
    await dlg.getByTestId('create-cell').click();
    await expect(dlg).toHaveCount(0);
    await expect(page.locator('.viewport-toolbar strong')).toHaveText('Wilderness');
    await expect(page.locator('.viewport-toolbar .chip').first()).toHaveText('0, 0');
    await expect(page.getByText('MyNewWorld (10)')).toBeVisible();

    // Step east twice: the second step makes a cell that wasn't there.
    await page.getByTestId('cell-step-east').click();
    await expect(page.locator('.viewport-toolbar .chip').first()).toHaveText('1, 0');
    const make = page.getByTestId('cell-step-east');
    await expect(make).toHaveText('E+');
    await expect(make).toHaveAttribute('title', /No cell to the east yet/);
    await make.click();
    await expect(page.locator('.viewport-toolbar .chip').first()).toHaveText('2, 0');
    await expect(page.getByText('MyNewWorld (11)')).toBeVisible();
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/new-cell-step-${size.width}.png` });
    const undo = page.locator('button[title^="Undo Create cell 2, 0"]');
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(page.getByText('MyNewWorld (10)')).toBeVisible();

    // Add a cell from the list: the nearest free spot is filled in.
    await page.getByText('MyNewWorld (10)').locator('..').getByTestId('new-exterior-cell').click();
    await expect(dlg.getByTestId('new-cell-kind-exterior')).toHaveAttribute('aria-selected', 'true');
    await expect(dlg.getByTestId('new-cell-world')).toHaveValue(/.+/);
    await dlg.getByTestId('create-cell').click();
    await expect(page.getByText('MyNewWorld (11)')).toBeVisible();
    expect(errors).toEqual([]);
  });
}
