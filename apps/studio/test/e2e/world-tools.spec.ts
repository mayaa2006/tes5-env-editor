/** World tools: lighting pass, mood, clutter, paint brush, paths, room builder, linked doors, kit snapping. */
import { expect, test, type Locator, type Page } from '@playwright/test';

const shots = process.env.SCREENSHOT_DIR;

/** Open a form picker (its button) and choose an item. */
async function pick(page: Page, button: Locator, search: string, item: string) {
  await button.click();
  await page.getByPlaceholder(/^Search /).fill(search);
  await page.locator('.card .list-item', { hasText: item }).first().click();
}

async function openCell(page: Page, name: string) {
  await page.getByTestId('cell-list').locator('..').getByText(name, { exact: true }).click();
  await expect(page.getByTestId('viewport')).toBeVisible();
}

const toastText = (page: Page, re: RegExp) => page.locator('.toast').filter({ hasText: re }).last();

test('dress and build with the world tools', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: /Explore the demo/ }).click();
  await page.getByTestId('load-plugins').click();
  await openCell(page, 'DemoTavern');
  await page.getByTestId('env-tools-toggle').click();
  const panel = page.getByTestId('env-tools');
  await expect(panel).toBeVisible();

  // Lighting: the unlit candle gets a light; the tavern mood is suggested.
  await panel.getByTestId('env-tab-light').click();
  await expect(panel).toContainText('1 candle, torch or fire object');
  await panel.getByTestId('env-light').click();
  await expect(toastText(page, /Added 1 light/)).toBeVisible();
  await expect(panel.locator('select')).toHaveValue('tavern');
  await panel.getByTestId('env-mood').click();
  await expect(toastText(page, /mood applied/)).toBeVisible();

  // Clutter the tavern.
  await panel.getByTestId('env-tab-clutter').click();
  await expect(panel).toContainText('Tankard');
  await panel.getByTestId('env-clutter').click();
  await expect(toastText(page, /Placed \d+ on tables/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/11-clutter.png` });

  // Array: four more pillars in a row.
  await page.getByTestId('outliner-toggle').click();
  await page.getByTestId('outliner').locator('.list-item', { hasText: 'DemoPillar' }).first().click();
  await page.getByTestId('env-tools-toggle').click();
  await panel.getByTestId('env-tab-place').click();
  await expect(panel).toContainText('1 selected');
  await panel.getByTestId('env-array').click();
  await expect(toastText(page, /Made 4 copies/)).toBeVisible();
  await page.getByTestId('outliner-toggle').click();
  await expect(page.getByTestId('outliner').locator('.list-item', { hasText: 'DemoPillar' })).toHaveCount(5);

  // Linked door: select the tavern door, make a matching one outside.
  await page.getByTestId('outliner').getByText('DemoTavernDoorRef').click();
  await page.getByTestId('env-tools-toggle').click();
  await panel.getByTestId('env-tab-doors').click();
  await expect(panel).toContainText('is not a load door yet');
  await pick(page, panel.locator('button.input').nth(1), 'DemoValley0', 'DemoValley0_0');
  await panel.getByTestId('env-new-door').click();
  await expect(toastText(page, /Door created and linked/)).toBeVisible();
  await expect(panel).toContainText('leads to');

  // Exterior: paint bushes with the brush.
  await openCell(page, 'DemoValley1_0');
  await panel.getByTestId('env-tab-paint').click();
  await pick(page, panel.locator('button.input').first(), 'DemoBush', 'DemoBush');
  await expect(panel).toContainText('DemoBush');
  await panel.getByTestId('env-paint').click();
  const vp = (await page.getByTestId('viewport').boundingBox())!;
  const cx = vp.x + vp.width * 0.6;
  const cy = vp.y + vp.height * 0.6;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy + 10, { steps: 8 });
  await page.mouse.up();
  await expect(toastText(page, /Painted \d+/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/12-paint.png` });
  // One undo step for the whole stroke.
  await expect(page.getByTitle(/Undo Scatter/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel.getByTestId('env-paint')).toContainText('Paint in the view');

  // A road along a drawn path.
  await panel.getByTestId('env-tab-path').click();
  await pick(page, panel.locator('button.input').first(), 'DemoRoad', 'DemoRoad');
  await panel.getByTestId('env-path').click();
  for (const [fx, fy] of [
    [0.3, 0.5],
    [0.5, 0.45],
    [0.7, 0.55],
  ])
    await page.mouse.click(vp.x + vp.width * fx, vp.y + vp.height * fy);
  await page.keyboard.press('Enter');
  await expect(toastText(page, /Placed \d+ piece/)).toBeVisible();

  // A new interior built from kit pieces, with a navmesh.
  await page.getByTitle('Create a new interior cell').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click();
  await panel.getByTestId('env-tab-room').click();
  const field = (label: string) => panel.locator('.field').filter({ hasText: label }).locator('button.input');
  await pick(page, field('Floor'), 'DemoFloorWood', 'DemoFloorWood');
  await pick(page, field('Wall'), 'DemoWallPlaster', 'DemoWallPlaster');
  await pick(page, field('Corner'), 'DemoWallCorner', 'DemoWallCorner');
  await pick(page, field('Doorway'), 'DemoWallDoorway', 'DemoWallDoorway');
  // Make it an L: add a tile, then a doorway on the east side of the bottom-right tile.
  await panel.locator('[data-tile="5,4"]').click();
  await panel.getByRole('button', { name: 'Doorways' }).click();
  const t = (await panel.locator('[data-tile="5,4"]').boundingBox())!;
  await page.mouse.click(t.x + t.width - 2, t.y + t.height / 2);
  await expect(panel.locator('[data-tile="5,4"] .room-door.e')).toBeVisible();
  await panel.getByTestId('env-build-room').click();
  await expect(toastText(page, /Placed \d+ piece\(s\); navmesh \d+ triangles/)).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/13-room.png` });

  // Kit snapping: moving a wall piece with G snaps it flush to its neighbours.
  // It's on by default.
  await expect(page.getByTestId('kit-snap')).toHaveClass(/active/);
  await page.getByTestId('outliner-toggle').click();
  await page.getByTestId('outliner').locator('.list-item', { hasText: 'DemoWallCorner' }).first().click();
  const v = (await page.getByTestId('viewport').boundingBox())!;
  await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2);
  await page.keyboard.press('g');
  await page.mouse.move(v.x + v.width / 2 + 6, v.y + v.height / 2 + 3, { steps: 3 });
  await expect(page.locator('.viewport-mode')).toContainText('snapped to');
  await page.keyboard.press('Escape');
  // And it can be turned off (remembered in the settings).
  await page.getByTestId('kit-snap').click();
  await expect(page.getByTestId('kit-snap')).not.toHaveClass(/active/);
  await page.keyboard.press('g');
  await page.mouse.move(v.x + v.width / 2 + 9, v.y + v.height / 2 + 5, { steps: 3 });
  await expect(page.locator('.viewport-mode')).not.toContainText('snapped to');
  await page.keyboard.press('Escape');
  await page.getByTestId('kit-snap').click();
  expect(errors).toEqual([]);
});
