/**
 * End-to-end smoke test of the browser demo: open the demo data, edit the
 * world, characters, quests and scripts, clean a plugin and save.
 */
import { expect, test, type Page } from '@playwright/test';

const shots = process.env.SCREENSHOT_DIR;
async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function openDemo(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await expect(workspace(page, 'World')).toBeVisible();
  await expect(page.getByText('Editing MyMod.esp')).toBeVisible();
  return errors;
}

const workspace = (page: Page, name: string) => page.locator('.workspace-tab', { hasText: name });

async function viewportStats(page: Page) {
  return page.evaluate(() => (window as unknown as { __viewport?: { stats(): { objects: number; selected: number } } }).__viewport?.stats());
}

test('world editing: open a cell, select, move with G, drag & drop, navmesh', async ({ page }) => {
  const errors = await openDemo(page);
  await page.getByTestId('cell-list').getByText('DemoTavern', { exact: true }).click();
  await expect(page.getByTestId('viewport').locator('canvas')).toBeVisible();
  await expect.poll(async () => (await viewportStats(page))?.objects ?? 0).toBeGreaterThan(30);
  await page.waitForTimeout(1500);
  await shot(page, '01-world');

  // Select a reference from the outliner; the inspector shows it.
  await page.getByTestId('outliner').getByText('DemoInnkeeperRef').click();
  await expect(page.getByTestId('inspector')).toContainText('DemoInnkeeperRef');

  // Blender-style grab: G, move the mouse, click to confirm.
  const box = (await page.getByTestId('viewport').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await page.keyboard.type('64');
  await expect(page.locator('.viewport-mode .modal-info')).toContainText('Move');
  await page.keyboard.press('Enter');
  await expect(page.getByTitle(/Undo Move/)).toBeEnabled();

  // Regression: Ctrl+Z during a grab must not undo underneath it, and
  // switching cells mid-grab must cancel it without errors.
  await page.keyboard.press('g');
  await page.mouse.move(cx + 40, cy, { steps: 3 });
  await page.keyboard.press('Control+z');
  await expect(page.getByTitle(/Undo Move/)).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('g');
  await page.getByTestId('cell-list').locator('..').getByText('DemoValley0_0').click();
  await page.mouse.move(cx + 10, cy + 10, { steps: 3 });
  await page.mouse.move(cx + 30, cy + 20, { steps: 3 });
  await page.getByTestId('cell-list').getByText('DemoTavern', { exact: true }).click();
  await expect.poll(async () => (await viewportStats(page))?.objects ?? 0).toBeGreaterThan(30);
  await page.getByTestId('outliner').getByText('DemoInnkeeperRef').click();

  // Drag a base object from the object browser into the viewport.
  await page.getByRole('tab', { name: 'Objects' }).click();
  await page.getByTestId('object-list').getByText('DemoBarrel', { exact: true }).waitFor();
  const before = (await viewportStats(page))!.objects;
  const key = await page.getByTestId('object-list').getByText('DemoBarrel', { exact: true }).locator('..').getAttribute('title');
  const formKey = key!.split(' ')[0]!;
  const dt = await page.evaluateHandle((k) => {
    const d = new DataTransfer();
    d.setData('application/x-tes5-form', k);
    return d;
  }, formKey);
  await page.getByTestId('viewport').dispatchEvent('dragover', { dataTransfer: dt, clientX: cx, clientY: cy });
  await page.getByTestId('viewport').dispatchEvent('drop', { dataTransfer: dt, clientX: cx, clientY: cy });
  await expect.poll(async () => (await viewportStats(page))?.objects ?? 0).toBe(before + 1);

  // Generate the navmesh.
  await page.getByTestId('navmesh-menu').click();
  await page.getByRole('menuitem', { name: 'Generate navmesh…' }).click();
  await page.getByTestId('generate-navmesh').click();
  await expect(page.locator('.toast').filter({ hasText: /Navmesh: \d+ triangles/ })).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '02-world-navmesh');

  // Navmesh edit mode: move all vertices up with G Z 8, then draw a triangle.
  await page.mouse.move(cx, cy);
  await page.keyboard.press('Tab');
  await expect(page.locator('.viewport-mode')).toContainText('Navmesh edit mode');
  const triCount = async () => Number((await page.locator('.card', { hasText: 'triangles ·' }).locator('.dim').first().textContent())!.split(' ')[0]);
  const n0 = await triCount();
  await page.keyboard.press('a');
  await page.keyboard.press('g');
  await page.keyboard.press('z');
  await page.keyboard.type('8');
  await page.keyboard.press('Enter');
  await expect(page.getByTitle(/Undo Edit navmesh/)).toBeEnabled();
  await page.getByTestId('nav-draw').click();
  await page.mouse.move(cx, cy);
  for (const [dx, dy] of [[-120, 60], [-40, 140], [-160, 160]]) await page.mouse.click(cx + dx, cy + dy);
  await page.keyboard.press('Escape');
  await expect.poll(triCount).toBe(n0 + 1);
  await shot(page, '02b-navmesh-edit');
  expect(errors).toEqual([]);
});

test('characters, quests, scripts, cleaning and saving', async ({ page }) => {
  const errors = await openDemo(page);

  // Character creator
  await workspace(page, 'Characters').click();
  await page.getByTestId('npc-list').getByText('DemoInnkeeper').first().click();
  await expect(page.getByTestId('head-preview').locator('canvas')).toBeVisible();
  await page.getByRole('tab', { name: 'Face' }).click();
  await page.getByRole('button', { name: 'Randomize' }).click();
  await expect(page.getByTitle(/Undo Edit character look/)).toBeEnabled();
  await page.waitForTimeout(1200);
  await shot(page, '03-character');

  // Quest designer: write a stage script in the inline editor.
  await workspace(page, 'Quests').click();
  await page.getByTestId('quest-list').getByText('DemoTavernQuest').click();
  await expect(page.getByTestId('quest-map')).toBeVisible();
  await page.getByRole('tab', { name: /Stages/ }).click();
  await expect(page.getByTestId('stages')).toBeVisible();
  const first = page.getByTestId('stages').getByRole('button', { name: /script/ }).first();
  await first.click();
  const editor = page.getByTestId('code-editor').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type('SetObjectiveDisplayed(10)');
  await page.getByRole('button', { name: 'Save script' }).first().click();
  await expect(page.locator('.toast').filter({ hasText: /script saved/ })).toBeVisible();
  await page.getByRole('tab', { name: /Dialogue/ }).click();
  await expect(page.getByTestId('dialogue-graph')).toBeVisible();
  await expect(page.getByTestId('dlg-topic').first()).toBeVisible();
  await shot(page, '04-quest');

  // Script editor with live diagnostics.
  await workspace(page, 'Scripts').click();
  await page.getByTestId('script-list').getByText('DemoQuestScript').click();
  await expect(page.locator('.chip').filter({ hasText: /No problems|warning/ })).toBeVisible();
  await page.getByTestId('code-editor').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nFunction Broken()\n  UndefinedThing.DoIt()\nEndFunction\n');
  await expect(page.locator('.chip').filter({ hasText: /error/ })).toBeVisible();
  await shot(page, '05-script');

  // Cleaner
  await workspace(page, 'Clean').click();
  await page.locator('select').first().selectOption('DirtyPatch.esp');
  await page.getByTestId('analyze').click();
  await expect(page.getByTestId('clean-report')).toContainText('Would remove');
  await page.getByTestId('clean').click();
  await expect(page.locator('.toast').filter({ hasText: /ITM removed/ })).toBeVisible();
  await shot(page, '06-clean');

  // Save
  await page.keyboard.press('Control+s');
  await expect(page.locator('.toast').filter({ hasText: /Saved MyMod.esp/ })).toBeVisible();
  expect(errors).toEqual([]);
});
