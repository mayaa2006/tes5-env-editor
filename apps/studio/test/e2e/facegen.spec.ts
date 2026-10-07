/** RaceMenu-style face shaping and FaceGen generation, without the Creation Kit. */
import { expect, test, type Page } from '@playwright/test';

const shot = async (page: Page, name: string) => {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png` });
};

/** Drag a range input to a fraction of its width. */
async function slide(page: Page, slider: ReturnType<Page['locator']>, at: number) {
  const b = (await slider.boundingBox())!;
  await page.mouse.click(b.x + b.width * at, b.y + b.height / 2);
}

async function openKeeper(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await page.locator('.workspace-tab', { hasText: 'Characters' }).click();
  await page.getByTestId('npc-list').getByText('DemoInnkeeper').first().click();
  await expect(page.getByTestId('head-preview').locator('canvas')).toBeVisible();
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`shape a face beyond the game's sliders and generate its face files (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openKeeper(page);
    await page.getByRole('tab', { name: 'Face' }).click();
    const face = page.getByTestId('face-tab');

    // Every feature of the demo head is found from its morphs; extra morphs are listed.
    for (const p of ['head', 'nose', 'eyes', 'brows', 'cheeks', 'mouth', 'jaw', 'chin', 'ears']) await expect(face.getByTestId(`face-page-${p}`)).toBeEnabled();
    await expect(face.getByTestId('face-page-more')).toContainText('More shapes (4)');

    // Ears: bigger and moved apart.
    await face.getByTestId('face-page-ears').click();
    await expect(face).toContainText('Apart / together');
    await slide(page, face.locator('.field', { hasText: 'Size' }).locator('input[type=range]'), 0.9);
    await expect(page.getByTitle(/Undo Edit character look/)).toBeEnabled();
    await expect(face.getByTestId('face-page-ears')).toContainText('•');

    // Past the game's limits: the range doubles up to 3.
    await face.getByTestId('face-page-nose').click();
    const nose = face.locator('.field', { hasText: 'Long/Short' }).locator('input[type=range]');
    await expect(nose).toHaveAttribute('max', '1');
    await face.getByText('Beyond game limits').click();
    await expect(nose).toHaveAttribute('max', '3');
    await slide(page, nose, 0.05);

    // An extra morph from the head's TRI.
    await face.getByTestId('face-page-more').click();
    await slide(page, face.locator('.field', { hasText: 'Ears Pointed' }).locator('input[type=range]'), 0.5);

    // The face now needs its files; make them here.
    const card = page.getByTestId('face-files');
    await expect(card).toContainText('This face needs its face files');
    await shot(page, `30-face-sculpt-${size.width}`);
    await card.getByTestId('generate-face').click();
    await expect(page.locator('.toast').filter({ hasText: /Face files written/ })).toBeVisible();
    await expect(page.getByText('Face files up to date')).toBeVisible();

    // Undo takes the files away again.
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('face-files')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('paint layers by name with a preview of the baked tint', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openKeeper(page);
  await page.getByRole('tab', { name: 'Paint' }).click();
  const paint = page.getByTestId('paint-tab');
  await expect(paint).toContainText('Skin Tone');
  await expect(paint).toContainText('Lips');
  await expect(paint.getByTestId('tint-preview')).toBeVisible();
  await expect(paint.getByTestId('add-tint')).toBeDisabled();
  await paint.locator('select').selectOption({ label: 'Warpaint 01' });
  await paint.getByTestId('add-tint').click();
  await expect(paint.locator('.card')).toHaveCount(3);
  await expect(paint).toContainText('Warpaint 01');
  await shot(page, '31-face-paint');
  expect(errors).toEqual([]);
});

for (const size of [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
]) {
  test(`the Release tab lists every face, generates the changed ones and exports ticked ones (${size.width}×${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openKeeper(page);
    await page.getByRole('tab', { name: 'Face' }).click();
    await page.getByRole('button', { name: 'Randomize' }).click();
    await expect(page.getByTestId('face-files')).toBeVisible();
    await page.locator('.workspace-tab', { hasText: 'Release' }).click();
    const faces = page.getByTestId('release-faces');
    await expect(faces).toContainText('1 need attention');
    const row = faces.getByTestId('face-row').filter({ hasText: 'Brynja' });
    await expect(row).toContainText('No face files');
    await expect(faces.getByTestId('export-faces')).toBeDisabled();
    await faces.getByTestId('generate-faces').click();
    await expect(page.locator('.toast').filter({ hasText: 'Wrote face files for 1 character' })).toBeVisible();
    await expect(faces).toContainText('Every changed face has up-to-date face files.');
    await expect(row).toContainText('Up to date');
    // The pre-release check updates on its own.
    await expect(page.getByTestId('release-check')).not.toContainText('has no FaceGen files');

    // Tick a face that's already up to date and write it again (the CK's Ctrl+F4).
    await row.locator('input[type=checkbox]').check();
    await expect(faces.getByTestId('export-faces')).toHaveText('Export ticked (1)');
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/release-faces-${size.width}.png` });
    await faces.getByTestId('export-faces').click();
    await expect(page.locator('.toast').filter({ hasText: 'Wrote face files for 1 character' }).last()).toBeVisible();
    await expect(faces.getByTestId('export-faces')).toBeDisabled();

    // The search narrows the list.
    await faces.getByLabel('Find character').fill('nobody here');
    await expect(faces).toContainText('No character matches');
    expect(errors).toEqual([]);
  });
}
