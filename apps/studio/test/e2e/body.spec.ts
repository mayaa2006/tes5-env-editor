/** BodySlide in the editor: pick a set and a preset, shape with sliders, build the meshes, undo. */
import { expect, test, type Page } from '@playwright/test';

const shot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png` });
};

async function openBody(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Body' }).click();
  await expect(page.getByTestId('body-preview').locator('canvas')).toBeVisible();
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`shape a body with presets and sliders, then build it (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openBody(page);

    // The demo's set is found and selected, with its sliders.
    await expect(page.getByTestId('body-sets')).toContainText('Demo Body');
    const sliders = page.getByTestId('body-sliders');
    for (const n of ['Breasts', 'Waist', 'Hips', 'Height']) await expect(sliders.getByTestId(`body-slider-${n}`)).toBeVisible();
    await expect(page.getByTestId('body-build')).toBeEnabled();

    // A preset sets values; Waist is one value for both weights, Breasts differs between them (so it's split in two).
    await page.locator('select').first().selectOption('Demo Curvy');
    const breasts = sliders.getByTestId('body-slider-Breasts');
    await expect(breasts.locator('input[type=range]')).toHaveCount(2);
    await expect(breasts.locator('input[type=range]').first()).toHaveValue('30');
    await expect(breasts.locator('input[type=range]').nth(1)).toHaveValue('100');
    await expect(sliders.getByTestId('body-slider-Hips').locator('input[type=range]')).toHaveCount(2);
    await shot(page, 'body-curvy');

    // Reset goes back to the set's own starting values.
    await page.getByTestId('body-reset').click();
    await expect(breasts.locator('input[type=range]').nth(1)).toHaveValue('40');

    // Build writes both weights into the mod, one undo step.
    await page.getByTestId('body-build').click();
    await expect(page.locator('.toast', { hasText: 'demobody_0.nif and demobody_1.nif' })).toBeVisible();
    await expect(page.getByTitle(/Undo Build body Demo Body/)).toBeEnabled();
    await page.getByTitle(/Undo Build body Demo Body/).click();
    await expect(page.getByTitle(/Redo Build body Demo Body/)).toBeEnabled();

    // A preset made here shows up in the list.
    await page.getByTestId('body-save-preset').click();
    await page.getByRole('dialog').getByRole('textbox').fill('E2E Preset');
    await page.getByTestId('body-save-confirm').click();
    await expect(page.locator('select').first().locator('option', { hasText: 'E2E Preset' })).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}
