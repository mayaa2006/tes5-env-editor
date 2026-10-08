/** Paint ground textures outdoors, with a texture picker, and undo. */
import { expect, test } from '@playwright/test';

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`paint the ground (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.getByRole('button', { name: /Explore the demo/ }).click();
    await page.getByTestId('load-plugins').click();
    await page.getByRole('tab', { name: 'Cells' }).click();
    await page.getByTestId('cell-list').locator('..').getByText('DemoValley1_0').click();
    await page.getByTestId('env-tools-toggle').click();
    await page.getByTestId('env-tab-terrain').click();

    await page.getByTestId('sculpt-paint').click();
    const list = page.getByTestId('ground-texture-list');
    await expect(list.getByTestId('ground-texture')).toHaveCount(3);
    await page.getByTestId('ground-texture-search').fill('rock');
    await list.getByText('DemoLandRock').click();
    await expect(list.getByTestId('ground-texture').first()).toHaveClass(/selected/);
    await expect(page.getByTestId('sculpt-toggle')).toHaveText('Start painting');
    await page.getByTestId('sculpt-toggle').click();

    const box = (await page.getByTestId('viewport').boundingBox())!;
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.55;
    await page.mouse.move(cx - 40, cy);
    await page.mouse.down();
    for (let i = 0; i <= 8; i++) await page.mouse.move(cx - 40 + i * 10, cy, { steps: 2 });
    await page.mouse.up();
    const undo = page.locator('button[title^="Undo Paint ground texture"]');
    await expect(undo).toBeEnabled();
    // The painted cell's ground picture is baked again.
    await expect.poll(() => page.evaluate(() => (window as any).__viewport.terrainGroup.children.some((m: any) => !!m.material.map))).toBe(true);
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/ground-paint-${size.width}.png` });
    await page.keyboard.press('Escape');
    await undo.click();
    await expect(undo).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
