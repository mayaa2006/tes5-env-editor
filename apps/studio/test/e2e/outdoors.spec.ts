/** Outdoors: the cells around the current one load too; step between cells; sculpt the terrain with undo. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`walk between outdoor cells and sculpt the ground (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.getByRole('tab', { name: 'Cells' }).click();
    await page.getByTestId('cell-list').locator('..').getByText('DemoValley1_0').click();

    // The neighbour to the west is loaded too; there's nothing to the east.
    const steps = page.getByTestId('cell-steps');
    await expect(steps.getByRole('button', { name: 'W' })).toBeEnabled();
    // No cell to the east: the button offers to make one.
    await expect(steps.getByRole('button', { name: 'E+' })).toHaveAttribute('title', /No cell to the east yet: click to make one at 2, 0/);
    const outliner = page.getByTestId('outliner');
    await expect(outliner.getByText('Only the current cell')).toBeVisible();
    const own = await outliner.locator('.list-item').count();
    await outliner.getByText('Only the current cell').click();
    await expect(outliner).toContainText('In view (2 cells)');
    expect(await outliner.locator('.list-item').count()).toBeGreaterThan(own);

    // Sculpt: one stroke raises the ground, and one undo takes it back.
    await page.getByTestId('env-tools-toggle').click();
    await page.getByTestId('env-tab-terrain').click();
    await expect(page.getByTestId('env-tools')).toContainText('Edges between cells stay joined');
    await page.getByTestId('sculpt-raise').click();
    await page.getByTestId('sculpt-toggle').click();
    const before = await page.evaluate(() => (window as any).__viewport.terrainGroup.children.map((m: any) => m.geometry.attributes.position.array.reduce((a: number, b: number) => a + b, 0)));
    const box = (await page.getByTestId('viewport').boundingBox())!;
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.55;
    await page.mouse.move(cx - 40, cy);
    await page.mouse.down();
    for (let i = 0; i <= 8; i++) await page.mouse.move(cx - 40 + i * 10, cy, { steps: 2 });
    await page.mouse.up();
    await expect(page.locator('button[title^="Undo Sculpt terrain"]')).toBeEnabled();
    const after = await page.evaluate(() => (window as any).__viewport.terrainGroup.children.map((m: any) => m.geometry.attributes.position.array.reduce((a: number, b: number) => a + b, 0)));
    expect(after.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(before.reduce((a: number, b: number) => a + b, 0));
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/outdoors-${size.width}.png` });
    await page.keyboard.press('Escape');
    await page.locator('button[title^="Undo Sculpt terrain"]').click();
    await expect(page.locator('button[title^="Undo Sculpt terrain"]')).toHaveCount(0);

    // Step to the cell to the west: it becomes the current one.
    await steps.getByRole('button', { name: 'W' }).click();
    await expect(page.locator('.viewport-toolbar strong')).toHaveText('DemoValley0_0');
    await expect(steps.getByRole('button', { name: 'E' })).toBeEnabled();
    expect(errors).toEqual([]);
  });
}
